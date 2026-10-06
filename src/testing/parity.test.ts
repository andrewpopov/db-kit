import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../open.js';
import type { PostgresHandle } from '../postgres.js';
import type { SqliteHandle } from '../sqlite.js';
import { compareSchemas, normalizeExpression, type SchemaDifference } from './parity.js';
import { createTestDatabase, startTestPostgres, type TestPostgres } from './postgres.js';

let server: TestPostgres;
beforeAll(async () => {
  server = await startTestPostgres();
}, 180_000);
afterAll(async () => {
  await server?.stop();
}, 60_000);

const SQLITE_DDL = [
  `create table users(id integer primary key, email text not null, name text not null, age integer, active boolean not null default 1, meta json,
     deleted_at datetime, created_at datetime default current_timestamp, check (length(name) > 0))`,
  'create unique index ux_active_email on users(email) where deleted_at is null',
  'create index ix_lower_name on users(lower(name))',
  'create index ix_age on users(age)',
  'create table memberships(user_id integer not null, org text not null, role text not null, primary key (user_id, org), unique (org, role))',
];
const POSTGRES_DDL = [
  `create table users(id bigint primary key, email text not null, name text not null, age bigint, active boolean not null default true, meta jsonb,
     deleted_at timestamptz, created_at timestamptz default now(), check (length(name) > 0))`,
  'create unique index ux_active_email on users(email) where deleted_at is null',
  'create index ix_lower_name on users(lower(name))',
  'create index ix_age on users(age)',
  'create table memberships(user_id bigint not null, org text not null, role text not null, primary key (user_id, org), unique (org, role))',
];

interface Pair {
  sqlite: SqliteHandle;
  postgres: PostgresHandle;
  release(): Promise<void>;
}

async function pair(): Promise<Pair> {
  const sqlite = openDatabase('file::memory:');
  const database = await createTestDatabase(server);
  const postgres = openDatabase(database.url, { postgres: { applicationName: 'db-kit-test' } });
  if (sqlite.dialect !== 'sqlite' || postgres.dialect !== 'postgres') throw new Error('unexpected dialects');
  for (const statement of SQLITE_DDL) sqlite.db.exec(statement);
  for (const statement of POSTGRES_DDL) await postgres.pool.query(statement);
  return {
    sqlite,
    postgres,
    release: async () => {
      await sqlite.close();
      await postgres.close();
      await database.release();
    },
  };
}

const summary = (differences: SchemaDifference[]): string[] => differences.map((d) => `${d.kind} ${d.table}${d.name === undefined ? '' : ` ${d.name}`}`);

describe('compareSchemas', () => {
  it('finds two migrations that mean the same thing identical (partial and expression indexes, checks, composite keys included)', async () => {
    const both = await pair();
    try {
      const result = await compareSchemas(both.sqlite, both.postgres);
      expect(result.differences).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.report).toBe('schemas match (0 allowed differences)');
    } finally {
      await both.release();
    }
  });

  interface Case {
    name: string;
    mutate: (both: Pair) => Promise<void>;
    expected: string[];
  }
  const cases: Case[] = [
    { name: 'a partial index dropped on Postgres', mutate: async (b) => void (await b.postgres.pool.query('drop index ux_active_email')), expected: ['index users ux_active_email'] },
    { name: 'a partial index dropped on SQLite', mutate: async (b) => void b.sqlite.db.exec('drop index ux_active_email'), expected: ['index users ux_active_email'] },
    { name: 'an expression index dropped on Postgres', mutate: async (b) => void (await b.postgres.pool.query('drop index ix_lower_name')), expected: ['index users ix_lower_name'] },
    {
      name: 'a partial index whose predicate differs',
      mutate: async (b) => {
        await b.postgres.pool.query('drop index ux_active_email');
        await b.postgres.pool.query('create unique index ux_active_email on users(email) where deleted_at is not null');
      },
      expected: ['index users ux_active_email', 'index users ux_active_email'],
    },
    { name: 'a plain index dropped', mutate: async (b) => void (await b.postgres.pool.query('drop index ix_age')), expected: ['index users ix_age'] },
    { name: 'a unique constraint dropped', mutate: async (b) => void (await b.postgres.pool.query('alter table memberships drop constraint memberships_org_role_key')), expected: ['unique memberships sqlite_autoindex_memberships_2'] },
    { name: 'a table missing on Postgres', mutate: async (b) => void (await b.postgres.pool.query('drop table memberships')), expected: ['table-missing memberships'] },
    { name: 'a column missing on SQLite', mutate: async (b) => void b.sqlite.db.exec('alter table users drop column meta'), expected: ['column-missing users meta'] },
    { name: 'a column type that changed class', mutate: async (b) => void (await b.postgres.pool.query('alter table users alter column age type text using age::text')), expected: ['column-type users age'] },
    { name: 'a nullability difference', mutate: async (b) => void (await b.postgres.pool.query('alter table users alter column age set not null')), expected: ['column-nullability users age'] },
    { name: 'a default present on one side only', mutate: async (b) => void (await b.postgres.pool.query('alter table users alter column age set default 0')), expected: ['column-default users age'] },
    {
      name: 'a different primary key',
      mutate: async (b) => void (await b.postgres.pool.query('alter table memberships drop constraint memberships_pkey, add primary key (org)')),
      expected: ['primary-key memberships'],
    },
    {
      name: 'a CHECK dropped on Postgres',
      mutate: async (b) => {
        const { rows } = await b.postgres.pool.query<{ conname: string }>("select conname from pg_constraint where contype = 'c' and conrelid = 'users'::regclass");
        await b.postgres.pool.query(`alter table users drop constraint ${rows[0]?.conname}`);
      },
      expected: ['check users length(name) > 0'],
    },
    {
      name: 'a CHECK whose expression changed',
      mutate: async (b) => {
        const { rows } = await b.postgres.pool.query<{ conname: string }>("select conname from pg_constraint where contype = 'c' and conrelid = 'users'::regclass");
        await b.postgres.pool.query(`alter table users drop constraint ${rows[0]?.conname}, add check (length(name) > 1)`);
      },
      expected: ['check users length(name) > 0', 'check users length(name) > 1'],
    },
  ];
  for (const c of cases) {
    it(`reports by name: ${c.name}`, async () => {
      const both = await pair();
      try {
        await c.mutate(both);
        const result = await compareSchemas(both.sqlite, both.postgres);
        expect(summary(result.differences)).toEqual(c.expected);
        expect(result.ok).toBe(false);
        expect(result.report).toContain(`schemas differ: ${c.expected.length}`);
      } finally {
        await both.release();
      }
    });
  }

  it('names the side that lacks a dropped partial index, with its normalised signature', async () => {
    const both = await pair();
    try {
      await both.postgres.pool.query('drop index ux_active_email');
      const { differences } = await compareSchemas(both.sqlite, both.postgres);
      expect(differences).toEqual([
        { kind: 'index', table: 'users', name: 'ux_active_email', sqlite: 'unique (email) where deleted_atisnull', message: 'index ux_active_email unique (email) where deleted_atisnull on users exists only in sqlite' },
      ]);
    } finally {
      await both.release();
    }
  });

  it('an allow-list records intentional differences, matched on kind, table and name, and leaves others failing', async () => {
    const both = await pair();
    try {
      await both.postgres.pool.query('drop index ux_active_email');
      await both.postgres.pool.query('alter table users alter column age set not null');
      const strict = await compareSchemas(both.sqlite, both.postgres);
      expect(summary(strict.differences)).toEqual(['column-nullability users age', 'index users ux_active_email']);
      const partial = await compareSchemas(both.sqlite, both.postgres, { allow: [{ kind: 'index', table: 'users', name: 'ux_active_email' }] });
      expect(summary(partial.differences)).toEqual(['column-nullability users age']);
      expect(summary(partial.allowed)).toEqual(['index users ux_active_email']);
      expect(partial.ok).toBe(false);
      const wrongName = await compareSchemas(both.sqlite, both.postgres, { allow: [{ kind: 'index', table: 'users', name: 'ix_other' }] });
      expect(wrongName.differences).toHaveLength(2);
      const all = await compareSchemas(both.sqlite, both.postgres, { allow: [{ kind: 'index' }, { table: 'users', name: 'age' }] });
      expect(all.ok).toBe(true);
      expect(all.report).toBe('schemas match (2 allowed differences)');
    } finally {
      await both.release();
    }
  });
});

describe('normalizeExpression', () => {
  it('drops spelling, not meaning', () => {
    expect(normalizeExpression('(deleted_at IS NULL)')).toBe(normalizeExpression('deleted_at is null'));
    expect(normalizeExpression('lower((email)::text)')).toBe(normalizeExpression('LOWER("email")'));
    expect(normalizeExpression("(status)::text = 'a'::text")).toBe(normalizeExpression("status = 'a'"));
    expect(normalizeExpression('length(name) > 0')).not.toBe(normalizeExpression('length(name) > 1'));
  });
});

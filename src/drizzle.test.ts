import { sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { drizzleFor } from './drizzle.js';
import { openDatabase } from './open.js';

describe('drizzleFor', () => {
  it('returns a working better-sqlite3 Drizzle instance for a sqlite handle', async () => {
    const handle = openDatabase('file::memory:');
    if (handle.dialect !== 'sqlite') throw new Error('expected sqlite');
    const db = drizzleFor(handle);
    expectTypeOf(db).toEqualTypeOf<BetterSQLite3Database>();
    expect(db.all(sql`select 41 + 1 as answer`)).toEqual([{ answer: 42 }]);
    await handle.close();
  });

  it('returns a node-postgres Drizzle instance for a postgres handle', async () => {
    const handle = openDatabase('postgres://u:p@127.0.0.1:1/db', { postgres: { applicationName: 'drizzle-test' } });
    if (handle.dialect !== 'postgres') throw new Error('expected postgres');
    const db = drizzleFor(handle);
    expectTypeOf(db).toEqualTypeOf<NodePgDatabase>();
    await handle.close();
  });

  it('an unnarrowed handle yields the dialect union', () => {
    const handle = openDatabase('file::memory:');
    expectTypeOf(drizzleFor(handle)).toEqualTypeOf<BetterSQLite3Database | NodePgDatabase>();
    return handle.close();
  });
});

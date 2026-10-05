import { describe as suite, expect, it } from 'vitest';
import { DbKitError } from './errors.js';
import { describe, parseDatabaseUrl } from './url.js';

const SECRET = 's3cr3t-p@ss/word';
const encoded = encodeURIComponent(SECRET);

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

suite('parseDatabaseUrl: sqlite', () => {
  it.each([
    ['file:relative/app.db', 'relative/app.db'],
    ['file:./app.db', './app.db'],
    ['file:/abs/app.db', '/abs/app.db'],
    ['file:///abs/app.db', '/abs/app.db'],
    ['sqlite:app.db', 'app.db'],
    ['sqlite:///abs/app.db', '/abs/app.db'],
    ['file:my%20dir/app.db', 'my dir/app.db'],
  ])('%s -> path %s', (url, path) => {
    expect(parseDatabaseUrl(url)).toEqual({ dialect: 'sqlite', path, inMemory: false });
  });

  it('accepts :memory: as in-memory', () => {
    expect(parseDatabaseUrl('file::memory:')).toEqual({ dialect: 'sqlite', path: ':memory:', inMemory: true });
  });

  it.each(['file:', 'file://host/app.db', 'file:app.db?mode=ro', 'file:app.db#x', 'file:%zz'])('rejects %s', (url) => {
    const error = errorOf(() => parseDatabaseUrl(url));
    expect(error).toBeInstanceOf(DbKitError);
    expect((error as DbKitError).code).toBe('INVALID_DATABASE_URL');
  });
});

suite('parseDatabaseUrl: postgres', () => {
  it('parses a full URL, decoding user and password', () => {
    expect(parseDatabaseUrl(`postgres://app:${encoded}@db.internal:6543/appdb?sslmode=verify-full`)).toEqual({
      dialect: 'postgres',
      host: 'db.internal',
      port: 6543,
      database: 'appdb',
      user: 'app',
      password: SECRET,
      sslmode: 'verify-full',
    });
  });

  it('defaults port 5432 and sslmode disable; postgresql: is equivalent', () => {
    expect(parseDatabaseUrl('postgresql://localhost/appdb')).toEqual({
      dialect: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'appdb',
      user: undefined,
      password: undefined,
      sslmode: 'disable',
    });
  });

  it('accepts the password as a query parameter and an IPv6 host', () => {
    const config = parseDatabaseUrl(`postgres://app@[::1]/appdb?password=${encoded}`);
    expect(config).toMatchObject({ host: '::1', user: 'app', password: SECRET });
  });

  it.each([
    ['postgres://localhost', 'database'],
    ['postgres://localhost/db?sslmode=prefer', 'sslmode'],
    ['postgres://localhost/db?application_name=x', 'unsupported query parameter'],
    ['postgres://u:p@localhost/db?password=q', 'both'],
    ['postgres://localhost:99999/db', ''],
  ])('rejects %s', (url, fragment) => {
    const error = errorOf(() => parseDatabaseUrl(url));
    expect(error).toBeInstanceOf(DbKitError);
    expect((error as DbKitError).message).toContain(fragment);
  });
});

suite('parseDatabaseUrl: query keys are never echoed', () => {
  it('a key equal to the password is not in the message', () => {
    const error = errorOf(() => parseDatabaseUrl('postgres://u:hunter2@h/db?hunter2=1'));
    expect(String(error)).not.toContain('hunter2');
    expect((error as Error).message).toContain('unsupported query parameter');
  });
});

suite('parseDatabaseUrl: other input', () => {
  it.each(['', '   ', 'not a url', 'mysql://u:p@h/db', 'http://u:p@h/db'])('rejects %j', (url) => {
    expect(errorOf(() => parseDatabaseUrl(url))).toBeInstanceOf(DbKitError);
  });
});

suite('redaction: no password in any parse error', () => {
  const urls = [
    `mysql://app:${encoded}@host/db`,
    `postgres://app:${encoded}@host/db?sslmode=bogus`,
    `postgres://app:${encoded}@host/db?${encoded}=1`,
    `postgres://app:${encoded}@host:99999/db`,
    `postgres://app:${encoded}@host/db#frag`,
    `postgres://app:${SECRET}@host/db`,
    `postgres://app:${encoded}@host/a/b`,
    `postgres://app:${encoded}@host/db?password=${encoded}`,
    `${SECRET}://x`,
  ];
  it.each(urls)('%s', (url) => {
    const error = errorOf(() => parseDatabaseUrl(url));
    for (const needle of [SECRET, encoded, 's3cr3t']) {
      expect(String(error)).not.toContain(needle);
      expect((error as Error).message).not.toContain(needle);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

suite('describe', () => {
  it('replaces the password with *** for a config', () => {
    const text = describe(parseDatabaseUrl(`postgres://app:${encoded}@db:5432/appdb?sslmode=require`));
    expect(text).toBe('postgres://app:***@db:5432/appdb?sslmode=require');
    expect(text).not.toContain('s3cr3t');
  });

  it('never shows a password given as a query parameter', () => {
    const text = describe(parseDatabaseUrl(`postgres://app@db/appdb?password=${encoded}`));
    expect(text).toBe('postgres://app:***@db:5432/appdb?sslmode=disable');
    expect(text).not.toContain('s3cr3t');
  });

  it('describes sqlite by path', () => {
    expect(describe(parseDatabaseUrl('file:./app.db'))).toBe('sqlite:./app.db');
  });

  it('redacts everything before the last @ of a raw string that does not parse, and keeps only the host', () => {
    expect(describe('mysql://u:hunter2@h/db?password=hunter2&x=1')).toBe('mysql://***@h');
    expect(describe('mysql://u:hunter2@h')).toBe('mysql://***@h');
    expect(describe('mysql://h/db?x=1#frag')).toBe('mysql://h');
  });

  it.each([
    ['percent-encoded param name', 'postgres://u@h/db?sslmode=bogus&%70assword=hunter2'],
    ['literal @ in the password', 'mysql://u:hunter2@second@host/db'],
    ['literal @ twice, first segment', 'mysql://u:hunter2@hunter3@host/db'],
    ['whitespace in the password', 'postgres://u:hunter2 hunter3@h/db?sslmode=bogus'],
    ['literal / in the password', 'mysql://u:hunter2/hunter3@h/db'],
    ['literal # and ? in the password', 'mysql://u:hun#ter?2@h/db'],
    ['password in query only', 'mysql://h/db?pass%77ord=hunter2'],
    ['uppercase param', 'mysql://h/db?PASSWORD=hunter2'],
    ['semicolon-separated param', 'mysql://h/db;password=hunter2'],
  ])('fallback never leaks: %s', (_name, url) => {
    const text = describe(url);
    for (const needle of ['hunter', 'hun#', 'ter?2', 'second']) expect(text).not.toContain(needle);
  });

  it('gives a fixed placeholder when the string has no scheme', () => {
    expect(describe('hunter2')).toBe('<unparseable DATABASE_URL>');
  });
});

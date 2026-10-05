import { z } from 'zod';
export declare const SSL_MODES: readonly ["disable", "require", "verify-ca", "verify-full"];
export type SslMode = (typeof SSL_MODES)[number];
declare const SqliteConfigSchema: z.ZodObject<{
    dialect: z.ZodLiteral<"sqlite">;
    path: z.ZodString;
    inMemory: z.ZodBoolean;
}, z.core.$strip>;
declare const PostgresConfigSchema: z.ZodObject<{
    dialect: z.ZodLiteral<"postgres">;
    host: z.ZodString;
    port: z.ZodNumber;
    database: z.ZodString;
    user: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodString>;
    sslmode: z.ZodEnum<{
        disable: "disable";
        require: "require";
        "verify-ca": "verify-ca";
        "verify-full": "verify-full";
    }>;
}, z.core.$strip>;
export type SqliteConfig = z.infer<typeof SqliteConfigSchema>;
export type PostgresConfig = z.infer<typeof PostgresConfigSchema>;
export declare const DatabaseConfigSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    dialect: z.ZodLiteral<"sqlite">;
    path: z.ZodString;
    inMemory: z.ZodBoolean;
}, z.core.$strip>, z.ZodObject<{
    dialect: z.ZodLiteral<"postgres">;
    host: z.ZodString;
    port: z.ZodNumber;
    database: z.ZodString;
    user: z.ZodOptional<z.ZodString>;
    password: z.ZodOptional<z.ZodString>;
    sslmode: z.ZodEnum<{
        disable: "disable";
        require: "require";
        "verify-ca": "verify-ca";
        "verify-full": "verify-full";
    }>;
}, z.core.$strip>], "dialect">;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
/**
 * Parse a `DATABASE_URL` into a validated config.
 *
 * SQLite (`file:` and `sqlite:` are equivalent):
 *   - `file:relative/app.db`, `file:./app.db`: relative to the process cwd.
 *   - `file:/abs/app.db` and `file:///abs/app.db`: absolute.
 *   - `file::memory:`: private in-memory database.
 *   - No query string, fragment or authority (`file://host/x` is refused).
 *
 * Postgres (`postgres:` and `postgresql:`):
 *   `postgres://[user[:password]@]host[:port]/database[?sslmode=...]`, port defaults to 5432.
 *   Percent-encode special characters in user/password. Accepted query keys:
 *   `sslmode` (disable | require | verify-ca | verify-full, default disable), `user`, `password`.
 *
 * Every failure is a `DbKitError('INVALID_DATABASE_URL')` whose message never contains the URL.
 */
export declare function parseDatabaseUrl(url: string): DatabaseConfig;
/**
 * Human-readable, log-safe description of a config. The password is always
 * `***`. A raw URL string is also accepted (e.g. to log a `DATABASE_URL` that
 * failed to parse): it is parsed when possible, otherwise regex-redacted
 * (userinfo password and any `password=` query parameter).
 */
export declare function describe(config: DatabaseConfig | string): string;
export {};

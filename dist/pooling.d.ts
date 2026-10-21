export interface PoolRoutingOptions {
    /** Runtime connections require a pool by default. Session-affine work must opt out explicitly. */
    purpose?: 'runtime' | 'migration' | 'backup' | 'session';
    pooling?: 'required' | 'preferred' | 'off';
}
/** ORM-independent routing. Never changes the direct URL or consults global process state. */
export declare function runtimeDatabaseUrl(env: Readonly<Record<string, string | undefined>>, options?: PoolRoutingOptions): string;
export interface PgBouncerDatabase {
    /** Must equal the upstream database name; aliases cannot multiply its server budget. */
    name: string;
    url: string;
    poolSize?: number;
    reservePoolSize?: number;
    maxServerConnections?: number;
    mode?: 'transaction' | 'session';
}
export interface PgBouncerOptions {
    databases: readonly PgBouncerDatabase[];
    /** Sum of all per-database caps must fit this operator-assigned budget. */
    serverConnectionBudget: number;
    listenPort?: number;
    maxClientConnections?: number;
    authFile?: string;
    socketDirectory?: string;
    /** Required for verify-ca/verify-full; never downgrade upstream TLS. */
    serverTlsCaFile?: string;
}
export interface PgBouncerFiles {
    /** Sensitive: install config and authentication files with mode 0600. */
    config: string;
    auth: string;
    runtimeUrls: Readonly<Record<string, string>>;
    serverConnectionCap: number;
}
/** Pure renderer: never installs packages, writes files, restarts services, or prints secrets. */
export declare function renderPgBouncer(options: PgBouncerOptions): PgBouncerFiles;

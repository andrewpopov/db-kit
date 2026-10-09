import type { CodecManifest } from '../codecs/manifest.js';
import type { PostgresConfig } from '../url.js';
import type { ProgressEvent } from './execute.js';
import { type ReverseResult } from './reverse.js';
import type { TopologyEntry } from './topology.js';
/**
 * Postgres to SQLite export, the swap-back path every app shares. `reverseClone` does the copy and the row-by-row
 * verification; the app supplies what only it knows: its forward manifest, how to build its empty SQLite schema, and
 * which migration ids Postgres must hold.
 */
export interface SqliteExportApp {
    /** The app's FORWARD codec manifest (already parsed). */
    manifest: CodecManifest;
    /** Extra tables the reverse direction must not copy: name -> reason. Merged into the manifest as `{ copy: false, reason }`. */
    skipTables?: Readonly<Record<string, string>>;
    /** Write an EMPTY file at `path` carrying the app's own SQLite schema (run its migrations, any app-specific rebuilds). */
    buildTemplate(path: string): void | Promise<void>;
    /** The source's migration ledger must equal `expected` exactly. `query` is SQL run on the Postgres source returning a text column `id`. */
    ledger: {
        query: string;
        expected: () => Iterable<string> | Promise<Iterable<string>>;
    };
    /** Open a COPY of the published file the way the app would. Throw to report a problem; it becomes a warning, never a refusal. */
    smoke?(copyPath: string): void | Promise<void>;
}
export interface ExportToSqliteOptions {
    app: SqliteExportApp;
    source: PostgresConfig;
    /** The new SQLite file; must not exist. Put it outside the live location. */
    toSqlitePath: string;
    /** Operator attestation that every writer to the source is stopped and drained. */
    writersStopped: boolean;
    dryRun?: boolean;
    confirmProduction?: string;
    topology?: readonly TopologyEntry[];
    tlsCa?: string;
    fetchRows?: number;
    onProgress?: (event: ProgressEvent) => void;
}
export interface ExportToSqliteResult extends ReverseResult {
    /** Copied tables in which the template held rows (seeded by a migration), emptied in the template only. */
    templateRowsCleared: string[];
}
/** The forward manifest with `app.skipTables` declared `copy: false`, so the template's own rows in them (such as its ledger) are kept. */
export declare function reverseManifestFor(app: SqliteExportApp): CodecManifest;
/**
 * Writes the app's empty SQLite file at `path`. A migration may seed a row into a table the clone copies (`reverseClone`
 * refuses a template with rows there); those rows are deleted here, in the template only, because Postgres's own copy of
 * them is what the export carries. Returns the tables emptied.
 */
export declare function buildExportTemplate(app: SqliteExportApp, path: string): Promise<string[]>;
/**
 * The whole export: refuse unless writers are stopped, build the template, check the Postgres ledger against the code,
 * `reverseClone`, then smoke-open a copy. Only a `CloneRefusal` ever leaves. The work directory is always removed.
 */
export declare function exportToSqlite(options: ExportToSqliteOptions): Promise<ExportToSqliteResult>;

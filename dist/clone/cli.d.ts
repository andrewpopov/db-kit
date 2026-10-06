import { reverseClone } from './reverse.js';
/** The only place the target URL is read from: an argv URL would sit in `ps` and shell history. */
export declare const TARGET_URL_ENV = "DB_KIT_TARGET_URL";
/** The reverse clone's source: read from the environment only, for the same reason. */
export declare const SOURCE_URL_ENV = "DB_KIT_SOURCE_URL";
export interface CliIo {
    out(text: string): void;
    err(text: string): void;
}
/**
 * Exit codes: 0 plan has no refusals / dry run verified / COMMITTED, 1 refused or failed with the target unchanged,
 * 2 usage error, 3 (reverse only) the SQLite file IS in place but a later step warned (see `warnings`), 4 COMMIT ABORTED (nothing committed), 5 COMMIT outcome UNKNOWN (inspect the target; never re-run blindly).
 */
export declare function runCloneCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo, deps?: {
    reverseClone?: typeof reverseClone;
}): Promise<number>;

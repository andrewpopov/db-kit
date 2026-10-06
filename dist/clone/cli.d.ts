/** The only place the target URL is read from: an argv URL would sit in `ps` and shell history. */
export declare const TARGET_URL_ENV = "DB_KIT_TARGET_URL";
export interface CliIo {
    out(text: string): void;
    err(text: string): void;
}
/** Exit codes: 0 plan has no refusals, 1 refused, 2 usage error or an operation this build does not do yet. */
export declare function runCloneCli(argv: readonly string[], env: NodeJS.ProcessEnv, io: CliIo): Promise<number>;

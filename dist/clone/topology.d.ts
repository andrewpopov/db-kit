import { z } from 'zod';
declare const TopologyEntrySchema: z.ZodObject<{
    host: z.ZodString;
    port: z.ZodNumber;
    systemIdentifier: z.ZodString;
    database: z.ZodString;
    production: z.ZodBoolean;
}, z.core.$strict>;
export type TopologyEntry = z.output<typeof TopologyEntrySchema>;
/** What the server itself reported, plus the host:port the operator pointed clone at. */
export interface TargetIdentity {
    host: string;
    port: number;
    database: string;
    systemIdentifier: string;
}
export declare function loadTopology(path: string): TopologyEntry[];
/** The exact string `--confirm-production` must equal. */
export declare const productionConfirmation: (identity: Pick<TargetIdentity, "host" | "port" | "database">) => string;
/**
 * A target is non-production only when EVERY field matches an entry that says `production: false`. No topology,
 * a partial match, or a matching `production: true` entry all mean production (fail closed).
 */
export declare function isProduction(identity: TargetIdentity, topology: readonly TopologyEntry[] | undefined): boolean;
export {};

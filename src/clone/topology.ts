import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { refuse } from './errors.js';

const TopologyEntrySchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** `pg_control_system().system_identifier`, as text (it is a 64-bit integer). */
  systemIdentifier: z.string().regex(/^\d+$/),
  database: z.string().min(1),
  production: z.boolean(),
});

const TopologySchema = z.union([z.array(TopologyEntrySchema), z.strictObject({ entries: z.array(TopologyEntrySchema) }).transform((t) => t.entries)]);

export type TopologyEntry = z.output<typeof TopologyEntrySchema>;

/** What the server itself reported, plus the host:port the operator pointed clone at. */
export interface TargetIdentity {
  host: string;
  port: number;
  database: string;
  systemIdentifier: string;
}

export function loadTopology(path: string): TopologyEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return refuse({ code: 'topology-invalid' });
  }
  const parsed = TopologySchema.safeParse(raw);
  return parsed.success ? parsed.data : refuse({ code: 'topology-invalid' });
}

/** The exact string `--confirm-production` must equal. */
export const productionConfirmation = (identity: Pick<TargetIdentity, 'host' | 'port' | 'database'>): string =>
  `${identity.host}:${identity.port}/${identity.database}`;

/**
 * A target is non-production only when EVERY field matches an entry that says `production: false`. No topology,
 * a partial match, or a matching `production: true` entry all mean production (fail closed).
 */
export function isProduction(identity: TargetIdentity, topology: readonly TopologyEntry[] | undefined): boolean {
  const matches = (topology ?? []).filter(
    (entry) =>
      entry.host === identity.host &&
      entry.port === identity.port &&
      entry.systemIdentifier === identity.systemIdentifier &&
      entry.database === identity.database,
  );
  return matches.length === 0 || matches.some((entry) => entry.production);
}

import { describeRefusal } from './errors.js';
import type { ClonePlan } from './plan.js';

/** The plan as JSON. 64-bit values (sequence bounds, restart values) are strings: JSON numbers cannot carry them. */
export function planToJson(plan: ClonePlan): string {
  return JSON.stringify(plan, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

export function planToText(plan: ClonePlan): string {
  const lines: string[] = [];
  const { target } = plan;
  if (target) {
    lines.push(
      `target ${target.host}:${target.port}/${target.database} (${target.production ? 'PRODUCTION' : 'non-production'}) postgres ${target.serverVersion} system_identifier ${target.systemIdentifier}${target.inRecovery ? ' IN RECOVERY' : ''}`,
    );
    if (target.production) lines.push(`  --confirm-production must equal ${target.confirmation}`);
  }
  lines.push(`snapshot sha256 ${plan.snapshot.sha256} (${plan.snapshot.bytes} bytes)`);
  lines.push(`tables (${plan.tables.length}):`);
  for (const table of plan.tables) {
    const state = table.willTruncate ? ' WILL TRUNCATE' : table.targetNonEmpty ? ' target NOT EMPTY' : '';
    lines.push(`  ${table.table}: ${table.rows} rows, ~${table.estimatedBytes} bytes${state}`);
  }
  lines.push(`foreign keys dropped and re-added (${plan.foreignKeys.length}):`);
  for (const fk of plan.foreignKeys) lines.push(`  ${fk.tableSchema}.${fk.table} ${fk.name}: ${fk.definition}`);
  if (plan.incomingReferences.length > 0) {
    lines.push(`incoming references from tables not copied (${plan.incomingReferences.length}):`);
    for (const fk of plan.incomingReferences) lines.push(`  ${fk.tableSchema}.${fk.table} ${fk.name} -> ${fk.refTable}`);
  }
  lines.push(`sequences restarted (${plan.sequences.length}):`);
  for (const sequence of plan.sequences) {
    lines.push(`  ${sequence.schema}.${sequence.name} (${sequence.table}.${sequence.column}): ${sequence.restartWith === null ? `RESTART (start ${sequence.start})` : `RESTART WITH ${sequence.restartWith}`}`);
  }
  lines.push(plan.ok ? 'plan OK: no refusals' : `REFUSED (${plan.refusals.length}):`);
  for (const refusal of plan.refusals) lines.push(`  ${describeRefusal(refusal)}`);
  return lines.join('\n');
}

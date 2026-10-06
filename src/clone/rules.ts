import type { CodecManifest } from '../codecs/manifest.js';
import { RECEIPT_COLUMNS, RECEIPT_PRIMARY_KEY, RECEIPT_SCHEMA, RECEIPT_TABLE, type ForeignKeyFact, type SequenceRef, type TargetFacts } from './catalog.js';
import type { Refusal } from './errors.js';

export const DEFAULT_MAX_SLOT_RETENTION_BYTES = 5n * 1024n ** 3n;

export interface RuleOptions {
  truncate: boolean;
  maxSlotRetentionBytes: bigint;
}

/** One sequence clone will restart: owned by (or identity of) exactly one column of a copied table. */
export interface OwnedSequence extends Omit<SequenceRef, 'kind' | 'tableOid'> {
  table: string;
}

export interface GateResult {
  refusals: Refusal[];
  /** Foreign keys owned by a copied table: the set clone will drop and re-add. */
  foreignKeys: ForeignKeyFact[];
  /** Foreign keys from a table clone does not copy into a copied one: left alone, listed for the operator. */
  incomingReferences: ForeignKeyFact[];
  sequences: OwnedSequence[];
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/** Turn catalog facts into refusals: the schema gate, capabilities, emptiness and operational checks of PKG-177 D5-D10 and A1/A3-A5/A7. */
export function evaluateGate(facts: TargetFacts, manifest: CodecManifest, options: RuleOptions): GateResult {
  const refusals: Refusal[] = [];
  const refuse = (refusal: Refusal): void => void refusals.push(refusal);
  const copied = new Map(facts.tables.map((table) => [table.oid, table.name]));

  for (const table of facts.tables) {
    if (table.kind === 'p') refuse({ code: 'partitioned-table', table: table.name });
    else if (table.isPartition || table.inherits || table.hasChildren) refuse({ code: 'inherited-table', table: table.name });
    if (table.rowSecurity) refuse({ code: 'row-security-enabled', table: table.name });
    if (!table.isOwner) refuse({ code: 'not-owner', table: table.name });
    const spec = Object.hasOwn(manifest.tables, table.name) ? manifest.tables[table.name] : undefined;
    if (spec && !sameList(facts.primaryKeys.get(table.name) ?? [], spec.primaryKey)) refuse({ code: 'primary-key-mismatch', table: table.name });
  }

  for (const column of facts.columns) {
    const spec = Object.hasOwn(manifest.tables, column.table) ? manifest.tables[column.table]?.columns[column.column] : undefined;
    if (spec && spec.nullable === column.notNull) refuse({ code: 'nullability-mismatch', table: column.table, column: column.column });
  }

  for (const trigger of facts.triggers) refuse({ code: 'trigger-present', table: trigger.table, object: trigger.name });
  for (const rule of facts.rules) refuse({ code: 'rule-present', table: rule.table, object: rule.name });

  const foreignKeys = facts.foreignKeys.filter((fk) => copied.has(fk.tableOid));
  const incomingReferences = facts.foreignKeys.filter((fk) => !copied.has(fk.tableOid));
  for (const fk of foreignKeys) {
    if (!fk.validated || !fk.enforced) refuse({ code: 'foreign-key-not-valid', table: fk.table, object: fk.name });
    if (fk.hasComment) refuse({ code: 'constraint-has-comment', table: fk.table, object: fk.name });
  }
  if (options.truncate) {
    for (const fk of incomingReferences) refuse({ code: 'incoming-reference-from-uncopied-table', table: fk.refTable, object: `${fk.tableSchema}.${fk.table}.${fk.name}` });
  }

  for (const name of facts.eventTriggers) refuse({ code: 'event-trigger-present', object: name });
  for (const published of facts.publications) refuse({ code: 'publication-covers-table', table: published.table, object: published.publication });
  if (facts.subscriptionCount > 0) refuse({ code: 'subscription-present' });

  const sequences = classifySequences(facts.sequenceRefs, copied, refuse);

  const { receipt } = facts;
  if (receipt.table) {
    const columnsMatch = sameList(Object.keys(receipt.table.columns).sort(), Object.keys(RECEIPT_COLUMNS).sort()) && Object.entries(RECEIPT_COLUMNS).every(([name, type]) => receipt.table?.columns[name] === type);
    const sound =
      receipt.table.kind === 'r' &&
      receipt.table.isOwner &&
      !receipt.table.rowSecurity &&
      !receipt.table.hasTrigger &&
      !receipt.table.hasRule &&
      !receipt.table.published &&
      columnsMatch &&
      sameList(receipt.table.primaryKey, RECEIPT_PRIMARY_KEY);
    if (!sound) refuse({ code: 'receipt-table-invalid', table: `${RECEIPT_SCHEMA}.${RECEIPT_TABLE}` });
  } else if (!receipt.canCreate) {
    refuse({ code: 'no-create-privilege', object: RECEIPT_SCHEMA });
  }

  for (const name of facts.nonEmptyTables) if (!options.truncate) refuse({ code: 'target-not-empty', table: name });
  if (facts.archiverFailedRecently) refuse({ code: 'archiver-failing' });
  for (const slot of facts.slots) if (slot.retainedBytes > options.maxSlotRetentionBytes) refuse({ code: 'replication-slot-lag', object: slot.name });

  return { refusals, foreignKeys, incomingReferences, sequences };
}

/**
 * A sequence is clone-safe only when it belongs to exactly one column of a copied table (OWNED BY or identity) and
 * nothing else's DEFAULT calls it, and it does not cycle: otherwise restarting it after the load could hand out a
 * value another table already holds or wrap around.
 */
function classifySequences(refs: readonly SequenceRef[], copied: ReadonlyMap<number, string>, refuse: (refusal: Refusal) => void): OwnedSequence[] {
  const bySequence = new Map<number, SequenceRef[]>();
  for (const ref of refs) bySequence.set(ref.sequenceOid, [...(bySequence.get(ref.sequenceOid) ?? []), ref]);
  const usable: OwnedSequence[] = [];
  for (const group of bySequence.values()) {
    const [first] = group;
    if (!first) continue;
    const owners = group.filter((ref) => ref.kind === 'owner');
    const defaults = group.filter((ref) => ref.kind === 'default');
    const used = group.find((ref) => copied.has(ref.tableOid));
    const object = `${first.schema}.${first.name}`;
    const identity = { table: copied.get(used?.tableOid ?? -1), column: used?.column, object };
    const [owner] = owners;
    if (!owner) refuse({ code: 'sequence-unowned', ...identity });
    else if (owners.length > 1 || defaults.some((use) => use.tableOid !== owner.tableOid || use.column !== owner.column)) refuse({ code: 'sequence-shared', ...identity });
    else if (first.cycles) refuse({ code: 'sequence-cycles', ...identity });
    else if (copied.has(owner.tableOid)) {
      const { kind: _kind, tableOid, ...sequence } = owner;
      usable.push({ ...sequence, table: copied.get(tableOid) ?? '' });
    }
  }
  return usable;
}

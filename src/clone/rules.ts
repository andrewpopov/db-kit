import { jsonPgType, type CodecManifest } from '../codecs/manifest.js';
import { RECEIPT_COLUMNS, RECEIPT_PRIMARY_KEY, RECEIPT_SCHEMA, RECEIPT_TABLE, TARGET_SCHEMA, type ForeignKeyFact, type ReceiptFacts, type SequenceRef, type TargetFacts } from './catalog.js';
import type { Refusal } from './errors.js';

const RECEIPT_REFUSAL = { code: 'receipt-table-invalid', table: `${RECEIPT_SCHEMA}.${RECEIPT_TABLE}` } as const;

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

/** A primary-key column whose order differs between SQLite text and the Postgres type it converts to, so row-by-row verification cannot line the two sides up. */
function reordersOnConversion(spec: CodecManifest['tables'][string]['columns'][string] | undefined): boolean {
  if (!spec) return false;
  return spec.codec === 'decimal-as-string' || (spec.codec === 'timestamp-iso' && !spec.preserveText) || (spec.codec === 'json-text' && jsonPgType(spec) !== 'text') || spec.codec === 'timestamp-naive';
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * What must hold of the copied tables whichever direction the data flows: no partitioning or inheritance, no RLS, the
 * real primary key and NULL rules match the manifest, keys sortable the same way on both sides, no key to a skipped
 * table. `requireOwnership` is for a target that is written (constraints are dropped and re-added), not for a source.
 * `skippedMayReferenceCopied` is for the reverse direction only (see the foreign-key check below).
 */
export function evaluateShape(facts: TargetFacts, manifest: CodecManifest, options: { requireOwnership: boolean; skippedMayReferenceCopied?: boolean }): Refusal[] {
  const refusals: Refusal[] = [];
  const refuse = (refusal: Refusal): void => void refusals.push(refusal);
  const copied = new Map(facts.tables.map((table) => [table.oid, table.name]));
  for (const table of facts.tables) {
    if (table.kind === 'p') refuse({ code: 'partitioned-table', table: table.name });
    else if (table.isPartition || table.inherits || table.hasChildren) refuse({ code: 'inherited-table', table: table.name });
    if (table.rowSecurity) refuse({ code: 'row-security-enabled', table: table.name });
    if (options.requireOwnership && !table.isOwner) refuse({ code: 'not-owner', table: table.name });
    const spec = Object.hasOwn(manifest.tables, table.name) ? manifest.tables[table.name] : undefined;
    if (spec && !sameList(facts.primaryKeys.get(table.name) ?? [], spec.primaryKey)) refuse({ code: 'primary-key-mismatch', table: table.name });
    for (const name of spec?.primaryKey ?? []) {
      if (reordersOnConversion(spec?.columns[name])) refuse({ code: 'primary-key-order-unsupported', table: table.name, column: name });
    }
  }

  for (const column of facts.columns) {
    const spec = Object.hasOwn(manifest.tables, column.table) ? manifest.tables[column.table]?.columns[column.column] : undefined;
    if (spec && spec.nullable === column.notNull) refuse({ code: 'nullability-mismatch', table: column.table, column: column.column });
  }

  // A skipped table (`copy: false`) is never loaded or verified, so a key between it and a copied table could not be honoured either way.
  // Reverse differs for a skipped table that references a copied one: the SQLite target's skipped tables keep only the template's
  // content and reverseClone runs `PRAGMA foreign_key_check` after the load, so a real violation there is still refused.
  // A copied table referencing a skipped one stays refused: the skipped parent rows are not loaded.
  const isSkipped = (schema: string, name: string): boolean => schema === TARGET_SCHEMA && Object.hasOwn(manifest.skipped, name);
  for (const fk of facts.foreignKeys) {
    const tableCopied = copied.has(fk.tableOid);
    const refCopied = copied.has(fk.refOid);
    const copiedToSkipped = tableCopied && isSkipped(fk.refSchema, fk.refTable);
    const skippedToCopied = refCopied && isSkipped(fk.tableSchema, fk.table);
    if (copiedToSkipped || (skippedToCopied && !options.skippedMayReferenceCopied)) {
      refuse({ code: 'foreign-key-to-skipped-table', table: tableCopied ? fk.table : fk.refTable, object: fk.name });
    }
  }
  return refusals;
}

/** Turn catalog facts into refusals: the schema gate, capabilities, emptiness and operational checks of PKG-177 D5-D10 and A1/A3-A5/A7. */
export function evaluateGate(facts: TargetFacts, manifest: CodecManifest, options: RuleOptions): GateResult {
  const refusals: Refusal[] = [];
  const refuse = (refusal: Refusal): void => void refusals.push(refusal);
  const copied = new Map(facts.tables.map((table) => [table.oid, table.name]));

  refusals.push(...evaluateShape(facts, manifest, { requireOwnership: true }));

  for (const trigger of facts.triggers) refuse({ code: 'trigger-present', table: trigger.table, object: trigger.name });
  for (const rule of facts.rules) refuse({ code: 'rule-present', table: rule.table, object: rule.name });

  const foreignKeys = facts.foreignKeys.filter((fk) => copied.has(fk.tableOid));
  const incomingReferences = facts.foreignKeys.filter((fk) => !copied.has(fk.tableOid));
  for (const fk of incomingReferences) {
    if (!fk.validated || !fk.enforced) refuse({ code: 'foreign-key-not-valid', table: `${fk.tableSchema}.${fk.table}`, object: fk.name });
  }
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

  for (const use of facts.dynamicSequenceDefaults) {
    refuse({ code: 'sequence-dynamic-default', table: use.schema === TARGET_SCHEMA ? use.table : `${use.schema}.${use.table}`, column: use.column });
  }
  for (const expression of facts.volatileExpressions) refuse({ code: 'volatile-expression', table: expression.table, object: expression.object });
  const sequences = classifySequences(facts.sequenceRefs, copied, refuse);

  const { receipt } = facts;
  for (const publication of receipt.adoptingPublications) refuse({ ...RECEIPT_REFUSAL, object: publication });
  if (receipt.table) {
    if (!receiptIsSound(receipt.table)) refuse(RECEIPT_REFUSAL);
  } else if (!receipt.canCreate) {
    refuse({ code: 'no-create-privilege', object: RECEIPT_SCHEMA });
  }

  for (const name of facts.nonEmptyTables) if (!options.truncate) refuse({ code: 'target-not-empty', table: name });
  if (facts.archiverFailedRecently) refuse({ code: 'archiver-failing' });
  for (const slot of facts.slots) if (slot.retainedBytes > options.maxSlotRetentionBytes) refuse({ code: 'replication-slot-lag', object: slot.name });

  return { refusals, foreignKeys, incomingReferences, sequences };
}

/** The receipt table is safe to insert into: a plain owned table of exactly the expected shape that nothing else hooks into. */
export function receiptIsSound(table: NonNullable<ReceiptFacts['table']>): boolean {
  const columnsMatch = sameList(Object.keys(table.columns).sort(), Object.keys(RECEIPT_COLUMNS).sort()) && Object.entries(RECEIPT_COLUMNS).every(([name, type]) => table.columns[name] === type);
  return table.kind === 'r' && table.isOwner && !table.rowSecurity && !table.hasTrigger && !table.hasRule && !table.published && columnsMatch && sameList(table.primaryKey, RECEIPT_PRIMARY_KEY);
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

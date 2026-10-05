import { buildCodecs } from './bound.js';
import type { IntrospectedColumn, IntrospectedSchema } from './introspect.js';
import type { CodecManifest } from './manifest.js';

export type ManifestIssueCode =
  | 'undeclared-table'
  | 'undeclared-column'
  | 'missing-table'
  | 'missing-column'
  | 'generated-undeclared'
  | 'generated-mismatch'
  | 'pg-type-mismatch';

export interface ManifestIssue {
  code: ManifestIssueCode;
  table: string;
  column?: string;
  /** The database the problem is on. */
  side: 'sqlite' | 'postgres';
  message: string;
}

export interface ManifestValidation {
  /** True only when there are no issues. */
  ok: boolean;
  issues: ManifestIssue[];
  /** Declared-generated columns that checked out on both sides: verified, never copied. */
  generated: { table: string; column: string }[];
  report: string;
}

export interface IntrospectedDatabases {
  sqlite: IntrospectedSchema;
  postgres: IntrospectedSchema;
}

const SIDES = ['sqlite', 'postgres'] as const;

/**
 * Check a manifest against both live schemas. Nothing is inferred and nothing is skipped: every table and column
 * on either side must be declared, every declared one must exist on both sides, `generated` must match each
 * engine, and the Postgres column type must be one the declared codec expects.
 */
export function validateManifest(manifest: CodecManifest, databases: IntrospectedDatabases): ManifestValidation {
  const codecs = buildCodecs(manifest);
  const issues: ManifestIssue[] = [];
  const generated: ManifestValidation['generated'] = [];
  const issue = (code: ManifestIssueCode, side: ManifestIssue['side'], table: string, column: string | undefined, message: string): void => {
    issues.push({ code, side, table, ...(column === undefined ? {} : { column }), message });
  };

  for (const side of SIDES) {
    for (const table of databases[side].keys()) {
      if (!(table in manifest.tables)) issue('undeclared-table', side, table, undefined, `${side} table ${table} is not declared in the manifest`);
    }
  }

  for (const [table, spec] of Object.entries(manifest.tables)) {
    const actual: Record<(typeof SIDES)[number], Map<string, IntrospectedColumn> | undefined> = {
      sqlite: toColumnMap(databases.sqlite.get(table)),
      postgres: toColumnMap(databases.postgres.get(table)),
    };
    for (const side of SIDES) {
      const columns = actual[side];
      if (!columns) {
        issue('missing-table', side, table, undefined, `declared table ${table} does not exist in ${side}`);
        continue;
      }
      for (const name of columns.keys()) {
        if (!(name in spec.columns)) issue('undeclared-column', side, table, name, `${side} column ${table}.${name} is not declared in the manifest`);
      }
    }
    for (const name of Object.keys(spec.columns)) {
      const codec = codecs.column(table, name);
      let bothSidesOk = true;
      for (const side of SIDES) {
        const columns = actual[side];
        if (!columns) continue;
        const found = columns.get(name);
        if (!found) {
          issue('missing-column', side, table, name, `declared column ${table}.${name} does not exist in ${side}`);
          bothSidesOk = false;
          continue;
        }
        if (found.generated && !codec.generated) {
          issue('generated-undeclared', side, table, name, `${side} column ${table}.${name} is generated but not declared \`generated: true\``);
          bothSidesOk = false;
        } else if (!found.generated && codec.generated) {
          issue('generated-mismatch', side, table, name, `${table}.${name} is declared generated but is a plain column in ${side}`);
          bothSidesOk = false;
        }
        if (side === 'postgres' && !codec.pgTypes.includes(found.type)) {
          issue('pg-type-mismatch', side, table, name, `${table}.${name} uses codec ${codec.spec.codec} (expects ${codec.pgTypes.join(' | ')}) but the Postgres column is ${found.type}`);
          bothSidesOk = false;
        }
      }
      if (codec.generated && bothSidesOk) generated.push({ table, column: name });
    }
  }

  return { ok: issues.length === 0, issues, generated, report: renderReport(manifest, issues, generated.length) };
}

function toColumnMap(columns: readonly IntrospectedColumn[] | undefined): Map<string, IntrospectedColumn> | undefined {
  return columns && new Map(columns.map((column) => [column.name, column]));
}

function renderReport(manifest: CodecManifest, issues: readonly ManifestIssue[], generatedCount: number): string {
  const tables = Object.values(manifest.tables);
  const columnCount = tables.reduce((sum, table) => sum + Object.keys(table.columns).length, 0);
  if (issues.length === 0) {
    return `manifest OK: ${tables.length} tables, ${columnCount} columns, ${generatedCount} generated (verified, not copied)`;
  }
  return [`manifest INVALID: ${issues.length} issue${issues.length === 1 ? '' : 's'}`, ...issues.map((i) => `  FAIL [${i.code}] ${i.message}`)].join('\n');
}

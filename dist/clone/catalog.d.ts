import type { PostgresQueryable } from '../codecs/introspect.js';
/** The schema clone copies into. Everything else, `db_kit` included, is outside manifest coverage. */
export declare const TARGET_SCHEMA = "public";
export declare const RECEIPT_SCHEMA = "db_kit";
export declare const RECEIPT_TABLE = "clone_receipt";
/** The receipt table's shape: part 2 creates exactly this, preflight validates exactly this. */
export declare const RECEIPT_COLUMNS: Readonly<Record<string, string>>;
export declare const RECEIPT_PRIMARY_KEY: readonly ["run_id"];
export declare const quoteIdent: (name: string) => string;
export interface TargetIdentityFacts {
    systemIdentifier: string;
    database: string;
    serverAddress: string | null;
    serverPort: number | null;
    inRecovery: boolean;
    serverVersion: string;
    serverVersionNum: number;
}
export interface TableFact {
    name: string;
    oid: number;
    kind: string;
    rowSecurity: boolean;
    isPartition: boolean;
    inherits: boolean;
    hasChildren: boolean;
    isOwner: boolean;
}
export interface ColumnFact {
    table: string;
    column: string;
    notNull: boolean;
}
export interface ForeignKeyFact {
    oid: number;
    name: string;
    tableOid: number;
    tableSchema: string;
    table: string;
    refOid: number;
    refSchema: string;
    refTable: string;
    definition: string;
    /** Catalog fields A1 compares after the constraint is re-created, all as the text Postgres renders. */
    validated: boolean;
    enforced: boolean;
    conkey: string;
    confkey: string;
    conpfeqop: string;
    confdelsetcols: string | null;
    confupdtype: string;
    confdeltype: string;
    confmatchtype: string;
    deferrable: boolean;
    deferred: boolean;
    indexName: string | null;
    hasComment: boolean;
}
export interface SequenceRef {
    sequenceOid: number;
    schema: string;
    name: string;
    start: bigint;
    increment: bigint;
    min: bigint;
    max: bigint;
    cycles: boolean;
    /** 'owner': the sequence is OWNED BY / identity of this column. 'default': this column's DEFAULT calls it. */
    kind: 'owner' | 'default';
    tableOid: number;
    column: string;
}
export interface ReceiptFacts {
    schemaExists: boolean;
    /** Publications that already include, or would automatically adopt, `db_kit.clone_receipt`: FOR ALL TABLES or FOR TABLES IN SCHEMA db_kit. */
    adoptingPublications: string[];
    /** Null when `db_kit.clone_receipt` does not exist. */
    table: null | {
        kind: string;
        isOwner: boolean;
        rowSecurity: boolean;
        hasTrigger: boolean;
        hasRule: boolean;
        published: boolean;
        columns: Record<string, string>;
        primaryKey: string[];
    };
    canCreate: boolean;
}
export interface TargetFacts {
    tables: TableFact[];
    columns: ColumnFact[];
    primaryKeys: Map<string, string[]>;
    triggers: {
        table: string;
        name: string;
    }[];
    rules: {
        table: string;
        name: string;
    }[];
    foreignKeys: ForeignKeyFact[];
    eventTriggers: string[];
    publications: {
        publication: string;
        table: string;
    }[];
    subscriptionCount: number;
    sequenceRefs: SequenceRef[];
    /** Column defaults anywhere in the database that call nextval() without a resolvable sequence dependency (a text or computed argument). */
    dynamicSequenceDefaults: {
        schema: string;
        table: string;
        column: string;
    }[];
    receipt: ReceiptFacts;
    nonEmptyTables: string[];
    archiverFailedRecently: boolean;
    slots: {
        name: string;
        retainedBytes: bigint;
    }[];
}
export declare function readIdentity(client: PostgresQueryable): Promise<TargetIdentityFacts>;
/**
 * Every catalog fact the schema gate needs, read through one session with `search_path = ''`: pg_catalog only,
 * schema-qualified names, no `information_schema`. Pure reads; the caller runs them in a READ ONLY transaction.
 */
export declare function readTargetFacts(client: PostgresQueryable, tableNames: readonly string[], versionNum: number): Promise<TargetFacts>;
/** Every foreign key owned by or pointing at one of `oids`, with the catalog fields A1 compares. */
export declare function readForeignKeys(client: PostgresQueryable, oids: readonly number[], versionNum: number): Promise<ForeignKeyFact[]>;

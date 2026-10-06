/** The schema clone copies into. Everything else, `db_kit` included, is outside manifest coverage. */
export const TARGET_SCHEMA = 'public';
export const RECEIPT_SCHEMA = 'db_kit';
export const RECEIPT_TABLE = 'clone_receipt';
/** The receipt table's shape: part 2 creates exactly this, preflight validates exactly this. */
export const RECEIPT_COLUMNS = {
    run_id: 'uuid',
    started_at: 'timestamp with time zone',
    manifest_sha: 'text',
    per_table: 'jsonb',
};
export const RECEIPT_PRIMARY_KEY = ['run_id'];
export const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;
export async function readIdentity(client) {
    const { rows } = await client.query(`select (select system_identifier::text from pg_catalog.pg_control_system()) as sysid,
            pg_catalog.current_database()::text as db,
            pg_catalog.inet_server_addr()::text as addr,
            pg_catalog.inet_server_port() as port,
            pg_catalog.pg_is_in_recovery() as recovery,
            pg_catalog.current_setting('server_version') as version,
            pg_catalog.current_setting('server_version_num')::int as vnum`);
    const row = rows[0];
    if (!row)
        throw new Error('identity query returned no row');
    return {
        systemIdentifier: row.sysid,
        database: row.db,
        serverAddress: row.addr,
        serverPort: row.port,
        inRecovery: row.recovery,
        serverVersion: row.version,
        serverVersionNum: row.vnum,
    };
}
/**
 * Every catalog fact the schema gate needs, read through one session with `search_path = ''`: pg_catalog only,
 * schema-qualified names, no `information_schema`. Pure reads; the caller runs them in a READ ONLY transaction.
 */
export async function readTargetFacts(client, tableNames, versionNum) {
    const q = async (text, values = []) => (await client.query(text, values)).rows;
    const oidOf = new Map();
    const tables = (await q(`select c.oid::int as oid, c.relname::text as name, c.relkind::text as kind, c.relrowsecurity as rls, c.relispartition as is_partition,
              exists (select 1 from pg_catalog.pg_inherits i where i.inhrelid = c.oid) as inherits,
              exists (select 1 from pg_catalog.pg_inherits i where i.inhparent = c.oid) as has_children,
              pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') as is_owner
         from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relname = any($2::text[]) order by c.relname`, [TARGET_SCHEMA, [...tableNames]])).map((row) => ({
        name: row.name,
        oid: row.oid,
        kind: row.kind,
        rowSecurity: row.rls,
        isPartition: row.is_partition,
        inherits: row.inherits,
        hasChildren: row.has_children,
        isOwner: row.is_owner,
    }));
    for (const table of tables)
        oidOf.set(table.oid, table.name);
    const oids = tables.map((table) => table.oid);
    const nameOf = (oid) => oidOf.get(oid) ?? '';
    const columns = (await q(`select a.attrelid::int as table_oid, a.attname::text as column, a.attnotnull as not_null
         from pg_catalog.pg_attribute a where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped order by a.attrelid, a.attnum`, [oids])).map((row) => ({ table: nameOf(row.table_oid), column: row.column, notNull: row.not_null }));
    const primaryKeys = new Map();
    for (const row of await q(`select k.conrelid::int as table_oid,
            array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
                    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord) as cols
       from pg_catalog.pg_constraint k where k.contype = 'p' and k.conrelid = any($1::oid[])`, [oids])) {
        primaryKeys.set(nameOf(row.table_oid), row.cols);
    }
    const triggers = (await q(`select t.tgrelid::int as table_oid, t.tgname::text as name from pg_catalog.pg_trigger t where t.tgrelid = any($1::oid[]) and not t.tgisinternal order by 1, 2`, [oids])).map((row) => ({ table: nameOf(row.table_oid), name: row.name }));
    const rules = (await q(`select r.ev_class::int as table_oid, r.rulename::text as name from pg_catalog.pg_rewrite r where r.ev_class = any($1::oid[]) order by 1, 2`, [oids])).map((row) => ({ table: nameOf(row.table_oid), name: row.name }));
    const foreignKeys = await readForeignKeys(client, oids, versionNum);
    const eventTriggers = (await q('select evtname::text as name from pg_catalog.pg_event_trigger order by 1')).map((row) => row.name);
    const publications = (await q(`select pubname::text as publication, tablename::text as table from pg_catalog.pg_publication_tables
        where schemaname = $1 and tablename = any($2::text[]) order by 1, 2`, [TARGET_SCHEMA, [...tableNames]]));
    const [{ n: subscriptions } = { n: '0' }] = await q(`select count(*)::text as n from pg_catalog.pg_subscription s
      where s.subdbid = (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database())`);
    const sequenceRefs = (await q(`with refs as (
         select d.objid as seq, d.refobjid as rel, d.refobjsubid as att, 'owner' as kind
           from pg_catalog.pg_depend d
          where d.classid = 'pg_catalog.pg_class'::regclass and d.refclassid = 'pg_catalog.pg_class'::regclass and d.deptype in ('a', 'i') and d.refobjsubid > 0
         union
         select dep.refobjid, ad.adrelid, ad.adnum, 'default'
           from pg_catalog.pg_attrdef ad
           join pg_catalog.pg_depend dep on dep.classid = 'pg_catalog.pg_attrdef'::regclass and dep.objid = ad.oid
                and dep.refclassid = 'pg_catalog.pg_class'::regclass and dep.deptype = 'n'
       )
       select s.oid::int as sequence_oid, sn.nspname::text as schema, s.relname::text as name,
              q.seqstart::text as start, q.seqincrement::text as increment, q.seqmin::text as min, q.seqmax::text as max, q.seqcycle as cycles,
              r.kind, r.rel::int as table_oid, a.attname::text as column
         from refs r
         join pg_catalog.pg_class s on s.oid = r.seq and s.relkind = 'S'
         join pg_catalog.pg_namespace sn on sn.oid = s.relnamespace
         join pg_catalog.pg_sequence q on q.seqrelid = s.oid
         join pg_catalog.pg_attribute a on a.attrelid = r.rel and a.attnum = r.att
        where r.seq in (select seq from refs where rel = any($1::oid[]))
        order by sn.nspname, s.relname, r.kind, r.rel, a.attname`, [oids])).map((row) => ({
        sequenceOid: row.sequence_oid,
        schema: row.schema,
        name: row.name,
        start: BigInt(row.start),
        increment: BigInt(row.increment),
        min: BigInt(row.min),
        max: BigInt(row.max),
        cycles: row.cycles,
        kind: row.kind,
        tableOid: row.table_oid,
        column: row.column,
    }));
    const dynamicSequenceDefaults = await q(`select n.nspname::text as schema, c.relname::text as table, a.attname::text as column
       from pg_catalog.pg_attrdef ad
       join pg_catalog.pg_class c on c.oid = ad.adrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
      where position('nextval(' in pg_catalog.lower(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid))) > 0
        and not exists (select 1 from pg_catalog.pg_depend dep
                         where dep.classid = 'pg_catalog.pg_attrdef'::regclass and dep.objid = ad.oid
                           and dep.refclassid = 'pg_catalog.pg_class'::regclass and dep.deptype = 'n')
        and n.nspname not in ('pg_catalog', 'information_schema')
      order by 1, 2, 3`);
    const receipt = await readReceipt(q, versionNum);
    const nonEmptyTables = [];
    for (const table of tables) {
        const [{ non_empty: nonEmpty } = { non_empty: false }] = await q(`select exists (select 1 from ${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(table.name)}) as non_empty`);
        if (nonEmpty)
            nonEmptyTables.push(table.name);
    }
    const [{ failing } = { failing: false }] = await q(`select coalesce(last_failed_time > pg_catalog.now() - interval '15 minutes', false) as failing from pg_catalog.pg_stat_archiver`);
    const slots = (await q(`select slot_name::text as name, pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), restart_lsn)::bigint::text as retained
         from pg_catalog.pg_replication_slots where restart_lsn is not null order by 1`)).map((row) => ({ name: row.name, retainedBytes: BigInt(row.retained) }));
    return {
        tables,
        columns,
        primaryKeys,
        triggers,
        rules,
        foreignKeys,
        eventTriggers,
        publications,
        subscriptionCount: Number(subscriptions),
        sequenceRefs,
        dynamicSequenceDefaults,
        receipt,
        nonEmptyTables,
        archiverFailedRecently: failing,
        slots,
    };
}
/** Every foreign key owned by or pointing at one of `oids`, with the catalog fields A1 compares. */
export async function readForeignKeys(client, oids, versionNum) {
    const q = async (text, values = []) => (await client.query(text, values)).rows;
    return (await q(`select c.oid::int as oid, c.conname::text as name,
              c.conrelid::int as table_oid, tn.nspname::text as table_schema, t.relname::text as table_name,
              c.confrelid::int as ref_oid, rn.nspname::text as ref_schema, r.relname::text as ref_table,
              pg_catalog.pg_get_constraintdef(c.oid) as definition,
              c.convalidated as validated, ${versionNum >= 180000 ? 'c.conenforced' : 'true'} as enforced,
              c.conkey::text as conkey, c.confkey::text as confkey, c.conpfeqop::text as conpfeqop,
              ${versionNum >= 150000 ? 'c.confdelsetcols::text' : 'null::text'} as confdelsetcols,
              c.confupdtype::text as confupdtype, c.confdeltype::text as confdeltype, c.confmatchtype::text as confmatchtype,
              c.condeferrable as deferrable, c.condeferred as deferred,
              (select i.relname::text from pg_catalog.pg_class i where i.oid = c.conindid) as index_name,
              pg_catalog.obj_description(c.oid, 'pg_constraint') is not null as has_comment
         from pg_catalog.pg_constraint c
         join pg_catalog.pg_class t on t.oid = c.conrelid join pg_catalog.pg_namespace tn on tn.oid = t.relnamespace
         join pg_catalog.pg_class r on r.oid = c.confrelid join pg_catalog.pg_namespace rn on rn.oid = r.relnamespace
        where c.contype = 'f' and (c.conrelid = any($1::oid[]) or c.confrelid = any($1::oid[]))
        order by tn.nspname, t.relname, c.conname`, [[...oids]])).map((row) => ({
        oid: row.oid,
        name: row.name,
        tableOid: row.table_oid,
        tableSchema: row.table_schema,
        table: row.table_name,
        refOid: row.ref_oid,
        refSchema: row.ref_schema,
        refTable: row.ref_table,
        definition: row.definition,
        validated: row.validated,
        enforced: row.enforced,
        conkey: row.conkey,
        confkey: row.confkey,
        conpfeqop: row.conpfeqop,
        confdelsetcols: row.confdelsetcols,
        confupdtype: row.confupdtype,
        confdeltype: row.confdeltype,
        confmatchtype: row.confmatchtype,
        deferrable: row.deferrable,
        deferred: row.deferred,
        indexName: row.index_name,
        hasComment: row.has_comment,
    }));
}
async function readReceipt(q, versionNum) {
    const adopting = (await q(`select p.pubname::text as name from pg_catalog.pg_publication p
        where p.puballtables${versionNum >= 150000
        ? ` or exists (select 1 from pg_catalog.pg_publication_namespace pn join pg_catalog.pg_namespace n on n.oid = pn.pnnspid where pn.pnpubid = p.oid and n.nspname = $1::text)`
        : ''} order by 1`, versionNum >= 150000 ? [RECEIPT_SCHEMA] : [])).map((row) => row.name);
    const [schema] = await q(`select exists (select 1 from pg_catalog.pg_namespace where nspname = $1::text) as exists,
            case when exists (select 1 from pg_catalog.pg_namespace where nspname = $1::text)
                 then pg_catalog.has_schema_privilege($1::text, 'CREATE')
                 else pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') end as can_create`, [RECEIPT_SCHEMA]);
    const [table] = await q(`select c.relkind::text as kind, pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') as is_owner, c.relrowsecurity as rls,
            exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as has_trigger,
            exists (select 1 from pg_catalog.pg_rewrite r where r.ev_class = c.oid) as has_rule,
            exists (select 1 from pg_catalog.pg_publication_tables p where p.schemaname = $1::text and p.tablename = $2::text) as published,
            (select coalesce(jsonb_object_agg(a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)), '{}'::jsonb)
               from pg_catalog.pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)::text as columns,
            array(select a.attname::text from pg_catalog.pg_constraint k
                    cross join lateral unnest(k.conkey) with ordinality u(attnum, ord)
                    join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum
                   where k.conrelid = c.oid and k.contype = 'p' order by u.ord) as pk
       from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1::text and c.relname = $2::text`, [RECEIPT_SCHEMA, RECEIPT_TABLE]);
    return {
        schemaExists: schema?.exists ?? false,
        adoptingPublications: adopting,
        canCreate: schema?.can_create ?? false,
        table: table
            ? { kind: table.kind, isOwner: table.is_owner, rowSecurity: table.rls, hasTrigger: table.has_trigger, hasRule: table.has_rule, published: table.published, columns: JSON.parse(table.columns), primaryKey: table.pk }
            : null,
    };
}

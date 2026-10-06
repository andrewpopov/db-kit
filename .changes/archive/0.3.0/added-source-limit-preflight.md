---
kind: added
summary: clone refuses varchar overflow, integer width and orphan foreign keys in the plan, before any load
---

`planClone` (so `--plan-only`) and the authoritative re-check under the locks now scan the snapshot for three things that used to fail mid-COPY or at the final `ADD CONSTRAINT`. `varchar-overflow`: a value longer in characters than the target's `character varying(n)` or `character(n)`. `integer-width`: an `integer` / `bigint` codec value outside the target `smallint` / `integer` / `bigint` range. `orphan-foreign-keys`: a child row whose non-NULL key columns match no parent row for a target foreign key between copied tables (MATCH SIMPLE). Each names the table, column or constraint plus counts and bounds, never a value. `IntrospectedColumn` gains an optional `maxLength` and `ForeignKeyFact` gains `columns` / `refColumns`.

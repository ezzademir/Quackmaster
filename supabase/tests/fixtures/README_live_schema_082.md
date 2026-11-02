`live_schema_082.sql` / `live_columns_082.json`: read-only dump of the live column definitions (fknrfntqycfrkaihwngg, after 081), produced with:

```sql
select cl.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
from pg_class cl join pg_attribute a on a.attrelid = cl.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = cl.oid and d.adnum = a.attnum
where cl.relnamespace = 'public'::regnamespace and cl.relkind = 'r' and cl.relname = any(:tables);
```
plus `pg_get_viewdef('public.recipe_variance_by_run')`. Used by `quantityPrecisionMigration.test.ts` so tests run on the real column types.

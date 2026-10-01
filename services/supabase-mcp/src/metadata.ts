// ABOUTME: Получает метаданные PostgreSQL, используя локально адаптированный SQL Supabase.
// ABOUTME: Облачный API отсутствует; источники и изменения указаны в NOTICE.
/** SQL доступных и установленных расширений без облачного API. */
export const extensionSql = `SELECT e.name,n.nspname AS schema,e.default_version,x.extversion AS installed_version,e.comment
FROM pg_available_extensions() e(name,default_version,comment)
LEFT JOIN pg_extension x ON e.name=x.extname LEFT JOIN pg_namespace n ON x.extnamespace=n.oid ORDER BY e.name COLLATE "C"`;
/** Общий параметризованный отбор схем: includeSystem и необязательный schemas. */
export const schemaWhere = `($1::boolean OR (n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'))
AND ($2::text[] IS NULL OR n.nspname=ANY($2))`;
/** SQL накопительного раскрытия таблиц, столбцов, ключей и связей. */
export const tableSql = `SELECT c.oid::int8 AS id,n.nspname AS schema,c.relname AS name,c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced,
CASE WHEN $3::int >= 1 THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
'name',a.attname,'ordinal_position',a.attnum,'data_type',format_type(a.atttypid,a.atttypmod),
'is_nullable',NOT(a.attnotnull OR t.typtype='d' AND t.typnotnull),
'default_value',CASE WHEN a.atthasdef THEN pg_get_expr(ad.adbin,ad.adrelid) ELSE NULL END,
'is_identity',a.attidentity IN ('a','d'),'is_generated',a.attgenerated IN ('s')) ORDER BY a.attnum)
FROM pg_attribute a JOIN pg_type t ON a.atttypid=t.oid LEFT JOIN pg_attrdef ad ON a.attrelid=ad.adrelid AND a.attnum=ad.adnum
WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) ELSE NULL END AS columns,
CASE WHEN $3::int >= 2 THEN COALESCE((SELECT jsonb_agg(a.attname ORDER BY k.ord)
FROM pg_index i JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ord) ON true
JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
WHERE i.indrelid=c.oid AND i.indisprimary AND k.ord<=i.indnkeyatts),'[]'::jsonb) ELSE NULL END AS primary_keys,
CASE WHEN $3::int >= 3 THEN COALESCE((SELECT jsonb_agg(r) FROM (
SELECT fk.conname AS constraint_name,nsa.nspname AS source_schema,csa.relname AS source_table_name,
array_agg(sa.attname ORDER BY cols.ord) AS source_columns,nta.nspname AS target_table_schema,cta.relname AS target_table_name,
array_agg(ta.attname ORDER BY cols.ord) AS target_columns
FROM pg_constraint fk JOIN LATERAL unnest(fk.conkey,fk.confkey) WITH ORDINALITY cols(conkey,confkey,ord) ON true
JOIN pg_class csa ON csa.oid=fk.conrelid JOIN pg_namespace nsa ON nsa.oid=csa.relnamespace
JOIN pg_attribute sa ON sa.attrelid=fk.conrelid AND sa.attnum=cols.conkey
JOIN pg_class cta ON cta.oid=fk.confrelid JOIN pg_namespace nta ON nta.oid=cta.relnamespace
JOIN pg_attribute ta ON ta.attrelid=fk.confrelid AND ta.attnum=cols.confkey
WHERE fk.contype='f' AND (fk.conrelid=c.oid OR fk.confrelid=c.oid)
GROUP BY fk.oid,fk.conname,nsa.nspname,csa.relname,nta.nspname,cta.relname) r),'[]'::jsonb) ELSE NULL END AS relationships
FROM pg_namespace n JOIN pg_class c ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND NOT pg_is_other_temp_schema(n.oid) AND ${schemaWhere}
AND (pg_has_role(c.relowner,'USAGE') OR has_table_privilege(c.oid,'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR has_any_column_privilege(c.oid,'SELECT, INSERT, UPDATE, REFERENCES'))
ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`;

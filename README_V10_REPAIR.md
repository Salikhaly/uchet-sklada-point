# V10 — Point repair release

This release consolidates the live fixes found during the production audit.

## Supabase migration
Apply:
`supabase/migrations/202609020001_point_repair_v10.sql`

It fixes:
- Point employee/product RPCs;
- price history for Point product changes;
- read-only evening-summary reads;
- cash reconciliation including `[SALE]` cash sales;
- expense audit with old_data;
- correct Point journal ordering before LIMIT 500;
- operation idempotency DB constraint;
- canonical `point_transfer_to_angar(uuid,numeric,text,uuid)`;
- linked Point→Angar deletion through `delete_operation`.

## Current Git project cleanup
The current deployed repository may still contain an old local PostgreSQL route:
`app/api/app-mode/route.ts`
and
`lib/local/point-schema.ts`.

They are not present in the v10 archive. If they are unused in the current Git project, remove them before production deploy. The v10 package keeps `pg` in package.json so the build cannot fail merely because the legacy route is still present.

## Verification
After the migration:
1. `npm install`
2. `npm run build`
3. `git add .`
4. `git commit -m "fix: point v10 production audit"`
5. `git push`

In Supabase verify:
- `profile_ok: true`
- Point products/employees RPCs exist
- `point_transfer_to_angar` has only the canonical 4-arg version
- `delete_operation(uuid)` exists

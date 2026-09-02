# V10 production audit fixes — exact deployment order

## 1. Supabase first
Open Supabase SQL Editor and run:

`supabase/migrations/202609020001_point_repair_v10.sql`

Do not rerun older Point migrations manually. This is a repair/canonicalization migration for the live schema.

## 2. Verify RPC signatures
Run:

```sql
select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in (
    'point_upsert_product',
    'point_upsert_employee',
    'point_post_operation',
    'point_get_evening_summary',
    'point_save_evening_summary',
    'point_add_evening_expense',
    'point_remove_evening_expense',
    'point_transfer_to_angar',
    'delete_operation'
  )
order by p.proname, 2;
```

There should be only the intended Point transfer signature:
`point_transfer_to_angar(p_product_id uuid, p_quantity_kg numeric, p_note text, p_idempotency_key uuid)`.

## 3. Current Git project
Because some older commits contained a local PostgreSQL-only route, run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\remove-legacy-local-pg.ps1
npm install
npm run build
```

The cleanup script refuses to delete the legacy files if other source files still reference them.

## 4. Git

```powershell
git add .
git commit -m "fix: point v10 production audit"
git push
```

## 5. Vercel
Vercel should then build from the new commit. Keep:
- `SUPABASE_WORKSPACE_ID=8c165ae4-759a-4e26-b734-a8762a07d7d3`
- `SUPABASE_SECRET_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_SITE_URL`

`pg` is pinned in package.json as a safety net for any remaining legacy route.

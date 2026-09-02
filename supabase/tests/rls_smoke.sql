-- Run with supabase db test after migrations. Verify anonymous users cannot read business tables.
select count(*) from public.products;

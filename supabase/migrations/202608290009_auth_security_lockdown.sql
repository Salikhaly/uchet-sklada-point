-- Restore authenticated-only access for the warehouse.
-- The no-login migration previously added anon read policies and workspace fallbacks.
-- This migration removes those paths so database access requires a real Supabase Auth session.

create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select workspace_id from public.profiles where id=auth.uid();
$$;

create or replace function public.current_user_role()
returns public.member_role
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select role from public.profiles where id=auth.uid();
$$;

drop policy if exists anon_workspace_select on public.workspaces;
drop policy if exists anon_products_select on public.products;
drop policy if exists anon_price_history_select on public.price_history;
drop policy if exists anon_groups_select on public.contractor_groups;
drop policy if exists anon_contractors_select on public.contractors;
drop policy if exists anon_operations_select on public.operations;
drop policy if exists anon_operation_items_select on public.operation_items;
drop policy if exists anon_inventory_select on public.inventory_balances;
drop policy if exists anon_audit_select on public.audit_log;

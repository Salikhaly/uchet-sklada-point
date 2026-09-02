-- Internal no-login mode for the single warehouse workspace.
-- The app intentionally runs with Supabase's anon role and uses the first workspace
-- named "Метал" (or the oldest workspace as a fallback). Manager checks fall back
-- to admin for anonymous/internal mode. RLS remains enabled; access is constrained
-- to the selected workspace only.

create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select coalesce(
    (select workspace_id from public.profiles where id=auth.uid()),
    (select id from public.workspaces where name='Метал' order by created_at asc limit 1),
    (select id from public.workspaces order by created_at asc limit 1)
  );
$$;

create or replace function public.current_user_role()
returns public.member_role
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select coalesce(
    (select role from public.profiles where id=auth.uid()),
    'admin'::public.member_role
  );
$$;

-- Explicit anon read access only to the active workspace.
do $$
begin
  execute 'drop policy if exists anon_workspace_select on public.workspaces';
  execute 'create policy anon_workspace_select on public.workspaces for select to anon using(id=public.current_workspace_id())';
  execute 'drop policy if exists anon_products_select on public.products';
  execute 'create policy anon_products_select on public.products for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_price_history_select on public.price_history';
  execute 'create policy anon_price_history_select on public.price_history for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_groups_select on public.contractor_groups';
  execute 'create policy anon_groups_select on public.contractor_groups for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_contractors_select on public.contractors';
  execute 'create policy anon_contractors_select on public.contractors for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_operations_select on public.operations';
  execute 'create policy anon_operations_select on public.operations for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_operation_items_select on public.operation_items';
  execute 'create policy anon_operation_items_select on public.operation_items for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_inventory_select on public.inventory_balances';
  execute 'create policy anon_inventory_select on public.inventory_balances for select to anon using(workspace_id=public.current_workspace_id())';
  execute 'drop policy if exists anon_audit_select on public.audit_log';
  execute 'create policy anon_audit_select on public.audit_log for select to anon using(workspace_id=public.current_workspace_id())';
end $$;

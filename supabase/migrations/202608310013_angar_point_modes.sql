begin;

alter table public.profiles
  add column if not exists point_workspace_id uuid references public.workspaces(id) on delete set null,
  add column if not exists active_mode text not null default 'ANGAR';

alter table public.profiles
  drop constraint if exists profiles_active_mode_check;
alter table public.profiles
  add constraint profiles_active_mode_check check (active_mode in ('ANGAR','POINT'));

-- current_workspace_id is intentionally the single switch used by the existing
-- Angar RPCs. In ANGAR it stays exactly as before; in POINT all existing
-- workspace-scoped operations run against the isolated point workspace.
create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select case
    when p.active_mode='POINT' then p.point_workspace_id
    else p.workspace_id
  end
  from public.profiles p
  where p.id=auth.uid();
$$;

-- The profile itself belongs to the Angar workspace, so profile visibility
-- must not disappear while POINT mode is active.
drop policy if exists profile_select on public.profiles;
create policy profile_select on public.profiles
  for select to authenticated
  using (id=auth.uid());

create or replace function public.switch_app_mode(p_mode text)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_point_ws uuid;
  v_angar_name text;
  r record;
  v_gid uuid;
begin
  if v_uid is null then raise exception 'Пользователь не авторизован'; end if;
  if upper(coalesce(p_mode,'')) not in ('ANGAR','POINT') then raise exception 'Неизвестный режим'; end if;

  select * into v_profile from public.profiles where id=v_uid for update;
  if not found then raise exception 'Профиль пользователя не найден'; end if;

  if upper(p_mode)='ANGAR' then
    update public.profiles set active_mode='ANGAR' where id=v_uid;
    return jsonb_build_object('mode','ANGAR','workspace_id',v_profile.workspace_id);
  end if;

  v_point_ws:=v_profile.point_workspace_id;
  if v_point_ws is null then
    select name into v_angar_name from public.workspaces where id=v_profile.workspace_id;
    insert into public.workspaces(name)
      values(coalesce(v_angar_name,'Ангар')||' · Точка')
      returning id into v_point_ws;

    -- Clone the catalog once. The point gets its own products and contractors,
    -- while names/prices start equal to the Angar catalog.
    insert into public.products(workspace_id,name,default_price,status,legacy_product_id)
      select v_point_ws,name,default_price,status,legacy_product_id
      from public.products
      where workspace_id=v_profile.workspace_id;

    for r in select id,name,created_at from public.contractor_groups where workspace_id=v_profile.workspace_id order by created_at loop
      insert into public.contractor_groups(workspace_id,name)
      values(v_point_ws,r.name)
      on conflict(workspace_id,lower(name)) do update set name=excluded.name
      returning id into v_gid;
    end loop;

    for r in select c.name,g.name as group_name from public.contractors c left join public.contractor_groups g on g.id=c.group_id where c.workspace_id=v_profile.workspace_id order by c.created_at loop
      select id into v_gid from public.contractor_groups where workspace_id=v_point_ws and lower(name)=lower(coalesce(r.group_name,'')) limit 1;
      insert into public.contractors(workspace_id,name,group_id)
      values(v_point_ws,r.name,case when coalesce(r.group_name,'')<>'' then v_gid else null end)
      on conflict(workspace_id,lower(name)) do update set group_id=excluded.group_id;
    end loop;

    update public.profiles
      set point_workspace_id=v_point_ws, active_mode='POINT'
      where id=v_uid;
  else
    update public.profiles
      set active_mode='POINT'
      where id=v_uid;
  end if;

  return jsonb_build_object('mode','POINT','workspace_id',v_point_ws);
end;
$$;

grant execute on function public.switch_app_mode(text) to authenticated;

commit;

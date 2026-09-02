begin;

alter table public.profiles
  add column if not exists point_workspace_id uuid references public.workspaces(id) on delete set null,
  add column if not exists active_mode text not null default 'ANGAR';

drop constraint if exists profiles_active_mode_check;
alter table public.profiles
  add constraint profiles_active_mode_check check (active_mode in ('ANGAR','POINT'));

create or replace function public.current_workspace_id()
returns uuid
language sql
stable
security definer
set search_path=public,pg_catalog
as $$
  select case
    when coalesce(p.active_mode,'ANGAR')='POINT' then p.point_workspace_id
    else p.workspace_id
  end
  from public.profiles p
  where p.id=auth.uid();
$$;

grant execute on function public.current_workspace_id() to authenticated;

drop policy if exists profile_select on public.profiles;
create policy profile_select on public.profiles
  for select to authenticated
  using (id=auth.uid());

commit;

import type { SupabaseClient, User } from '@supabase/supabase-js';

type Profile = {
  id: string;
  workspace_id: string | null;
  point_workspace_id: string | null;
  role: string | null;
  display_name: string | null;
};

function configuredAngarWorkspaceId(): string {
  return String(process.env.SUPABASE_WORKSPACE_ID || '').trim();
}

// Сверяет каталог Точки с Ангаром пакетно: две выборки списком + один insert
// недостающих строк, вместо запроса на каждый товар/контрагента по отдельности.
// Идемпотентно: при повторном вызове ничего лишнего не создаёт.
async function ensurePointProducts(admin: SupabaseClient, angarWorkspaceId: string, pointWorkspaceId: string) {
  const [angarRes, pointRes] = await Promise.all([
    admin.from('products').select('name,default_price,status,sort_order').eq('workspace_id', angarWorkspaceId),
    admin.from('products').select('name').eq('workspace_id', pointWorkspaceId),
  ]);
  if (angarRes.error) throw angarRes.error;
  if (pointRes.error) throw pointRes.error;

  const existing = new Set((pointRes.data || []).map((p) => p.name.toLowerCase()));
  const missing = (angarRes.data || [])
    .filter((p) => !existing.has(p.name.toLowerCase()))
    .map((p) => ({
      workspace_id: pointWorkspaceId,
      name: p.name,
      default_price: p.default_price,
      status: p.status,
      sort_order: p.sort_order ?? 0,
    }));
  if (missing.length) {
    const { error } = await admin.from('products').insert(missing);
    if (error) throw error;
  }
}

async function ensurePointContractors(admin: SupabaseClient, angarWorkspaceId: string, pointWorkspaceId: string) {
  const [angarGroupsRes, pointGroupsRes] = await Promise.all([
    admin.from('contractor_groups').select('id,name').eq('workspace_id', angarWorkspaceId),
    admin.from('contractor_groups').select('id,name').eq('workspace_id', pointWorkspaceId),
  ]);
  if (angarGroupsRes.error) throw angarGroupsRes.error;
  if (pointGroupsRes.error) throw pointGroupsRes.error;

  const pointGroupIdByName = new Map<string, string>((pointGroupsRes.data || []).map((g) => [g.name.toLowerCase(), g.id]));
  const missingGroups = (angarGroupsRes.data || []).filter((g) => !pointGroupIdByName.has(g.name.toLowerCase()));
  if (missingGroups.length) {
    const { data: created, error } = await admin
      .from('contractor_groups')
      .insert(missingGroups.map((g) => ({ workspace_id: pointWorkspaceId, name: g.name })))
      .select('id,name');
    if (error) throw error;
    for (const c of created || []) pointGroupIdByName.set(c.name.toLowerCase(), c.id);
  }
  const angarGroupNameById = new Map<string, string>((angarGroupsRes.data || []).map((g) => [g.id, g.name]));

  const [angarContractorsRes, pointContractorsRes] = await Promise.all([
    admin.from('contractors').select('name,group_id').eq('workspace_id', angarWorkspaceId),
    admin.from('contractors').select('name').eq('workspace_id', pointWorkspaceId),
  ]);
  if (angarContractorsRes.error) throw angarContractorsRes.error;
  if (pointContractorsRes.error) throw pointContractorsRes.error;

  const existingNames = new Set((pointContractorsRes.data || []).map((c) => c.name.toLowerCase()));
  const missingContractors = (angarContractorsRes.data || [])
    .filter((c) => !existingNames.has(c.name.toLowerCase()))
    .map((c) => {
      const angarGroupName = c.group_id ? angarGroupNameById.get(c.group_id) : null;
      const pointGroupId = angarGroupName ? pointGroupIdByName.get(angarGroupName.toLowerCase()) || null : null;
      return { workspace_id: pointWorkspaceId, name: c.name, group_id: pointGroupId };
    });
  if (missingContractors.length) {
    const { error } = await admin.from('contractors').insert(missingContractors);
    if (error) throw error;
  }
}

async function ensureRetailContractors(admin: SupabaseClient, pointWorkspaceId: string) {
  const names = ['Розничный покупатель', 'Население'];
  const { data: existing, error } = await admin.from('contractors').select('name').eq('workspace_id', pointWorkspaceId);
  if (error) throw error;
  const have = new Set((existing || []).map((c) => c.name.toLowerCase()));
  const missing = names.filter((n) => !have.has(n.toLowerCase())).map((n) => ({ workspace_id: pointWorkspaceId, name: n }));
  if (missing.length) {
    const { error: insertError } = await admin.from('contractors').insert(missing);
    if (insertError) throw insertError;
  }
}

export async function ensureProfileAccess(admin: SupabaseClient, user: User): Promise<Profile> {
  const { data: existing, error: profileError } = await admin
    .from('profiles')
    .select('id,workspace_id,point_workspace_id,role,display_name')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) throw profileError;

  let workspaceId = existing?.workspace_id || null;
  let pointWorkspaceId = existing?.point_workspace_id || null;

  if (!workspaceId) {
    const configured = configuredAngarWorkspaceId();
    if (!configured) throw new Error('Для первого входа не задан SUPABASE_WORKSPACE_ID');
    const { data: workspace, error } = await admin.from('workspaces').select('id').eq('id', configured).maybeSingle();
    if (error) throw error;
    if (!workspace) throw new Error('SUPABASE_WORKSPACE_ID указывает на несуществующий склад');
    workspaceId = workspace.id;
  }

  if (!pointWorkspaceId) {
    const { data: pointWorkspace, error } = await admin.from('workspaces').insert({ name: `Точка ${user.email || user.id}` }).select('id').single();
    if (error) throw error;
    pointWorkspaceId = pointWorkspace.id;
  }

  const profilePatch = {
    id: user.id,
    workspace_id: workspaceId,
    point_workspace_id: pointWorkspaceId,
    role: existing?.role || 'admin',
    display_name: existing?.display_name || user.user_metadata?.display_name || user.email || user.id,
  };
  const { data: saved, error: saveError } = await admin
    .from('profiles')
    .upsert(profilePatch, { onConflict: 'id' })
    .select('id,workspace_id,point_workspace_id,role,display_name')
    .single();
  if (saveError) throw saveError;

  // Сверяем справочники Точки с Ангаром пакетно (см. функции выше) — дозаполняет
  // недостающие товары/контрагентов, если Точка новая или что-то удалили вручную.
  await Promise.all([
    ensurePointProducts(admin, workspaceId, pointWorkspaceId),
    ensurePointContractors(admin, workspaceId, pointWorkspaceId),
  ]);
  await ensureRetailContractors(admin, pointWorkspaceId);

  return saved;
}

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

async function ensurePointProducts(admin: SupabaseClient, angarWorkspaceId: string, pointWorkspaceId: string) {
  const { data, error } = await admin
    .from('products')
    .select('name,default_price,status,sort_order')
    .eq('workspace_id', angarWorkspaceId);
  if (error) throw error;

  for (const product of data || []) {
    const { data: existing, error: lookupError } = await admin
      .from('products')
      .select('id')
      .eq('workspace_id', pointWorkspaceId)
      .ilike('name', product.name)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      const { error: insertError } = await admin.from('products').insert({
        workspace_id: pointWorkspaceId,
        name: product.name,
        default_price: product.default_price,
        status: product.status,
        sort_order: product.sort_order ?? 0,
      });
      if (insertError) throw insertError;
    }
  }
}

async function ensurePointContractors(admin: SupabaseClient, angarWorkspaceId: string, pointWorkspaceId: string) {
  const { data: groups, error: groupsError } = await admin
    .from('contractor_groups')
    .select('name')
    .eq('workspace_id', angarWorkspaceId);
  if (groupsError) throw groupsError;

  const groupIdByName = new Map<string, string>();
  for (const group of groups || []) {
    const { data: existing, error: lookupError } = await admin
      .from('contractor_groups')
      .select('id')
      .eq('workspace_id', pointWorkspaceId)
      .ilike('name', group.name)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      groupIdByName.set(group.name.toLowerCase(), existing.id);
    } else {
      const { data: created, error: insertError } = await admin
        .from('contractor_groups')
        .insert({ workspace_id: pointWorkspaceId, name: group.name })
        .select('id')
        .single();
      if (insertError) throw insertError;
      groupIdByName.set(group.name.toLowerCase(), created.id);
    }
  }

  const { data: contractors, error: contractorsError } = await admin
    .from('contractors')
    .select('name,group_id')
    .eq('workspace_id', angarWorkspaceId);
  if (contractorsError) throw contractorsError;

  for (const contractor of contractors || []) {
    let pointGroupId: string | null = null;
    if (contractor.group_id) {
      const { data: angarGroup, error: groupError } = await admin
        .from('contractor_groups')
        .select('name')
        .eq('id', contractor.group_id)
        .maybeSingle();
      if (groupError) throw groupError;
      pointGroupId = angarGroup ? groupIdByName.get(angarGroup.name.toLowerCase()) || null : null;
    }

    const { data: existing, error: lookupError } = await admin
      .from('contractors')
      .select('id')
      .eq('workspace_id', pointWorkspaceId)
      .ilike('name', contractor.name)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      const { error: insertError } = await admin.from('contractors').insert({
        workspace_id: pointWorkspaceId,
        name: contractor.name,
        group_id: pointGroupId,
      });
      if (insertError) throw insertError;
    }
  }
}

async function ensureRetailContractors(admin: SupabaseClient, pointWorkspaceId: string) {
  for (const name of ['Розничный покупатель', 'Население']) {
    const { data: existing, error: lookupError } = await admin
      .from('contractors')
      .select('id')
      .eq('workspace_id', pointWorkspaceId)
      .ilike('name', name)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      const { error: insertError } = await admin.from('contractors').insert({ workspace_id: pointWorkspaceId, name });
      if (insertError) throw insertError;
    }
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

  let createdPoint = false;
  if (!pointWorkspaceId) {
    const { data: pointWorkspace, error } = await admin.from('workspaces').insert({ name: `Точка ${user.email || user.id}` }).select('id').single();
    if (error) throw error;
    pointWorkspaceId = pointWorkspace.id;
    createdPoint = true;
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

  // Always sync Point dictionaries so an existing-but-empty Point is repaired too.
  // The operation is idempotent: only missing products/contractors are inserted.
  await ensurePointProducts(admin, workspaceId, pointWorkspaceId);
  await ensurePointContractors(admin, workspaceId, pointWorkspaceId);
  await ensureRetailContractors(admin, pointWorkspaceId);

  return saved;
}

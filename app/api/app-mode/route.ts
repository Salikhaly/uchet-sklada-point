import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ensureLocalPointSchema } from '@/lib/local/point-schema';

type Mode = 'ANGAR' | 'POINT';

export async function POST(req: Request) {
  try { await ensureLocalPointSchema(); } catch (e) {
    return NextResponse.json({ error: `Локальная БД не подготовлена: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
  // Local build endpoint: intentionally independent of switch_app_mode RPC.
  const body = await req.json().catch(() => ({}));
  const mode = String(body.mode || '').trim().toUpperCase() as Mode;
  if (mode !== 'ANGAR' && mode !== 'POINT') {
    return NextResponse.json({ error: 'Неизвестный режим' }, { status: 400 });
  }

  const auth = await createClient();
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id,workspace_id,point_workspace_id,active_mode,role')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) return NextResponse.json({ error: `Не удалось прочитать профиль: ${profileError.message}` }, { status: 500 });
  if (!profile?.workspace_id) return NextResponse.json({ error: 'Профиль пользователя не найден' }, { status: 404 });

  if (mode === 'ANGAR') {
    const { error } = await admin.from('profiles').update({ active_mode: 'ANGAR' }).eq('id', user.id);
    if (error) return NextResponse.json({ error: `Не удалось войти в Ангар: ${error.message}` }, { status: 500 });
    return NextResponse.json({ ok: true, mode: 'ANGAR', workspace_id: profile.workspace_id });
  }

  let pointWorkspaceId = profile.point_workspace_id as string | null;

  if (!pointWorkspaceId) {
    const { data: angar, error: angarError } = await admin
      .from('workspaces')
      .select('name')
      .eq('id', profile.workspace_id)
      .single();
    if (angarError) return NextResponse.json({ error: `Не удалось прочитать Ангар: ${angarError.message}` }, { status: 500 });

    const { data: point, error: pointError } = await admin
      .from('workspaces')
      .insert({ name: `${angar?.name || 'Ангар'} · Точка` })
      .select('id')
      .single();
    if (pointError) return NextResponse.json({ error: `Не удалось создать Точку: ${pointError.message}` }, { status: 500 });
    pointWorkspaceId = point.id;

    const { data: products, error: productsError } = await admin
      .from('products')
      .select('name,default_price,status,legacy_product_id')
      .eq('workspace_id', profile.workspace_id);
    if (productsError) return NextResponse.json({ error: `Не удалось скопировать товары: ${productsError.message}` }, { status: 500 });
    if (products?.length) {
      const { error } = await admin.from('products').insert(products.map((p) => ({
        workspace_id: pointWorkspaceId,
        name: p.name,
        default_price: p.default_price,
        status: p.status,
        legacy_product_id: p.legacy_product_id,
      })));
      if (error) return NextResponse.json({ error: `Не удалось создать товары Точки: ${error.message}` }, { status: 500 });
    }

    const { data: groups, error: groupsError } = await admin
      .from('contractor_groups')
      .select('id,name,created_at')
      .eq('workspace_id', profile.workspace_id)
      .order('created_at', { ascending: true });
    if (groupsError) return NextResponse.json({ error: `Не удалось прочитать группы: ${groupsError.message}` }, { status: 500 });

    const groupMap = new Map<string, string>();
    if (groups?.length) {
      const { data: insertedGroups, error } = await admin
        .from('contractor_groups')
        .insert(groups.map((g) => ({ workspace_id: pointWorkspaceId, name: g.name })))
        .select('id,name');
      if (error) return NextResponse.json({ error: `Не удалось создать группы Точки: ${error.message}` }, { status: 500 });
      for (const g of insertedGroups || []) groupMap.set(String(g.name).toLowerCase(), g.id);
    }

    const { data: contractors, error: contractorsError } = await admin
      .from('contractors')
      .select('name,group_id')
      .eq('workspace_id', profile.workspace_id);
    if (contractorsError) return NextResponse.json({ error: `Не удалось прочитать контрагентов: ${contractorsError.message}` }, { status: 500 });

    if (contractors?.length) {
      const sourceGroupIds = new Set((groups || []).map((g) => g.id));
      const sourceNameById = new Map((groups || []).map((g) => [g.id, String(g.name).toLowerCase()]));
      const rows = contractors.map((c) => ({
        workspace_id: pointWorkspaceId,
        name: c.name,
        group_id: c.group_id && sourceGroupIds.has(c.group_id) ? groupMap.get(sourceNameById.get(c.group_id) || '') || null : null,
      }));
      const { error } = await admin.from('contractors').insert(rows);
      if (error) return NextResponse.json({ error: `Не удалось создать контрагентов Точки: ${error.message}` }, { status: 500 });
    }
  }

  const { error: updateError } = await admin.from('profiles').update({
    point_workspace_id: pointWorkspaceId,
    active_mode: 'POINT',
  }).eq('id', user.id);
  if (updateError) return NextResponse.json({ error: `Не удалось включить Точку: ${updateError.message}` }, { status: 500 });

  return NextResponse.json({ ok: true, mode: 'POINT', workspace_id: pointWorkspaceId });
}

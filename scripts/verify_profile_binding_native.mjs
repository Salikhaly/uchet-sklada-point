const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const email = (process.env.WAREHOUSE_LOGIN_EMAIL || 'ansar@warehouse.local').trim().toLowerCase();
if (!url || !key) throw new Error('Set SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY');
const headers = { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };
async function get(path){ const r=await fetch(`${url}${path}`,{headers}); const t=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status}: ${t}`); return t?JSON.parse(t):null; }
const users = await get('/auth/v1/admin/users?page=1&per_page=1000');
const list = users.users || [];
const user = list.find(u => String(u.email||'').toLowerCase()===email);
if(!user) throw new Error(`Auth user not found: ${email}`);
const profiles = await get(`/rest/v1/profiles?select=id,workspace_id,point_workspace_id,role,display_name&id=eq.${encodeURIComponent(user.id)}&limit=1`);
const profile = profiles?.[0] || null;
const workspaceIds = profile ? [profile.workspace_id, profile.point_workspace_id].filter(Boolean) : [];
const workspaces = workspaceIds.length ? await get(`/rest/v1/workspaces?select=id,name&id=in.(${workspaceIds.map(encodeURIComponent).join(',')})`) : [];
const ws = new Map((workspaces||[]).map(x=>[x.id,x]));
const out = {auth_user:{id:user.id,email:user.email,email_confirmed_at:user.email_confirmed_at},profile,workspace_angar:profile?.workspace_id?ws.get(profile.workspace_id)||null:null,workspace_point:profile?.point_workspace_id?ws.get(profile.point_workspace_id)||null:null,profile_ok:!!profile?.workspace_id&&!!profile?.point_workspace_id&&!!ws.get(profile.workspace_id)&&!!ws.get(profile.point_workspace_id)};
console.log(JSON.stringify(out,null,2));
if(!out.profile_ok) process.exitCode=2;

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = (process.env.WAREHOUSE_LOGIN_EMAIL || 'ansar@warehouse.local').trim().toLowerCase();
if (!url || !key) throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY');
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const users = await admin.auth.admin.listUsers({page:1, perPage:1000});
if (users.error) throw users.error;
const user = users.data.users.find(u => u.email?.toLowerCase() === email);
if (!user) throw new Error(`Auth user not found: ${email}`);
const {data: profile, error: profileError} = await admin.from('profiles')
  .select('id,workspace_id,point_workspace_id,role,display_name').eq('id', user.id).maybeSingle();
if (profileError) throw profileError;
console.log(JSON.stringify({
  auth_user: {id:user.id,email:user.email,email_confirmed_at:user.email_confirmed_at},
  profile,
  profile_ok: !!profile && !!profile.workspace_id && !!profile.point_workspace_id,
}, null, 2));
if (!profile?.workspace_id) process.exitCode = 2;
if (!profile?.point_workspace_id) process.exitCode = 3;

import { redirect } from 'next/navigation';
import WarehouseApp from '@/components/warehouse-app';
import { createClient } from '@/lib/supabase/server';

export default async function AngarPage(){
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)redirect('/login');
  const {data:profile}=await supabase.from('profiles').select('display_name,role,workspace_id,point_workspace_id').eq('id',user.id).maybeSingle();
  if(!profile?.workspace_id)redirect('/login?error=' + encodeURIComponent('Нет профиля склада'));
  return <WarehouseApp userEmail={user.email||''} profile={profile}/>;
}

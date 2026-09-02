import { redirect } from 'next/navigation';
import PointApp from '@/components/point-app';
import { createClient } from '@/lib/supabase/server';

export default async function PointPage(){
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)redirect('/login');
  const {data:profile}=await supabase.from('profiles').select('id,point_workspace_id').eq('id',user.id).maybeSingle();
  if(!profile?.point_workspace_id)redirect('/?error=' + encodeURIComponent('Точка не настроена'));
  return <PointApp/>;
}

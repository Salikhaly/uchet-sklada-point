import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ensureProfileAccess } from '@/lib/auth/ensure-profile';

function expectedLogin(){ return (process.env.WAREHOUSE_LOGIN_USERNAME || 'Ansar').trim().toLowerCase(); }
function loginEmail(){ return (process.env.WAREHOUSE_LOGIN_EMAIL || 'ansar@warehouse.local').trim().toLowerCase(); }

export async function POST(req: Request){
  const body=await req.json().catch(()=>({}));
  const username=String(body.username||'').trim().toLowerCase();
  const password=String(body.password||'');
  if(!username||!password) return NextResponse.json({error:'Введите логин и пароль'},{status:400});
  if(username!==expectedLogin()) return NextResponse.json({error:'Неверный логин или пароль'},{status:401});
  const supabase=await createClient();
  const {data:sessionData,error}=await supabase.auth.signInWithPassword({email:loginEmail(),password});
  if(error || !sessionData.user) return NextResponse.json({error:'Неверный логин или пароль'},{status:401});
  try {
    const admin=createAdminClient();
    await ensureProfileAccess(admin,sessionData.user);
  } catch (err) {
    console.error('LOGIN_PROFILE_PROVISION_ERROR',err);
    await supabase.auth.signOut();
    return NextResponse.json({error:err instanceof Error?err.message:'Профиль пользователя не настроен'},{status:500});
  }
  return NextResponse.json({ok:true});
}

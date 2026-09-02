import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function HomePage(){
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)redirect('/login');
  const {data:profile}=await supabase.from('profiles').select('display_name,role,workspace_id,point_workspace_id').eq('id',user.id).maybeSingle();
  if(!profile?.workspace_id && !profile?.point_workspace_id){
    return <main className="app-shell"><div className="panel"><h1>Профиль не настроен</h1><p className="muted">Вход выполнен, но пользователю не назначен склад или Точка.</p><p className="muted">Проверь SUPABASE_WORKSPACE_ID и запуск первичной настройки пользователя.</p><a href="/api/auth/logout" className="primary" style={{display:'inline-block',marginTop:16,textDecoration:'none'}}>Выйти</a></div></main>;
  }
  return <main className="app-shell"><div className="page-title-row"><div><div className="eyebrow">УЧЁТ</div><h1 className="page-title">Куда заходим?</h1><div className="muted">Ангар и Точка работают раздельно. Остатки и операции не смешиваются.</div></div></div><div className="two-col" style={{marginTop:24}}><Link href="/angar" className="panel" style={{textDecoration:'none',color:'inherit'}}><div className="eyebrow">АНГАР</div><h2>Существующая система</h2><p className="muted">Текущий склад, операции, журнал, отчёты и контроль.</p><span className="primary" style={{display:'inline-block',marginTop:18}}>Зайти в Ангар →</span></Link><Link href="/point" className="panel" style={{textDecoration:'none',color:'inherit'}}><div className="eyebrow">ТОЧКА</div><h2>Пункт приёмки</h2><p className="muted">Приёмка, отгрузка, продажи, собственный склад, перемещение в Ангар и вечерняя сводка.</p><span className="primary" style={{display:'inline-block',marginTop:18}}>Зайти в Точку →</span></Link></div></main>;
}

'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import AngarApp from './angar-app';
import PointApp from './point-app';

type Profile={display_name?:string;role?:string;workspace_id?:string;point_workspace_id?:string|null;active_mode?:'ANGAR'|'POINT'};
type Mode='ANGAR'|'POINT'|null;

export default function ModeSelector({userEmail='',profile}:{userEmail?:string;profile:Profile|null}){
  const supabase=createClient();
  // Always show the parent selector first. The selected mode is changed explicitly.
  const [mode,setMode]=useState<Mode>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');


  async function enter(next:'ANGAR'|'POINT'){
    setBusy(true); setError('');
    try {
      // Local build: NEVER call the production-style switch_app_mode RPC.
      // Mode switching goes through the local server endpoint only.
      const res = await fetch('/api/app-mode', {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({mode: next}),
        cache: 'no-store',
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось переключить режим');
      setMode(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось переключить режим');
    } finally {
      setBusy(false);
    }
  }

  if(mode==='ANGAR') return <AngarApp userEmail={userEmail} profile={profile} onModeChange={()=>enter('POINT')}/>;
  if(mode==='POINT') return <PointApp userEmail={userEmail} profile={profile} onModeChange={()=>enter('ANGAR')}/>;

  return <div className="mode-shell">
    <div className="mode-card">
      <div className="mode-brand"><div className="brand-icon">⚖</div><div><div className="brand-title">Учёт металла</div><div className="brand-sub">Выберите рабочее место · {profile?.display_name||userEmail}</div></div></div>
      <h1>Куда заходим?</h1>
      <p>Ангар — существующая система. Точка — отдельный склад пункта приёмки и вечерняя сверка.</p>
      <div className="mode-grid">
        <button className="mode-choice" onClick={()=>enter('ANGAR')} disabled={busy}><span className="mode-icon">🏭</span><b>Ангар</b><small>Вся текущая система без изменений</small><strong>Зайти →</strong></button>
        <button className="mode-choice point-choice" onClick={()=>enter('POINT')} disabled={busy}><span className="mode-icon">📍</span><b>Точка</b><small>Приёмка · свой склад · вечерняя сверка · продажи</small><strong>Зайти →</strong></button>
      </div>
      {busy&&<div className="mode-status">Переключение…</div>}
      {error&&<div className="mode-error">{error}</div>}
    </div>
  </div>;
}

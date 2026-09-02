'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginForm(){
  const params=useSearchParams();
  const [username,setUsername]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(params.get('error')||'');
  async function submit(e:React.FormEvent){
    e.preventDefault(); setBusy(true); setError('');
    try{
      const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({username,password})});
      const body=await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(body.error||'Не удалось войти');
      window.location.href='/';
    }catch(err){setError(err instanceof Error?err.message:'Ошибка входа');setBusy(false);}
  }
  return <main className="login-shell"><div className="login-card">
    <div className="login-logo">⚖</div><h1>Учёт склада</h1><p className="login-sub">Защищённый вход · склад «Метал»</p>
    <form onSubmit={submit} className="login-form">
      <label>Логин<input autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Логин" autoFocus /></label>
      <label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Пароль" /></label>
      {error&&<div className="login-error">{error}</div>}
      <button className="login-button" disabled={busy||!username||!password}>{busy?'Вход…':'Войти'}</button>
      <div className="login-note">На этом устройстве вход сохраняется автоматически.</div>
    </form>
  </div></main>
}

export default function LoginPage(){
  return <Suspense fallback={<main className="login-shell"><div className="login-card"><div className="login-logo">⚖</div><h1>Учёт склада</h1><p className="login-sub">Загрузка защищённого входа…</p></div></main>}><LoginForm /></Suspense>;
}

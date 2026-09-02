const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY');
const headers = { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' };
async function get(path){ const r=await fetch(`${url}${path}`,{headers}); const t=await r.text(); if(!r.ok) throw new Error(`HTTP ${r.status}: ${t}`); return t?JSON.parse(t):null; }
const funcs = await get('/rest/v1/rpc/?select=*').catch(()=>null);
console.log('V11 repair migration should be verified in SQL Editor; native RPC smoke remains the source of truth.');
console.log({hasUrl:!!url, hasKey:!!key, rpcProbe:!!funcs});

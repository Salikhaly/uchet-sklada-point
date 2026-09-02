import { createClient } from '@supabase/supabase-js';
import readline from 'node:readline';

const url=process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL;
const key=process.env.SUPABASE_SECRET_KEY;
const workspaceId=process.env.SUPABASE_WORKSPACE_ID||'8c165ae4-759a-4e26-b734-a8762a07d7d3';
const username=(process.env.WAREHOUSE_LOGIN_USERNAME||'Ansar').trim();
const email=(process.env.WAREHOUSE_LOGIN_EMAIL||'ansar@warehouse.local').trim().toLowerCase();
if(!url||!key) throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SECRET_KEY');
const admin=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});

function secretPrompt(q){
  return new Promise(resolve=>{
    const rl=readline.createInterface({input:process.stdin,output:process.stdout});
    const stdin=process.stdin;
    if(stdin.isTTY) stdin.setRawMode(true);
    process.stdout.write(q);
    let value='';
    const onData=(ch)=>{
      const c=String(ch);
      if(c==='\r'||c==='\n'){stdin.setRawMode?.(false);stdin.off('data',onData);rl.close();process.stdout.write('\n');resolve(value);}
      else if(c==='\u0003'){stdin.setRawMode?.(false);stdin.off('data',onData);rl.close();process.exit(1);}
      else if(c==='\u007f'){value=value.slice(0,-1);}
      else value+=c;
    };
    stdin.on('data',onData);
  });
}

const password=process.env.WAREHOUSE_BOOTSTRAP_PASSWORD||await secretPrompt(`Пароль для ${username}: `);
if(password.length<6) throw new Error('Пароль должен быть не короче 6 символов');
const {data:ws,error:wsErr}=await admin.from('workspaces').select('id,name').eq('id',workspaceId).maybeSingle();
if(wsErr) throw wsErr;
if(!ws) throw new Error(`Workspace ${workspaceId} не найден`);

let user;
const {data:list,error:listErr}=await admin.auth.admin.listUsers({page:1,perPage:1000});
if(listErr) throw listErr;
user=list.users.find(u=>u.email?.toLowerCase()===email);
if(!user){
  const {data:created,error:createErr}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:username,workspace_name:ws.name}});
  if(createErr) throw createErr; user=created.user;
}else{
  const {data:updated,error:updateErr}=await admin.auth.admin.updateUserById(user.id,{password,email_confirm:true,user_metadata:{...(user.user_metadata||{}),display_name:username,workspace_name:ws.name}});
  if(updateErr) throw updateErr; user=updated.user;
}
const {error:profileErr}=await admin.from('profiles').upsert({id:user.id,workspace_id:ws.id,role:'admin',display_name:username},{onConflict:'id'});
if(profileErr) throw profileErr;
console.log(`Готово. Пользователь ${username} привязан к workspace «${ws.name}» (${ws.id}).`);
console.log(`Логин: ${username}`);
console.log('Вход на устройстве будет сохраняться автоматически.');

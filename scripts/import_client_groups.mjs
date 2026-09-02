import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
const file=process.argv[2]; if(!file) throw new Error('Usage: node scripts/import_client_groups.mjs ./Группы.csv');
const url=process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL, key=process.env.SUPABASE_SECRET_KEY; if(!url||!key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
const s=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}}); const rows=parse(fs.readFileSync(file,'utf8'),{bom:true,skip_empty_lines:true});
for(let i=1;i<rows.length;i++){const parent=String(rows[i][0]||'').trim(),child=String(rows[i][1]||'').trim();if(!parent||!child)continue;const {error}=await s.rpc('save_client_group',{p_parent_name:parent,p_child_name:child});if(error)throw error;}console.log('Groups imported');

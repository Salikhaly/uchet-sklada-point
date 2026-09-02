import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import_google_journal.mjs ./Общий_журнал.csv'); process.exit(1); }
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
const workspaceId = process.env.SUPABASE_WORKSPACE_ID;
if (!url || !key || !workspaceId) throw new Error('Set SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_WORKSPACE_ID');
const supabase = createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
const csv=fs.readFileSync(file,'utf8');
const rows=parse(csv,{bom:true,skip_empty_lines:true,relax_column_count:true});
if(rows.length<2) throw new Error('CSV пустой');
const header=rows[0].map(x=>String(x||'').trim());
const idx=n=>header.findIndex(h=>h.toLowerCase()===n.toLowerCase());
const C={contractor:idx('Контрагент'),date:idx('Дата'),type:idx('Тип'),product:idx('Продукт'),kg:idx('Кг'),price:idx('Цена'),sum:idx('Сумма'),waste:idx('Отход'),opid:idx('ID операции'),created:idx('Время создания'),rel:idx('Связанная операция'),role:idx('Роль операции')};
for(const [k,v] of Object.entries(C)){if(v<0)console.warn('Не найдена колонка',k)}
const blocks=new Map();
for(let i=1;i<rows.length;i++){
  const r=rows[i]; const contractor=String(r[C.contractor]||'').trim(); if(!contractor)continue; const date=String(r[C.date]||'').trim(); const product=String(r[C.product]||'').trim();
  const kg=Math.abs(Number(String(r[C.kg]||'').replace(',', '.'))||0); if(!product||kg<=0)continue;
  const key=`${contractor}|${date}|${String(r[C.opid]||'').trim()||`LEGACY-${date}-${contractor}-${i}`}`;
  if(!blocks.has(key)) blocks.set(key,{contractor,date,opid:String(r[C.opid]||'').trim()||key,created:String(r[C.created]||'').trim(),type:/ОТГРУЗКА/i.test(String(r[C.type]||''))?'SHIPMENT':'ARRIVAL',role:String(r[C.role]||'').trim().toUpperCase()||(/АВТОПРИХОД/i.test(String(r[C.type]||''))?'AUTO_REPLENISH':(/ОТГРУЗКА/i.test(String(r[C.type]||''))?'SHIPMENT':'ARRIVAL')),rel:String(r[C.rel]||'').trim(),headerLabel:String(r[C.type]||'').trim(),items:[]});
  blocks.get(key).items.push({name:product,kg,price:Number(String(r[C.price]||'').replace(',', '.'))||0,wasteKg:Math.abs(Number(String(r[C.waste]||'').replace(',', '.'))||0)});
}
const contractorIds=new Map();
for(const b of blocks.values()){
 const lower=b.contractor.toLowerCase();
 if(!contractorIds.has(lower)){
   let {data,error}=await supabase.from('contractors').select('id').eq('workspace_id',workspaceId).ilike('name',b.contractor).maybeSingle();
   if(error)throw error;
   if(!data){const ins=await supabase.from('contractors').insert({workspace_id:workspaceId,name:b.contractor}).select('id').single(); if(ins.error)throw ins.error; data=ins.data;}
   contractorIds.set(lower,data.id);
 }
}
let n=0;
for(const b of blocks.values()){
 const operationId=randomUUID();
 const label = b.headerLabel || ''; const numMatch = label.match(/№\s*(\d+)/); const operationNumber = numMatch ? Number(numMatch[1]) : (n + 1);
 const createdAt=b.created?new Date(b.created):new Date();
 const {error}=await supabase.rpc('import_legacy_operation',{p_workspace_id:workspaceId,p_operation_id:operationId,p_legacy_operation_id:b.opid,p_legacy_parent_operation_id:b.rel||null,p_operation_number:operationNumber,p_operation_date:(/^\d{2}\.\d{2}\.\d{4}$/.test(b.date)?b.date.split('.').reverse().join('-'):b.date),p_type:b.type,p_role:b.role,p_contractor_id:contractorIds.get(b.contractor.toLowerCase()),p_created_at:createdAt.toISOString(),p_items:b.items});
 if(error)throw error; n++; if(n%100===0)console.log('imported',n);
}
await supabase.rpc('resolve_legacy_parents',{p_workspace_id:workspaceId});
await supabase.rpc('rebuild_all_inventory',{p_workspace_id:workspaceId});
console.log('Imported operations:',n);

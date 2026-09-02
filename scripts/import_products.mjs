import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
const file=process.argv[2];
if(!file) throw new Error('Usage: node scripts/import_products.mjs ./Товары.csv');
const url=process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL;
const key=process.env.SUPABASE_SECRET_KEY;
if(!url||!key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY');
const s=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
const rows=parse(fs.readFileSync(file,'utf8'),{bom:true,skip_empty_lines:true});
const h=rows[0].map(x=>String(x||'').trim().toLowerCase());
const ni=h.findIndex(x=>['название','name','товар'].includes(x));
const pi=h.findIndex(x=>['цена','price','цена/кг'].includes(x));
if(ni<0) throw new Error('Не найдена колонка Название');
for(let i=1;i<rows.length;i++){
  const name=String(rows[i][ni]||'').trim(); if(!name) continue;
  const price=pi>=0?Number(String(rows[i][pi]||0).replace(',','.'))||0:0;
  const {error}=await s.rpc('upsert_product',{p_name:name,p_price:price,p_status:'ACTIVE'});
  if(error) throw error;
}
console.log('Products imported');

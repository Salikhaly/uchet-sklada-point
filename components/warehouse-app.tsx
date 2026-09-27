'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Tab = 'monitor'|'operation'|'journal'|'stock'|'report'|'search'|'clients'|'products'|'control';
type Mode = 'ARRIVAL'|'SHIPMENT';
type Product={id:string;name:string;default_price:number;status:string;sort_order?:number};
type Contractor={id:string;name:string;group_id:string|null;group_name?:string|null;archived_at?:string|null};
type Group={id:string;name:string;children:Contractor[];archived_at?:string|null};
type Line={product_id:string;product_name:string;kg:number;price:number;sum:number;wasteKg:number;cogs:number};
type Operation={id:string;operation_number:number;operation_date:string;type:Mode;role:string;status:string;version:number;contractor_id:string;contractor_name:string;group_name?:string|null;created_at:string;items:Line[]};
type Profile={display_name?:string;role?:string;workspace_id?:string;point_workspace_id?:string|null};

const moneyFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const kgFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3});
const dateNow=()=>new Date().toISOString().slice(0,10);
const num=(v:unknown)=>{const x=Number(v);return Number.isFinite(x)?x:0};
const money=(v:unknown)=>moneyFmt.format(num(v))+' ₸';
const qty=(v:unknown)=>kgFmt.format(num(v));
const iso=(d:Date)=>d.toISOString().slice(0,10);

function escapeHtml(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}

export default function WarehouseApp({userEmail='',profile=null}:{userEmail?:string;profile?:Profile|null}){
  const supabase=createClient();
  const [tab,setTab]=useState<Tab>('monitor'); const [mode,setMode]=useState<Mode>('ARRIVAL');
  const [products,setProducts]=useState<Product[]>([]); const [contractors,setContractors]=useState<Contractor[]>([]); const [groups,setGroups]=useState<Group[]>([]);
  const [stock,setStock]=useState<any[]>([]); const [ops,setOps]=useState<Operation[]>([]); const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false); const [toast,setToast]=useState('');
  const [contractorId,setContractorId]=useState(''); const [date,setDate]=useState(dateNow()); const [clearPrices,setClearPrices]=useState(false);
  const [rows,setRows]=useState<Record<string,{kg:string;price:string;sum:string;waste:string;sumTouched:boolean}>>({});
  const [journalClient,setJournalClient]=useState(''); const [journalFrom,setJournalFrom]=useState(''); const [journalTo,setJournalTo]=useState('');
  const [search,setSearch]=useState({client:'',product:'',from:'',to:''}); const [searchResults,setSearchResults]=useState<any[]>([]);
  const [report,setReport]=useState<any>(null); const [monitorReport,setMonitorReport]=useState<any>(null); const [reportView,setReportView]=useState<'overview'|'gross'>('overview'); const [reportFrom,setReportFrom]=useState(()=>iso(new Date(new Date().getFullYear(),new Date().getMonth(),1))); const [reportTo,setReportTo]=useState(dateNow());
  const [expandedGroups,setExpandedGroups]=useState<Record<string,boolean>>({});
  const [expandedOps,setExpandedOps]=useState<Record<string,boolean>>({});
  const [journalProduct,setJournalProduct]=useState('');
  const [journalFocusId,setJournalFocusId]=useState<string|null>(null);
  const [journalFocusProductId,setJournalFocusProductId]=useState<string|null>(null);
  const [modal,setModal]=useState<{kind:'edit'|'history'|'price'|'client'|'product'|'group'|'confirmCancel'|'confirmDelete';op?:Operation;client?:Contractor;price?:Product;product?:Product;group?:Group} | null>(null);
  const [newProduct,setNewProduct]=useState({name:'',price:''}); const [newClient,setNewClient]=useState(''); const [groupForm,setGroupForm]=useState({parent:'',child:''});
  const [control,setControl]=useState<any>(null); const [draftRestored,setDraftRestored]=useState(false); const [undoCancel,setUndoCancel]=useState<{id:string;seconds:number}|null>(null);

  const activeProducts=useMemo(()=>products.filter((p:Product)=>p.status==='ACTIVE'),[products]);
  const filled=useMemo(()=>Object.values(rows).filter(r=>num(r.kg)>0 && r.sum!=='' && num(r.sum)>=0),[rows]).length;
  const total=useMemo(()=>Object.values(rows).reduce((s,r)=>s+(r.sum!==''?num(r.sum):num(r.kg)*num(r.price)),0),[rows]);
  const filteredOps=useMemo(()=>{
    const groupName = journalClient ? contractors.find(c=>c.id===journalClient)?.group_name : null;
    return ops.filter(o=>{
      const clientOk = !journalClient || o.contractor_id===journalClient || (!!groupName && o.group_name===groupName);
      const dateOk = (!journalFrom||o.operation_date>=journalFrom)&&(!journalTo||o.operation_date<=journalTo);
      const productOk = !journalProduct || o.items.some(i=>i.product_name.toLowerCase().includes(journalProduct.toLowerCase()));
      return clientOk && dateOk && productOk;
    });
  },[ops,journalClient,journalFrom,journalTo,journalProduct,contractors]);

  function notify(m:string){setToast(m);window.setTimeout(()=>setToast(''),3200);}

  async function loadData(){
    setLoading(true);
    const [ps,cs,gs,st,os]=await Promise.all([
      supabase.from('products').select('id,name,default_price,status,sort_order').order('sort_order',{ascending:true}).order('name',{ascending:true}),
      supabase.from('contractors').select('id,name,group_id,archived_at,contractor_groups(id,name,archived_at)').is('archived_at',null).order('name'),
      supabase.from('contractor_groups').select('id,name,archived_at').is('archived_at',null).order('name'),
      supabase.rpc('dashboard_summary'),
      supabase.from('operations').select('id,operation_number,operation_date,type,role,status,version,contractor_id,created_at,contractors(name,contractor_groups(name)),operation_items(product_id,quantity_kg,unit_price,total_amount,waste_kg,cogs_amount,products(name,sort_order))').order('operation_date',{ascending:false}).order('created_at',{ascending:false}).limit(200)
    ]);
    if(ps.error||cs.error||gs.error||st.error||os.error){notify([ps.error,cs.error,gs.error,st.error,os.error].find(Boolean)?.message||'Ошибка загрузки');setLoading(false);return;}
    setProducts((ps.data||[]) as Product[]);
    const cdata=(cs.data||[]).map((c:any)=>({...c,group_name:(c.contractor_groups && !c.contractor_groups.archived_at)?c.contractor_groups.name:null})); setContractors(cdata);
    const kids:Record<string,Contractor[]>={}; for(const c of cdata){if(c.group_id)(kids[c.group_id] ||= []).push(c);}
    setGroups((gs.data||[]).map((g:any)=>({...g,children:kids[g.id]||[]})));
    setStock(st.data||[]); setOps((os.data||[]).map((o:any)=>mapOp(o)));
    setLoading(false);
  }
  function mapOp(o:any):Operation{const items=(o.operation_items||[]).map((i:any)=>({product_id:i.product_id,product_name:i.products?.name||'',kg:num(i.quantity_kg),price:num(i.unit_price),sum:num(i.total_amount),wasteKg:num(i.waste_kg),cogs:num(i.cogs_amount),_so:num(i.products?.sort_order)})).sort((a:any,b:any)=>a._so-b._so||a.product_name.localeCompare(b.product_name,'ru'));return {...o,contractor_name:o.contractors?.name||'',group_name:o.contractors?.contractor_groups?.name||null,items};}
  useEffect(()=>{loadData();loadMonitorReport();},[]);
  useEffect(()=>{ if(!undoCancel) return; if(undoCancel.seconds<=0){setUndoCancel(null);return;} const t=window.setTimeout(()=>setUndoCancel(x=>x?{...x,seconds:x.seconds-1}:null),1000); return ()=>window.clearTimeout(t); },[undoCancel]);

  useEffect(()=>{
    const key='warehouse-draft-v2'; const raw=localStorage.getItem(key); if(raw){try{const d=JSON.parse(raw); if(d.date===dateNow()){setMode(d.mode||'ARRIVAL');setContractorId(d.contractorId||'');setDate(d.date||dateNow());setRows(d.rows||{});setDraftRestored(true);}}catch{}}
  },[]);
  useEffect(()=>{localStorage.setItem('warehouse-draft-v2',JSON.stringify({mode,contractorId,date,rows,savedAt:Date.now()}));},[mode,contractorId,date,rows]);

  function updateRow(id:string,field:'kg'|'price'|'sum'|'waste',value:string){
    setRows(prev=>{const product=activeProducts.find(p=>p.id===id); const cur=prev[id]||{kg:'',price:clearPrices?'':String(product?.default_price??0),sum:'',waste:'',sumTouched:false}; const next={...cur,[field]:value}; const K=num(next.kg),P=num(next.price),S=next.sum===''?null:num(next.sum);
      if(field==='kg'){if(next.sumTouched&&K>0&&S!==null)next.price=String(S/K);else if(K>0)next.sum=(K*P).toFixed(2);}
      if(field==='price'){if(K>0)next.sum=(K*P).toFixed(2);next.sumTouched=false;}
      if(field==='sum'){next.sumTouched=true;if(K>0&&S!==null)next.price=String(S/K);else if(P>0&&S!==null)next.kg=String(S/P);}
      if(num(next.waste)>K)next.waste=K?String(K):'';
      return {...prev,[id]:next};});
  }
  function toggleClear(v:boolean){setClearPrices(v);setRows(prev=>{const out={...prev};for(const p of activeProducts){const r=out[p.id]||{kg:'',price:'',sum:'',waste:'',sumTouched:false};out[p.id]={...r,price:v?'':String(p.default_price),sumTouched:false};}return out;});}
  function rowByProduct(id:string){return rows[id]||{kg:'',price:clearPrices?'':String(activeProducts.find(p=>p.id===id)?.default_price??0),sum:'',waste:'',sumTouched:false};}
  async function submitOperation(){
    if(!contractorId)return notify('Выберите контрагента'); if(date>dateNow())return notify('Дата не может быть в будущем');
    const items=activeProducts.map((p:any)=>{const r=rows[p.id];if(!r||num(r.kg)<=0)return null;return {product_id:p.id,name:p.name,kg:num(r.kg),price:num(r.price),wasteKg:num(r.waste)};}).filter(Boolean) as any[];
    if(!items.length)return notify('Заполните хотя бы один товар');
    setBusy(true);const idempotencyKey=crypto.randomUUID();
    const res=await fetch('/api/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:mode,contractorId,operationDate:date,items,idempotencyKey})}); const body=await res.json();setBusy(false);if(!res.ok)return notify(body.error||'Не удалось сохранить');
    localStorage.removeItem('warehouse-draft-v2');setRows({});setDraftRestored(false);notify(mode==='ARRIVAL'?'Приход сохранён ✅':'Отгрузка сохранена ✅');setUndoCancel({id:String(body.id),seconds:10});await loadData();
  }
  async function undoLastOperation(){
    if(!undoCancel||!undoCancel.id)return;
    const op=ops.find(o=>o.id===undoCancel.id);
    setUndoCancel(null);
    if(op) return cancelOperation(op);
    setBusy(true);
    const res=await fetch('/api/operations/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:undoCancel.id,reason:'Отмена в течение 10 секунд после сохранения'})});
    const b=await res.json();setBusy(false);
    if(!res.ok)return notify(b.error||'Не удалось отменить');
    notify('Накладная отменена');await loadData();
  }
  function repeatOperation(o:Operation){if(o.role==='AUTO_REPLENISH')return;setMode(o.type);setContractorId(o.contractor_id);setDate(dateNow());const r:any={};o.items.forEach(i=>r[i.product_id]={kg:String(i.kg),price:String(i.price),sum:String(i.sum),waste:String(i.wasteKg),sumTouched:false});setRows(r);setTab('operation');notify('Операция скопирована — проверьте данные');}
  async function cancelOperation(o:Operation){setBusy(true);const res=await fetch('/api/operations/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:o.id})});const b=await res.json();setBusy(false);if(!res.ok)return notify(b.error||'Не удалось отменить');notify('Операция отменена');setModal(null);await loadData();}
  async function restoreOperation(o:Operation){setBusy(true);const res=await fetch('/api/operations/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:o.id})});const b=await res.json();setBusy(false);if(!res.ok)return notify(b.error||'Не удалось восстановить');notify('Операция восстановлена');await loadData();}
  async function hardDeleteOperation(o:Operation){setBusy(true);const res=await fetch('/api/operations',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:o.id})});const b=await res.json();setBusy(false);if(!res.ok)return notify(b.error||'Не удалось удалить накладную');notify('Накладная удалена полностью');setModal(null);setJournalFocusId(null);setJournalFocusProductId(null);await loadData();}
  async function saveEdit(o:Operation,form:any){setBusy(true);const res=await fetch('/api/operations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:o.id,...form})});const b=await res.json();setBusy(false);if(!res.ok)return notify(b.error||'Не удалось сохранить');notify('Изменение сохранено');setModal(null);await loadData();}
  async function showHistory(o:Operation){const {data,error}=await supabase.from('audit_log').select('id,action,old_data,new_data,details,created_at').eq('operation_id',o.id).order('created_at',{ascending:false}).limit(100);if(error)return notify(error.message);setModal({kind:'history',op:o,client:undefined});setHistoryRows(data||[]);}
  const [historyRows,setHistoryRows]=useState<any[]>([]);
  async function createProduct(){if(!newProduct.name.trim())return notify('Введите товар');const {error}=await supabase.rpc('upsert_product',{p_name:newProduct.name.trim(),p_price:num(newProduct.price)});if(error)return notify(error.message);setNewProduct({name:'',price:''});notify('Товар сохранён');await loadData();}
  async function createContractor(){if(!newClient.trim())return notify('Введите контрагента');const {error}=await supabase.rpc('upsert_contractor',{p_name:newClient.trim(),p_group_id:null});if(error)return notify(error.message);setNewClient('');notify('Контрагент сохранён');await loadData();}
  async function createGroup(){if(!groupForm.parent||!groupForm.child)return notify('Заполните оба поля');const {error}=await supabase.rpc('save_client_group',{p_parent_name:groupForm.parent,p_child_name:groupForm.child});if(error)return notify(error.message);setGroupForm({parent:'',child:''});notify('Группа сохранена');await loadData();}
  async function archiveContractor(c:any){if(!confirm(`Удалить контрагента «${c.name}» из активного списка? История операций сохранится.`))return;const {error}=await supabase.rpc('archive_contractor',{p_contractor_id:c.id});if(error)return notify(error.message);if(contractorId===c.id)setContractorId('');notify('Контрагент скрыт из активного списка; история сохранена');await loadData();}
  async function archiveGroup(g:any){if(!confirm(`Удалить группу «${g.name}» из активного списка? История всех её участников сохранится.`))return;const {error}=await supabase.rpc('archive_contractor_group',{p_group_id:g.id});if(error)return notify(error.message);notify('Группа скрыта из активного списка; история сохранена');await loadData();}
  async function reorderProducts(nextProducts:Product[]){const ids=nextProducts.map(p=>p.id);const {error}=await supabase.rpc('reorder_products',{p_product_ids:ids});if(error)return notify(error.message);setProducts(nextProducts.map((p,i)=>({...p,sort_order:i})));notify('Порядок товаров сохранён');}
  async function moveProduct(id:string,dir:-1|1){const arr=[...products].sort((a,b)=>num(a.sort_order)-num(b.sort_order));const idx=arr.findIndex(p=>p.id===id);const ni=idx+dir;if(idx<0||ni<0||ni>=arr.length)return;[arr[idx],arr[ni]]=[arr[ni],arr[idx]];await reorderProducts(arr);}
  async function loadReport(){const {data,error}=await supabase.rpc('get_profit_report',{p_from:reportFrom||null,p_to:reportTo||null});if(error)return notify(error.message);setReport(data);}
  async function loadMonitorReport(){const today=dateNow(); const {data,error}=await supabase.rpc('get_profit_report',{p_from:today,p_to:today}); if(error){notify(error.message);return;} setMonitorReport(data);}
  async function runSearch(){
    const clientTerm=search.client.trim().toLowerCase();
    const productTerm=search.product.trim().toLowerCase();
    const results:any[]=[];
    for(const o of ops){
      if(search.from && o.operation_date<search.from) continue;
      if(search.to && o.operation_date>search.to) continue;
      if(clientTerm && !o.contractor_name.toLowerCase().includes(clientTerm)) continue;
      for(const i of o.items){
        if(productTerm && !i.product_name.toLowerCase().includes(productTerm)) continue;
        results.push({
          operationId:o.id,
          operationNumber:o.operation_number,
          operationDate:o.operation_date,
          type:o.type,
          status:o.status,
          contractor:o.contractor_name,
          product:i.product_name,
          productId:i.product_id,
          quantity_kg:i.kg,
          unit_price:i.price,
          total_amount:i.sum
        });
      }
    }
    setSearchResults(results.slice(0,500));
  }
  async function controlCheck(){const {data,error}=await supabase.rpc('system_control_check');if(error)return notify(error.message);setControl(data);setTab('control');}

  function focusJournalOperation(operationId:string,productId?:string){
    const op=ops.find(x=>x.id===operationId);
    if(!op){notify('Накладная не найдена');return;}
    setJournalClient('');
    setJournalProduct('');
    setJournalFrom('');
    setJournalTo('');
    // Переход из карточки в журнал должен закрывать карточку,
    // иначе модалка остаётся поверх журнала и мешает увидеть накладную.
    setJournalFocusId(operationId);
    setJournalFocusProductId(productId||null);
    setExpandedOps(prev=>({...prev,[operationId]:true}));
    setModal(null);
    setTab('journal');
    window.setTimeout(()=>{
      const el=document.getElementById('journal-op-'+operationId);
      if(el) el.scrollIntoView({behavior:'smooth',block:'center'});
    },180);
  }
  function openProductCard(productName:string){
    const product=products.find(p=>p.name===productName);
    if(!product){notify('Товар не найден');return;}
    setModal({kind:'product',product});
  }
  function openProductInJournal(productName:string){
    const op=ops.find(o=>o.items.some(i=>i.product_name===productName));
    if(!op){notify('По этому товару пока нет операций');return;}
    const item=op.items.find(i=>i.product_name===productName);
    focusJournalOperation(op.id,item?.product_id);
  }
  async function openClientCardByName(name:string){
    const c=contractors.find(x=>x.name===name);
    if(c){ setModal({kind:'client',client:c}); return; }
    const {data,error}=await supabase.from('contractors').select('id,name,group_id,archived_at,contractor_groups(id,name,archived_at)').eq('name',name).maybeSingle();
    if(error) return notify(error.message);
    if(data){ const one:any = data; setModal({kind:'client',client:{...one,group_name:one.contractor_groups?.name||null}}); return; }
    const g=groups.find(x=>x.name===name); if(g){ setModal({kind:'group',group:g}); return; }
    const {data:gd}=await supabase.from('contractor_groups').select('id,name,archived_at').eq('name',name).maybeSingle();
    if(gd){ const one:any = gd; setModal({kind:'group',group:{...one,children:[]}}); } else notify('Контрагент не найден');
  }
  function openGroupCardByName(name:string){const g=groups.find(x=>x.name===name); if(g) setModal({kind:'group',group:g}); else notify('Группа не найдена');}
  function openSearchResult(r:any){
    if(r.operationId) focusJournalOperation(r.operationId,r.productId);
  }
  function nav(t:Tab){setTab(t);if(t==='report')loadReport();if(t==='monitor')loadMonitorReport();}
  async function logout(){ await fetch('/api/auth/logout',{method:'POST',credentials:'include'}); window.location.href='/login'; }

  if(loading)return <div className="app-loading"><div className="brand-dot">⚖</div><div>Загрузка склада…</div></div>;

  return <div className="warehouse-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">⚖</div><div><div className="brand-title">Учёт склада</div><div className="brand-sub">Supabase edition · {profile?.display_name||userEmail}</div></div></div>
      <div className="top-actions"><span className="workspace-pill">{profile?.workspace_id ? 'Метал' : 'Склад'}</span>{profile?.point_workspace_id&&<button className="workspace-switch" onClick={()=>{window.location.href='/point';}}>Точка</button>}<button onClick={controlCheck}>Проверка</button><button onClick={logout}>Выйти</button></div>
    </header>
    <nav className="navtabs">
      {([['monitor','Монитор'],['operation','Операция'],['journal','Журнал'],['stock','Остатки'],['report','Отчёты'],['search','Поиск'],['clients','Контрагенты'],['products','Товары'],['control','Контроль']] as const).map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>nav(id)}>{label}</button>)}
    </nav>
    <main className="page">
      {draftRestored&&tab==='operation'&&<div className="notice">Найден черновик сегодняшней операции. <button onClick={()=>{localStorage.removeItem('warehouse-draft-v2');setRows({});setDraftRestored(false);}}>Очистить</button></div>}
      {toast&&<div className="toast">{toast}</div>}
      {undoCancel&&<div className="undo-toast"><div><b>Накладная сохранена</b><span>Можно отменить ещё {undoCancel.seconds} сек.</span></div><button onClick={undoLastOperation} disabled={busy}>Отменить</button></div>}
      {tab==='monitor'&&<MonitorView stock={stock} products={activeProducts} ops={ops} report={monitorReport} onNew={()=>{setMode('ARRIVAL');setContractorId('');setRows({});setDate(dateNow());setTab('operation')}} onOpenOperation={focusJournalOperation}/>}
      {tab==='operation'&&<OperationView mode={mode} setMode={setMode} contractors={contractors} contractorId={contractorId} setContractorId={setContractorId} date={date} setDate={setDate} activeProducts={activeProducts} rows={rows} rowByProduct={rowByProduct} updateRow={updateRow} clearPrices={clearPrices} toggleClear={toggleClear} filled={filled} total={total} stock={stock} busy={busy} submit={submitOperation}/>} 
      {tab==='journal'&&<JournalView ops={filteredOps} contractors={contractors} products={activeProducts} client={journalClient} setClient={setJournalClient} product={journalProduct} setProduct={setJournalProduct} from={journalFrom} to={journalTo} setFrom={setJournalFrom} setTo={setJournalTo} focusId={journalFocusId} focusProductId={journalFocusProductId} clearFocus={()=>{setJournalFocusId(null);setJournalFocusProductId(null);}} onRepeat={repeatOperation} onHistory={showHistory} onCancel={(o:Operation)=>setModal({kind:'confirmCancel',op:o})} onRestore={restoreOperation} onEdit={(o:Operation)=>setModal({kind:'edit',op:o})} onDelete={(o:Operation)=>setModal({kind:'confirmDelete',op:o})}/>} 
      {tab==='stock'&&<StockView stock={stock} products={activeProducts} onProduct={openProductCard}/>} 
      {tab==='report'&&<ReportView report={report} from={reportFrom} to={reportTo} setFrom={setReportFrom} setTo={setReportTo} load={loadReport} onProduct={openProductCard} onClient={openClientCardByName} onGroup={openGroupCardByName} reportView={reportView} setReportView={setReportView}/>}
      {tab==='search'&&<SearchView search={search} setSearch={setSearch} run={runSearch} results={searchResults} onOpen={openSearchResult}/>} 
      {tab==='clients'&&<ClientsView contractors={contractors} groups={groups} expanded={expandedGroups} setExpanded={setExpandedGroups} onClient={(c:Contractor)=>setModal({kind:'client',client:c})} onGroup={(g:Group)=>setModal({kind:'group',group:g})} onDeleteClient={archiveContractor} onDeleteGroup={archiveGroup} newClient={newClient} setNewClient={setNewClient} createClient={createContractor} groupForm={groupForm} setGroupForm={setGroupForm} createGroup={createGroup}/>} 
      {tab==='products'&&<ProductsView products={products} newProduct={newProduct} setNewProduct={setNewProduct} createProduct={createProduct} onPrice={(p:Product)=>setModal({kind:'price',price:p})} onMove={moveProduct}/>} 
      {tab==='control'&&<ControlView control={control} run={controlCheck}/>} 
    </main>
    {modal?.kind==='edit'&&modal.op&&<EditModal op={modal.op} contractors={contractors} products={activeProducts} onClose={()=>setModal(null)} onSave={(payload)=>saveEdit(modal.op!,payload)}/>} 
    {modal?.kind==='history'&&<HistoryModal op={modal.op!} rows={historyRows} onClose={()=>setModal(null)}/>} 
    {modal?.kind==='confirmCancel'&&<ConfirmModal title="Отменить операцию?" text="Операция останется в истории, но перестанет влиять на склад и отчёты." onClose={()=>setModal(null)} onConfirm={()=>cancelOperation(modal.op!)}/>}
      {modal?.kind==='confirmDelete'&&<ConfirmModal title="Удалить накладную полностью?" text="Накладная будет физически удалена из журнала и из расчётов. Историю отмены сохранить не получится." onClose={()=>setModal(null)} onConfirm={()=>hardDeleteOperation(modal.op!)} confirmLabel="Удалить полностью" danger/>} 
    {modal?.kind==='client'&&modal.client&&<ClientModal client={modal.client} ops={ops} onClose={()=>setModal(null)} onOpenOperation={focusJournalOperation}/>}
    {modal?.kind==='group'&&modal.group&&<GroupModal group={modal.group} ops={ops} contractors={contractors} onClose={()=>setModal(null)} onOpenOperation={focusJournalOperation} onClient={(c:Contractor)=>setModal({kind:'client',client:c})}/>}
    {modal?.kind==='product'&&modal.product&&<ProductModal product={modal.product} stock={stock} ops={ops} onClose={()=>setModal(null)} onOpenOperation={focusJournalOperation} supabase={supabase}/>}
    {modal?.kind==='price'&&modal.price&&<PriceModal product={modal.price} onClose={()=>setModal(null)} supabase={supabase} refresh={loadData}/>} 
  </div>;
}

function MonitorView({stock,products,ops,report,onNew,onOpenOperation}:{stock:any[];products:Product[];ops:Operation[];report:any;onNew:()=>void;onOpenOperation:(operationId:string,productId?:string)=>void}){
  const today=dateNow();
  const d=new Date(today+'T00:00:00'); d.setDate(d.getDate()-1); const yesterday=iso(d);
  const activeOps=ops.filter(o=>o.status!=='CANCELLED');
  const todayOps=activeOps.filter((o:Operation)=>o.operation_date===today).sort((a,b)=>a.created_at<b.created_at?1:-1);
  const yesterdayOps=activeOps.filter((o:Operation)=>o.operation_date===yesterday);
  const negative=stock.filter((s:any)=>num(s.quantity_kg)<-0.000001);
  const zero=products.filter((p:Product)=>num(stock.find((s:any)=>s.product_id===p.id)?.quantity_kg)<=0);
  const totalInventoryValue=stock.reduce((s:any,x:any)=>s+num(x.inventory_value),0);
  const noMove=products.map((p:Product)=>{
    const last=activeOps.filter((o:Operation)=>o.items.some(i=>i.product_id===p.id)).sort((a,b)=>a.operation_date<b.operation_date?1:-1)[0];
    const days=last?Math.max(0,Math.floor((new Date(today).getTime()-new Date(last.operation_date).getTime())/86400000)):999;
    return {p,last,days,kg:num(stock.find((s:any)=>s.product_id===p.id)?.quantity_kg)};
  }).filter(x=>x.days>=14).sort((a,b)=>b.days-a.days).slice(0,8);
  const scoreIssues=negative.length*25 + Math.min(20,noMove.length*3) + Math.min(15,zero.length*2);
  const score=Math.max(0,Math.min(100,100-scoreIssues));
  const status=negative.length?'Нужна проверка':score>=90?'Стабильно':score>=75?'Внимание':'Требует внимания';
  const statusClass=negative.length?'bad':score>=90?'good':score>=75?'warn':'bad';
  const tin=num(report?.totals?.in_sum), tout=num(report?.totals?.out_sum), tprofit=num(report?.totals?.profit), margin=num(report?.totals?.margin);
  const todayKgIn=num(report?.totals?.in_kg), todayKgOut=num(report?.totals?.out_kg);
  const yIn=yesterdayOps.filter((o:Operation)=>o.type==='ARRIVAL').reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const yOut=yesterdayOps.filter((o:Operation)=>o.type==='SHIPMENT').reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const change=(v:number,prev:number)=>prev===0?(v===0?'—':'+100%'):`${v-prev>=0?'+':''}${((v-prev)/Math.abs(prev)*100).toFixed(1)}%`;
  const profitable=[...(report?.products||[])].sort((a:any,b:any)=>num(b.profit)-num(a.profit)).slice(0,5);
  const topValue=[...stock].sort((a,b)=>num(b.inventory_value)-num(a.inventory_value)).slice(0,5);
  const todayTitle=new Date(today+'T00:00:00').toLocaleDateString('ru-RU',{day:'2-digit',month:'long'});
  return <section className="monitor-screen">
    <div className="page-title-row"><div><h2 className="page-title">Монитор склада</h2><div className="muted">Оценка, сегодняшняя активность и сигналы, которые требуют внимания — всё на одном экране.</div></div><button className="primary" onClick={onNew}>＋ Новая операция</button></div>
    <div className="monitor-grid">
      <div className={'monitor-score '+statusClass}><div><small>Оценка склада</small><div className="score-line"><strong>{score}</strong><span>/100</span></div><b>{status}</b><em>{negative.length?'Есть критические остатки':noMove.length?`${noMove.length} товаров без движения 14+ дней`:'Ключевые показатели в норме'}</em></div><div className="score-ring" style={{'--score':`${score}%`} as any}><span>СКЛАД</span></div></div>
      <div className="monitor-card"><small>Сегодня · Приход</small><b className="green">{money(tin)}</b><span>{qty(todayKgIn)} кг · {num(report?.totals?.in_count)} накладных</span><em>{change(tin,yIn)} к вчера</em></div>
      <div className="monitor-card"><small>Сегодня · Отгрузка</small><b className="red">{money(tout)}</b><span>{qty(todayKgOut)} кг · {num(report?.totals?.out_count)} накладных</span><em>{change(tout,yOut)} к вчера</em></div>
      <div className="monitor-card"><small>Сегодня · Валовая прибыль</small><b className={tprofit>=0?'green':'red'}>{tprofit>=0?'+':''}{money(tprofit)}</b><span>Маржа {margin.toFixed(1)}% · прибыль/кг {money(todayKgOut?tprofit/todayKgOut:0)}</span><em>{todayKgOut?'':'Пока нет отгрузок'}</em></div>
    </div>
    <div className="monitor-quick-grid">
      <div className="panel quick-card"><div className="panel-head"><h3>Сравнение с вчера</h3><span className="muted">по сумме</span></div><div className="compare-row"><span>Приход</span><b>{change(tin,yIn)}</b><small>{money(yIn)} → {money(tin)}</small></div><div className="compare-row"><span>Отгрузка</span><b>{change(tout,yOut)}</b><small>{money(yOut)} → {money(tout)}</small></div><div className="compare-row"><span>Прибыль</span><b>{change(tprofit, yesterdayOps.filter((o:Operation)=>o.type==='SHIPMENT').reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0)-0)}</b><small>Сегодня {money(tprofit)}</small></div></div>
      <div className="panel quick-card"><div className="panel-head"><h3>Что требует внимания</h3><span className="muted">автоматически</span></div><div className="signal-list">{negative.length?<button className="signal bad" onClick={()=>setTimeout(()=>{},0)}><b>Отрицательный остаток</b><span>{negative.map((s:any)=>products.find(p=>p.id===s.product_id)?.name||'Товар').join(', ')}</span></button>:null}{noMove.length?<div className="signal warn"><b>Нет движения 14+ дней</b><span>{noMove.map((x:any)=>x.p.name).join(', ')}</span></div>:null}{zero.length?<div className="signal"><b>Товары закончились</b><span>{zero.length} позиций</span></div>:null}{!negative.length&&!noMove.length&&!zero.length?<div className="signal good"><b>Критичных сигналов нет</b><span>Склад выглядит стабильно.</span></div>:null}</div></div>
    </div>
    <div className="two-col monitor-main">
      <div className="panel"><div className="panel-head"><h3>Что было сегодня</h3><span className="muted">{todayOps.length} операций</span></div>{todayOps.length?<div className="today-feed">{todayOps.slice(0,8).map((o:Operation)=><button className={'today-item '+(o.type==='SHIPMENT'?'out':'in')} key={o.id} onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><div className="today-icon">{o.type==='SHIPMENT'?'↑':'↓'}</div><div className="today-body"><b>{o.contractor_name}</b><span>№{o.operation_number} · {o.operation_date} · {o.type==='SHIPMENT'?'Отгрузка':'Приход'}</span><small>{o.items.map((i:Line)=>i.product_name).slice(0,3).join(', ')}{o.items.length>3?' · ещё '+(o.items.length-3):''}</small></div><strong>{money(o.items.reduce((s,i)=>s+i.sum,0))}</strong></button>)}</div>:<div className="empty-state"><b>Сегодня операций пока нет</b><span>Можно сразу создать приход или отгрузку.</span><button className="primary" onClick={onNew}>Начать</button></div>}</div>
      <div className="panel"><div className="panel-head"><h3>Состояние остатков</h3><span className="muted">{products.length} товаров</span></div><div className="alert-list"><div className="alert-item good"><b>Общая стоимость склада</b><span>{money(totalInventoryValue)}</span></div><div className="alert-item"><b>Нет на складе</b><span>{zero.length} товаров</span></div>{negative.length?<div className="alert-item bad"><b>Отрицательный остаток</b><span>{negative.length} позиций</span></div>:<div className="alert-item good"><b>Отрицательных остатков нет</b><span>Серверная проверка отгрузки работает.</span></div>}</div><h4 className="monitor-subtitle">Топ по стоимости</h4><div className="monitor-bars">{topValue.map((s:any)=>{const name=products.find(p=>p.id===s.product_id)?.name||'Товар';return <button key={s.product_id} onClick={()=>onOpenOperation((activeOps.find(o=>o.items.some(i=>i.product_id===s.product_id))||{} as any).id,s.product_id)}><span>{name}</span><i><em style={{width:`${Math.max(6,Math.min(100,(num(s.inventory_value)/Math.max(1,num(topValue[0]?.inventory_value)))*100))}%`}} /></i><b>{money(s.inventory_value)}</b></button>})}</div></div>
    </div>
    <div className="two-col">
      <div className="panel"><div className="panel-head"><h3>Топ по валовой прибыли</h3><span className="muted">за выбранный день</span></div>{profitable.length?<div className="profit-list">{profitable.map((r:any)=><button key={r.name} onClick={()=>{}}><span><b>{r.name}</b><small>{money(r.out_sum)} отгрузка · {qty(r.out_kg)} кг</small></span><strong className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}<em>{num(r.margin).toFixed(1)}%</em></strong></button>)}</div>:<div className="muted">Сегодня ещё нет отгрузок.</div>}</div>
      <div className="panel"><div className="panel-head"><h3>Товары без движения</h3><span className="muted">14+ дней</span></div>{noMove.length?<div className="detail-list monitor-detail-list">{noMove.map((x:any)=><div className="detail-row compact" key={x.p.id}><div><b>{x.p.name}</b><span>{x.last?`Последняя операция ${x.last.operation_date}`:'Операций ещё не было'}</span></div><strong>{x.days===999?'—':x.days+' дн.'}</strong><small>{qty(x.kg)} кг на складе</small></div>)}</div>:<div className="empty-state compact"><b>Все товары двигаются</b><span>Нет позиций без движения 14+ дней.</span></div>}</div>
    </div>
  </section>
}

function OperationView(p:any){
  const {mode,setMode,contractors,contractorId,setContractorId,date,setDate,activeProducts,rowByProduct,updateRow,clearPrices,toggleClear,filled,total,stock,busy,submit}=p;
  const stockMap:any=Object.fromEntries(stock.map((s:any)=>[s.product_id,num(s.quantity_kg)]));
  const modeLabel=mode==='ARRIVAL'?'приход':'отгрузку';
  return <section className="sheet-screen">
    <div className="panel operation-head">
      <div className="mode-toggle"><button className={mode==='ARRIVAL'?'on in':''} onClick={()=>setMode('ARRIVAL')}>＋ Приход</button><button className={mode==='SHIPMENT'?'on out':''} onClick={()=>setMode('SHIPMENT')}>− Отгрузка</button></div>
      <div className="meta-grid">
        <label>Контрагент<select value={contractorId} onChange={e=>setContractorId(e.target.value)}><option value="">Выберите…</option>{contractors.map((c:any)=><option key={c.id} value={c.id}>{c.name}{c.group_name?' · '+c.group_name:''}</option>)}</select></label>
        <label>Дата<input type="date" value={date} max={dateNow()} onChange={e=>setDate(e.target.value)}/></label>
        <label className="check-wrap"><input type="checkbox" checked={clearPrices} onChange={e=>toggleClear(e.target.checked)}/> Стереть цены</label>
      </div>
    </div>
    <div className="mobile-entry-hint">📱 На телефоне: нажмите поле и вводите с цифровой клавиатуры. Цена, кг и сумма считаются взаимосвязано. Система не меняет кг, пока вы вводите сумму при заданном количестве.</div>
    <div className="sheet-grid mobile-friendly-entry">
      <div className="sheet-row sheet-header"><span>Товар</span><span>Цена / кг</span><span>Кг</span><span>Сумма</span><span>Отход</span><span>Остаток</span></div>
      {activeProducts.map((prod:Product)=>{
        const r=rowByProduct(prod.id); const av=stockMap[prod.id]||0; const over=mode==='SHIPMENT'&&num(r.kg)>av+1e-6;
        return <div className={'sheet-row '+(num(r.kg)>0?'filled ':'')+(over?'danger-row':'')} key={prod.id}>
          <strong>{prod.name}</strong>
          <label className="cell-field"><span>Цена</span><input aria-label={`Цена ${prod.name}`} value={r.price} onChange={e=>updateRow(prod.id,'price',e.target.value)} inputMode="decimal" placeholder="Цена"/></label>
          <label className="cell-field"><span>Кг</span><input aria-label={`Кг ${prod.name}`} value={r.kg} onChange={e=>updateRow(prod.id,'kg',e.target.value)} inputMode="decimal" placeholder="Кг"/></label>
          <label className="cell-field"><span>Сумма</span><input aria-label={`Сумма ${prod.name}`} value={r.sum} onChange={e=>updateRow(prod.id,'sum',e.target.value)} inputMode="decimal" placeholder="Сумма"/></label>
          <label className="cell-field"><span>Отход</span><input aria-label={`Отход ${prod.name}`} value={r.waste} onChange={e=>updateRow(prod.id,'waste',e.target.value)} inputMode="decimal" placeholder="Отход"/></label>
          <span className={over?'stock-bad':'stock-cell'}>{qty(av)} кг</span>
        </div>
      })}
    </div>
    <div className="operation-foot">
      <div><b>Товаров заполнено:</b> {filled} <span className="muted">· {mode==='SHIPMENT'?'отгружаем':'принимаем'} только заполненные позиции</span></div>
      <div className="total-box"><span>Итого</span><strong>{money(total)}</strong><button className="primary large sticky-action" disabled={busy||!filled} onClick={submit}>{busy?'Сохранение…':mode==='ARRIVAL'?'Сохранить приход':'Отгрузить'}</button></div>
    </div>
  </section>
}

function JournalView(p:any){
  const clientOptions=(p.contractors as Contractor[]||[]).slice().sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  const productOptions=(p.products as Product[]||[]).slice().sort((a,b)=>num(a.sort_order)-num(b.sort_order)||a.name.localeCompare(b.name,'ru'));
  const ordered=(p.ops as Operation[]).slice().sort((a,b)=>a.operation_date<b.operation_date?1:-1);
  return <section>
    <div className="panel filters">
      <div className="filter-line journal-select-line">
        <label><span>Контрагент</span><select value={p.client||''} onChange={e=>p.setClient(e.target.value)}><option value="">Все контрагенты</option>{clientOptions.map(c=><option key={c.id} value={c.id}>{c.name}{c.group_name?` · ${c.group_name}`:''}</option>)}</select></label>
        <label><span>Товар</span><select value={p.product||''} onChange={e=>p.setProduct(e.target.value)}><option value="">Все товары</option>{productOptions.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label><span>С</span><input type="date" value={p.from} onChange={e=>p.setFrom(e.target.value)}/></label>
        <label><span>По</span><input type="date" value={p.to} onChange={e=>p.setTo(e.target.value)}/></label>
      </div>
      <div className="muted">Выбор из списка · найдено: {ordered.length} операций · отменённые остаются в истории</div>
    </div>
    <div className="journal-list">{ordered.map((o:Operation)=>{const focused=o.id===p.focusId;const badge=o.status==='CANCELLED'?'ОТМЕНЕНА':o.type==='ARRIVAL'?'ПРИХОД':'ОТГРУЗКА';const opTotal=o.items.reduce((s,i)=>s+i.sum,0);const cogs=o.type==='SHIPMENT'?o.items.reduce((s,i)=>s+i.cogs,0):0;const profit=opTotal-cogs;return <article id={'journal-op-'+o.id} className={'op-card '+(o.type==='SHIPMENT'?'shipment':'arrival')+(o.status==='CANCELLED'?' cancelled':'')+(focused?' focused':'')} key={o.id}>
      <div className="focus-label">{focused?'● Выбранная накладная':''}</div><div className="op-main"><div><div className="op-title">{o.contractor_name} <span className="op-badge">{badge}</span></div><div className="op-meta">Накладная № {o.operation_number} · {o.operation_date} · v{o.version}</div></div><div className="op-actions">{o.role!=='AUTO_REPLENISH'&&<><button onClick={()=>p.onRepeat(o)}>↻ Повторить</button><button onClick={()=>p.onHistory(o)}>История</button>{o.status==='CONFIRMED'?<><button onClick={()=>p.onEdit(o)}>Изменить</button><button className="danger" onClick={()=>p.onCancel(o)}>Отменить</button><button className="danger-outline" onClick={()=>p.onDelete(o)}>Удалить</button></>:<button onClick={()=>p.onRestore(o)}>Восстановить</button>}</>}</div></div>
      <div className="op-items">{o.items.map((i:Line)=>{const costPerKg=i.kg?i.cogs/i.kg:0;const gross=i.sum-i.cogs;return <div className={'op-item '+(p.focusProductId===i.product_id?'item-focus':'')} key={i.product_id}><span><b>{i.product_name}</b>{o.type==='SHIPMENT'&&<small className="op-subline">Продажа: {money(i.price)}/кг · Себестоимость: {money(costPerKg)}/кг · COGS: {money(i.cogs)} · Валовая: {gross>=0?'+':''}{money(gross)}{i.wasteKg>0?` · Отход: ${qty(i.wasteKg)} кг`:''}</small>}</span><span>{qty(i.kg)} кг × {money(i.price)}/кг</span><b>{money(i.sum)}</b></div>})}</div><div className="op-total"><span>{o.items.length} товаров{o.type==='SHIPMENT'?` · COGS ${money(cogs)} · Валовая прибыль ${profit>=0?'+':''}${money(profit)}`:''}</span><strong>{money(opTotal)}</strong></div>
    </article>})}{!ordered.length&&<div className="panel muted">Нет операций по выбранным фильтрам.</div>}</div>
  </section>
}

function SearchView({search,setSearch,run,results,onOpen}:{search:any;setSearch:(v:any)=>void;run:()=>void;results:any[];onOpen:(r:any)=>void}){
  return <section>
    <div className="panel filters"><div className="filter-line">
      <input placeholder="Контрагент" value={search.client} onChange={e=>setSearch({...search,client:e.target.value})}/>
      <input placeholder="Товар" value={search.product} onChange={e=>setSearch({...search,product:e.target.value})}/>
      <input type="date" value={search.from} onChange={e=>setSearch({...search,from:e.target.value})}/>
      <input type="date" value={search.to} onChange={e=>setSearch({...search,to:e.target.value})}/>
      </div><button className="primary" onClick={run}>Найти</button></div>
    <div className="panel">
      <div className="search-count">{results.length?`Результатов: ${results.length}`:'Введите фильтры и нажмите «Найти»'}</div>
      <table className="data-table"><thead><tr><th>Дата</th><th>Накладная</th><th>Контрагент</th><th>Тип</th><th>Товар</th><th>Кг</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>
        {results.map((r:any,i:number)=><tr key={r.operationId+'-'+r.productId+'-'+i} className="clickable-row search-row" onClick={()=>onOpen(r)}>
          <td>{r.operationDate}</td><td>№{r.operationNumber}</td><td>{r.contractor}</td><td>{r.type==='ARRIVAL'?'Приход':'Отгрузка'}</td><td><b>{r.product}</b><span className="row-link-hint">Открыть накладную →</span></td><td>{qty(r.quantity_kg)}</td><td>{money(r.unit_price)}</td><td>{money(r.total_amount)}</td>
        </tr>)}
      </tbody></table>
      {!results.length&&<div className="muted search-empty">Нет результатов.</div>}
    </div>
  </section>
}

function StockView({stock,products,onProduct}:{stock:any[];products:Product[];onProduct:(name:string)=>void}){
  return <section>
    <div className="stat-cards"><div><small>Товаров</small><b>{products.length}</b></div><div><small>Всего кг</small><b>{qty(stock.reduce((s:any,x:any)=>s+num(x.quantity_kg),0))}</b></div><div><small>Стоимость</small><b>{money(stock.reduce((s:any,x:any)=>s+num(x.inventory_value),0))}</b></div></div>
    <div className="panel">
      <table className="data-table"><thead><tr><th>Товар</th><th>Остаток кг</th><th>Средняя себестоимость</th><th>Стоимость</th></tr></thead>
      <tbody>{products.map((p:Product)=>{const s=stock.find((x:any)=>x.product_id===p.id)||{};return <tr key={p.id} className="clickable-row" onClick={()=>onProduct(p.name)}>
        <td><b>{p.name}</b><span className="row-link-hint">Открыть накладную →</span></td><td>{qty(s.quantity_kg)}</td><td>{money(s.avg_cost)}</td><td>{money(s.inventory_value)}</td>
      </tr>})}</tbody></table>
    </div>
  </section>
}

function ReportView({report,from,to,setFrom,setTo,load,onProduct,onClient,onGroup,reportView,setReportView}:{report:any;from:string;to:string;setFrom:(v:string)=>void;setTo:(v:string)=>void;load:()=>void;onProduct:(name:string)=>void;onClient:(name:string)=>void;onGroup:(name:string)=>void;reportView:'overview'|'gross';setReportView:(v:'overview'|'gross')=>void}){
  const t=report?.totals||{}; const profit=num(t.profit), margin=num(t.margin); const products:any[]=Array.isArray(report?.products)?report.products:[], clients:any[]=Array.isArray(report?.clients)?report.clients:[], groups:any[]=Array.isArray(report?.groups)?report.groups:[];
  const profitableProducts=[...products].sort((a:any,b:any)=>num(b.profit)-num(a.profit));
  const losingProducts=products.filter((r:any)=>num(r.profit)<0).sort((a:any,b:any)=>num(a.profit)-num(b.profit));
  const profitableClients=[...clients].sort((a:any,b:any)=>num(b.profit)-num(a.profit));
  const outKg=num(t.out_kg); const profitPerKg=outKg?profit/outKg:0;
  return <section className="report-screen">
    <div className="page-title-row"><div><h2 className="page-title">Отчёты</h2><div className="muted">Период → итог → валовая прибыль → детализация по товарам, клиентам и группам.</div></div><button className="primary" onClick={load}>↻ Обновить отчёт</button></div>
    <div className="panel report-toolbar"><div className="period-chips"><button className={'chip '+(reportView==='overview'?'on':'')} onClick={()=>setReportView('overview')}>Обзор</button><button className={'chip '+(reportView==='gross'?'on':'')} onClick={()=>setReportView('gross')}>Валовая прибыль</button></div><div className="report-dates"><label><span>С</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label><span>По</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div></div>
    {!report?<div className="panel empty-state"><b>Выберите период и обновите отчёт</b><span>Показатели появятся здесь.</span><button className="primary" onClick={load}>Загрузить</button></div>: reportView==='gross'?<>
      <div className="stat-cards report-kpis"><div><small>Выручка от отгрузки</small><b>{money(t.out_sum)}</b><span>{qty(t.out_kg)} кг</span></div><div><small>COGS</small><b>{money(t.cogs)}</b><span>Себестоимость реализованного металла</span></div><div><small>Валовая прибыль</small><b className={profit>=0?'green':'red'}>{profit>=0?'+':''}{money(profit)}</b><span>Прибыль на кг: {money(profitPerKg)}</span></div><div><small>Валовая маржа</small><b className={margin>=0?'green':'red'}>{margin.toFixed(1)}%</b><span>{num(t.out_count)} отгрузок</span></div></div>
      <div className="gross-banner"><div><small>Формула</small><b>Валовая прибыль = Отгрузка − COGS</b><span>Здесь учитывается себестоимость, а не закупочная выручка.</span></div><div className="gross-number">{profit>=0?'+':''}{money(profit)}</div></div>
      <div className="two-col"><div className="panel"><div className="panel-head"><h3>Самые прибыльные товары</h3><span className="muted">Нажмите — карточка товара</span></div><div className="profit-list">{profitableProducts.slice(0,8).map((r:any)=><button key={r.name} onClick={()=>onProduct(r.name)}><span><b>{r.name}</b><small>{money(r.out_sum)} отгрузка · {qty(r.out_kg)} кг</small></span><strong className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}<em>{num(r.margin).toFixed(1)}%</em></strong></button>)}</div></div><div className="panel"><div className="panel-head"><h3>Самые прибыльные клиенты</h3><span className="muted">Нажмите — карточка</span></div><div className="profit-list">{profitableClients.slice(0,8).map((r:any)=><button key={r.name} onClick={()=>onClient(r.name)}><span><b>{r.name}</b><small>{money(r.out_sum)} отгрузка</small></span><strong className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}<em>{num(r.margin).toFixed(1)}%</em></strong></button>)}</div></div></div><div className="panel"><div className="panel-head"><h3>Самые прибыльные группы</h3><span className="muted">Общая прибыль по всем участникам</span></div><div className="profit-list">{groups.slice().sort((a:any,b:any)=>num(b.profit)-num(a.profit)).slice(0,8).map((r:any)=><button key={r.name} onClick={()=>onGroup(r.name)}><span><b>◉ {r.name}</b><small>{money(r.out_sum)} отгрузка</small></span><strong className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}<em>{num(r.margin).toFixed(1)}%</em></strong></button>)}</div></div>
      <div className="panel"><div className="panel-head"><h3>Товары с отрицательной валовой прибылью</h3><span className="muted">Требуют проверки цены продажи или себестоимости</span></div>{losingProducts.length?<table className="data-table"><thead><tr><th>Товар</th><th>Отгрузка</th><th>COGS</th><th>Убыток</th><th>Маржа</th></tr></thead><tbody>{losingProducts.map((r:any)=><tr className="clickable-row" key={r.name} onClick={()=>onProduct(r.name)}><td data-label="Товар"><b>{r.name}</b></td><td data-label="Отгрузка">{money(r.out_sum)}</td><td data-label="COGS">{money(r.cogs)}</td><td data-label="Убыток" className="red">{money(r.profit)}</td><td data-label="Маржа">{num(r.margin).toFixed(1)}%</td></tr>)}</tbody></table>:<div className="empty-state compact"><b>Убыточных товаров не найдено</b><span>За выбранный период все реализованные позиции дали нулевую или положительную валовую прибыль.</span></div>}</div>
    </>:<>
      <div className="stat-cards report-kpis"><div><small>Приход</small><b className="green">{money(t.in_sum)}</b><span>{qty(t.in_kg)} кг · {num(t.in_count)} накладных</span></div><div><small>Отгрузка</small><b className="red">{money(t.out_sum)}</b><span>{qty(t.out_kg)} кг · {num(t.out_count)} накладных</span></div><div><small>COGS</small><b>{money(t.cogs)}</b></div><div><small>Валовая прибыль</small><b className={profit>=0?'green':'red'}>{profit>=0?'+':''}{money(profit)}</b><span>Маржа: {margin.toFixed(1)}%</span></div></div>
      <div className="two-col"><div className="panel"><div className="panel-head"><h3>По товарам</h3><span className="muted">Нажмите на товар</span></div><table className="data-table"><thead><tr><th>Товар</th><th>Приход</th><th>Отгрузка</th><th>COGS</th><th>Прибыль</th><th>Маржа</th></tr></thead><tbody>{products.map((r:any)=><tr key={r.name} className="clickable-row" onClick={()=>onProduct(r.name)}><td data-label="Товар"><b>{r.name}</b></td><td data-label="Приход">{money(r.in_sum)}</td><td data-label="Отгрузка">{money(r.out_sum)}</td><td data-label="COGS">{money(r.cogs)}</td><td data-label="Прибыль" className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}</td><td data-label="Маржа">{num(r.margin).toFixed(1)}%</td></tr>)}</tbody></table></div><div className="panel"><div className="panel-head"><h3>По клиентам</h3><span className="muted">Нажмите на клиента</span></div><table className="data-table"><thead><tr><th>Контрагент</th><th>Приход</th><th>Отгрузка</th><th>COGS</th><th>Прибыль</th><th>Маржа</th></tr></thead><tbody>{clients.map((r:any)=><tr key={r.name} className="clickable-row" onClick={()=>onClient(r.name)}><td data-label="Товар"><b>{r.name}</b></td><td data-label="Приход">{money(r.in_sum)}</td><td data-label="Отгрузка">{money(r.out_sum)}</td><td data-label="COGS">{money(r.cogs)}</td><td data-label="Прибыль" className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}</td><td data-label="Маржа">{num(r.margin).toFixed(1)}%</td></tr>)}</tbody></table></div></div><div className="panel"><div className="panel-head"><h3>По группам</h3><span className="muted">Нажмите — общая карточка группы</span></div>{groups.length?<table className="data-table"><thead><tr><th>Группа</th><th>Приход</th><th>Отгрузка</th><th>COGS</th><th>Прибыль</th></tr></thead><tbody>{groups.map((r:any)=><tr key={r.name} className="clickable-row" onClick={()=>onGroup(r.name)}><td data-label="Группа"><b>◉ {r.name}</b></td><td data-label="Приход">{money(r.in_sum)}</td><td data-label="Отгрузка">{money(r.out_sum)}</td><td data-label="COGS">{money(r.cogs)}</td><td data-label="Прибыль" className={num(r.profit)>=0?'green':'red'}>{num(r.profit)>=0?'+':''}{money(r.profit)}</td></tr>)}</tbody></table>:<div className="empty-state compact"><b>Групп пока нет</b><span>Создайте группу в разделе «Контрагенты».</span></div>}</div>
    </>}
  </section>
}

function ClientsView(p:any){return <section><div className="two-col"><div className="panel"><h3>Контрагенты</h3><div className="inline-add"><input placeholder="Новый контрагент" value={p.newClient} onChange={e=>p.setNewClient(e.target.value)}/><button className="primary" onClick={p.createClient}>Добавить</button></div><div className="client-list">{(p.contractors as any[]).map((c:any)=><div key={c.id} className="list-row-wrap"><button className="list-row" onClick={()=>p.onClient(c)}><span>{c.name}</span><span>{c.group_name||'—'}</span></button><button className="icon-danger" title="Удалить" onClick={()=>p.onDeleteClient(c)}>×</button></div>)}</div></div><div className="panel"><h3>Группы</h3><div className="inline-add"><input placeholder="Общий: Димаш" value={p.groupForm.parent} onChange={e=>p.setGroupForm({...p.groupForm,parent:e.target.value})}/><input placeholder="Мини: Димаш Баглан" value={p.groupForm.child} onChange={e=>p.setGroupForm({...p.groupForm,child:e.target.value})}/><button className="primary" onClick={p.createGroup}>Создать</button></div>{(p.groups as any[]).map((g:any)=><div className="group-box" key={g.id}><div className="group-title-row"><button className="group-title" onClick={()=>p.onGroup(g)}>◉ {g.name}<span>{p.expanded[g.id]?'▴':'▾'}</span></button><button className="icon-danger" title="Удалить группу" onClick={()=>p.onDeleteGroup(g)}>×</button></div>{p.expanded[g.id]&&<div className="group-children">{(g.children as any[]).map((c:any)=><button className="group-child-link" key={c.id} onClick={()=>p.onClient(c)}>↳ {c.name}</button>)}</div>}</div>)}</div></div></section>}

function ProductsView(p:any){const ordered=[...(p.products||[])].sort((a:any,b:any)=>num(a.sort_order)-num(b.sort_order));return <section><div className="panel"><h3>Добавить / изменить товар</h3><div className="inline-add"><input placeholder="Название" value={p.newProduct.name} onChange={e=>p.setNewProduct({...p.newProduct,name:e.target.value})}/><input placeholder="Цена по умолчанию" type="number" value={p.newProduct.price} onChange={e=>p.setNewProduct({...p.newProduct,price:e.target.value})}/><button className="primary" onClick={p.createProduct}>Сохранить</button></div><p className="muted">Порядок ниже используется в приходе, отгрузке, остатках и карточках. На телефоне можно двигать товар кнопками ↑ ↓.</p></div><div className="panel"><div className="product-order-list">{ordered.map((x:any,i:number)=><div className="product-order-row" key={x.id}><div className="product-order-grip">☰</div><div className="product-order-name"><b>{x.name}</b><span>{money(x.default_price)} · {x.status}</span></div><div className="product-order-actions"><button disabled={i===0} onClick={()=>p.onMove(x.id,-1)}>↑</button><button disabled={i===ordered.length-1} onClick={()=>p.onMove(x.id,1)}>↓</button><button className="link-btn" onClick={()=>p.onPrice(x)}>Цена</button></div></div>)}</div></div></section>}

function ControlView({control,run}:{control:any;run:()=>void}){return <section><div className="panel control-head"><div><h2>Контроль склада</h2><p className="muted">Проверка целостности операций, остатков и справочников.</p></div><button className="primary" onClick={run}>Запустить проверку</button></div>{control?<div className={'control-result '+(control.ok?'ok':'bad')}><h3>{control.ok?'Система в порядке ✅':'Найдены проблемы ⚠️'}</h3>{(control.errors||[]).map((e:string,i:number)=><div key={i}>❌ {e}</div>)}{(control.warnings||[]).map((e:string,i:number)=><div key={i}>⚠️ {e}</div>)}<div className="muted">Проверено: {control.checked_at}</div></div>:<div className="panel muted">Нажмите «Запустить проверку».</div>}</section>}

function EditModal({op,contractors,products,onClose,onSave}:{op:Operation;contractors:Contractor[];products:Product[];onClose:()=>void;onSave:(p:any)=>void}){const [cid,setCid]=useState(op.contractor_id);const [date,setDate]=useState(op.operation_date);const [items,setItems]=useState(op.items.map((i:any)=>({...i,kg:String(i.kg),price:String(i.price),sum:String(i.sum),wasteKg:String(i.wasteKg)})));const update=(idx:number,key:string,v:string)=>setItems(a=>a.map((x,i)=>i===idx?{...x,[key]:v}:x));return <div className="modal-wrap"><div className="modal"><h2>Изменить операцию №{op.operation_number}</h2><div className="meta-grid"><label>Контрагент<select value={cid} onChange={e=>setCid(e.target.value)}>{contractors.map((c:Contractor)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Дата<input type="date" max={dateNow()} value={date} onChange={e=>setDate(e.target.value)}/></label></div><div className="edit-table">{items.map((i:any,idx:number)=><div className="sheet-row" key={i.product_id}><b>{i.product_name}</b><input value={i.price} onChange={e=>update(idx,'price',e.target.value)}/><input value={i.kg} onChange={e=>update(idx,'kg',e.target.value)}/><input value={i.sum} onChange={e=>update(idx,'sum',e.target.value)}/><input value={i.wasteKg} onChange={e=>update(idx,'wasteKg',e.target.value)}/></div>)}</div><div className="modal-actions"><button onClick={onClose}>Отмена</button><button className="primary" onClick={()=>onSave({contractorId:cid,operationDate:date,items:items.map((i:any)=>({product_id:i.product_id,name:i.product_name,kg:num(i.kg),price:num(i.price),wasteKg:num(i.wasteKg)}))})}>Сохранить</button></div></div></div>}
function HistoryModal({op,rows,onClose}:{op:Operation;rows:any[];onClose:()=>void}){return <div className="modal-wrap"><div className="modal"><h2>История №{op.operation_number}</h2>{!rows.length&&<div className="muted">Изменений нет.</div>}{rows.map((r:any)=><div className="history-row" key={r.id}><strong>{r.action}</strong><span>{new Date(r.created_at).toLocaleString('ru-RU')}</span><pre>{JSON.stringify({old:r.old_data,new:r.new_data},null,2)}</pre></div>)}<button onClick={onClose}>Закрыть</button></div></div>}
function ConfirmModal({title,text,onClose,onConfirm,confirmLabel='Да, отменить',danger=false}:{title:string;text:string;onClose:()=>void;onConfirm:()=>void;confirmLabel?:string;danger?:boolean}){return <div className="modal-wrap"><div className="modal small"><h2>{title}</h2><p>{text}</p><div className="modal-actions"><button onClick={onClose}>Назад</button><button className={danger?'danger-btn':'primary'} onClick={onConfirm}>{confirmLabel}</button></div></div></div>}
function ClientModal({client,ops,onClose,onOpenOperation}:{client:Contractor;ops:Operation[];onClose:()=>void;onOpenOperation:(operationId:string,productId?:string)=>void}){
  const [priceFilter,setPriceFilter]=useState<'all'|'in'|'out'>('all');
  const inPriceRef=useRef<HTMLDivElement|null>(null); const outPriceRef=useRef<HTMLDivElement|null>(null); const inListRef=useRef<HTMLDivElement|null>(null); const outListRef=useRef<HTMLDivElement|null>(null);
  const jumpToPrice=(mode:'in'|'out')=>{ setPriceFilter(mode); requestAnimationFrame(()=>requestAnimationFrame(()=>{ const el=mode==='in'?inListRef.current:outListRef.current; if(!el)return; const sc=el.closest('.modal') as HTMLElement|null; if(sc){ sc.scrollTo({top:Math.max(0,el.offsetTop-sc.clientHeight*0.18),behavior:'auto'}); } else { el.scrollIntoView({behavior:'auto',block:'start'}); } })); };
  const clientOps=useMemo(()=>ops.filter(o=>o.contractor_id===client.id).sort((a,b)=>a.operation_date<b.operation_date?1:-1),[ops,client.id]);
  const incoming=clientOps.filter((o:Operation)=>o.type==='ARRIVAL'&&o.status!=='CANCELLED');
  const outgoing=clientOps.filter((o:Operation)=>o.type==='SHIPMENT'&&o.status!=='CANCELLED');
  const inSum=incoming.flatMap(o=>o.items).reduce((s,i)=>s+i.sum,0); const outSum=outgoing.flatMap(o=>o.items).reduce((s,i)=>s+i.sum,0);
  const inKg=incoming.flatMap(o=>o.items).reduce((s,i)=>s+i.kg,0); const outKg=outgoing.flatMap(o=>o.items).reduce((s,i)=>s+i.kg,0);
  const pricePoint=(o:Operation)=>{const items=o.items;const kg=items.reduce((s,i)=>s+i.kg,0);return kg?items.reduce((s,i)=>s+i.price*i.kg,0)/kg:0};
  const renderChart=(list:Operation[], tone:'in'|'out')=>{const pts=list.slice(0,50);const max=Math.max(1,...pts.map(pricePoint));return <div className="mini-chart separated-price-chart">{pts.length?pts.map((o:Operation)=>{const v=pricePoint(o);const who=tone==='in'?`От кого: ${o.contractor_name}`:`Кому: ${o.contractor_name}`;return <button key={o.id} className={'mini-bar '+tone} title={`№${o.operation_number} · ${o.operation_date} · ${money(v)}/кг · ${who}`} onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><span style={{height:`${Math.max(8,(v/max)*100)}%`}}></span><em>{money(v)}</em><small>{tone==='in'?'От:':'Кому:'} {o.contractor_name}</small></button>}):<div className="muted">Нет операций</div>}</div>};
  return <div className="modal-wrap"><div className="modal modal-wide">
    <div className="modal-top"><div><div className="eyebrow">КАРТОЧКА КОНТРАГЕНТА</div><h2>{client.name}</h2><p className="muted">{client.group_name?`Группа: ${client.group_name}`:'Поставщик / покупатель'}</p></div><button className="modal-close" onClick={onClose}>×</button></div>
    <div className="detail-grid"><div className="detail-card"><small>Принимаем от них</small><b>{money(inSum)}</b><span>{qty(inKg)} кг · {incoming.length} накладных</span></div><div className="detail-card"><small>Отгружаем им</small><b>{money(outSum)}</b><span>{qty(outKg)} кг · {outgoing.length} накладных</span></div><div className="detail-card"><small>Всего накладных</small><b>{clientOps.length}</b><span>{incoming.length} приходов · {outgoing.length} отгрузок</span></div></div>
    <div className="price-toggle"><button className={priceFilter==='all'?'on':''} onClick={()=>setPriceFilter('all')}>Обе цены</button><button className={priceFilter==='in'?'on':''} onClick={()=>jumpToPrice('in')}>Цена прихода</button><button className={priceFilter==='out'?'on':''} onClick={()=>jumpToPrice('out')}>Цена отгрузки</button></div>
    <div className={priceFilter==='all'?'two-col price-dynamics-grid':'single-col price-dynamics-grid'}>
      {(priceFilter==='all'||priceFilter==='in')&&<div ref={inPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены прихода</h3><span className="muted">Средняя цена закупки</span></div>{renderChart(incoming,'in')}</div>}
      {(priceFilter==='all'||priceFilter==='out')&&<div ref={outPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены отгрузки</h3><span className="muted">Средняя цена продажи</span></div>{renderChart(outgoing,'out')}</div>}
    </div>
    <div className="two-col">
      <div className="panel"><div className="panel-head"><h3>История прихода</h3><span>{incoming.length}</span></div><div className="detail-list">{incoming.map((o:Operation)=><button key={o.id} className="detail-row" onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><div><b>№{o.operation_number}</b><span>{o.operation_date}</span></div><strong>{money(o.items.reduce((s,i)=>s+i.sum,0))}</strong><small>{qty(o.items.reduce((s,i)=>s+i.kg,0))} кг · Открыть накладную →</small></button>)}{!incoming.length&&<div className="muted">Нет приходов</div>}</div></div>
      <div className="panel"><div className="panel-head"><h3>История отгрузок</h3><span>{outgoing.length}</span></div><div className="detail-list">{outgoing.map((o:Operation)=>{const sum=o.items.reduce((s,i)=>s+i.sum,0);const cogs=o.items.reduce((s,i)=>s+i.cogs,0);const gross=sum-cogs;const kg=o.items.reduce((s,i)=>s+i.kg,0);return <button key={o.id} className="detail-row out" onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><div><b>№{o.operation_number}</b><span>{o.operation_date}</span></div><strong>{money(sum)}</strong><small>{qty(kg)} кг · себестоимость {money(cogs)} · валовая {gross>=0?'+':''}{money(gross)} · Открыть накладную →</small></button>})}{!outgoing.length&&<div className="muted">Нет отгрузок</div>}</div></div>
    </div>
  </div></div>}

function GroupModal({group,ops,contractors,onClose,onOpenOperation,onClient}:{group:Group;ops:Operation[];contractors:Contractor[];onClose:()=>void;onOpenOperation:(operationId:string,productId?:string)=>void;onClient:(c:Contractor)=>void}):any{
  const [priceFilter,setPriceFilter]=useState<'all'|'in'|'out'>('all');
  const inPriceRef=useRef<HTMLDivElement|null>(null); const outPriceRef=useRef<HTMLDivElement|null>(null); const inListRef=useRef<HTMLDivElement|null>(null); const outListRef=useRef<HTMLDivElement|null>(null);
  const jumpToPrice=(mode:'in'|'out')=>{ setPriceFilter(mode); requestAnimationFrame(()=>requestAnimationFrame(()=>{ const el=mode==='in'?inListRef.current:outListRef.current; if(!el)return; const sc=el.closest('.modal') as HTMLElement|null; if(sc){ sc.scrollTo({top:Math.max(0,el.offsetTop-sc.clientHeight*0.18),behavior:'auto'}); } else { el.scrollIntoView({behavior:'auto',block:'start'}); } })); };
  const [members,setMembers]=useState<Contractor[]>(group.children||contractors.filter(c=>c.group_id===group.id));
  const memberIds=new Set(members.map((c:any)=>c.id));
  useEffect(()=>setMembers(group.children||contractors.filter(c=>c.group_id===group.id)),[group.id,group.children,contractors]);
  const groupOps=ops.filter(o=>memberIds.has(o.contractor_id)&&o.status!=='CANCELLED').sort((a,b)=>a.operation_date<b.operation_date?1:-1);
  const arrivals=groupOps.filter((o:Operation)=>o.type==='ARRIVAL'); const shipments=groupOps.filter((o:Operation)=>o.type==='SHIPMENT');
  const inSum=arrivals.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0); const outSum=shipments.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const inKg=arrivals.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0); const outKg=shipments.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const last=groupOps[0]?.operation_date||'—';
  const pricePoint=(o:Operation)=>{const kg=o.items.reduce((s,i)=>s+i.kg,0);return kg?o.items.reduce((s,i)=>s+i.price*i.kg,0)/kg:0};
  const chart=(list:Operation[],tone:'in'|'out')=>{const pts=list.slice(0,50);const max=Math.max(1,...pts.map(pricePoint));return <div className="mini-chart separated-price-chart">{pts.length?pts.map((o:Operation)=>{const v=pricePoint(o);const who=tone==='in'?`От кого: ${o.contractor_name}`:`Кому: ${o.contractor_name}`;return <button key={o.id} className={'mini-bar '+tone} title={`№${o.operation_number} · ${o.operation_date} · ${money(v)}/кг · ${who}`} onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><span style={{height:`${Math.max(8,(v/max)*100)}%`}}></span><em>{money(v)}</em><small>{tone==='in'?'От:':'Кому:'} {o.contractor_name}</small></button>}):<div className="muted">Нет операций</div>}</div>};
  return <div className="modal-wrap"><div className="modal wide-modal"><div className="modal-top"><div><div className="eyebrow">КАРТОЧКА ГРУППЫ</div><h2>◉ {group.name}</h2><p className="muted">Общая отчётность по группе и всем участникам.</p></div><button className="modal-close" onClick={onClose}>×</button></div>
    <div className="stat-cards"><div><small>Участников</small><b>{members.length}</b></div><div><small>Приход</small><b className="green">{money(inSum)}</b><span>{qty(inKg)} кг · {arrivals.length} накладных</span></div><div><small>Отгрузка</small><b className="red">{money(outSum)}</b><span>{qty(outKg)} кг · {shipments.length} накладных</span></div><div><small>Последняя операция</small><b>{last}</b></div></div>
    <div className="price-toggle"><button className={priceFilter==='all'?'on':''} onClick={()=>setPriceFilter('all')}>Обе цены</button><button className={priceFilter==='in'?'on':''} onClick={()=>jumpToPrice('in')}>Цена прихода</button><button className={priceFilter==='out'?'on':''} onClick={()=>jumpToPrice('out')}>Цена отгрузки</button></div>
    <div className={priceFilter==='all'?'two-col price-dynamics-grid':'single-col price-dynamics-grid'}>{(priceFilter==='all'||priceFilter==='in')&&<div ref={inPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены прихода</h3><span className="muted">Средняя цена закупки</span></div>{chart(arrivals,'in')}</div>}{(priceFilter==='all'||priceFilter==='out')&&<div ref={outPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены отгрузки</h3><span className="muted">Средняя цена продажи</span></div>{chart(shipments,'out')}</div>}</div>
    <div className="panel"><div className="panel-head"><h3>Участники</h3><span className="muted">Нажмите для чистой карточки</span></div><div className="member-grid">{members.map((c:Contractor)=><button key={c.id} className="member-card" onClick={()=>onClient(c)}><b>{c.name}</b><span>{groupOps.filter((o:Operation)=>o.contractor_id===c.id).length} накладных</span></button>)}</div></div>
    <div className="two-col"><div ref={inListRef} className="panel"><div className="panel-head"><h3>Последние приходы</h3></div><div className="detail-list">{arrivals.slice(0,12).map((o:Operation)=><button key={o.id} className="detail-row" onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><div><b>№{o.operation_number}</b><span>{o.operation_date} · {o.contractor_name}</span></div><strong>{money(o.items.reduce((s,i)=>s+i.sum,0))}</strong><small>{o.items.length} товар(ов) · Открыть накладную →</small></button>)}</div></div><div ref={outListRef} className="panel"><div className="panel-head"><h3>Последние отгрузки</h3></div><div className="detail-list">{shipments.slice(0,12).map((o:Operation)=>{const sum=o.items.reduce((s,i)=>s+i.sum,0);const cogs=o.items.reduce((s,i)=>s+i.cogs,0);const gross=sum-cogs;return <button key={o.id} className="detail-row out" onClick={()=>onOpenOperation(o.id,o.items[0]?.product_id)}><div><b>№{o.operation_number}</b><span>{o.operation_date} · {o.contractor_name}</span></div><strong>{money(sum)}</strong><small>{o.items.length} товар(ов) · себестоимость {money(cogs)} · валовая {gross>=0?'+':''}{money(gross)} · Открыть накладную →</small></button>})}</div></div></div>
  </div></div>}

function ProductModal({product,stock,ops,onClose,onOpenOperation,supabase}:{product:Product;stock:any[];ops:Operation[];onClose:()=>void;onOpenOperation:(operationId:string,productId?:string)=>void;supabase:any}){
  const [priceFilter,setPriceFilter]=useState<'all'|'in'|'out'>('all');
  const inPriceRef=useRef<HTMLDivElement|null>(null); const outPriceRef=useRef<HTMLDivElement|null>(null); const inListRef=useRef<HTMLDivElement|null>(null); const outListRef=useRef<HTMLDivElement|null>(null);
  const jumpToPrice=(mode:'in'|'out')=>{ setPriceFilter(mode); requestAnimationFrame(()=>requestAnimationFrame(()=>{ const el=mode==='in'?inListRef.current:outListRef.current; if(!el)return; const sc=el.closest('.modal') as HTMLElement|null; if(sc){ sc.scrollTo({top:Math.max(0,el.offsetTop-sc.clientHeight*0.18),behavior:'auto'}); } else { el.scrollIntoView({behavior:'auto',block:'start'}); } })); };
  const s=stock.find((x:any)=>x.product_id===product.id)||{};
  const history=useMemo(()=>ops.filter(o=>o.status!=='CANCELLED'&&o.items.some(i=>i.product_id===product.id)).sort((a,b)=>a.operation_date<b.operation_date?1:-1),[ops,product.id]);
  const arrivals=history.filter(o=>o.type==='ARRIVAL'); const shipments=history.filter(o=>o.type==='SHIPMENT');
  const arrivalItems=arrivals.flatMap(o=>o.items.filter(i=>i.product_id===product.id));
  const shipmentItems=shipments.flatMap(o=>o.items.filter(i=>i.product_id===product.id));
  const avg=(items:Line[])=>{const kg=items.reduce((s,i)=>s+i.kg,0);return kg?items.reduce((s,i)=>s+i.price*i.kg,0)/kg:0};
  const avgIn=avg(arrivalItems); const avgOut=avg(shipmentItems);
  const [priceHist,setPriceHist]=useState<any[]>([]);
  useEffect(()=>{(async()=>{const {data}=await supabase.from('price_history').select('old_price,new_price,source,changed_at').eq('product_id',product.id).order('changed_at',{ascending:false}).limit(50);setPriceHist(data||[]);})();},[product.id,supabase]);
  const chart=(list:Operation[], tone:'in'|'out')=>{const pts=list.slice(0,50);const values=pts.map(o=>o.items.filter(i=>i.product_id===product.id).reduce((s,i)=>s+i.price,0)/(pts.length?Math.max(1,o.items.filter(i=>i.product_id===product.id).length):1));const max=Math.max(1,...values);return <div className="mini-chart price-chart separated-price-chart">{pts.length?pts.map((o:Operation)=>{const item=o.items.find((i:Line)=>i.product_id===product.id)!;return <button key={o.id} className={'mini-bar '+tone} title={`№${o.operation_number} · ${o.operation_date} · ${money(item.price)}/кг`} onClick={()=>onOpenOperation(o.id,product.id)}><span style={{height:`${Math.max(8,(item.price/max)*100)}%`}}></span><em>{money(item.price)}</em><small>{tone==='in'?'От:':'Кому:'} {o.contractor_name}</small></button>}):<div className="muted">Нет операций</div>}</div>};
  return <div className="modal-wrap"><div className="modal modal-wide">
    <div className="modal-top"><div><div className="eyebrow">КАРТОЧКА ТОВАРА</div><h2>{product.name}</h2><p className="muted">Цена по умолчанию: {money(product.default_price)}</p></div><button className="modal-close" onClick={onClose}>×</button></div>
    <div className="detail-grid"><div className="detail-card"><small>Остаток</small><b>{qty(s.quantity_kg)} кг</b><span>Средняя себестоимость: {money(s.avg_cost)}/кг</span></div><div className="detail-card"><small>Стоимость остатка</small><b>{money(s.inventory_value)}</b><span>Текущая средняя: {money(s.avg_cost)}/кг</span></div><div className="detail-card"><small>Движения</small><b>{history.length}</b><span>{arrivals.length} приходов · {shipments.length} отгрузок</span></div></div>
    <div className="price-toggle"><button className={priceFilter==='all'?'on':''} onClick={()=>setPriceFilter('all')}>Обе цены</button><button className={priceFilter==='in'?'on':''} onClick={()=>jumpToPrice('in')}>Цена прихода</button><button className={priceFilter==='out'?'on':''} onClick={()=>jumpToPrice('out')}>Цена отгрузки</button></div>
    <div className={priceFilter==='all'?'two-col price-dynamics-grid':'single-col price-dynamics-grid'}>{(priceFilter==='all'||priceFilter==='in')&&<div ref={inPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены прихода</h3><span className="muted">Средняя: {money(avgIn)}/кг</span></div>{chart(arrivals,'in')}</div>}{(priceFilter==='all'||priceFilter==='out')&&<div ref={outPriceRef} className="panel"><div className="panel-head"><h3>Динамика цены отгрузки</h3><span className="muted">Средняя: {money(avgOut)}/кг</span></div>{chart(shipments,'out')}</div>}</div>
    <div className="two-col"><div ref={inListRef} className="panel"><div className="panel-head"><h3>Цена прихода</h3><span className="muted">Фактическая цена закупки</span></div><div className="detail-list">{arrivals.map((o:Operation)=>{const i=o.items.find((x:Line)=>x.product_id===product.id)!;return <button key={o.id} className="detail-row" onClick={()=>onOpenOperation(o.id,product.id)}><div><b>№{o.operation_number}</b><span>{o.operation_date} · {o.contractor_name}</span></div><strong>{money(i.price)}/кг</strong><small>{qty(i.kg)} кг · {money(i.sum)} · Открыть накладную →</small></button>})}</div></div>
      <div ref={outListRef} className="panel"><div className="panel-head"><h3>Цена отгрузки</h3><span className="muted">Фактическая цена продажи</span></div><div className="detail-list">{shipments.map((o:Operation)=>{const i=o.items.find((x:Line)=>x.product_id===product.id)!;const costPerKg=i.kg?i.cogs/i.kg:0;const gross=i.sum-i.cogs;return <button key={o.id} className="detail-row out" onClick={()=>onOpenOperation(o.id,product.id)}><div><b>№{o.operation_number}</b><span>{o.operation_date} · {o.contractor_name}</span></div><strong>{money(i.price)}/кг</strong><small>{qty(i.kg)} кг · сумма отгрузки {money(i.sum)} · себестоимость {money(costPerKg)}/кг · COGS {money(i.cogs)} · валовая {gross>=0?'+':''}{money(gross)} · Открыть →</small></button>})}</div></div></div>
    <div className="panel"><div className="panel-head"><h3>История изменения справочной цены</h3><span>{priceHist.length}</span></div>{priceHist.map((h:any,i:number)=><div className="history-row" key={i}>{new Date(h.changed_at).toLocaleString('ru-RU')} · {money(h.old_price)} → {money(h.new_price)} · {h.source}</div>)}{!priceHist.length&&<div className="muted">Изменений справочной цены пока нет.</div>}</div>
  </div></div>}

function PriceModal({product,onClose,supabase,refresh}:{product:Product;onClose:()=>void;supabase:any;refresh:()=>void}){const [price,setPrice]=useState(String(product.default_price));const [hist,setHist]=useState<any[]>([]);useEffect(()=>{(async()=>{const {data}=await supabase.from('price_history').select('old_price,new_price,source,changed_at').eq('product_id',product.id).order('changed_at',{ascending:false}).limit(100);setHist(data||[]);})();},[product.id,supabase]);async function save(){const {error}=await supabase.rpc('upsert_product',{p_name:product.name,p_price:num(price)});if(error){alert(error.message);return}await refresh();onClose();}return <div className="modal-wrap"><div className="modal"><h2>Цена — {product.name}</h2><label>Текущая цена<input type="number" value={price} onChange={e=>setPrice(e.target.value)}/></label><button className="primary" onClick={save}>Сохранить</button><h3>История цен</h3>{hist.map((h:any,i:number)=><div className="history-row" key={i}>{new Date(h.changed_at).toLocaleString('ru-RU')} · {money(h.old_price)} → {money(h.new_price)} · {h.source}</div>)}<button onClick={onClose}>Закрыть</button></div></div>}

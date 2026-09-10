'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Product = { id:string; name:string; default_price:number; status:string; sort_order?:number };
type Contractor = { id:string; name:string; group_id:string|null; group_name?:string|null };
type Employee = { id:string; name:string };
type StockRow = { product_id:string; product_name:string; quantity_kg:number; avg_cost:number; inventory_value:number };
type Group = { id:string; name:string };
type OperationItem = { product_id:string; product_name:string; kg:number; price:number; sum:number; wasteKg:number; cogs:number };
type Operation = { id:string; operation_number:number; operation_date:string; type:'ARRIVAL'|'SHIPMENT'; role:string; status:string; contractor_id:string; contractor_name:string; created_at:string; note?:string; items:OperationItem[] };
type PointState = { products:Product[]; contractors:Contractor[]; groups:Group[]; employees:Employee[]; stock:StockRow[]; operations:Operation[] };
type EntryMode='PURCHASE'|'SHIPMENT'|'SALE'|'TRANSFER';
type Line = { kg:string; price:string; sum:string; sumTouched:boolean };
type EvenTab='work'|'stock'|'report';
type EveningExpense = { id:string; employee_name?:string|null; category:string; comment?:string|null; amount:number };
type EveningSummary = { id?:string; opening_cash?:number|null; brought_cash?:number|null; actual_cash?:number|null; expected_cash?:number|null; variance?:number|null; status?:string };
type EveningData = { summary?: EveningSummary; expenses?: EveningExpense[] };
type AuditRow = { id:string|number; created_at:string; action:string; user_display_name?:string|null; user_id?:string|null };
type PointReport = {
  totals?: { purchase_kg?:number; purchase_amount?:number; shipment_kg?:number; shipment_amount?:number; sale_kg?:number; sale_amount?:number; transfer_kg?:number; cogs?:number; sale_cogs?:number; expense_amount?:number };
  employees?: Array<{employee_id:string;employee_name:string;amount:number}>;
  categories?: Array<{category:string;amount:number}>;
  products?: Array<{name:string;stock_kg:number;purchase_kg:number;shipment_kg:number;sale_kg:number;purchase_amount:number;shipment_amount:number;sale_amount:number}>;
};

const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:0};
const moneyFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const kgFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3});
const money=(v:unknown)=>moneyFmt.format(num(v))+' ₸';
const qty=(v:unknown)=>kgFmt.format(num(v));
const today=()=>new Date().toISOString().slice(0,10);
const addDays=(date:string,days:number)=>{const d=new Date(`${date}T00:00:00`);d.setDate(d.getDate()+days);return d.toISOString().slice(0,10)};
const startOfMonth=(date:string)=>date.slice(0,8)+'01';

function mapState(raw:unknown):PointState{
  const obj=(raw&&typeof raw==='object')?raw as Record<string,unknown>:{};
  return {
    products:Array.isArray(obj.products)?obj.products as Product[]:[],
    contractors:Array.isArray(obj.contractors)?obj.contractors as Contractor[]:[],
    groups:Array.isArray(obj.groups)?obj.groups as Group[]:[],
    employees:Array.isArray(obj.employees)?obj.employees as Employee[]:[],
    stock:Array.isArray(obj.stock)?obj.stock as StockRow[]:[],
    operations:Array.isArray(obj.operations)?obj.operations as Operation[]:[],
  };
}

export default function PointApp(){
  const supabase=createClient();
  const [state,setState]=useState<PointState>(mapState({}));
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState('');
  const [date,setDate]=useState(today());
  const [tab,setTab]=useState<EvenTab>('work');
  const [entryMode,setEntryMode]=useState<EntryMode>('PURCHASE');
  const [rows,setRows]=useState<Record<string,Line>>({});
  const [evening,setEvening]=useState<EveningData|null>(null);
  const [eveningForm,setEveningForm]=useState({opening:'',brought:'',actual:''});
  const [expense,setExpense]=useState({employeeId:'',category:'Еда',comment:'',amount:''});
  const [newEmployee,setNewEmployee]=useState('');
  const [shipmentContractor,setShipmentContractor]=useState('');
  const [audit,setAudit]=useState<AuditRow[]>([]);
  const [report,setReport]=useState<PointReport|null>(null);
  const [reportFrom,setReportFrom]=useState(()=>addDays(today(),-6));
  const [reportTo,setReportTo]=useState(today());
  const [reportPeriod,setReportPeriod]=useState<'week'|'month'|'custom'>('week');
  const [newProduct,setNewProduct]=useState({name:'',price:''});
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({stock:false,journal:true,summary:true});

  const activeProducts=useMemo(()=>state.products.filter((p:Product)=>p.status==='ACTIVE').sort((a:Product,b:Product)=>(a.sort_order??0)-(b.sort_order??0)),[state.products]);
  const population=useMemo(()=>state.contractors.find((c:Contractor)=>c.name==='Население')?.id||state.contractors[0]?.id||'',[state.contractors]);
  const retail=useMemo(()=>state.contractors.find((c:Contractor)=>c.name==='Розничный покупатель')?.id||state.contractors.find((c:Contractor)=>c.name==='Внутреннее перемещение')?.id||state.contractors[0]?.id||'',[state.contractors]);
  const visibleContractors=useMemo(()=>state.contractors.filter((c:Contractor)=>!['Население','Розничный покупатель','Внутреннее перемещение'].includes(c.name)),[state.contractors]);

  const notify=(m:string)=>{setToast(m);window.setTimeout(()=>setToast(''),3200)};

  async function load(){
    setLoading(true);
    const {data,error}=await supabase.rpc('point_get_state');
    if(error){notify(error.message);setLoading(false);return;}
    setState(mapState(data));
    setLoading(false);
  }
  async function loadAudit(){
    const {data,error}=await supabase.rpc('point_get_audit_report',{p_from:date,p_to:date,p_limit:100});
    if(!error)setAudit(Array.isArray(data)?data:[]);
  }
  async function loadEvening(){
    const {data,error}=await supabase.rpc('point_get_evening_summary',{p_date:date});
    if(error){notify(error.message);return;}
    const parsed=(data??null) as unknown as EveningData|null;
    setEvening(parsed);
    const s:EveningSummary=parsed?.summary??{};
    setEveningForm({opening:s.opening_cash==null?'':String(s.opening_cash),brought:s.brought_cash==null?'':String(s.brought_cash),actual:s.actual_cash==null?'':String(s.actual_cash)});
  }
  async function loadReport(){
    const {data,error}=await supabase.rpc('point_get_report',{p_from:reportFrom,p_to:reportTo});
    if(error){notify(error.message);return;}
    setReport((data??{}) as PointReport);
  }

  useEffect(()=>{load();},[]);
  useEffect(()=>{loadEvening();loadAudit();},[date]);
  useEffect(()=>{if(tab==='report')loadReport();},[tab,reportFrom,reportTo]);

  function getLine(id:string):Line{
    const p=activeProducts.find((x:Product)=>x.id===id);
    return rows[id]||{kg:'',price:String(p?.default_price??0),sum:'',sumTouched:false};
  }
  function updateLine(id:string,field:'kg'|'price'|'sum',value:string){
    setRows(prev=>{
      const p=activeProducts.find((x:Product)=>x.id===id);
      const cur=prev[id]||{kg:'',price:String(p?.default_price??0),sum:'',sumTouched:false};
      const next={...cur,[field]:value};
      const k=num(next.kg),pr=num(next.price),s=next.sum===''?null:num(next.sum);
      if(field==='kg'){
        if(next.sumTouched&&k>0&&s!==null)next.price=String(s/k);
        else if(k>0)next.sum=(k*pr).toFixed(2);
      }
      if(field==='price'){
        if(k>0)next.sum=(k*pr).toFixed(2);
        next.sumTouched=false;
      }
      if(field==='sum'){
        next.sumTouched=true;
        if(k>0&&s!==null)next.price=String(s/k);
        else if(pr>0&&s!==null)next.kg=String(s/pr);
      }
      return {...prev,[id]:next};
    });
  }
  function clearEntry(){setRows({});}
  const entryItems=():Array<{product_id:string;kg:number;price:number;wasteKg:number}>=>activeProducts.map((p:Product)=>{const r=rows[p.id];if(!r||num(r.kg)<=0)return null;return {product_id:p.id,kg:num(r.kg),price:num(r.price),wasteKg:0};}).filter(Boolean) as Array<{product_id:string;kg:number;price:number;wasteKg:number}>;
  const entryTotal=entryItems().reduce((s,i)=>s+i.kg*i.price,0);
  const entryKg=entryItems().reduce((s,i)=>s+i.kg,0);

  async function submitEntry(){
    if(date>today())return notify('Дата не может быть в будущем');
    const items=entryItems();
    if(!items.length)return notify('Заполните хотя бы один товар');
    const contractorId=entryMode==='PURCHASE'?population:entryMode==='SALE'?retail:shipmentContractor;
    if(!contractorId)return notify('Выберите контрагента');
    setBusy(true);
    const pType:'ARRIVAL'|'SHIPMENT'=entryMode==='PURCHASE'?'ARRIVAL':'SHIPMENT';
    const note=entryMode==='PURCHASE'?'Закуп из тетради':entryMode==='SALE'?'[SALE] Розничная продажа':'Отгрузка из Точки';
    const {error}=await supabase.rpc('point_post_operation',{p_type:pType,p_contractor_id:contractorId,p_operation_date:date,p_items:items,p_note:note,p_idempotency_key:crypto.randomUUID()});
    setBusy(false);
    if(error)return notify(error.message);
    clearEntry();
    notify(entryMode==='PURCHASE'?'Закуп записан ✅':entryMode==='SALE'?'Продажа записана ✅':'Отгрузка записана ✅');
    await Promise.all([load(),loadEvening(),loadAudit()]);
  }

  async function transferSelected(){
    const items=activeProducts.map((p:Product)=>{const r=rows[p.id];return r&&num(r.kg)>0?{product_id:p.id,kg:num(r.kg)}:null}).filter(Boolean) as Array<{product_id:string;kg:number}>;
    if(items.length===0)return notify('Укажите количество для перемещения');
    if(items.length>1)return notify('Перемещайте по одному товару за операцию');
    setBusy(true);
    const item=items[0];
    const {error}=await supabase.rpc('point_transfer_to_angar',{p_product_id:item.product_id,p_quantity_kg:item.kg,p_note:'Перемещение Точка → Ангар',p_idempotency_key:crypto.randomUUID()});
    setBusy(false);
    if(error)return notify(error.message);
    clearEntry();
    notify('Перемещение в Ангар проведено ✅');
    await Promise.all([load(),loadEvening(),loadAudit()]);
  }

  async function saveEvening(){
    setBusy(true);
    const {error}=await supabase.rpc('point_save_evening_summary',{p_date:date,p_opening_cash:num(eveningForm.opening),p_brought_cash:num(eveningForm.brought),p_actual_cash:eveningForm.actual===''?null:num(eveningForm.actual),p_note:null});
    setBusy(false);
    if(error)return notify(error.message);
    notify('Вечерняя сводка сохранена ✅');
    await loadEvening();
  }
  async function addExpense(){
    if(!evening?.summary?.id)return notify('Сначала сохраните вечернюю сводку');
    if(num(expense.amount)<=0||!expense.category.trim())return notify('Укажите категорию и сумму');
    setBusy(true);
    const {error}=await supabase.rpc('point_add_evening_expense',{p_summary_id:evening.summary.id,p_employee_id:expense.employeeId||null,p_category:expense.category.trim(),p_comment:expense.comment,p_amount:num(expense.amount)});
    setBusy(false);
    if(error)return notify(error.message);
    setExpense({employeeId:'',category:'Еда',comment:'',amount:''});
    notify('Расход добавлен ✅');
    await loadEvening();
  }
  async function removeExpense(id:string){
    const {error}=await supabase.rpc('point_remove_evening_expense',{p_expense_id:id});
    if(error)return notify(error.message);
    notify('Расход удалён');
    await loadEvening();
  }
  async function addEmployee(){
    if(!newEmployee.trim())return notify('Введите имя сотрудника');
    const {error}=await supabase.rpc('point_upsert_employee',{p_name:newEmployee.trim()});
    if(error)return notify(error.message);
    setNewEmployee('');notify('Сотрудник добавлен ✅');await load();
  }
  async function addProduct(){
    const name=newProduct.name.trim();
    const price=num(newProduct.price);
    if(!name)return notify('Введите название товара');
    if(price<0)return notify('Цена не может быть отрицательной');
    setBusy(true);
    const {error}=await supabase.rpc('point_upsert_product',{p_name:name,p_price:price});
    setBusy(false);
    if(error)return notify(error.message);
    setNewProduct({name:'',price:''});
    notify('Товар добавлен в Точку ✅');
    await load();
  }
  async function checkDay(){
    const {data,error}=await supabase.rpc('point_check_day',{p_date:date});
    if(error)return notify(error.message);
    const result=(data??{}) as unknown as {ok?:boolean;errors?:string[]};
    if(result.ok)notify('День проверен — ошибок нет ✅');
    else notify((result.errors??[]).join(' · ')||'Есть замечания');
    await loadEvening();
  }
  async function closeDay(){
    const {error}=await supabase.rpc('point_close_day',{p_date:date});
    if(error)return notify(error.message);
    notify('День закрыт ✅');await loadEvening();await load();
  }
  async function reopenDay(){
    const reason=window.prompt('Причина переоткрытия дня');
    if(!reason?.trim())return;
    const {error}=await supabase.rpc('point_reopen_day',{p_date:date,p_reason:reason.trim()});
    if(error)return notify(error.message);
    notify('День переоткрыт ✅');await loadEvening();
  }

  function setPeriod(period:'week'|'month'|'custom'){
    const end=today();
    setReportPeriod(period);setReportTo(end);
    if(period==='week')setReportFrom(addDays(end,-6));
    if(period==='month')setReportFrom(startOfMonth(end));
  }

  if(loading)return <main className="warehouse-shell"><div className="page"><div className="panel empty-state"><b>Загрузка Точки…</b></div></div></main>;

  const stockMap=new Map<string,StockRow>(state.stock.map((x:StockRow)=>[x.product_id,x]));
  const productOrder=new Map<string,number>(activeProducts.map((p:Product,i:number)=>[p.id,i]));
  const sortItems=(items:OperationItem[])=>[...items].sort((a:OperationItem,b:OperationItem)=>(productOrder.get(a.product_id)??9999)-(productOrder.get(b.product_id)??9999));
  const dayOps:Operation[]=state.operations.filter((o:Operation)=>o.operation_date===date).sort((a:Operation,b:Operation)=>{const bd=new Date(b.created_at).getTime(),ad=new Date(a.created_at).getTime();return bd-ad||b.operation_number-a.operation_number;});
  const purchaseOps=dayOps.filter((o:Operation)=>o.role==='ARRIVAL');
  const shipmentOps=dayOps.filter((o:Operation)=>o.role==='SHIPMENT'&&!o.note?.startsWith('[SALE]')&&!o.note?.startsWith('[TRANSFER_TO_ANGAR]'));
  const saleOps=dayOps.filter((o:Operation)=>o.note?.startsWith('[SALE]'));
  const transferOps=dayOps.filter((o:Operation)=>o.note?.startsWith('[TRANSFER_TO_ANGAR]'));
  const purchaseKg=purchaseOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const purchaseAmount=purchaseOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const shipmentKg=shipmentOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const saleKg=saleOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const saleAmount=saleOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const transferKg=transferOps.reduce((s,o)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const exps=evening?.expenses??[];
  const expTotal=exps.reduce((s,e)=>s+num(e.amount),0);
  const expected=evening?.summary?.expected_cash;
  const variance=evening?.summary?.variance;
  const status=evening?.summary?.status||'DRAFT';
  const totalStockKg=state.stock.reduce((s,x)=>s+num(x.quantity_kg),0);
  const stockValue=state.stock.reduce((s,x)=>s+num(x.inventory_value),0);
  const quickModeLabel=entryMode==='PURCHASE'?'Закуп из тетради':entryMode==='SHIPMENT'?'Отгрузка':entryMode==='SALE'?'Продажа':'Перемещение в Ангар';
  const quickModeColor=entryMode==='PURCHASE'?'in':entryMode==='SHIPMENT'?'out':'neutral';
  const reportTotals=report?.totals||{};
  const reportEmployees=report?.employees||[];
  const reportCategories=report?.categories||[];
  const reportProducts=report?.products||[];
  const productIdByName=new Map<string,string>(activeProducts.map((p:Product)=>[p.name,p.id]));
  const orderedReportProducts=[...reportProducts].sort((a,b)=>(productOrder.get(productIdByName.get(a.name)??'')??9999)-(productOrder.get(productIdByName.get(b.name)??'')??9999));

  return <main className="warehouse-shell point-dashboard">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">◆</div><div><div className="brand-title">Точка</div><div className="brand-sub">Пункт приёмки · склад · вечерняя сверка</div></div></div>
      <div className="top-actions"><label className="point-date"><span>Рабочий день</span><input type="date" value={date} max={today()} onChange={e=>setDate(e.target.value)}/></label><button onClick={()=>{load();loadEvening();loadAudit();if(tab==='report')loadReport();}}>Обновить</button><a className="workspace-pill" href="/">← Режим</a></div>
    </header>

    <div className="point-page page">
      <section className="point-hero"><div><div className="eyebrow">ВЕЧЕРНЯЯ РАБОЧАЯ КНИГА</div><h1>Смена Точки</h1><p>Операции, склад, вечерняя сверка и отчёты собраны в одном рабочем окне.</p></div><div className={`day-state ${status.toLowerCase()}`}><span>Статус дня</span><b>{status}</b></div></section>

      <nav className="point-tabs" aria-label="Разделы Точки">
        <button className={tab==='work'?'active':''} onClick={()=>setTab('work')}>Рабочий день</button>
        <button className={tab==='stock'?'active':''} onClick={()=>setTab('stock')}>Склад</button>
        <button className={tab==='report'?'active':''} onClick={()=>{setTab('report');loadReport();}}>Отчёты</button>
      </nav>

      <section className="point-kpis">
        <div><span>Остаток металла</span><b>{qty(totalStockKg)} кг</b><small>{money(stockValue)}</small></div>
        <div><span>Куплено сегодня</span><b>{qty(purchaseKg)} кг</b><small>{money(purchaseAmount)}</small></div>
        <div><span>Отгружено</span><b>{qty(shipmentKg)} кг</b><small>за {date}</small></div>
        <div><span>Продажи</span><b>{money(saleAmount)}</b><small>{qty(saleKg)} кг</small></div>
        <div><span>Расходы</span><b>{money(expTotal)}</b><small>{exps.length} записей</small></div>
      </section>

      {tab==='work'&&<>
        <section className="point-book">
          <div className="book-title"><div><h2>1. Операции дня</h2><span>Проводи здесь — они сразу попадут в журнал и вечерний итог.</span></div><div className="quick-tags"><span>{dayOps.length} операций</span><span>Точка</span></div></div>
          <div className="point-modebar">{([['PURCHASE','＋ Закуп из тетради'],['SHIPMENT','↗ Отгрузка'],['SALE','₸ Продажа'],['TRANSFER','→ В Ангар']] as const).map(([m,l]:readonly [EntryMode,string])=><button key={m} className={`${entryMode===m?'active ':''}${m.toLowerCase()}`} onClick={()=>{setEntryMode(m);clearEntry();}}>{l}</button>)}</div>
          {entryMode==='SHIPMENT'&&<div className="entry-meta"><label>Контрагент<select value={shipmentContractor} onChange={e=>setShipmentContractor(e.target.value)}><option value="">Выберите</option>{visibleContractors.map((c:Contractor)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>}
          <div className="point-entry-grid">
            <div className="point-sheet"><div className="point-sheet-head"><span>Товар</span><span>Остаток</span><span>Кг</span><span>₸/кг</span><span>Сумма</span></div>{activeProducts.map((p:Product)=>{const r=getLine(p.id);const s=stockMap.get(p.id);const stock=num(s?.quantity_kg);const entered=num(r.kg);const insufficient=(entryMode==='SHIPMENT'||entryMode==='SALE'||entryMode==='TRANSFER')&&entered>stock+0.000001;return <div className={`point-sheet-row ${entered>0?'filled':''} ${insufficient?'bad':''}`} key={p.id}><div className="p-name"><b>{p.name}</b><small>{money(p.default_price)}/кг прайс</small></div><div className="p-stock">{qty(stock)} кг</div><input type="number" min="0" step="0.001" placeholder="кг" value={r.kg} onChange={e=>updateLine(p.id,'kg',e.target.value)}/><input type="number" min="0" step="0.01" placeholder="₸/кг" value={r.price} disabled={entryMode==='TRANSFER'} onChange={e=>updateLine(p.id,'price',e.target.value)}/><input type="number" min="0" step="0.01" placeholder="сумма" value={r.sum} onChange={e=>updateLine(p.id,'sum',e.target.value)}/></div>;})}</div>
            <aside className="entry-summary"><div className="entry-summary-top"><span>{quickModeLabel}</span><b>{qty(entryKg)} кг</b></div><div className="entry-total">{entryMode==='TRANSFER'?<><small>Стоимость по средней себестоимости</small><strong>{money(entryItems().reduce((s,i)=>{const st=stockMap.get(i.product_id);return s+num(st?.avg_cost)*i.kg},0))}</strong></>:<><small>Итого операции</small><strong>{money(entryTotal)}</strong></>}</div>{entryMode==='PURCHASE'&&<p>Вводи вечерний итог по тетради. Каждая строка станет приходом в склад Точки.</p>}{entryMode==='SHIPMENT'&&<p>Отгрузка проводится сразу. Остаток и себестоимость пересчитываются автоматически.</p>}{entryMode==='SALE'&&<p>Продажа случайному покупателю. Себестоимость берётся из текущего среднего остатка.</p>}{entryMode==='TRANSFER'&&<p>Перемещение в Ангар не является продажей или расходом.</p>}{entryMode==='TRANSFER'?<button className="primary large" disabled={busy} onClick={transferSelected}>{busy?'Проводим…':'Переместить в Ангар'}</button>:<button className={`primary large ${quickModeColor}`} disabled={busy} onClick={submitEntry}>{busy?'Сохраняем…':entryMode==='PURCHASE'?'Записать закупку':entryMode==='SALE'?'Продать':'Провести отгрузку'}</button>}<button className="ghost-btn" onClick={clearEntry}>Очистить ввод</button></aside>
          </div>
        </section>

        <section className="point-book evening-book"><div className="book-title"><div><div className="eyebrow">ГЛАВНОЕ ВЕЧЕРОМ</div><h2>2. Вечерняя сводка</h2><span>Ничего из проведённых операций заново не вводим — система сама подтягивает день.</span></div><div className="evening-badge">{status}</div></div><div className="evening-layout"><div className="evening-left"><div className="evening-summary-grid"><div><small>Закуплено</small><b>{qty(purchaseKg)} кг</b><span>{money(purchaseAmount)}</span></div><div><small>Отгружено</small><b>{qty(shipmentKg)} кг</b><span>из Точки</span></div><div><small>Продано</small><b>{qty(saleKg)} кг</b><span>{money(saleAmount)}</span></div><div><small>В Ангар</small><b>{qty(transferKg)} кг</b><span>перемещение</span></div></div><div className="notebook-box"><div className="notebook-title">Деньги</div><div className="money-grid"><label>Начальная касса<input type="number" value={eveningForm.opening} onChange={e=>setEveningForm(x=>({...x,opening:e.target.value}))}/></label><label>Принесли за день<input type="number" value={eveningForm.brought} onChange={e=>setEveningForm(x=>({...x,brought:e.target.value}))}/></label><label>Фактическая касса<input type="number" value={eveningForm.actual} onChange={e=>setEveningForm(x=>({...x,actual:e.target.value}))}/></label></div><div className="cash-check"><span>Ожидаемая касса</span><b>{expected==null?'—':money(expected)}</b><span>Расхождение</span><b className={variance==null?'':num(variance)===0?'ok':'warn'}>{variance==null?'—':money(variance)}</b></div></div></div><aside className="evening-actions"><button className="primary large" disabled={busy} onClick={saveEvening}>Сохранить сводку</button><button onClick={checkDay}>Проверить день</button><button className="primary-dark" onClick={closeDay}>Закрыть день</button>{status==='CLOSED'&&<button onClick={reopenDay}>Переоткрыть с причиной</button>}</aside></div></section>

        <section className="point-book"><div className="book-title"><div><h2>3. Расходы сотрудников</h2><span>Еда · аванс · бензин · доставка · прочее.</span></div><b>{money(expTotal)}</b></div><div className="expense-entry"><select value={expense.employeeId} onChange={e=>setExpense(x=>({...x,employeeId:e.target.value}))}><option value="">Без сотрудника</option>{state.employees.map((e:Employee)=><option key={e.id} value={e.id}>{e.name}</option>)}</select><select value={expense.category} onChange={e=>setExpense(x=>({...x,category:e.target.value}))}><option>Еда</option><option>Аванс</option><option>Бензин</option><option>Доставка</option><option>Зарплата</option><option>Хозяйственные</option><option>Прочее</option></select><input placeholder="Комментарий" value={expense.comment} onChange={e=>setExpense(x=>({...x,comment:e.target.value}))}/><input type="number" placeholder="Сумма" value={expense.amount} onChange={e=>setExpense(x=>({...x,amount:e.target.value}))}/><button className="primary" onClick={addExpense}>＋ Добавить</button></div><div className="expense-table"><div className="expense-head"><span>Сотрудник</span><span>Категория</span><span>Комментарий</span><span>Сумма</span><span></span></div>{exps.map((e:EveningExpense)=><div className="expense-row" key={e.id}><b>{e.employee_name||'Без сотрудника'}</b><span>{e.category}</span><span>{e.comment||'—'}</span><strong>{money(e.amount)}</strong><button onClick={()=>removeExpense(e.id)}>×</button></div>)}{!exps.length&&<div className="empty-state compact">За этот день расходов пока нет.</div>}</div><div className="employee-inline"><input placeholder="Добавить сотрудника" value={newEmployee} onChange={e=>setNewEmployee(e.target.value)}/><button onClick={addEmployee}>Сохранить сотрудника</button><span>Всего сотрудников: {state.employees.length}</span></div></section>

        <section className="point-book"><div className="book-title clickable-section" onClick={()=>setCollapsed(x=>({...x,journal:!x.journal}))}><div><h2>4. Что прошло за день</h2><span>Последняя добавленная накладная всегда сверху.</span></div><b>{collapsed.journal?'＋':'−'}</b></div>{!collapsed.journal&&<div className="day-ledger">{dayOps.length?dayOps.map(o=>{const isSale=o.note?.startsWith('[SALE]');const isTransfer=o.note?.startsWith('[TRANSFER_TO_ANGAR]');const isArrival=o.type==='ARRIVAL';const action=isSale?'ПРОДАЖА':isTransfer?'В АНГАР':isArrival?'ПРИЁМКА':'ОТГРУЗКА';const verb=isSale?'Продал':isTransfer?'Переместил':isArrival?'Привёз':'Увёз';const time=new Date(o.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});return <div className={`ledger-row ${isArrival?'in':'out'}`} key={o.id}><div className="ledger-main"><div className="ledger-meta"><b>№{o.operation_number}</b><span className="ledger-time">{time}</span></div><strong>{action}</strong><span className="ledger-person">{o.contractor_name} · {verb}</span></div><div className="ledger-items">{sortItems(o.items).map(i=><span key={i.product_id}><b>{i.product_name}</b> · {qty(i.kg)} кг · {money(i.sum)}</span>)}</div><div className="ledger-total">{money(o.items.reduce((s:number,i:OperationItem)=>s+i.sum,0))}</div></div>}) : <div className="empty-state compact">Сегодня операций ещё нет.</div>}</div>}</section>
      </>}

      {tab==='stock'&&<>
        <section className="point-book"><div className="book-title"><div><div className="eyebrow">СКЛАД ТОЧКИ</div><h2>Остатки и товары</h2><span>Просмотр текущего остатка, средней себестоимости и стоимости. Новый товар добавляется прямо сюда.</span></div><div className="evening-badge">{state.products.length} товаров</div></div><div className="stock-admin-grid"><div className="stock-add-card"><div className="notebook-title">Новый товар</div><div className="stock-add-fields"><input placeholder="Название товара" value={newProduct.name} onChange={e=>setNewProduct(x=>({...x,name:e.target.value}))}/><input type="number" min="0" step="0.01" placeholder="Цена по умолчанию ₸/кг" value={newProduct.price} onChange={e=>setNewProduct(x=>({...x,price:e.target.value}))}/><button className="primary" disabled={busy} onClick={addProduct}>＋ Добавить товар</button></div></div><div className="stock-totals-card"><span>Всего металла</span><b>{qty(totalStockKg)} кг</b><small>{money(stockValue)} по себестоимости</small></div></div></section>
        <section className="point-book"><div className="book-title"><div><h2>Склад по товарам</h2><span>Все активные товары Точки.</span></div></div><div className="compact-stock-grid stock-grid-wide">{[...state.stock].sort((a:StockRow,b:StockRow)=>(productOrder.get(a.product_id)??9999)-(productOrder.get(b.product_id)??9999)).map((s:StockRow)=><div className="compact-stock-card" key={s.product_id}><div><b>{s.product_name}</b><small>Прайс: {money(state.products.find(p=>p.id===s.product_id)?.default_price||0)}/кг</small></div><strong>{qty(s.quantity_kg)} кг</strong><span>{money(s.avg_cost)}/кг · {money(s.inventory_value)}</span></div>)}</div></section>
      </>}

      {tab==='report'&&<section className="report-screen">
        <div className="point-book"><div className="book-title"><div><div className="eyebrow">ОТЧЁТЫ ТОЧКИ</div><h2>Период и показатели</h2><span>Отдельный отчёт за неделю, месяц или выбранный период. Расходы сгруппированы по сотрудникам.</span></div></div><div className="report-toolbar"><div className="period-chips"><button className={`chip ${reportPeriod==='week'?'on':''}`} onClick={()=>setPeriod('week')}>7 дней</button><button className={`chip ${reportPeriod==='month'?'on':''}`} onClick={()=>setPeriod('month')}>Месяц</button><button className={`chip ${reportPeriod==='custom'?'on':''}`} onClick={()=>setReportPeriod('custom')}>Свой период</button></div><div className="report-dates"><label><span>С</span><input type="date" value={reportFrom} max={reportTo} onChange={e=>{setReportPeriod('custom');setReportFrom(e.target.value)}}/></label><label><span>По</span><input type="date" value={reportTo} min={reportFrom} max={today()} onChange={e=>{setReportPeriod('custom');setReportTo(e.target.value)}}/></label><button className="primary" onClick={loadReport}>Обновить</button></div></div></div>
        {!report?<div className="point-book empty-state"><b>Выберите период</b><span>Отчёт строится по складу Точки.</span></div>:<>
          <div className="stat-cards report-kpis"><div><small>Закуплено</small><b>{qty(reportTotals.purchase_kg)} кг</b><span>{money(reportTotals.purchase_amount)}</span></div><div><small>Отгружено</small><b>{qty(reportTotals.shipment_kg)} кг</b><span>{money(reportTotals.shipment_amount)}</span></div><div><small>Продано</small><b>{qty(reportTotals.sale_kg)} кг</b><span>{money(reportTotals.sale_amount)}</span></div><div><small>Расходы</small><b>{money(reportTotals.expense_amount)}</b><span>за период</span></div></div>
          <div className="two-col report-columns"><div className="point-book"><div className="book-title"><div><h2>По сотрудникам</h2><span>Сколько денег ушло каждому сотруднику.</span></div></div><div className="report-rows">{reportEmployees.map((e)=><div className="report-row" key={e.employee_id}><div><b>{e.employee_name}</b><small>Расходы за период</small></div><strong>{money(e.amount)}</strong></div>)}{!reportEmployees.length&&<div className="empty-state compact">Расходов по сотрудникам нет.</div>}</div></div><div className="point-book"><div className="book-title"><div><h2>По категориям</h2><span>На что ушли деньги.</span></div></div><div className="report-rows">{reportCategories.map((c)=><div className="report-row" key={c.category}><div><b>{c.category}</b><small>Расходы за период</small></div><strong>{money(c.amount)}</strong></div>)}{!reportCategories.length&&<div className="empty-state compact">Категорий нет.</div>}</div></div></div>
          <section className="point-book"><div className="book-title"><div><h2>По складу и товарам</h2><span>Что покупали, отгружали и сколько осталось.</span></div></div><div className="report-product-grid">{orderedReportProducts.map((p)=><div className="report-product-card" key={p.name}><b>{p.name}</b><span>Остаток: {qty(p.stock_kg)} кг</span><span>Приход: {qty(p.purchase_kg)} кг · {money(p.purchase_amount)}</span><span>Отгрузка: {qty(p.shipment_kg)} кг · {money(p.shipment_amount)}</span><span>Продажа: {qty(p.sale_kg)} кг · {money(p.sale_amount)}</span></div>)}</div></section>
        </>}
      </section>}

      <footer className="point-footer"><span>Точка · {date}</span><span>Операций: {dayOps.length} · Расходов: {exps.length} · Статус: <b>{status}</b></span></footer>
      {toast&&<div className="toast">{toast}</div>}
    </div>
  </main>;
}

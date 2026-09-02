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

const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:0};
const moneyFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const kgFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3});
const money=(v:unknown)=>moneyFmt.format(num(v))+' ₸';
const qty=(v:unknown)=>kgFmt.format(num(v));
const today=()=>new Date().toISOString().slice(0,10);

function mapState(raw:unknown):PointState{
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  return {
    products: Array.isArray(obj.products) ? obj.products as Product[] : [],
    contractors: Array.isArray(obj.contractors) ? obj.contractors as Contractor[] : [],
    groups: Array.isArray(obj.groups) ? obj.groups as Group[] : [],
    employees: Array.isArray(obj.employees) ? obj.employees as Employee[] : [],
    stock: Array.isArray(obj.stock) ? obj.stock as StockRow[] : [],
    operations: Array.isArray(obj.operations) ? obj.operations as Operation[] : [],
  };
}

type EntryMode='PURCHASE'|'SHIPMENT'|'SALE'|'TRANSFER';

type Line = { kg:string; price:string; sum:string; sumTouched:boolean };

export default function PointApp(){
  const supabase=createClient();
  const [state,setState]=useState<PointState>(mapState({}));
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [toast,setToast]=useState('');
  const [date,setDate]=useState(today());
  const [entryMode,setEntryMode]=useState<EntryMode>('PURCHASE');
  const [rows,setRows]=useState<Record<string,Line>>({});
  type EveningExpense = { id:string; employee_name?:string|null; category:string; comment?:string|null; amount:number };
  type EveningSummary = { id?:string; opening_cash?:number|null; brought_cash?:number|null; actual_cash?:number|null; expected_cash?:number|null; variance?:number|null; status?:string };
  type EveningData = { summary?: EveningSummary; expenses?: EveningExpense[] };
  const [evening,setEvening]=useState<EveningData|null>(null);
  const [eveningForm,setEveningForm]=useState({opening:'',brought:'',actual:''});
  const [expense,setExpense]=useState({employeeId:'',category:'Еда',comment:'',amount:''});
  const [newEmployee,setNewEmployee]=useState('');
  const [shipmentContractor,setShipmentContractor]=useState('');
  type AuditRow = { id:string|number; created_at:string; action:string; user_display_name?:string|null; user_id?:string|null };
  const [audit,setAudit]=useState<AuditRow[]>([]);
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({stock:false,journal:true,summary:true});

  const activeProducts=useMemo(()=>state.products.filter((p:Product)=>p.status==='ACTIVE'),[state.products]);
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
    if(!error) setAudit(Array.isArray(data)?data:[]);
  }
  async function loadEvening(){
    const {data,error}=await supabase.rpc('point_get_evening_summary',{p_date:date});
    if(error){notify(error.message);return;}
    const parsed = (data ?? null) as unknown as EveningData | null;
    setEvening(parsed);
    const s: EveningSummary = parsed?.summary ?? {};
    setEveningForm({opening:s.opening_cash==null?'':String(s.opening_cash),brought:s.brought_cash==null?'':String(s.brought_cash),actual:s.actual_cash==null?'':String(s.actual_cash)});
  }
  useEffect(()=>{load();},[]);
  useEffect(()=>{loadEvening();loadAudit();},[date]);

  function getLine(id:string):Line{
    const p=activeProducts.find((x:Product)=>x.id===id);
    return rows[id]||{kg:'',price:String(p?.default_price??0),sum:'',sumTouched:false};
  }
  function updateLine(id:string,field:'kg'|'price'|'sum',value:string){
    setRows(prev=>{
      const p=activeProducts.find((x:Product)=>x.id===id);
      const cur=prev[id]||{kg:'',price:String(p?.default_price??0),sum:'',sumTouched:false};
      const next={...cur,[field]:value};
      const k=num(next.kg), pr=num(next.price), s=next.sum===''?null:num(next.sum);
      if(field==='kg'){
        if(next.sumTouched&&k>0&&s!==null) next.price=String(s/k);
        else if(k>0) next.sum=(k*pr).toFixed(2);
      }
      if(field==='price'){
        if(k>0) next.sum=(k*pr).toFixed(2);
        next.sumTouched=false;
      }
      if(field==='sum'){
        next.sumTouched=true;
        if(k>0&&s!==null) next.price=String(s/k);
        else if(pr>0&&s!==null) next.kg=String(s/pr);
      }
      return {...prev,[id]:next};
    });
  }
  function clearEntry(){setRows({});}

  const entryItems=():Array<{product_id:string;kg:number;price:number;wasteKg:number}>=>activeProducts.map((p:Product)=>{const r=rows[p.id];if(!r||num(r.kg)<=0)return null;return {product_id:p.id,kg:num(r.kg),price:num(r.price),wasteKg:0};}).filter(Boolean) as any[];
  const entryTotal=entryItems().reduce((s,i)=>s+i.kg*i.price,0);
  const entryKg=entryItems().reduce((s,i)=>s+i.kg,0);

  async function submitEntry(){
    if(date>today())return notify('Дата не может быть в будущем');
    const items=entryItems();
    if(!items.length)return notify('Заполните хотя бы один товар');
    const contractorId=entryMode==='PURCHASE'?population:entryMode==='SALE'?retail:shipmentContractor;
    if(!contractorId)return notify('Выберите контрагента');
    setBusy(true);
    const pType: 'ARRIVAL'|'SHIPMENT' = entryMode==='PURCHASE'?'ARRIVAL':'SHIPMENT';
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
    const {error}=await supabase.rpc('point_transfer_to_angar',{p_product_id:item.product_id,p_quantity_kg:item.kg,p_note:'Перемещение Точка → Ангар'});
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
    setNewEmployee(''); notify('Сотрудник добавлен ✅'); await load();
  }
  async function checkDay(){
    const {data,error}=await supabase.rpc('point_check_day',{p_date:date});
    if(error)return notify(error.message);
    const result = (data ?? {}) as unknown as { ok?: boolean; errors?: string[] };
    if(result.ok) notify('День проверен — ошибок нет ✅');
    else notify((result.errors ?? []).join(' · ')||'Есть замечания');
    await loadEvening();
  }
  async function closeDay(){
    const {error}=await supabase.rpc('point_close_day',{p_date:date});
    if(error)return notify(error.message);
    notify('День закрыт ✅'); await loadEvening(); await load();
  }
  async function reopenDay(){
    const reason=window.prompt('Причина переоткрытия дня');
    if(!reason?.trim())return;
    const {error}=await supabase.rpc('point_reopen_day',{p_date:date,p_reason:reason.trim()});
    if(error)return notify(error.message);
    notify('День переоткрыт ✅'); await loadEvening();
  }

  if(loading)return <main className="warehouse-shell"><div className="page"><div className="panel empty-state"><b>Загрузка Точки…</b></div></div></main>;

  const stockMap=new Map<string,StockRow>(state.stock.map((x:StockRow)=>[x.product_id,x]));
  const dayOps:Operation[]=state.operations.filter((o:Operation)=>o.operation_date===date);
  const purchaseOps=dayOps.filter((o:Operation)=>o.role==='ARRIVAL');
  const shipmentOps=dayOps.filter((o:Operation)=>o.role==='SHIPMENT'&&!o.note?.startsWith('[SALE]')&&!o.note?.startsWith('[TRANSFER_TO_ANGAR]'));
  const saleOps=dayOps.filter((o:Operation)=>o.note?.startsWith('[SALE]'));
  const transferOps=dayOps.filter((o:Operation)=>o.note?.startsWith('[TRANSFER_TO_ANGAR]'));
  const purchaseKg=purchaseOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const purchaseAmount=purchaseOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const shipmentKg=shipmentOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const saleKg=saleOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const saleAmount=saleOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.sum,0),0);
  const transferKg=transferOps.reduce((s:number,o:Operation)=>s+o.items.reduce((a,i)=>a+i.kg,0),0);
  const exps=evening?.expenses ?? [];
  const expTotal=exps.reduce((s:number,e:EveningExpense)=>s+num(e.amount),0);
  const expected=evening?.summary?.expected_cash;
  const variance=evening?.summary?.variance;
  const status=evening?.summary?.status||'DRAFT';
  const totalStockKg=state.stock.reduce((s:number,x:StockRow)=>s+num(x.quantity_kg),0);
  const stockValue=state.stock.reduce((s:number,x:StockRow)=>s+num(x.inventory_value),0);

  const quickModeLabel=entryMode==='PURCHASE'?'Закуп из тетради':entryMode==='SHIPMENT'?'Отгрузка':entryMode==='SALE'?'Продажа':'Перемещение в Ангар';
  const quickModeColor=entryMode==='PURCHASE'?'in':entryMode==='SHIPMENT'?'out':'neutral';

  return <main className="warehouse-shell point-dashboard">
    <header className="topbar">
      <div className="brand">
        <div className="brand-icon">◆</div>
        <div><div className="brand-title">Точка</div><div className="brand-sub">Пункт приёмки · склад · вечерняя сверка</div></div>
      </div>
      <div className="top-actions">
        <label className="point-date"><span>Рабочий день</span><input type="date" value={date} max={today()} onChange={e=>setDate(e.target.value)}/></label>
        <button onClick={()=>{load();loadEvening();}}>Обновить</button>
        <a className="workspace-pill" href="/">← Режим</a>
      </div>
    </header>

    <div className="point-page page">
      <section className="point-hero">
        <div><div className="eyebrow">ВЕЧЕРНЯЯ РАБОЧАЯ КНИГА</div><h1>Смена Точки</h1><p>Всё в одном окне — как в тетрадке: операции за день, остатки, расходы, деньги и закрытие.</p></div>
        <div className={`day-state ${status.toLowerCase()}`}><span>Статус дня</span><b>{status}</b></div>
      </section>

      <section className="point-kpis">
        <div><span>Остаток металла</span><b>{qty(totalStockKg)} кг</b><small>{money(stockValue)}</small></div>
        <div><span>Куплено сегодня</span><b>{qty(purchaseKg)} кг</b><small>{money(purchaseAmount)}</small></div>
        <div><span>Отгружено</span><b>{qty(shipmentKg)} кг</b><small>за {date}</small></div>
        <div><span>Продажи</span><b>{money(saleAmount)}</b><small>{qty(saleKg)} кг</small></div>
        <div><span>Расходы</span><b>{money(expTotal)}</b><small>{exps.length} записей</small></div>
      </section>

      <section className="point-book">
        <div className="book-title"><div><h2>1. Операции дня</h2><span>Проводи здесь — они сразу попадут в журнал и вечерний итог.</span></div><div className="quick-tags"><span>{qty(dayOps.length)} операций</span><span>Точка</span></div></div>
        <div className="point-modebar">
          {([['PURCHASE','＋ Закуп из тетради'],['SHIPMENT','↗ Отгрузка'],['SALE','₸ Продажа'],['TRANSFER','→ В Ангар']] as const).map(([m,l]: readonly [EntryMode,string])=><button key={m} className={`${entryMode===m?'active ':''}${m.toLowerCase()}`} onClick={()=>{setEntryMode(m);clearEntry();}}>{l}</button>)}
        </div>

        {entryMode==='SHIPMENT'&&<div className="entry-meta"><label>Контрагент<select value={shipmentContractor} onChange={e=>setShipmentContractor(e.target.value)}><option value="">Выберите</option>{visibleContractors.map((c:Contractor)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>}
        <div className="point-entry-grid">
          <div className="point-sheet">
            <div className="point-sheet-head"><span>Товар</span><span>Остаток</span><span>Кг</span><span>Цена / кг</span><span>Сумма</span></div>
            {activeProducts.map((p:Product)=>{
              const r=getLine(p.id); const s=stockMap.get(p.id); const stock=num(s?.quantity_kg); const entered=num(r.kg); const insufficient=(entryMode==='SHIPMENT'||entryMode==='SALE'||entryMode==='TRANSFER')&&entered>stock+0.000001;
              return <div className={`point-sheet-row ${entered>0?'filled':''} ${insufficient?'bad':''}`} key={p.id}>
                <div className="p-name"><b>{p.name}</b><small>{money(p.default_price)}/кг прайс</small></div>
                <div className="p-stock">{qty(stock)} кг</div>
                <input type="number" min="0" step="0.001" placeholder="кг" value={r.kg} onChange={e=>updateLine(p.id,'kg',e.target.value)} />
                <input type="number" min="0" step="0.01" placeholder="₸/кг" value={r.price} disabled={entryMode==='TRANSFER'} onChange={e=>updateLine(p.id,'price',e.target.value)} />
                <input type="number" min="0" step="0.01" placeholder="сумма" value={r.sum} onChange={e=>updateLine(p.id,'sum',e.target.value)} />
              </div>;
            })}
          </div>
          <aside className="entry-summary">
            <div className="entry-summary-top"><span>{quickModeLabel}</span><b>{qty(entryKg)} кг</b></div>
            <div className="entry-total">{entryMode==='TRANSFER'?<><small>Стоимость по средней себестоимости</small><strong>{money(entryItems().reduce((s,i)=>{const st=stockMap.get(i.product_id);return s+num(st?.avg_cost)*i.kg},0))}</strong></>:<><small>Итого операции</small><strong>{money(entryTotal)}</strong></>}</div>
            {entryMode==='PURCHASE'&&<p>Вводи вечерний итог по тетради. Каждая строка станет приходом в склад Точки.</p>}
            {entryMode==='SHIPMENT'&&<p>Отгрузка проводится сразу. Остаток и себестоимость пересчитываются автоматически.</p>}
            {entryMode==='SALE'&&<p>Продажа случайному покупателю. Себестоимость берётся из текущего среднего остатка.</p>}
            {entryMode==='TRANSFER'&&<p>Перемещение в Ангар не является продажей или расходом.</p>}
            {entryMode==='TRANSFER'?<button className="primary large" disabled={busy} onClick={transferSelected}>{busy?'Проводим…':'Переместить в Ангар'}</button>:<button className={`primary large ${quickModeColor}`} disabled={busy} onClick={submitEntry}>{busy?'Сохраняем…':entryMode==='PURCHASE'?'Записать закупку':entryMode==='SALE'?'Продать':'Провести отгрузку'}</button>}
            <button className="ghost-btn" onClick={clearEntry}>Очистить ввод</button>
          </aside>
        </div>
      </section>

      <section className="point-book">
        <div className="book-title clickable-section" onClick={()=>setCollapsed(x=>({...x,stock:!x.stock}))}><div><h2>2. Склад Точки</h2><span>Что есть, по какой средней себестоимости и на какую сумму.</span></div><b>{collapsed.stock?'＋':'−'}</b></div>
        {!collapsed.stock&&<div className="compact-stock-grid">{state.stock.map((s:StockRow)=><div className="compact-stock-card" key={s.product_id}><div><b>{s.product_name}</b><small>{money(s.avg_cost)}/кг</small></div><strong>{qty(s.quantity_kg)} кг</strong><span>{money(s.inventory_value)}</span></div>)}</div>}
      </section>

      <section className="point-book evening-book">
        <div className="book-title"><div><div className="eyebrow">ГЛАВНОЕ ВЕЧЕРОМ</div><h2>3. Вечерняя сводка</h2><span>Ничего из проведённых операций заново не вводим — система сама подтягивает день.</span></div><div className="evening-badge">{status}</div></div>
        <div className="evening-layout">
          <div className="evening-left">
            <div className="evening-summary-grid">
              <div><small>Закуплено</small><b>{qty(purchaseKg)} кг</b><span>{money(purchaseAmount)}</span></div>
              <div><small>Отгружено</small><b>{qty(shipmentKg)} кг</b><span>из Точки</span></div>
              <div><small>Продано</small><b>{qty(saleKg)} кг</b><span>{money(saleAmount)}</span></div>
              <div><small>В Ангар</small><b>{qty(transferKg)} кг</b><span>перемещение</span></div>
            </div>
            <div className="notebook-box"><div className="notebook-title">Деньги</div><div className="money-grid"><label>Начальная касса<input type="number" value={eveningForm.opening} onChange={e=>setEveningForm(x=>({...x,opening:e.target.value}))}/></label><label>Принесли за день<input type="number" value={eveningForm.brought} onChange={e=>setEveningForm(x=>({...x,brought:e.target.value}))}/></label><label>Фактическая касса<input type="number" value={eveningForm.actual} onChange={e=>setEveningForm(x=>({...x,actual:e.target.value}))}/></label></div><div className="cash-check"><span>Ожидаемая касса</span><b>{expected==null?'—':money(expected)}</b><span>Расхождение</span><b className={variance==null?'':num(variance)===0?'ok':'warn'}>{variance==null?'—':money(variance)}</b></div></div>
          </div>
          <aside className="evening-actions"><button className="primary large" disabled={busy} onClick={saveEvening}>Сохранить сводку</button><button onClick={checkDay}>Проверить день</button><button className="primary-dark" onClick={closeDay}>Закрыть день</button>{status==='CLOSED'&&<button onClick={reopenDay}>Переоткрыть с причиной</button>}</aside>
        </div>
      </section>

      <section className="point-book">
        <div className="book-title"><div><h2>4. Расходы сотрудников</h2><span>Еда · аванс · бензин · доставка · прочее.</span></div><b>{money(expTotal)}</b></div>
        <div className="expense-entry"><select value={expense.employeeId} onChange={e=>setExpense(x=>({...x,employeeId:e.target.value}))}><option value="">Без сотрудника</option>{state.employees.map((e:Employee)=><option key={e.id} value={e.id}>{e.name}</option>)}</select><select value={expense.category} onChange={e=>setExpense(x=>({...x,category:e.target.value}))}><option>Еда</option><option>Аванс</option><option>Бензин</option><option>Доставка</option><option>Зарплата</option><option>Хозяйственные</option><option>Прочее</option></select><input placeholder="Комментарий" value={expense.comment} onChange={e=>setExpense(x=>({...x,comment:e.target.value}))}/><input type="number" placeholder="Сумма" value={expense.amount} onChange={e=>setExpense(x=>({...x,amount:e.target.value}))}/><button className="primary" onClick={addExpense}>＋ Добавить</button></div>
        <div className="expense-table"><div className="expense-head"><span>Сотрудник</span><span>Категория</span><span>Комментарий</span><span>Сумма</span><span></span></div>{exps.map((e:EveningExpense)=><div className="expense-row" key={e.id}><b>{e.employee_name||'Без сотрудника'}</b><span>{e.category}</span><span>{e.comment||'—'}</span><strong>{money(e.amount)}</strong><button onClick={()=>removeExpense(e.id)}>×</button></div>)}{!exps.length&&<div className="empty-state compact">За этот день расходов пока нет.</div>}</div>
        <div className="employee-inline"><input placeholder="Добавить сотрудника" value={newEmployee} onChange={e=>setNewEmployee(e.target.value)}/><button onClick={addEmployee}>Сохранить сотрудника</button><span>Всего сотрудников: {state.employees.length}</span></div>
      </section>

      <section className="point-book">
        <div className="book-title clickable-section" onClick={()=>setCollapsed(x=>({...x,journal:!x.journal}))}><div><h2>5. Что прошло за день</h2><span>История накапливается. Вечером ничего не переписываем.</span></div><b>{collapsed.journal?'＋':'−'}</b></div>
        {!collapsed.journal&&<div className="day-ledger">{dayOps.length?dayOps.map(o=><div className={`ledger-row ${o.type==='ARRIVAL'?'in':'out'}`} key={o.id}><div className="ledger-main"><b>№{o.operation_number}</b><strong>{o.note?.startsWith('[SALE]')?'Продажа':o.note?.startsWith('[TRANSFER_TO_ANGAR]')?'В Ангар':o.type==='ARRIVAL'?'Закуп':'Отгрузка'}</strong><span>{o.contractor_name}</span></div><div className="ledger-items">{o.items.map((i:OperationItem)=><span key={i.product_id}>{i.product_name} · {qty(i.kg)} кг</span>)}</div><div className="ledger-total">{money(o.items.reduce((s:number,i:OperationItem)=>s+i.sum,0))}</div></div>):<div className="empty-state compact">Сегодня операций ещё нет.</div>}</div>}
      </section>

      <section className="point-book">
        <div className="book-title clickable-section" onClick={()=>setCollapsed(x=>({...x,summary:!x.summary}))}>
          <div><h2>6. Итог дня и история</h2><span>Сводка по сотрудникам, категориям расходов и audit — здесь же, без переходов.</span></div><b>{collapsed.summary?'＋':'−'}</b>
        </div>
        {!collapsed.summary&&<div className="final-summary-grid">
          <div className="summary-panel"><h3>По сотрудникам</h3>{(() => { const m=new Map<string,number>(); exps.forEach((e)=>{const k=e.employee_name||'Без сотрудника';m.set(k,(m.get(k)||0)+num(e.amount));}); return [...m.entries()].map(([k,v])=><div className="summary-line" key={k}><span>{k}</span><b>{money(v)}</b></div>); })()}{!exps.length&&<div className="empty-state compact">Нет расходов.</div>}</div>
          <div className="summary-panel"><h3>По категориям</h3>{(() => { const m=new Map<string,number>(); exps.forEach((e)=>m.set(e.category,(m.get(e.category)||0)+num(e.amount))); return [...m.entries()].map(([k,v])=><div className="summary-line" key={k}><span>{k}</span><b>{money(v)}</b></div>); })()}{!exps.length&&<div className="empty-state compact">Нет расходов.</div>}</div>
          <div className="summary-panel summary-wide"><h3>Audit за день</h3>{audit.slice(0,12).map((a:AuditRow)=><div className="audit-line" key={String(a.id)}><span>{new Date(a.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</span><b>{a.action}</b><em>{a.user_display_name||a.user_id||'система'}</em></div>)}{!audit.length&&<div className="empty-state compact">Записей audit нет.</div>}</div>
        </div>}
      </section>

      <footer className="point-footer"><span>Точка · {date}</span><span>Операций: {dayOps.length} · Расходов: {exps.length} · Статус: <b>{status}</b></span></footer>
      {toast&&<div className="toast">{toast}</div>}
    </div>
  </main>;
}

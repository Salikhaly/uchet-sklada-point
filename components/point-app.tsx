'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import PointPayroll from './point-payroll';
import { DailyCharts } from './point-charts';

type Product = { id:string; name:string; default_price:number; status:string; sort_order?:number; category?:string|null };
const CATEGORY_ORDER=['Медь','Латунь','Алюминий','Нержавейка','Свинец','Цинк','Чёрный металл','Пластик','Электроника','Смешанное'];
function groupByCategory<T extends {category?:string|null}>(items:T[]):Array<{category:string;items:T[]}>{
  const map=new Map<string,T[]>();
  for(const it of items){const k=(it.category&&it.category.trim())||'Без категории';if(!map.has(k))map.set(k,[]);map.get(k)!.push(it);}
  const order=[...CATEGORY_ORDER,'Без категории'];
  const keys=[...map.keys()].sort((a,b)=>{const ia=order.indexOf(a),ib=order.indexOf(b);return (ia<0?999:ia)-(ib<0?999:ib);});
  return keys.map(k=>({category:k,items:map.get(k)!}));
}
function slugCat(c:string){return c.toLowerCase().replace(/[^a-zа-яё0-9]+/gi,'-').replace(/^-|-$/g,'')||'none';}
type Contractor = { id:string; name:string; group_id:string|null; group_name?:string|null };
type Employee = { id:string; name:string };
type ExpenseCategory = { id:string; name:string };
type StockRow = { product_id:string; product_name:string; category?:string|null; quantity_kg:number; avg_cost:number; inventory_value:number };
type Group = { id:string; name:string };
type OperationItem = { product_id:string; product_name:string; kg:number; price:number; sum:number; wasteKg:number; cogs:number };
type Operation = { id:string; operation_number:number; operation_date:string; type:'ARRIVAL'|'SHIPMENT'; role:string; status:string; contractor_id:string; contractor_name:string; created_at:string; note?:string; items:OperationItem[] };
type PointState = { products:Product[]; contractors:Contractor[]; groups:Group[]; employees:Employee[]; expenseCategories:ExpenseCategory[]; stock:StockRow[]; operations:Operation[] };
type EntryMode='PURCHASE'|'SHIPMENT'|'SALE'|'TRANSFER';
type Line = { kg:string; price:string; sum:string; sumTouched:boolean };
type EvenTab='work'|'stock'|'count'|'days'|'payroll'|'report';
type EveningExpense = { id:string; employee_id?:string|null; employee_name?:string|null; category:string; comment?:string|null; amount:number; is_loan?:boolean; repaid?:number };
type Repayment = { id:string; amount:number; note?:string|null; employee_name?:string|null; given_date?:string; category?:string };
type LoanRow = { expense_id:string; given_date:string; employee_name:string; category:string; comment?:string|null; amount:number; repaid:number; remaining:number; status:'UNPAID'|'PARTIAL'|'PAID'; repayments:Array<{id:string;date:string;amount:number;note?:string|null}> };
type EditItem = { product_id:string; name:string; kg:string; price:string; wasteKg:number };
type EditOp = { id:string; number:number; contractorId:string; date:string; items:EditItem[]; addProduct:string };
type DayRow = { date:string; status:string|null; ops:number; expenses:number; variance:number|null; has_comment:boolean };
type StocktakeItem = { product_name:string; system_kg:number; actual_kg:number; diff_kg:number; diff_cost:number };
type Stocktake = { id:string; date:string; reason:string; created_at:string; user_name?:string|null; items:StocktakeItem[] };
type EditExp = { id:string; employeeId:string; category:string; comment:string; amount:string; isLoan:boolean };
type ReopenRow = { id:number; date:string; reason:string; user_name:string; created_at:string };
type RepEmployee={employee_id:string;employee_name:string;expense_amount:number;loan_amount:number;total_amount:number;repaid_in_period:number;debt_remaining:number};
type PersonItem={date:string;category:string;amount:number;comment?:string|null;is_loan:boolean};
type PersonRep={employee_id:string|null;name:string;hidden:boolean;advance:number;salary:number;other:number;loan_given:number;total:number;repaid:number;debt_remaining:number;items:PersonItem[]};
type RepCategory={category:string;amount:number;count:number};
type RepDay={date:string;status:string|null;purchase_amount:number;purchase_kg:number;shipment_amount:number;sale_amount:number;expense_amount:number;loan_amount:number;repayment_amount:number;opening_cash:number|null;brought_cash:number|null;actual_cash:number|null;expected_cash:number|null;variance:number|null;ops:number;comment?:string|null};
const loanLabel={UNPAID:'Не погашен',PARTIAL:'Частично погашен',PAID:'Погашен'} as const;
type EveningSummary = { id?:string; opening_cash?:number|null; brought_cash?:number|null; actual_cash?:number|null; expected_cash?:number|null; variance?:number|null; status?:string; close_comment?:string|null; note?:string|null };
type EveningData = { prev_cash?:{date:string;actual_cash:number|null;status?:string}|null; summary?: EveningSummary; expenses?: EveningExpense[]; repayments?: Repayment[]; repayments_amount?:number };
type AuditRow = { id:string|number; created_at:string; action:string; user_display_name?:string|null; user_id?:string|null };
type PointReport = {
  totals?: { purchase_kg?:number; purchase_amount?:number; shipment_kg?:number; shipment_amount?:number; sale_kg?:number; sale_amount?:number; transfer_kg?:number; cogs?:number; sale_cogs?:number; expense_amount?:number; loan_given_amount?:number; repayment_amount?:number; brought_cash?:number; opening_cash_first?:number|null; actual_cash_last?:number|null; days_total?:number; days_closed?:number; days_variance?:number };
  employees?: RepEmployee[];
  categories?: RepCategory[];
  products?: Array<{name:string;category?:string|null;stock_kg:number;purchase_kg:number;shipment_kg:number;sale_kg:number;purchase_amount:number;shipment_amount:number;sale_amount:number}>;
  days?: RepDay[];
};

const num=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:0};
const moneyFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const kgFmt=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3});
const money=(v:unknown)=>moneyFmt.format(num(v))+' ₸';
const qty=(v:unknown)=>kgFmt.format(num(v));
const fmtDate=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today=()=>fmtDate(new Date());
const addDays=(date:string,days:number)=>{const [y,m,d]=date.split('-').map(Number);return fmtDate(new Date(y,m-1,d+days));};
const ruDate=(iso:string)=>{const [y,m,d]=iso.split('-').map(Number);return new Date(y,m-1,d).toLocaleDateString('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit'});};
const startOfMonth=(date:string)=>date.slice(0,8)+'01';

// ── Инфографика по дням (закуп и средняя цена металла) ──
// Общий формат: 100×36 viewBox, растягивается на всю ширину контейнера.
// Подписи дат показываем не под каждым баром (тесно при месяце), а раз в
// несколько дней, плюс полная дата видна в title при наведении/тапе.

function mapState(raw:unknown):PointState{
  const obj=(raw&&typeof raw==='object')?raw as Record<string,unknown>:{};
  return {
    products:Array.isArray(obj.products)?obj.products as Product[]:[],
    contractors:Array.isArray(obj.contractors)?obj.contractors as Contractor[]:[],
    groups:Array.isArray(obj.groups)?obj.groups as Group[]:[],
    employees:Array.isArray(obj.employees)?obj.employees as Employee[]:[],
    expenseCategories:Array.isArray(obj.expense_categories)?obj.expense_categories as ExpenseCategory[]:[],
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
  const [closeComment,setCloseComment]=useState('');
  const [loans,setLoans]=useState<LoanRow[]>([]);
  const [editOp,setEditOp]=useState<EditOp|null>(null);
  const [days,setDays]=useState<DayRow[]>([]);
  const [stocktakes,setStocktakes]=useState<Stocktake[]>([]);
  const [countRows,setCountRows]=useState<Record<string,string>>({});
  const [countReason,setCountReason]=useState('');
  const [editExp,setEditExp]=useState<EditExp|null>(null);
  const [newContractor,setNewContractor]=useState('');
  const [reopens,setReopens]=useState<ReopenRow[]>([]);
  const [clearPrices,setClearPrices]=useState(false);
  const [showPaidLoans,setShowPaidLoans]=useState(false);
  const [dayInfo,setDayInfo]=useState<{report:PointReport;evening:EveningData}|null>(null);
  const [expense,setExpense]=useState({employeeId:'',category:'',comment:'',amount:'',isLoan:false});
  const [newEmployee,setNewEmployee]=useState('');
  const [newCategory,setNewCategory]=useState('');
  const [shipmentContractor,setShipmentContractor]=useState('');
  const [audit,setAudit]=useState<AuditRow[]>([]);
  const [report,setReport]=useState<PointReport|null>(null);
  const [reportFrom,setReportFrom]=useState(()=>addDays(today(),-6));
  const [reportTo,setReportTo]=useState(today());
  const [reportPeriod,setReportPeriod]=useState<'week'|'month'|'custom'>('week');
  const [reportPeople,setReportPeople]=useState<PersonRep[]>([]);
  const [openPerson,setOpenPerson]=useState<Record<string,boolean>>({});
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
    const prefill=!parsed?.summary&&parsed?.prev_cash?.actual_cash!=null?String(parsed.prev_cash.actual_cash):'';
    setEveningForm({opening:s.opening_cash==null?prefill:String(s.opening_cash),brought:s.brought_cash==null?'':String(s.brought_cash),actual:s.actual_cash==null?'':String(s.actual_cash)});
    setCloseComment(s.close_comment??'');
  }
  function startEdit(o:Operation){
    setEditOp({id:o.id,number:o.operation_number,contractorId:o.contractor_id,date:o.operation_date,addProduct:'',items:sortItems(o.items).map((i:OperationItem)=>({product_id:i.product_id,name:i.product_name,kg:String(i.kg),price:String(i.price),wasteKg:i.wasteKg}))});
  }
  function patchEditItem(idx:number,patch:Partial<EditItem>){setEditOp(e=>e?{...e,items:e.items.map((it:EditItem,i:number)=>i===idx?{...it,...patch}:it)}:e);}
  function addEditProduct(id:string){
    const pr=activeProducts.find((x:Product)=>x.id===id);
    if(!pr)return;
    setEditOp(e=>e?{...e,addProduct:'',items:[...e.items,{product_id:pr.id,name:pr.name,kg:'',price:String(pr.default_price||''),wasteKg:0}].sort((a:EditItem,b:EditItem)=>(productOrder.get(a.product_id)??9999)-(productOrder.get(b.product_id)??9999))}:e);
  }
  async function saveEdit(){
    if(!editOp)return;
    const items=editOp.items.filter((i:EditItem)=>num(i.kg)>0).map((i:EditItem)=>({product_id:i.product_id,name:i.name,kg:num(i.kg),price:num(i.price),wasteKg:i.wasteKg}));
    if(!items.length)return notify('В накладной должен остаться хотя бы один товар с весом');
    if(!editOp.contractorId)return notify('Выберите контрагента');
    setBusy(true);
    const {error}=await supabase.rpc('point_update_operation',{p_operation_id:editOp.id,p_contractor_id:editOp.contractorId,p_operation_date:editOp.date,p_items:items,p_note:null});
    setBusy(false);
    if(error)return notify(error.message);
    notify('Накладная изменена ✅');
    setEditOp(null);
    await Promise.all([load(),loadEvening(),loadAudit()]);
    if(tab==='report')await loadDayInfo();
  }
  async function deleteOp(o:Operation){
    const total=o.items.reduce((s2:number,i:OperationItem)=>s2+i.sum,0);
    if(!window.confirm(`Удалить накладную №${o.operation_number} (${o.contractor_name}, ${money(total)})?\nОстатки и себестоимость пересчитаются. Действие попадёт в журнал.`))return;
    const {error}=await supabase.rpc('point_delete_operation',{p_operation_id:o.id});
    if(error)return notify(error.message);
    notify('Накладная удалена');
    if(editOp?.id===o.id)setEditOp(null);
    await Promise.all([load(),loadEvening(),loadAudit()]);
    if(tab==='report')await loadDayInfo();
  }
  async function loadDays(){
    const {data,error}=await supabase.rpc('point_get_days_overview',{p_days:30});
    if(error)return;
    setDays((Array.isArray(data)?data:[]) as unknown as DayRow[]);
  }
  async function loadReopens(){
    const {data,error}=await supabase.rpc('point_get_reopens',{p_limit:30});
    if(error)return;
    setReopens((Array.isArray(data)?data:[]) as unknown as ReopenRow[]);
  }
  async function loadStocktakes(){
    const {data,error}=await supabase.rpc('point_get_stocktakes',{p_limit:20});
    if(error){notify(error.message);return;}
    setStocktakes((Array.isArray(data)?data:[]) as unknown as Stocktake[]);
  }
  function shiftDay(n:number){const next=addDays(date,n);if(next>today())return;setDate(next);}
  function startExpEdit(e:EveningExpense){setEditExp({id:e.id,employeeId:e.employee_id||'',category:e.category,comment:e.comment||'',amount:String(e.amount),isLoan:!!e.is_loan});}
  async function saveExpenseEdit(){
    if(!editExp)return;
    if(num(editExp.amount)<=0||!editExp.category.trim())return notify('Укажите категорию и сумму');
    if(editExp.isLoan&&!editExp.employeeId)return notify('Для долга выберите сотрудника — кто должен вернуть');
    setBusy(true);
    const {error}=await supabase.rpc('point_update_evening_expense',{p_expense_id:editExp.id,p_employee_id:editExp.employeeId||null,p_category:editExp.category,p_comment:editExp.comment,p_amount:num(editExp.amount),p_is_loan:editExp.isLoan});
    setBusy(false);
    if(error)return notify(error.message);
    notify('Расход изменён ✅');
    setEditExp(null);
    await Promise.all([loadEvening(),loadLoans(),loadAudit()]);
    if(tab==='report')await loadDayInfo();
  }
  async function addContractorQuick(){
    const name=newContractor.trim();
    if(!name)return notify('Введите имя получателя');
    setBusy(true);
    const {data,error}=await supabase.rpc('point_upsert_contractor',{p_name:name});
    setBusy(false);
    if(error)return notify(error.message);
    setNewContractor('');
    await load();
    if(typeof data==='string')setShipmentContractor(data);
    notify('Получатель добавлен ✅');
  }
  async function applyStocktake(){
    const items=activeProducts.filter((p:Product)=>countRows[p.id]!==undefined&&countRows[p.id]!=='').map((p:Product)=>({product_id:p.id,actual_kg:num(countRows[p.id])}));
    if(!items.length)return notify('Впишите фактический вес хотя бы по одному товару');
    if(!countReason.trim())return notify('Укажите причину / комментарий инвентаризации');
    let plus=0,minus=0,changed=0;
    items.forEach((it:{product_id:string;actual_kg:number})=>{const sys=num(stockMap.get(it.product_id)?.quantity_kg);const d=Math.round((it.actual_kg-sys)*1000)/1000;if(d>0)plus+=d;if(d<0)minus+=-d;if(d!==0)changed++;});
    if(!window.confirm(`Инвентаризация на ${date}\nПроверено товаров: ${items.length}, с расхождением: ${changed}\nИзлишек: +${qty(plus)} кг · Недостача: −${qty(minus)} кг\nОстатки будут исправлены, действие попадёт в журнал. Применить?`))return;
    setBusy(true);
    const {error}=await supabase.rpc('point_apply_stocktake',{p_date:date,p_items:items,p_reason:countReason.trim()});
    setBusy(false);
    if(error)return notify(error.message);
    notify(changed?'Инвентаризация применена ✅':'Расхождений нет — инвентаризация записана ✅');
    setCountRows({});setCountReason('');
    await Promise.all([load(),loadEvening(),loadStocktakes(),loadAudit()]);
  }
  function buildDayText(){
    const sm:EveningSummary=evening?.summary||{};
    const cats=new Map<string,number>();
    exps.forEach((e:EveningExpense)=>cats.set(e.category,(cats.get(e.category)||0)+num(e.amount)));
    const lines:string[]=[`📅 Точка · ${date} · ${status==='CLOSED'?'день закрыт':status==='CHECKED'?'проверен':'черновик'}`,'',
      `Закуплено: ${qty(purchaseKg)} кг — ${money(purchaseAmount)}`,
      `Отгружено: ${qty(shipmentKg)} кг`,
      `Продано: ${qty(saleKg)} кг — ${money(saleAmount)}`,
      `В Ангар: ${qty(transferKg)} кг`,'',
      `Расходы: ${money(expTotal)}`,...Array.from(cats.entries()).map(([c,v])=>`  • ${c}: ${money(v)}`)];
    if(num(evening?.repayments_amount)>0)lines.push(`Внесения (возврат долгов): ${money(evening?.repayments_amount)}`);
    lines.push('',`Касса: начальная ${money(sm.opening_cash)} + принесли ${money(sm.brought_cash)}`,`Ожидаемая: ${expected==null?'—':money(expected)}`,`Фактическая: ${sm.actual_cash==null?'—':money(sm.actual_cash)}`,`Расхождение: ${variance==null?'—':money(variance)}`);
    if(openLoans.length)lines.push('',`Долги (не погашено): ${money(openRemaining)}`,...openLoans.map((l:LoanRow)=>`  • ${l.employee_name}: осталось ${money(l.remaining)} из ${money(l.amount)}`));
    const cm=(sm.close_comment||closeComment||'').trim();
    if(cm)lines.push('',`💬 ${cm}`);
    return lines.join('\n');
  }
  async function shareDay(){
    const text=buildDayText();
    try{
      if(typeof navigator!=='undefined'&&typeof navigator.share==='function'){await navigator.share({title:`Точка ${date}`,text});return;}
    }catch(err){if((err as Error)?.name==='AbortError')return;}
    try{await navigator.clipboard.writeText(text);notify('Сводка скопирована — вставьте в WhatsApp или Telegram');}
    catch{notify('Не удалось скопировать. Воспользуйтесь кнопкой «Печать».');}
  }
  async function exportReportXlsx(){
    if(!report){notify('Сначала загрузите отчёт');return;}
    const XLSX=await import('xlsx');
    const wb=XLSX.utils.book_new();
    const t=report.totals||{};
    const sheet=(rows:Array<Array<string|number>>,widths:number[])=>{const ws=XLSX.utils.aoa_to_sheet(rows);ws['!cols']=widths.map((w:number)=>({wch:w}));return ws;};
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Отчёт Точки'],['Период',`${reportFrom} — ${reportTo}`],[],
      ['Показатель','Кг','Сумма, ₸'],
      ['Закуп',num(t.purchase_kg),num(t.purchase_amount)],
      ['Отгрузка',num(t.shipment_kg),num(t.shipment_amount)],
      ['Продажи',num(t.sale_kg),num(t.sale_amount)],
      ['В Ангар',num(t.transfer_kg),''],
      ['Расходы','',num(t.expense_amount)],
    ],[22,14,18]),'Итоги');
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Товар','Остаток, кг','Закуп, кг','Закуп, ₸','Отгрузка, кг','Отгрузка, ₸','Продажа, кг','Продажа, ₸'],
      ...orderedReportProducts.map((r)=>[r.name,num(r.stock_kg),num(r.purchase_kg),num(r.purchase_amount),num(r.shipment_kg),num(r.shipment_amount),num(r.sale_kg),num(r.sale_amount)]),
    ],[24,14,12,14,14,14,12,14]),'Товары');
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Статья расхода','Сумма, ₸','Операций'],...reportCategories.map((c)=>[c.category,num(c.amount),num(c.count)]),
      [],['Сотрудник','Аванс, ₸','Зарплата, ₸','Расходы, ₸','В долг, ₸','Всего, ₸','Вернул за период, ₸','Осталось должен (на сегодня), ₸'],
      ...reportPeople.map((x)=>[x.name+(x.hidden?' (служебная)':''),num(x.advance),num(x.salary),num(x.other),num(x.loan_given),num(x.total),num(x.repaid),num(x.debt_remaining)]),
    ],[28,14,14,14,14,14,18,26]),'Расходы и люди');
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Дата','Сотрудник','Статья','Сумма, ₸','В долг','Комментарий'],
      ...reportPeople.flatMap((x)=>x.items.map((it)=>[String(it.date).slice(0,10),x.name,it.category,num(it.amount),it.is_loan?'да':'',it.comment||''])),
    ],[12,22,18,14,8,36]),'Люди — записи');
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Дата','Статус','Закуп, ₸','Продажа, ₸','Расходы, ₸','Долг выдан, ₸','Внесли, ₸','Факт. касса, ₸','Расхождение, ₸','Комментарий'],
      ...reportDays.map((d)=>[d.date.slice(0,10),d.status||'—',num(d.purchase_amount),num(d.sale_amount),num(d.expense_amount),num(d.loan_amount),num(d.repayment_amount),d.actual_cash==null?'':num(d.actual_cash),d.variance==null?'':num(d.variance),d.comment||'']),
    ],[12,12,14,14,14,14,12,14,14,30]),'По дням');
    XLSX.utils.book_append_sheet(wb,sheet([
      ['Сотрудник','Дата выдачи','Статья','Выдано, ₸','Вернули, ₸','Осталось, ₸','Статус','Внесения'],
      ...loans.map((l:LoanRow)=>[l.employee_name,l.given_date,l.category,num(l.amount),num(l.repaid),num(l.remaining),loanLabel[l.status],l.repayments.map((r)=>`${r.date}: ${num(r.amount)}`).join('; ')]),
    ],[22,14,16,14,14,14,18,40]),'Долги');
    XLSX.writeFile(wb,`tochka_${reportFrom}_${reportTo}.xlsx`);
    notify('Файл Excel сохранён ✅');
  }
  async function loadLoans(){
    const {data,error}=await supabase.rpc('point_get_loans');
    if(error){notify(error.message);return;}
    setLoans((Array.isArray(data)?data:[]) as unknown as LoanRow[]);
  }
  async function addRepayment(l:LoanRow){
    const raw=window.prompt(`Внесение по долгу: ${l.employee_name}\nОсталось вернуть ${money(l.remaining)}. Сколько вносят сейчас (${date})?`,String(l.remaining));
    if(raw===null)return;
    const amount=num(raw.replace(',','.'));
    if(amount<=0)return notify('Введите сумму внесения');
    const note=window.prompt('Комментарий (необязательно)')||null;
    const {error}=await supabase.rpc('point_add_loan_repayment',{p_expense_id:l.expense_id,p_date:date,p_amount:amount,p_note:note});
    if(error)return notify(error.message);
    notify('Внесение записано ✅');
    await Promise.all([loadEvening(),loadLoans()]);
    if(tab==='report')await loadDayInfo();
  }
  async function removeRepayment(id:string){
    if(!window.confirm('Удалить это внесение?'))return;
    const {error}=await supabase.rpc('point_remove_loan_repayment',{p_repayment_id:id});
    if(error)return notify(error.message);
    notify('Внесение удалено');
    await Promise.all([loadEvening(),loadLoans()]);
    if(tab==='report')await loadDayInfo();
  }
  async function loadDayInfo(){
    const [r,e]=await Promise.all([supabase.rpc('point_get_report',{p_from:date,p_to:date}),supabase.rpc('point_get_evening_summary',{p_date:date})]);
    const err=r.error||e.error;
    if(err){notify(err.message);return;}
    setDayInfo({report:(r.data??{}) as unknown as PointReport,evening:(e.data??{}) as unknown as EveningData});
  }
  async function loadReport(){
    const [{data,error},people]=await Promise.all([
      supabase.rpc('point_get_report',{p_from:reportFrom,p_to:reportTo}),
      supabase.rpc('point_get_people_report',{p_from:reportFrom,p_to:reportTo}),
    ]);
    if(error){notify(error.message);return;}
    setReport((data??{}) as PointReport);
    if(people.error){notify(people.error.message);setReportPeople([]);}
    else setReportPeople(((people.data??[]) as PersonRep[]).map(x=>({...x,items:x.items||[]})));
  }

  useEffect(()=>{load();},[]);
  useEffect(()=>{loadEvening();loadAudit();loadLoans();},[date]);
  useEffect(()=>{if(tab==='report')loadDayInfo();},[tab,date]);
  useEffect(()=>{loadDays();loadReopens();},[date,evening?.summary?.status,evening?.expenses?.length,state.operations.length]);
  useEffect(()=>{if(tab==='count')loadStocktakes();},[tab]);
  useEffect(()=>{if(tab==='report')loadReport();},[tab,reportFrom,reportTo]);

  function getLine(id:string):Line{
    const p=activeProducts.find((x:Product)=>x.id===id);
    return rows[id]||{kg:'',price:clearPrices?'':String(p?.default_price??0),sum:'',sumTouched:false};
  }
  function toggleClearPrices(v:boolean){
    setClearPrices(v);
    setRows(prev=>{
      const out:Record<string,Line>={...prev};
      for(const p of activeProducts){const r=out[p.id]||{kg:'',price:'',sum:'',sumTouched:false};out[p.id]={...r,price:v?'':String(p.default_price??0),sumTouched:false};}
      return out;
    });
  }
  function updateLine(id:string,field:'kg'|'price'|'sum',value:string){
    setRows(prev=>{
      const p=activeProducts.find((x:Product)=>x.id===id);
      const cur=prev[id]||{kg:'',price:clearPrices?'':String(p?.default_price??0),sum:'',sumTouched:false};
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
    if(expense.isLoan&&!expense.employeeId)return notify('Для долга выберите сотрудника — кто должен вернуть');
    setBusy(true);
    const {error}=await supabase.rpc('point_add_evening_expense',{p_summary_id:evening.summary.id,p_employee_id:expense.employeeId||null,p_category:expense.category.trim(),p_comment:expense.comment,p_amount:num(expense.amount),p_is_loan:expense.isLoan});
    setBusy(false);
    if(error)return notify(error.message);
    setExpense({employeeId:'',category:'',comment:'',amount:'',isLoan:false});
    notify(expense.isLoan?'Расход записан как долг ✅':'Расход добавлен ✅');
    await Promise.all([loadEvening(),loadLoans()]);
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
  async function addExpenseCategory(){
    const name=newCategory.trim();
    if(!name)return notify('Введите название статьи');
    setBusy(true);
    const {error}=await supabase.rpc('point_upsert_expense_category',{p_name:name});
    setBusy(false);
    if(error)return notify(error.message);
    setNewCategory('');notify('Статья добавлена ✅');await load();
  }
  async function removeExpenseCategory(id:string){
    if(!window.confirm('Скрыть эту статью расхода? История с ней сохранится.'))return;
    const {error}=await supabase.rpc('point_set_expense_category_active',{p_id:id,p_active:false});
    if(error)return notify(error.message);
    notify('Статья скрыта');await load();
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
    const {error}=await supabase.rpc('point_close_day',{p_date:date,p_comment:closeComment.trim()||null});
    if(error)return notify(error.message);
    notify('День закрыт ✅');await loadEvening();await load();if(tab==='report')await loadDayInfo();
  }
  async function reopenDay(){
    const reason=window.prompt('Причина переоткрытия дня');
    if(!reason?.trim())return;
    const {error}=await supabase.rpc('point_reopen_day',{p_date:date,p_reason:reason.trim()});
    if(error)return notify(error.message);
    await loadReopens();
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
  const editPanel=(o:Operation)=>{
    const e=editOp!;
    const used=new Set(e.items.map((i:EditItem)=>i.product_id));
    const free=activeProducts.filter((x:Product)=>!used.has(x.id));
    const total=e.items.reduce((s2:number,i:EditItem)=>s2+num(i.kg)*num(i.price),0);
    return <div className="ledger-edit" key={o.id}><div className="ledger-edit-head"><b>Правка накладной №{e.number}</b><span>Итого: {money(Math.round(total*100)/100)}</span></div><div className="ledger-edit-top"><label>Контрагент<select value={e.contractorId} onChange={ev=>setEditOp(x=>x?{...x,contractorId:ev.target.value}:x)}>{state.contractors.map((c:Contractor)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Дата<input type="date" value={e.date} max={today()} onChange={ev=>setEditOp(x=>x?{...x,date:ev.target.value}:x)}/></label></div><div className="ledger-edit-items">{e.items.map((it:EditItem,idx:number)=><div className="ledger-edit-item" key={it.product_id}><b>{it.name}</b><label>кг<input type="number" step="0.001" value={it.kg} onChange={ev=>patchEditItem(idx,{kg:ev.target.value})}/></label><label>цена ₸/кг<input type="number" step="0.01" value={it.price} onChange={ev=>patchEditItem(idx,{price:ev.target.value})}/></label><span>{money(Math.round(num(it.kg)*num(it.price)*100)/100)}</span><button title="Убрать товар из накладной" onClick={()=>setEditOp(x=>x?{...x,items:x.items.filter((_:EditItem,i:number)=>i!==idx)}:x)}>×</button></div>)}</div><div className="ledger-edit-add"><select value={e.addProduct} onChange={ev=>addEditProduct(ev.target.value)}><option value="">＋ Добавить товар в накладную</option>{free.map((x:Product)=><option key={x.id} value={x.id}>{x.name}</option>)}</select></div><div className="ledger-edit-buttons"><button className="primary" disabled={busy} onClick={saveEdit}>Сохранить изменения</button><button onClick={()=>setEditOp(null)}>Отмена</button></div></div>;
  };
  const expenseEditRow=(e:EveningExpense)=>{
    const x=editExp!;
    const cats=state.expenseCategories.map((c:ExpenseCategory)=>c.name);
    if(x.category&&!cats.includes(x.category))cats.push(x.category);
    const locked=num(e.repaid)>0;
    return <div className="expense-edit" key={e.id}><select value={x.employeeId} disabled={locked} onChange={ev=>setEditExp(v=>v?{...v,employeeId:ev.target.value}:v)}><option value="">Без сотрудника</option>{state.employees.map((em:Employee)=><option key={em.id} value={em.id}>{em.name}</option>)}</select><select value={x.category} onChange={ev=>setEditExp(v=>v?{...v,category:ev.target.value}:v)}>{cats.map((c:string)=><option key={c} value={c}>{c}</option>)}</select><input placeholder="Комментарий" value={x.comment} onChange={ev=>setEditExp(v=>v?{...v,comment:ev.target.value}:v)}/><input type="number" placeholder="Сумма" value={x.amount} onChange={ev=>setEditExp(v=>v?{...v,amount:ev.target.value}:v)}/><label className="loan-check"><input type="checkbox" checked={x.isLoan} disabled={locked} onChange={ev=>setEditExp(v=>v?{...v,isLoan:ev.target.checked}:v)}/>В долг</label><button className="primary" disabled={busy} onClick={saveExpenseEdit}>Сохранить</button><button onClick={()=>setEditExp(null)}>Отмена</button>{locked&&<small className="expense-edit-note">По долгу есть внесения — сотрудника и отметку «в долг» менять нельзя, сумма не меньше {money(e.repaid)}.</small>}</div>;
  };
  const sortItems=(items:OperationItem[])=>[...items].sort((a:OperationItem,b:OperationItem)=>(productOrder.get(a.product_id)??9999)-(productOrder.get(b.product_id)??9999));
  const dayOps:Operation[]=state.operations.filter((o:Operation)=>o.operation_date===date).sort((a:Operation,b:Operation)=>{const bd=new Date(b.created_at).getTime(),ad=new Date(a.created_at).getTime();return bd-ad||b.operation_number-a.operation_number;});
  const purchaseOps=dayOps.filter((o:Operation)=>o.role==='ARRIVAL'&&!o.note?.startsWith('[STOCKTAKE]'));
  const shipmentOps=dayOps.filter((o:Operation)=>o.role==='SHIPMENT'&&!o.note?.startsWith('[SALE]')&&!o.note?.startsWith('[TRANSFER_TO_ANGAR]')&&!o.note?.startsWith('[STOCKTAKE]'));
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
  const rt0=report?.totals||{};
  const reportEmployees=report?.employees||[];
  // «Люди»: считаем из отдельного отчёта (строго за период). Скрытые в «Зарплате» (Тест, Дневной расход, Начальство…) — одной служебной строкой, чтобы итог сходился с расходами.
  const mainPeople=reportPeople.filter(x=>!x.hidden);
  const servicePeople=reportPeople.filter(x=>x.hidden);
  const sumP=(list:PersonRep[],k:'advance'|'salary'|'other'|'loan_given'|'total')=>list.reduce((a,x)=>a+num(x[k]),0);
  const servicePerson:PersonRep|null=servicePeople.length?{employee_id:'service',name:'Служебные записи',hidden:true,advance:sumP(servicePeople,'advance'),salary:sumP(servicePeople,'salary'),other:sumP(servicePeople,'other'),loan_given:sumP(servicePeople,'loan_given'),total:sumP(servicePeople,'total'),repaid:0,debt_remaining:0,items:servicePeople.flatMap(x=>x.items.map(it=>({...it,category:`${x.name}: ${it.category}`}))).sort((a,b)=>a.date.localeCompare(b.date))}:null;
  const peopleTotal=sumP(reportPeople,'total');
  const peopleDiff=num(rt0.expense_amount)-peopleTotal;
  const debtPeople=reportPeople.filter(x=>num(x.loan_given)>0||num(x.repaid)>0||num(x.debt_remaining)>0);
  const reportCategories=report?.categories||[];
  const reportProducts=report?.products||[];
  const reportDays=report?.days||[];
  const chartDays=[...reportDays].reverse(); // графикам нужен хронологический порядок (слева направо). Без useMemo: он стоял после раннего return и ломал порядок хуков (React #310)
  const rt=report?.totals||{};
  const periodProfit=num(rt.sale_amount)-num(rt.sale_cogs)+num(rt.shipment_amount)-num(rt.cogs);
  const reportPeriodLabel=reportFrom===reportTo?ruDate(reportFrom):`${ruDate(reportFrom)} — ${ruDate(reportTo)}`;
  const productIdByName=new Map<string,string>(activeProducts.map((p:Product)=>[p.name,p.id]));
  const prevCash=evening?.prev_cash;
  const staleDays=days.filter((d:DayRow)=>d.date<today()&&d.status!=='CLOSED'&&(d.ops>0||d.expenses>0||d.status!==null));
  const countFilled=Object.values(countRows).some((v:string)=>v!==undefined&&v!=='');
  const openLoans=loans.filter((l:LoanRow)=>l.status!=='PAID');
  const paidLoans=loans.filter((l:LoanRow)=>l.status==='PAID');
  const openRemaining=openLoans.reduce((s2:number,l:LoanRow)=>s2+num(l.remaining),0);
  const shownLoans=showPaidLoans?loans:openLoans;
  const dayTot=dayInfo?.report?.totals||{};
  const daySum:EveningSummary=dayInfo?.evening?.summary||{};
  const dayProducts=[...(dayInfo?.report?.products||[])].filter(p=>num(p.purchase_kg)||num(p.sale_kg)||num(p.shipment_kg)).sort((a,b)=>(productOrder.get(productIdByName.get(a.name)??'')??9999)-(productOrder.get(productIdByName.get(b.name)??'')??9999));
  const dayCats=dayInfo?.report?.categories||[];
  const flowRows=[{label:'Начальная касса',v:num(daySum.opening_cash),plus:true},{label:'Принесли за день',v:num(daySum.brought_cash),plus:true},{label:'Продажи',v:num(dayTot.sale_amount),plus:true},{label:'Внесения (возврат долгов)',v:num(dayInfo?.evening?.repayments_amount),plus:true},{label:'Закуп',v:num(dayTot.purchase_amount),plus:false},{label:'Расходы',v:num(dayTot.expense_amount),plus:false}];
  const flowMax=Math.max(1,...flowRows.map(f=>f.v),num(daySum.expected_cash),num(daySum.actual_cash));
  const kgMax=Math.max(1,...dayProducts.map(p=>Math.max(num(p.purchase_kg),num(p.sale_kg),num(p.shipment_kg))));
  const catMax=Math.max(1,...dayCats.map(c=>num(c.amount)));
  const pct=(v:number,max:number)=>({width:Math.max(v>0?2:0,Math.min(100,v/max*100))+'%'});
  const orderedReportProducts=[...reportProducts].sort((a,b)=>(productOrder.get(productIdByName.get(a.name)??'')??9999)-(productOrder.get(productIdByName.get(b.name)??'')??9999));
  // ── Касса: сверка «должно быть» ↔ «посчитали» (только по дням с вечерней сводкой) ──
  const dIso=(d:RepDay)=>String(d.date).slice(0,10);
  const daysAsc=[...reportDays].sort((a,b)=>dIso(a).localeCompare(dIso(b)));
  const sumDays=daysAsc.filter(d=>d.status!==null&&d.opening_cash!=null);
  const noSumWithOps=daysAsc.filter(d=>d.status===null&&(num(d.ops)>0||num(d.purchase_amount)>0||num(d.expense_amount)>0||num(d.sale_amount)>0));
  const ledger=(()=>{
    if(!sumDays.length)return null;
    const first=sumDays[0],last=sumDays[sumDays.length-1];
    const add=(k:'brought_cash'|'sale_amount'|'repayment_amount'|'purchase_amount'|'expense_amount')=>sumDays.reduce((a,d)=>a+num(d[k]),0);
    const closing=(d:RepDay)=>d.actual_cash!=null?num(d.actual_cash):num(d.expected_cash);
    let gap=0;const gaps:Array<{from:string;to:string;amount:number}>=[];
    for(let i=1;i<sumDays.length;i++){const g=num(sumDays[i].opening_cash)-closing(sumDays[i-1]);if(Math.abs(g)>=1){gap+=g;gaps.push({from:dIso(sumDays[i-1]),to:dIso(sumDays[i]),amount:g});}}
    const opening=num(first.opening_cash);
    const brought=add('brought_cash'),sale=add('sale_amount'),repay=add('repayment_amount'),purchase=add('purchase_amount'),expense=add('expense_amount');
    const expected=opening+brought+sale+repay-purchase-expense+gap;
    const counted=last.actual_cash!=null;
    const actual=counted?num(last.actual_cash):null;
    return {opening,openDate:dIso(first),brought,sale,repay,purchase,expense,gap,gaps,expected,actual,actualDate:dIso(last),diff:actual!=null?actual-expected:null,lastStatus:last.status};
  })();
  const missedPurchase=noSumWithOps.reduce((a,d)=>a+num(d.purchase_amount),0);
  const missedExpense=noSumWithOps.reduce((a,d)=>a+num(d.expense_amount),0);
  // ── Металл и расходы за период ──
  const metalRows=orderedReportProducts.filter(x=>num(x.purchase_kg)||num(x.sale_kg)||num(x.shipment_kg));
  const metalMax=Math.max(1,...metalRows.map(x=>num(x.purchase_kg)));
  const showShip=metalRows.some(x=>num(x.shipment_kg)>0),showSale=metalRows.some(x=>num(x.sale_kg)>0);
  const metalSum=(k:'purchase_kg'|'purchase_amount'|'shipment_kg'|'sale_kg'|'stock_kg')=>metalRows.reduce((a,x)=>a+num(x[k]),0);
  const catsSorted=[...reportCategories].sort((a,b)=>num(b.amount)-num(a.amount));
  const catsTotal=catsSorted.reduce((a,c)=>a+num(c.amount),0);

  return <main className="warehouse-shell point-dashboard">
    <header className="topbar">
      <div className="brand"><div className="brand-icon">◆</div><div><div className="brand-title">Точка</div><div className="brand-sub">Пункт приёмки · склад · вечерняя сверка</div></div></div>
      <div className="top-actions"><div className="point-date"><span>Рабочий день</span><div className="date-nav"><button type="button" title="Предыдущий день" onClick={()=>shiftDay(-1)}>‹</button><input type="date" value={date} max={today()} onChange={e=>e.target.value&&setDate(e.target.value)}/><button type="button" title="Следующий день" disabled={date>=today()} onClick={()=>shiftDay(1)}>›</button><button type="button" className="today-btn" disabled={date===today()} onClick={()=>setDate(today())}>Сегодня</button></div></div><button onClick={()=>{load();loadEvening();loadAudit();if(tab==='report')loadReport();}}>Обновить</button><a className="workspace-pill" href="/">← Режим</a></div>
    </header>

    <div className="point-page page">
      <section className="point-hero"><div><div className="eyebrow">ВЕЧЕРНЯЯ РАБОЧАЯ КНИГА</div><h1>Смена Точки</h1><p>Операции, склад, вечерняя сверка и отчёты собраны в одном рабочем окне.</p></div><div className={`day-state ${status.toLowerCase()}`}><span>Статус дня</span><b>{status}</b></div></section>

      {staleDays.length>0&&<div className="stale-banner">⚠️ Не закрыты дни: {staleDays.slice(0,6).map((d:DayRow)=><button key={d.date} onClick={()=>{setDate(d.date);setTab('work');}}>{d.date.slice(8)}.{d.date.slice(5,7)}</button>)}{staleDays.length>6&&<span>и ещё {staleDays.length-6}</span>}<button className="link-btn" onClick={()=>{setTab('days');loadDays();}}>Обзор дней →</button></div>}
      <nav className="point-tabs" aria-label="Разделы Точки">
        <button className={tab==='work'?'active':''} onClick={()=>setTab('work')}>Рабочий день</button>
        <button className={tab==='stock'?'active':''} onClick={()=>setTab('stock')}>Склад</button>
        <button className={tab==='count'?'active':''} onClick={()=>setTab('count')}>Инвентаризация</button>
        <button className={tab==='days'?'active':''} onClick={()=>{setTab('days');loadDays();}}>Дни{staleDays.length>0&&<em className="tab-dot">{staleDays.length}</em>}</button>
        <button className={tab==='payroll'?'active':''} onClick={()=>setTab('payroll')}>Зарплата</button>
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
          {entryMode==='SHIPMENT'&&<div className="entry-meta"><label>Контрагент<select value={shipmentContractor} onChange={e=>setShipmentContractor(e.target.value)}><option value="">Выберите</option>{visibleContractors.map((c:Contractor)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><div className="new-contractor"><input placeholder="Новый получатель" value={newContractor} onChange={e=>setNewContractor(e.target.value)}/><button disabled={busy} onClick={addContractorQuick}>＋ Добавить</button></div></div>}
          <label className="check-wrap clear-prices-check"><input type="checkbox" checked={clearPrices} onChange={e=>toggleClearPrices(e.target.checked)}/> Стереть цены</label>
          <div className="point-entry-grid">
            <div className="point-sheet"><div className="point-sheet-head"><span>Товар</span><span>Остаток</span><span>Кг</span><span>₸/кг</span><span>Сумма</span></div>{activeProducts.map((p:Product)=>{const r=getLine(p.id);const s=stockMap.get(p.id);const stock=num(s?.quantity_kg);const entered=num(r.kg);const insufficient=(entryMode==='SHIPMENT'||entryMode==='SALE'||entryMode==='TRANSFER')&&entered>stock+0.000001;return <div className={`point-sheet-row ${entered>0?'filled':''} ${insufficient?'bad':''}`} key={p.id}><div className="p-name"><b>{p.name}</b><small>{money(p.default_price)}/кг прайс</small></div><div className="p-stock">{qty(stock)} кг</div><input type="number" min="0" step="0.001" placeholder="кг" value={r.kg} onChange={e=>updateLine(p.id,'kg',e.target.value)}/><input type="number" min="0" step="0.01" placeholder="₸/кг" value={r.price} disabled={entryMode==='TRANSFER'} onChange={e=>updateLine(p.id,'price',e.target.value)}/><input type="number" min="0" step="0.01" placeholder="сумма" value={r.sum} onChange={e=>updateLine(p.id,'sum',e.target.value)}/></div>;})}</div>
            <aside className="entry-summary"><div className="entry-summary-top"><span>{quickModeLabel}</span><b>{qty(entryKg)} кг</b></div><div className="entry-total">{entryMode==='TRANSFER'?<><small>Стоимость по средней себестоимости</small><strong>{money(entryItems().reduce((s,i)=>{const st=stockMap.get(i.product_id);return s+num(st?.avg_cost)*i.kg},0))}</strong></>:<><small>Итого операции</small><strong>{money(entryTotal)}</strong></>}</div>{entryMode==='PURCHASE'&&<p>Вводи вечерний итог по тетради. Каждая строка станет приходом в склад Точки.</p>}{entryMode==='SHIPMENT'&&<p>Отгрузка проводится сразу. Остаток и себестоимость пересчитываются автоматически.</p>}{entryMode==='SALE'&&<p>Продажа случайному покупателю. Себестоимость берётся из текущего среднего остатка.</p>}{entryMode==='TRANSFER'&&<p>Перемещение в Ангар не является продажей или расходом.</p>}{entryMode==='TRANSFER'?<button className="primary large" disabled={busy} onClick={transferSelected}>{busy?'Проводим…':'Переместить в Ангар'}</button>:<button className={`primary large ${quickModeColor}`} disabled={busy} onClick={submitEntry}>{busy?'Сохраняем…':entryMode==='PURCHASE'?'Записать закупку':entryMode==='SALE'?'Продать':'Провести отгрузку'}</button>}<button className="ghost-btn" onClick={clearEntry}>Очистить ввод</button></aside>
          </div>
        </section>

        <section className="point-book evening-book"><div className="book-title"><div><div className="eyebrow">ГЛАВНОЕ ВЕЧЕРОМ</div><h2>2. Вечерняя сводка</h2><span>Ничего из проведённых операций заново не вводим — система сама подтягивает день.</span></div><div className="evening-badge">{status}</div></div><div className="evening-layout"><div className="evening-left"><div className="evening-summary-grid"><div><small>Закуплено</small><b>{qty(purchaseKg)} кг</b><span>{money(purchaseAmount)}</span></div><div><small>Отгружено</small><b>{qty(shipmentKg)} кг</b><span>из Точки</span></div><div><small>Продано</small><b>{qty(saleKg)} кг</b><span>{money(saleAmount)}</span></div><div><small>В Ангар</small><b>{qty(transferKg)} кг</b><span>перемещение</span></div></div><div className="notebook-box"><div className="notebook-title">Деньги</div><div className="money-grid"><label>Начальная касса<input type="number" value={eveningForm.opening} onChange={e=>setEveningForm(x=>({...x,opening:e.target.value}))}/>{prevCash&&prevCash.actual_cash!=null&&status!=='CLOSED'&&num(eveningForm.opening)!==num(prevCash.actual_cash)&&<button type="button" className="link-btn prev-cash" onClick={()=>setEveningForm(x=>({...x,opening:String(prevCash.actual_cash)}))}>↺ {money(prevCash.actual_cash)} — касса на {prevCash.date}</button>}{prevCash&&prevCash.actual_cash!=null&&num(eveningForm.opening)===num(prevCash.actual_cash)&&<small className="prev-cash-ok">= касса на {prevCash.date}</small>}</label><label>Принесли за день<input type="number" value={eveningForm.brought} onChange={e=>setEveningForm(x=>({...x,brought:e.target.value}))}/></label><label>Фактическая касса<input type="number" value={eveningForm.actual} onChange={e=>setEveningForm(x=>({...x,actual:e.target.value}))}/></label></div><div className="cash-check"><span>Ожидаемая касса</span><b>{expected==null?'—':money(expected)}</b><span>Расхождение</span><b className={variance==null?'':num(variance)===0?'ok':'warn'}>{variance==null?'—':money(variance)}</b></div></div><div className="notebook-box day-comment"><div className="notebook-title">Комментарий к дню</div><textarea rows={3} placeholder="Например: почему расхождение, что важно помнить про этот день" value={closeComment} disabled={status==='CLOSED'} onChange={e=>setCloseComment(e.target.value)}/><small>{status==='CLOSED'?'День закрыт — комментарий сохранён.':'Сохранится при нажатии «Закрыть день».'}</small></div></div><aside className="evening-actions"><button className="primary large" disabled={busy} onClick={saveEvening}>Сохранить сводку</button><button onClick={checkDay}>Проверить день</button><button className="primary-dark" onClick={closeDay}>Закрыть день</button>{status==='CLOSED'&&<button onClick={reopenDay}>Переоткрыть с причиной</button>}<button onClick={shareDay}>📤 Поделиться сводкой</button><button onClick={()=>window.print()}>🖨 Печать</button></aside></div></section>

        <section className="point-book loans-book"><div className="book-title"><div><div className="eyebrow">ДОЛГИ</div><h2>Долги и внесения</h2><span>Кто должен вернуть деньги и сколько уже внесено. Внесение записывается на выбранный рабочий день и попадает в кассу этого дня.</span></div><b className={openLoans.length?'warn':'ok'}>{openLoans.length?`Осталось вернуть: ${money(openRemaining)}`:'Долгов нет'}</b></div>{(evening?.repayments?.length??0)>0&&<div className="repay-today"><b>Внесено сегодня: {money(evening?.repayments_amount)}</b>{(evening?.repayments??[]).map((r:Repayment)=><span key={r.id}>{r.employee_name||'—'} · {money(r.amount)}{r.note?` · ${r.note}`:''} <button onClick={()=>removeRepayment(r.id)} title="Удалить внесение">×</button></span>)}</div>}<div className="loan-list">{shownLoans.map((l:LoanRow)=><div className={`loan-row ${l.status.toLowerCase()}`} key={l.expense_id}><div className="loan-main"><b>{l.employee_name}</b><span>{l.given_date} · {l.category}{l.comment?` · ${l.comment}`:''}</span><em className={`loan-badge ${l.status==='PAID'?'paid':l.status==='PARTIAL'?'partial':'unpaid'}`}>{loanLabel[l.status]}</em></div><div className="loan-progress"><div className="info-track"><i className="plus" style={{width:Math.min(100,num(l.repaid)/Math.max(1,num(l.amount))*100)+'%'}}/></div><span>Выдано {money(l.amount)} · вернули {money(l.repaid)} · осталось <b>{money(l.remaining)}</b></span>{l.repayments.length>0&&<small>{l.repayments.map(r=>`${r.date}: ${money(r.amount)}`).join(' · ')}</small>}</div>{l.status!=='PAID'&&<button className="primary" onClick={()=>addRepayment(l)}>＋ Внесение</button>}</div>)}{!loans.length&&<div className="empty-state compact">Долгов пока нет. Чтобы записать долг, при добавлении расхода отметьте «В долг».</div>}{paidLoans.length>0&&<button className="link-btn" onClick={()=>setShowPaidLoans(v=>!v)}>{showPaidLoans?'Скрыть погашенные':`Показать погашенные (${paidLoans.length})`}</button>}</div></section>
        <section className="point-book"><div className="book-title"><div><h2>3. Расходы сотрудников</h2><span>Еда · аванс · бензин · доставка · прочее.</span></div><b>{money(expTotal)}</b></div><div className="expense-entry"><select value={expense.employeeId} onChange={e=>setExpense(x=>({...x,employeeId:e.target.value}))}><option value="">Без сотрудника</option>{state.employees.map((e:Employee)=><option key={e.id} value={e.id}>{e.name}</option>)}</select><select value={expense.category} onChange={e=>setExpense(x=>({...x,category:e.target.value}))}><option value="">Выберите статью</option>{state.expenseCategories.map((c:ExpenseCategory)=><option key={c.id} value={c.name}>{c.name}</option>)}</select><input placeholder="Комментарий" value={expense.comment} onChange={e=>setExpense(x=>({...x,comment:e.target.value}))}/><input type="number" placeholder="Сумма" value={expense.amount} onChange={e=>setExpense(x=>({...x,amount:e.target.value}))}/><label className="loan-check"><input type="checkbox" checked={expense.isLoan} onChange={e=>setExpense(x=>({...x,isLoan:e.target.checked}))}/>В долг</label><button className="primary" onClick={addExpense}>＋ Добавить</button></div><div className="expense-table"><div className="expense-head"><span>Сотрудник</span><span>Категория</span><span>Комментарий</span><span>Сумма</span><span></span></div>{exps.map((e:EveningExpense)=>editExp?.id===e.id?expenseEditRow(e):<div className="expense-row" key={e.id}><b>{e.employee_name||'Без сотрудника'}</b><span>{e.category}</span><span>{e.comment||'—'}{e.is_loan&&<em className={`loan-badge ${num(e.repaid)>=num(e.amount)?'paid':num(e.repaid)>0?'partial':'unpaid'}`}>{num(e.repaid)>=num(e.amount)?'Долг погашен':num(e.repaid)>0?`Долг: вернули ${money(e.repaid)} из ${money(e.amount)}`:'Долг: не возвращён'}</em>}</span><strong>{money(e.amount)}</strong><span className="row-actions">{status!=='CLOSED'&&<button title="Изменить" onClick={()=>startExpEdit(e)}>✎</button>}<button title="Удалить" onClick={()=>removeExpense(e.id)}>×</button></span></div>)}{!exps.length&&<div className="empty-state compact">За этот день расходов пока нет.</div>}</div><div className="employee-inline"><input placeholder="Добавить сотрудника" value={newEmployee} onChange={e=>setNewEmployee(e.target.value)}/><button onClick={addEmployee}>Сохранить сотрудника</button><span>Всего сотрудников: {state.employees.length}</span></div><div className="employee-inline category-inline"><input placeholder="Новая статья расхода" value={newCategory} onChange={e=>setNewCategory(e.target.value)}/><button onClick={addExpenseCategory}>Сохранить статью</button><div className="category-chip-list">{state.expenseCategories.map((c:ExpenseCategory)=><span className="category-chip" key={c.id}>{c.name}<button onClick={()=>removeExpenseCategory(c.id)} title="Скрыть статью">×</button></span>)}{!state.expenseCategories.length&&<span>Статей пока нет</span>}</div></div></section>

        <section className="point-book"><div className="book-title clickable-section" onClick={()=>setCollapsed(x=>({...x,journal:!x.journal}))}><div><h2>4. Что прошло за день</h2><span>Последняя добавленная накладная всегда сверху. Накладную можно изменить или удалить, пока день не закрыт.</span></div><b>{collapsed.journal?'＋':'−'}</b></div>{!collapsed.journal&&<div className="day-ledger">{dayOps.length?dayOps.map(o=>{const isSale=o.note?.startsWith('[SALE]');const isTransfer=o.note?.startsWith('[TRANSFER_TO_ANGAR]');const isCount=o.note?.startsWith('[STOCKTAKE]');const isArrival=o.type==='ARRIVAL';const action=isCount?'ИНВЕНТАРИЗАЦИЯ':isSale?'ПРОДАЖА':isTransfer?'В АНГАР':isArrival?'ПРИЁМКА':'ОТГРУЗКА';const verb=isCount?(isArrival?'Излишек':'Недостача'):isSale?'Продал':isTransfer?'Переместил':isArrival?'Привёз':'Увёз';const time=new Date(o.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});if(editOp?.id===o.id)return editPanel(o);return <div className={`ledger-row ${isArrival?'in':'out'}`} key={o.id}><div className="ledger-main"><div className="ledger-meta"><b>№{o.operation_number}</b><span className="ledger-time">{time}</span></div><strong>{action}</strong><span className="ledger-person">{o.contractor_name} · {verb}</span></div><div className="ledger-items">{sortItems(o.items).map(i=><span key={i.product_id}><b>{i.product_name}</b> · {qty(i.kg)} кг · {money(i.sum)}</span>)}</div><div className="ledger-total">{money(o.items.reduce((s:number,i:OperationItem)=>s+i.sum,0))}{!isTransfer&&!isCount&&status!=='CLOSED'&&<div className="ledger-actions"><button title="Изменить" onClick={()=>startEdit(o)}>✎ Изменить</button><button className="danger" title="Удалить" onClick={()=>deleteOp(o)}>🗑 Удалить</button></div>}{status==='CLOSED'&&<small className="ledger-locked">день закрыт</small>}</div></div>}) : <div className="empty-state compact">Сегодня операций ещё нет.</div>}</div>}</section>
        <div className="print-sheet"><h2>Учёт склада · Точка</h2><pre>{buildDayText()}</pre></div>
      </>}

      {tab==='days'&&<><section className="point-book"><div className="book-title"><div><div className="eyebrow">КОНТРОЛЬ</div><h2>Обзор дней</h2><span>Последние 30 дней. Нажмите на день, чтобы открыть его. Красным отмечены дни с операциями, которые не закрыты.</span></div><div className={`evening-badge`}>{staleDays.length?`не закрыто: ${staleDays.length}`:'всё закрыто'}</div></div><div className="days-list">{days.map((d:DayRow)=>{const empty=d.status===null&&d.ops===0&&d.expenses===0;const stale=d.date<today()&&d.status!=='CLOSED'&&!empty;const label=d.status==='CLOSED'?'Закрыт':d.status==='CHECKED'?'Проверен, не закрыт':d.status==='DRAFT'?'Черновик':empty?'Нет данных':'Не закрыт';return <button className={`day-row ${stale?'stale':''} ${empty?'empty':''} ${d.date===date?'current':''}`} key={d.date} onClick={()=>{setDate(d.date);setTab('work');}}><b>{ruDate(d.date)}</b><span className={`day-chip ${d.status==='CLOSED'?'ok':empty?'muted':'warn'}`}>{label}</span><span>{d.ops>0?`операций: ${d.ops}`:''}{d.ops>0&&d.expenses>0?' · ':''}{d.expenses>0?`расходов: ${d.expenses}`:''}</span><span>{d.variance!=null&&num(d.variance)!==0?<em className="day-var">расхождение {money(d.variance)}</em>:d.status==='CLOSED'?<em className="day-ok">касса сошлась</em>:null}{d.has_comment&&' 💬'}</span></button>})}{!days.length&&<div className="empty-state compact">Загрузка…</div>}</div></section>
      <section className="point-book"><div className="book-title"><div><div className="eyebrow">ИСТОРИЯ</div><h2>Переоткрытия дня</h2><span>Кто, когда и почему переоткрывал уже закрытый день.</span></div></div>{reopens.length?<div className="reopen-list">{reopens.map((r:ReopenRow)=><div className="reopen-row" key={r.id}><b>{ruDate(r.date)}</b><span>{r.user_name}</span><span className="reopen-reason">{r.reason}</span><small>{new Date(r.created_at).toLocaleString('ru-RU')}</small></div>)}</div>:<div className="empty-state compact">Переоткрытий пока не было.</div>}</section></>}

      {tab==='count'&&<>
        <section className="point-book"><div className="book-title"><div><div className="eyebrow">СКЛАД</div><h2>Инвентаризация</h2><span>Взвесили металл — впишите фактический вес. Система сравнит с учётом и сама создаст корректировку: излишек или недостачу. Считаем на текущий момент, день ({date}) должен быть открыт.</span></div></div><div className="count-table"><div className="count-head"><span>Товар</span><span>По учёту, кг</span><span>По факту, кг</span><span>Разница</span></div>{activeProducts.map((p:Product)=>{const st=stockMap.get(p.id);const sys=num(st?.quantity_kg);const raw=countRows[p.id];const has=raw!==undefined&&raw!=='';const diff=has?Math.round((num(raw)-sys)*1000)/1000:0;return <div className="count-row" key={p.id}><b>{p.name}</b><span>{qty(sys)}</span><input type="number" step="0.001" min="0" placeholder="—" value={raw??''} onChange={e=>setCountRows((x:Record<string,string>)=>({...x,[p.id]:e.target.value}))}/><em className={diff>0?'plus':diff<0?'minus':''}>{has?`${diff>0?'+':''}${qty(diff)} кг${diff!==0?` · ${money(Math.round(diff*num(st?.avg_cost)*100)/100)}`:''}`:''}</em></div>})}</div><div className="count-footer"><input placeholder="Причина / комментарий (обязательно), например: плановая инвентаризация" value={countReason} onChange={e=>setCountReason(e.target.value)}/><button className="primary" disabled={busy||!countFilled} onClick={applyStocktake}>Применить инвентаризацию</button></div><small className="muted">Пустые строки не проверяются и не меняются. Изменения делают admin и manager.</small></section>
        <section className="point-book"><div className="book-title"><div><h2>История инвентаризаций</h2><span>Что проверяли и что было исправлено.</span></div></div>{stocktakes.length?stocktakes.map((t:Stocktake)=><details className="count-hist" key={t.id}><summary><b>{t.date}</b> · {t.reason}<span>{t.items.filter((i:StocktakeItem)=>num(i.diff_kg)!==0).length} расхожд. из {t.items.length}{t.user_name?` · ${t.user_name}`:''}</span></summary>{t.items.map((i:StocktakeItem)=><div className="count-hist-row" key={i.product_name}><b>{i.product_name}</b><span>{qty(i.system_kg)} → {qty(i.actual_kg)} кг</span><em className={num(i.diff_kg)>0?'plus':num(i.diff_kg)<0?'minus':''}>{num(i.diff_kg)===0?'без расхождений':`${num(i.diff_kg)>0?'+':''}${qty(i.diff_kg)} кг · ${money(i.diff_cost)}`}</em></div>)}</details>):<div className="empty-state compact">Инвентаризаций пока не было.</div>}</section>
      </>}

      {tab==='stock'&&<>
        <section className="point-book"><div className="book-title"><div><div className="eyebrow">СКЛАД ТОЧКИ</div><h2>Остатки и товары</h2><span>Просмотр текущего остатка, средней себестоимости и стоимости. Новый товар добавляется прямо сюда.</span></div><div className="evening-badge">{state.products.length} товаров</div></div><div className="stock-admin-grid"><div className="stock-add-card"><div className="notebook-title">Новый товар</div><div className="stock-add-fields"><input placeholder="Название товара" value={newProduct.name} onChange={e=>setNewProduct(x=>({...x,name:e.target.value}))}/><input type="number" min="0" step="0.01" placeholder="Цена по умолчанию ₸/кг" value={newProduct.price} onChange={e=>setNewProduct(x=>({...x,price:e.target.value}))}/><button className="primary" disabled={busy} onClick={addProduct}>＋ Добавить товар</button></div></div><div className="stock-totals-card"><span>Всего металла</span><b>{qty(totalStockKg)} кг</b><small>{money(stockValue)} по себестоимости</small></div></div></section>
        <section className="point-book"><div className="book-title"><div><h2>Склад по товарам</h2><span>Все активные товары Точки, по категориям.</span></div></div>{groupByCategory([...state.stock].sort((a:StockRow,b:StockRow)=>(productOrder.get(a.product_id)??9999)-(productOrder.get(b.product_id)??9999))).map(g=>{const kgSum=g.items.reduce((s2:number,s:StockRow)=>s2+num(s.quantity_kg),0);const valSum=g.items.reduce((s2:number,s:StockRow)=>s2+num(s.inventory_value),0);return <div className="category-block" key={g.category}><div className="category-head"><span className={`category-dot cat-${slugCat(g.category)}`}/><h3>{g.category}</h3><span className="muted">{g.items.length} тов. · {qty(kgSum)} кг · {money(valSum)}</span></div><div className="compact-stock-grid stock-grid-wide">{g.items.map((s:StockRow)=><div className="compact-stock-card" key={s.product_id}><div><b>{s.product_name}</b><small>Прайс: {money(state.products.find(p=>p.id===s.product_id)?.default_price||0)}/кг</small></div><strong>{qty(s.quantity_kg)} кг</strong><span>{money(s.avg_cost)}/кг · {money(s.inventory_value)}</span></div>)}</div></div>})}</section>
      </>}

      {tab==='payroll'&&<PointPayroll employees={state.employees} categories={state.expenseCategories} notify={notify} onChanged={()=>{loadEvening();loadDays();}}/>}
      {tab==='report'&&<section className="report-screen">
        <div className="point-book"><div className="book-title"><div><div className="eyebrow">ОТЧЁТЫ ТОЧКИ</div><h2>{reportPeriodLabel}</h2><span>Всё за период одним экраном: касса, кто сколько взял, расходы по статьям и лист по дням для проверки.</span></div></div><div className="report-toolbar"><div className="period-chips"><button className={`chip ${reportPeriod==='week'?'on':''}`} onClick={()=>setPeriod('week')}>7 дней</button><button className={`chip ${reportPeriod==='month'?'on':''}`} onClick={()=>setPeriod('month')}>Месяц</button><button className={`chip ${reportPeriod==='custom'?'on':''}`} onClick={()=>setReportPeriod('custom')}>Свой период</button></div><div className="report-dates"><label><span>С</span><input type="date" value={reportFrom} max={reportTo} onChange={e=>{setReportPeriod('custom');setReportFrom(e.target.value)}}/></label><label><span>По</span><input type="date" value={reportTo} min={reportFrom} max={today()} onChange={e=>{setReportPeriod('custom');setReportTo(e.target.value)}}/></label><button className="primary" onClick={loadReport}>Обновить</button><button onClick={exportReportXlsx}>⬇ Excel</button></div></div></div>

        {!report?<div className="point-book empty-state"><b>Выберите период</b><span>Отчёт строится по складу Точки.</span></div>:<>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">1 · КАССА ЗА ПЕРИОД</div><h2>Сошлась ли касса</h2><span>Сколько денег должно быть в кассе по записям и сколько насчитали на самом деле. Считаем по дням, где есть вечерняя сводка.</span></div></div>
          <div className="led">
            {!ledger?<div className="led-empty"><b>За этот период нет ни одной вечерней сводки — касса не сверялась.</b><span>Заполняйте «Вечер» каждый день, тогда здесь появится сверка.</span></div>:<>
              <div className="led-row base"><span>Касса на начало<small>{ruDate(ledger.openDate)}</small></span><b>{money(ledger.opening)}</b></div>
              <div className="led-row plus"><span>Принесли в кассу</span><b>+{money(ledger.brought)}</b></div>
              {ledger.sale>0&&<div className="led-row plus"><span>Продажи наличными</span><b>+{money(ledger.sale)}</b></div>}
              {ledger.repay>0&&<div className="led-row plus"><span>Вернули долги</span><b>+{money(ledger.repay)}</b></div>}
              <div className="led-row minus"><span>Закуп<small>оплачено из кассы</small></span><b>−{money(ledger.purchase)}</b></div>
              <div className="led-row minus"><span>Расходы<small>{num(rt.loan_given_amount)>0?`из них выдано в долг: ${money(rt.loan_given_amount)}`:'зарплата, аванс, еда и т.д.'}</small></span><b>−{money(ledger.expense)}</b></div>
              {Math.abs(ledger.gap)>=1&&<div className="led-row gap"><span>Дни без сводки<small>касса менялась, а записей нет</small></span><b>{ledger.gap>0?'+':'−'}{money(Math.abs(ledger.gap))}</b></div>}
              <div className="led-row sub"><span>Должно быть в кассе</span><b>{money(ledger.expected)}</b></div>
              <div className="led-row sub"><span>Насчитали по факту<small>{ruDate(ledger.actualDate)}</small></span><b>{ledger.actual==null?'ещё не считали':money(ledger.actual)}</b></div>
              <div className={`led-result ${ledger.diff==null?'wait':Math.abs(ledger.diff)<1?'ok':ledger.diff<0?'bad':'plus'}`}>
                {ledger.diff==null?'Кассу в последний день ещё не посчитали':Math.abs(ledger.diff)<1?'✓ Касса сошлась':ledger.diff<0?`Недостача ${money(-ledger.diff)}`:`Излишек ${money(ledger.diff)}`}
              </div>
            </>}
            {noSumWithOps.length>0&&<p className="led-note warn">Нет вечерней сводки за дни с операциями: {noSumWithOps.map(d=>ruDate(dIso(d))).join(', ')}.{(missedPurchase>0||missedExpense>0)&&<> Закуп {money(missedPurchase)} и расходы {money(missedExpense)} за эти дни в сверку не вошли.</>}</p>}
            {ledger?.gaps.map(g=><p className="led-note" key={g.from}>Между {ruDate(g.from)} и {ruDate(g.to)} сводок нет: касса изменилась на {g.amount>0?'+':'−'}{money(Math.abs(g.amount))} без записей.</p>)}
            {ledger?.lastStatus==='DRAFT'&&<p className="led-note">День {ruDate(ledger.actualDate)} ещё не закрыт — цифры могут измениться.</p>}
          </div>
          <div className="stat-cards report-kpis"><div><small>Дней в периоде</small><b>{rt.days_total}</b><span>закрыто: {rt.days_closed}</span></div><div><small>С расхождением кассы</small><b className={num(rt.days_variance)>0?'warn':''}>{rt.days_variance}</b><span>из {rt.days_total} дней</span></div><div><small>Прибыль от металла</small><b>{money(periodProfit)}</b><span>продажа+отгрузка минус себестоимость</span></div><div><small>Не погашено долгов</small><b className={openLoans.length?'warn':''}>{money(openRemaining)}</b><span>на сегодня, {openLoans.length} чел.</span></div></div>
          <div className="rep-sec">
            <div className="notebook-title">Металл за период</div>
            {metalRows.length?<div className="mt-wrap"><table className="mt-table">
              <thead><tr><th>Металл</th><th>Закуплено, кг</th><th>На сумму</th><th>Цена, ₸/кг</th>{showShip&&<th>Отгружено, кг</th>}{showSale&&<th>Продано, кг</th>}<th>На складе сейчас, кг</th></tr></thead>
              <tbody>{metalRows.map(x=><tr key={x.name}>
                <td><b>{x.name}</b></td>
                <td><div className="mt-bar"><i style={pct(num(x.purchase_kg),metalMax)}/><span>{num(x.purchase_kg)>0?qty(x.purchase_kg):'—'}</span></div></td>
                <td>{num(x.purchase_amount)>0?money(x.purchase_amount):'—'}</td>
                <td>{num(x.purchase_kg)>0?money(Math.round(num(x.purchase_amount)/num(x.purchase_kg)*10)/10):'—'}</td>
                {showShip&&<td>{num(x.shipment_kg)>0?qty(x.shipment_kg):'—'}</td>}
                {showSale&&<td>{num(x.sale_kg)>0?qty(x.sale_kg):'—'}</td>}
                <td className="mt-stock">{qty(x.stock_kg)}</td>
              </tr>)}</tbody>
              <tfoot><tr><td><b>Итого</b></td><td><b>{qty(metalSum('purchase_kg'))}</b></td><td><b>{money(metalSum('purchase_amount'))}</b></td><td><b>{metalSum('purchase_kg')>0?money(Math.round(metalSum('purchase_amount')/metalSum('purchase_kg')*10)/10):'—'}</b></td>{showShip&&<td><b>{qty(metalSum('shipment_kg'))}</b></td>}{showSale&&<td><b>{qty(metalSum('sale_kg'))}</b></td>}<td><b>{qty(metalSum('stock_kg'))}</b></td></tr></tfoot>
            </table></div>:<div className="empty-state compact">За период движений металла нет.</div>}
          </div>
          <div className="rep-sec">
            <div className="notebook-title">Расходы по статьям{catsSorted.length>0&&<em className="rep-total"> · всего {money(catsTotal)}</em>}</div>
            {catsSorted.length?<div className="exp-list">{catsSorted.map((c:RepCategory)=>{const share=catsTotal>0?num(c.amount)/catsTotal*100:0;return <div className="exp-row" key={c.category}>
              <span>{c.category}<small>{c.count} {c.count===1?'запись':'записей'}</small></span>
              <div className="exp-track"><i style={pct(num(c.amount),Math.max(1,num(catsSorted[0].amount)))}/></div>
              <b>{money(c.amount)}</b><em>{share>0&&share<1?'<1':Math.round(share)}%</em>
            </div>})}</div>:<div className="empty-state compact">Расходов за период нет.</div>}
          </div>
        </section>

        <div className="stat-cards report-kpis"><div><small>Закуплено</small><b>{qty(reportTotals.purchase_kg)} кг</b><span>{money(reportTotals.purchase_amount)}</span></div><div><small>Отгружено</small><b>{qty(reportTotals.shipment_kg)} кг</b><span>{money(reportTotals.shipment_amount)}</span></div><div><small>Продано</small><b>{qty(reportTotals.sale_kg)} кг</b><span>{money(reportTotals.sale_amount)}</span></div><div><small>В Ангар</small><b>{qty(reportTotals.transfer_kg)} кг</b><span>перемещение</span></div></div>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">2 · ПО ДНЯМ</div><h2>Закуп и цена по дням</h2><span>Наведите на день (или коснитесь на телефоне): увидите сумму, вес и цену. Столбики можно переключить между суммой и весом.</span></div></div>
          <DailyCharts days={chartDays}/>
        </section>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">3 · ЛЮДИ</div><h2>Кто сколько взял</h2><span>Строго за выбранный период. Нажмите на сотрудника — увидите, когда и на что. Долги «осталось» считаются на сегодня.</span></div></div>
          <div className="ppl">
            <div className="ppl-head"><span>Сотрудник</span><span className="ppl-c">Аванс</span><span className="ppl-c">Зарплата</span><span className="ppl-c">Расходы</span><span className="ppl-c">В долг</span><span className="ppl-t">Всего</span></div>
            {[...mainPeople,...(servicePerson?[servicePerson]:[])].map((x:PersonRep)=>{const k=x.employee_id||'none';const open=!!openPerson[k];const d=(v:number)=>num(v)>0?money(v):'—';return <div className="ppl-item" key={k}>
              <button type="button" className={`ppl-row ${open?'open':''} ${x.employee_id==='service'?'svc':''}`} onClick={()=>setOpenPerson({...openPerson,[k]:!open})}>
                <b>{open?'▾':'▸'} {x.name}{x.employee_id==='service'&&<em className="ppl-names"> ({servicePeople.map(sp=>sp.name).join(', ')})</em>}</b>
                <span className="ppl-c">{d(x.advance)}</span><span className="ppl-c">{d(x.salary)}</span><span className="ppl-c">{d(x.other)}</span><span className="ppl-c">{d(x.loan_given)}</span><span className="ppl-t"><b>{money(x.total)}</b></span>
              </button>
              {open&&<div className="ppl-detail">
                <div className="ppl-break"><span>Аванс <b>{d(x.advance)}</b></span><span>Зарплата <b>{d(x.salary)}</b></span><span>Расходы <b>{d(x.other)}</b></span>{num(x.loan_given)>0&&<span>В долг <b>{money(x.loan_given)}</b></span>}</div>
                {x.items.map((it:PersonItem,i:number)=><div className="ppl-line" key={i}><span>{ruDate(String(it.date).slice(0,10))}</span><span>{it.category}{it.is_loan?' (в долг)':''}{it.comment?<em> · {it.comment}</em>:null}</span><b>{money(it.amount)}</b></div>)}
              </div>}
            </div>})}
            {!reportPeople.length&&<div className="empty-state compact">За период расходов и долгов нет.</div>}
            {reportPeople.length>0&&<div className="ppl-row total"><b>Итого</b><span className="ppl-c">{money(sumP(reportPeople,'advance'))}</span><span className="ppl-c">{money(sumP(reportPeople,'salary'))}</span><span className="ppl-c">{money(sumP(reportPeople,'other'))}</span><span className="ppl-c">{money(sumP(reportPeople,'loan_given'))}</span><span className="ppl-t"><b>{money(peopleTotal)}</b></span></div>}
            {reportPeople.length>0&&<p className={`ppl-check ${Math.abs(peopleDiff)<1?'ok':'warn'}`}>{Math.abs(peopleDiff)<1?`✓ Сходится с расходами за период: ${money(rt0.expense_amount)}`:`⚠ Не сходится с расходами за период (${money(rt0.expense_amount)}): разница ${money(peopleDiff)}`}</p>}
          </div>
          {debtPeople.length>0&&<div className="ppl-debts"><div className="notebook-title">Долги</div>
            <div className="ppl-dhead"><span>Сотрудник</span><span>Выдан за период</span><span>Вернул за период</span><span>Осталось сегодня</span></div>
            {debtPeople.map((x:PersonRep)=><div className={`ppl-drow ${num(x.debt_remaining)>0?'has-debt':''}`} key={x.employee_id||'none'}><b>{x.name}</b><span>{num(x.loan_given)>0?money(x.loan_given):'—'}</span><span>{num(x.repaid)>0?money(x.repaid):'—'}</span><span className={num(x.debt_remaining)>0?'warn-text':''}>{num(x.debt_remaining)>0?money(x.debt_remaining):'—'}</span></div>)}
          </div>}
        </section>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">4 · СТАТЬИ</div><h2>На что ушли деньги</h2><span>Расходы за период по статьям, без выданных долгов.</span></div></div>
          <div className="report-rows">{reportCategories.map((c:RepCategory)=><div className="report-row" key={c.category}><div><b>{c.category}</b><small>{c.count} операц.</small></div><strong>{money(c.amount)}</strong></div>)}{!reportCategories.length&&<div className="empty-state compact">Категорий нет.</div>}</div>
        </section>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">5 · СКЛАД</div><h2>По товарам</h2><span>Что покупали, отгружали и сколько осталось, по категориям, в твоём порядке.</span></div></div>{groupByCategory(orderedReportProducts).map(g=><div className="category-block" key={g.category}><div className="category-head"><span className={`category-dot cat-${slugCat(g.category)}`}/><h3>{g.category}</h3><span className="muted">{g.items.length} тов.</span></div><div className="report-product-grid">{g.items.map((p)=><div className="report-product-card" key={p.name}><b>{p.name}</b><span>Остаток: {qty(p.stock_kg)} кг</span><span>Приход: {qty(p.purchase_kg)} кг · {money(p.purchase_amount)}</span><span>Отгрузка: {qty(p.shipment_kg)} кг · {money(p.shipment_amount)}</span><span>Продажа: {qty(p.sale_kg)} кг · {money(p.sale_amount)}</span></div>)}</div></div>)}</section>

        <section className="point-book"><div className="book-title"><div><div className="eyebrow">6 · ЛИСТ ПО ДНЯМ</div><h2>День за днём</h2><span>Каждая строка — один день. Нажми на день, чтобы открыть его на вкладке «Работа». Жёлтым — расхождение кассы, серым — пустые дни без операций.</span></div></div>
          <div className="days-sheet"><div className="days-sheet-head"><span>День</span><span>Закуп</span><span>Продажа</span><span>Расходы</span><span>Долг</span><span>Внесли</span><span>Касса</span><span>Комментарий</span></div>
          {reportDays.map((d:RepDay)=>{const empty=!d.status&&!d.ops;const hasVar=d.variance!=null&&num(d.variance)!==0;return <button className={`days-sheet-row ${empty?'empty':''} ${hasVar?'stale':''}`} key={d.date} onClick={()=>{setDate(d.date);setTab('work');}}><span className="dsr-date"><b>{ruDate(d.date)}</b><em className={`day-chip ${d.status==='CLOSED'?'ok':d.status?'warn':'muted'}`}>{d.status==='CLOSED'?'закрыт':d.status==='CHECKED'?'проверен':d.status==='DRAFT'?'черновик':'нет данных'}</em></span><span>{d.purchase_amount?money(d.purchase_amount):'—'}</span><span>{d.sale_amount?money(d.sale_amount):'—'}</span><span>{d.expense_amount?money(d.expense_amount):'—'}</span><span>{d.loan_amount?money(d.loan_amount):'—'}</span><span>{d.repayment_amount?money(d.repayment_amount):'—'}</span><span>{d.actual_cash==null?'—':<>{money(d.actual_cash)}{hasVar&&<em className="warn-text"> ({num(d.variance)>0?'+':''}{money(d.variance)})</em>}</>}</span><span className="dsr-comment">{d.comment||''}</span></button>})}
          {!reportDays.length&&<div className="empty-state compact">Нет данных за период.</div>}</div>
        </section>

        </>}
      </section>}
<footer className="point-footer"><span>Точка · {date}</span><span>Операций: {dayOps.length} · Расходов: {exps.length} · Статус: <b>{status}</b></span></footer>
      {toast&&<div className="toast">{toast}</div>}
    </div>
  </main>;
}

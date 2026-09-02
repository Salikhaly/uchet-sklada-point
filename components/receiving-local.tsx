'use client';

import { useEffect, useMemo, useState } from 'react';

type Product = { id: string; name: string; default_price: number; status: string; sort_order?: number };
type Channel = 'CASH' | 'KASPI' | 'TRANSFER';
type ShipmentDestination = 'ANGAR' | 'CLIENT';
type OperationKind = 'ARRIVAL' | 'SHIPMENT';
type Employee = { id: string; name: string };
type EmployeeTxKind = 'SALARY' | 'ADVANCE' | 'DEBT' | 'DEBT_REPAY';
type EmployeeTx = { id: string; date: string; employeeId: string; kind: EmployeeTxKind; amount: number; note: string };
type MoneyEntry = { id: string; date: string; kind: 'IN' | 'OUT'; channel: Channel; amount: number; category: string; person: string; note: string };
type Item = { productId: string; kg: number; price: number; sum: number; cogs: number };
type LocalOp = {
  id: string;
  number: number;
  date: string;
  kind: OperationKind;
  destination: ShipmentDestination | null;
  items: Item[];
  party: string;
  note: string;
  createdAt: string;
};
type DayClose = {
  id: string;
  date: string;
  actualCash: number;
  actualKaspi: number;
  actualTransfer: number;
  actualStock: Record<string, number>;
  note: string;
  closed: boolean;
  createdAt: string;
};
type DraftRow = { kg: string; price: string; sum: string; cogs: string };
type ProductStock = {
  kg: number;
  value: number;
  inKg: number;
  inValue: number;
  clientKg: number;
  clientSales: number;
  clientCogs: number;
  angarKg: number;
  angarCost: number;
};

type Props = { products: Product[] };

const KEY = 'warehouse-receiving-v14-local';
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const money = (v: unknown) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(num(v)) + ' ₸';
const qty = (v: unknown) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(num(v));
const uid = () => crypto.randomUUID();

export default function ReceivingLocal({ products: seedProducts }: Props) {
  const products = useMemo(
    () => seedProducts.filter(p => p.status === 'ACTIVE').slice().sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999) || a.name.localeCompare(b.name, 'ru')),
    [seedProducts]
  );

  const [tab, setTab] = useState<'monitor' | 'entry' | 'journal' | 'stock' | 'report' | 'closing'>('monitor');
  const [ops, setOps] = useState<LocalOp[]>([]);
  const [moneyEntries, setMoneyEntries] = useState<MoneyEntry[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeeTx, setEmployeeTx] = useState<EmployeeTx[]>([]);
  const [closes, setCloses] = useState<DayClose[]>([]);
  const [opening, setOpening] = useState<Record<string, { kg: string; price: string }>>({});
  const [loadStatus, setLoadStatus] = useState<Record<string, 'LOAD' | 'HOLD' | 'CHECK'>>({});

  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<OperationKind>('ARRIVAL');
  const [destination, setDestination] = useState<ShipmentDestination>('CLIENT');
  const [rows, setRows] = useState<Record<string, DraftRow>>({});
  const [party, setParty] = useState('');
  const [note, setNote] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [actualCash, setActualCash] = useState('');
  const [actualKaspi, setActualKaspi] = useState('');
  const [actualTransfer, setActualTransfer] = useState('');
  const [actualStock, setActualStock] = useState<Record<string, string>>({});
  const [closeNote, setCloseNote] = useState('');
  const [moneyForm, setMoneyForm] = useState({ kind: 'OUT' as 'IN' | 'OUT', channel: 'CASH' as Channel, amount: '', category: '', person: '', note: '' });
  const [employeeForm, setEmployeeForm] = useState({ name: '' });
  const [employeeTxForm, setEmployeeTxForm] = useState({ employeeId: '', kind: 'SALARY' as EmployeeTxKind, amount: '', note: '' });
  const [toast, setToast] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      const migratedOps: LocalOp[] = Array.isArray(d.ops) ? d.ops.map((o: any) => ({
        ...o,
        kind: o.kind === 'TRANSFER' ? 'SHIPMENT' : o.kind,
        destination: o.kind === 'TRANSFER' ? 'ANGAR' : (o.destination ?? (o.kind === 'SHIPMENT' ? 'CLIENT' : null)),
      })) : [];
      setOps(migratedOps);
      setMoneyEntries(Array.isArray(d.moneyEntries) ? d.moneyEntries : []);
      setEmployees(Array.isArray(d.employees) ? d.employees : []);
      setEmployeeTx(Array.isArray(d.employeeTx) ? d.employeeTx : []);
      setCloses(Array.isArray(d.closes) ? d.closes : []);
      setOpening(d.opening && typeof d.opening === 'object' ? d.opening : {});
      setLoadStatus(d.loadStatus && typeof d.loadStatus === 'object' ? d.loadStatus : {});
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify({ ops, moneyEntries, employees, employeeTx, closes, opening, loadStatus }));
  }, [ops, moneyEntries, employees, employeeTx, closes, opening, loadStatus]);

  const stock = useMemo(() => {
    const r: Record<string, ProductStock> = {};
    for (const p of products) {
      const o = opening[p.id];
      const kg = num(o?.kg);
      const price = num(o?.price);
      r[p.id] = { kg, value: kg * price, inKg: 0, inValue: 0, clientKg: 0, clientSales: 0, clientCogs: 0, angarKg: 0, angarCost: 0 };
    }
    for (const op of ops) {
      for (const item of op.items) {
        const x = r[item.productId] ?? { kg: 0, value: 0, inKg: 0, inValue: 0, clientKg: 0, clientSales: 0, clientCogs: 0, angarKg: 0, angarCost: 0 };
        if (op.kind === 'ARRIVAL') {
          x.kg += item.kg;
          x.value += item.sum;
          x.inKg += item.kg;
          x.inValue += item.sum;
        } else {
          x.kg -= item.kg;
          x.value -= item.cogs;
          if (op.destination === 'ANGAR') {
            x.angarKg += item.kg;
            x.angarCost += item.cogs;
          } else {
            x.clientKg += item.kg;
            x.clientSales += item.sum;
            x.clientCogs += item.cogs;
          }
        }
        r[item.productId] = x;
      }
    }
    return r;
  }, [products, ops, opening]);

  const dayOps = useMemo(() => ops.filter(o => o.date === date), [ops, date]);
  const dayItems = useMemo(() => dayOps.flatMap(o => o.items.map(i => ({ ...i, kind: o.kind, destination: o.destination }))), [dayOps]);
  const dayInKg = dayItems.filter(i => i.kind === 'ARRIVAL').reduce((s, i) => s + i.kg, 0);
  const dayInSum = dayItems.filter(i => i.kind === 'ARRIVAL').reduce((s, i) => s + i.sum, 0);
  const dayAngarKg = dayItems.filter(i => i.kind === 'SHIPMENT' && i.destination === 'ANGAR').reduce((s, i) => s + i.kg, 0);
  const dayAngarCost = dayItems.filter(i => i.kind === 'SHIPMENT' && i.destination === 'ANGAR').reduce((s, i) => s + i.cogs, 0);
  const dayClientKg = dayItems.filter(i => i.kind === 'SHIPMENT' && i.destination === 'CLIENT').reduce((s, i) => s + i.kg, 0);
  const dayClientSales = dayItems.filter(i => i.kind === 'SHIPMENT' && i.destination === 'CLIENT').reduce((s, i) => s + i.sum, 0);
  const dayClientCogs = dayItems.filter(i => i.kind === 'SHIPMENT' && i.destination === 'CLIENT').reduce((s, i) => s + i.cogs, 0);
  const dayProfit = dayClientSales - dayClientCogs;

  const moneyExpected = useMemo(() => {
    const r = { CASH: 0, KASPI: 0, TRANSFER: 0 };
    for (const e of moneyEntries.filter(x => x.date === date)) r[e.channel] += e.kind === 'IN' ? e.amount : -e.amount;
    return r;
  }, [moneyEntries, date]);

  const totalStockKg = Object.values(stock).reduce((s, x) => s + x.kg, 0);
  const totalStockValue = Object.values(stock).reduce((s, x) => s + x.value, 0);

  const filteredOps = useMemo(() => ops.filter(o =>
    (!from || o.date >= from) &&
    (!to || o.date <= to) &&
    (!productFilter || o.items.some(i => i.productId === productFilter))
  ), [ops, from, to, productFilter]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  }

  function updateRow(productId: string, field: keyof DraftRow, value: string) {
    setRows(prev => {
      const current = prev[productId] ?? { kg: '', price: String(products.find(p => p.id === productId)?.default_price ?? ''), sum: '', cogs: '' };
      const next = { ...current, [field]: value };
      const kg = num(next.kg);
      const price = num(next.price);
      const sum = next.sum === '' ? null : num(next.sum);
      if (field === 'kg' && kg > 0 && next.sum === '') next.sum = (kg * price).toFixed(2);
      if (field === 'price' && kg > 0) next.sum = (kg * price).toFixed(2);
      if (field === 'sum' && kg > 0 && sum !== null) next.price = String(sum / kg);
      return { ...prev, [productId]: next };
    });
  }

  function addOperation() {
    const items: Item[] = products.flatMap(product => {
      const r = rows[product.id];
      if (!r || num(r.kg) <= 0) return [];
      const kg = num(r.kg);
      const sum = r.sum === '' ? kg * num(r.price) : num(r.sum);
      const price = kg ? sum / kg : 0;
      const current = stock[product.id];
      const avg = current && current.kg > 0 ? current.value / current.kg : price;
      const cogs = kind === 'ARRIVAL' ? sum : (destination === 'ANGAR' && r.cogs !== '' ? num(r.cogs) : kg * avg);
      return [{ productId: product.id, kg, price, sum, cogs }];
    });

    if (!items.length) return notify('Заполните хотя бы один товар');
    if (kind === 'SHIPMENT' && items.some(i => i.kg > (stock[i.productId]?.kg || 0))) return notify('Недостаточно остатка пункта');
    if (kind === 'SHIPMENT' && destination === 'CLIENT' && !party.trim()) return notify('Укажите, кому отгрузили');

    const op: LocalOp = {
      id: uid(),
      number: Math.max(0, ...ops.map(o => o.number)) + 1,
      date,
      kind,
      destination: kind === 'SHIPMENT' ? destination : null,
      items,
      party: kind === 'SHIPMENT' && destination === 'ANGAR' ? 'АНГАР' : party.trim(),
      note,
      createdAt: new Date().toISOString(),
    };
    setOps(current => [op, ...current]);
    setRows({});
    setParty('');
    setNote('');
    notify(kind === 'ARRIVAL' ? 'Приём записан ✅' : destination === 'ANGAR' ? 'Отгрузка в Ангар записана ✅' : 'Отгрузка клиенту записана ✅');
    setTab('journal');
  }

  function addMoney() {
    if (num(moneyForm.amount) <= 0) return notify('Введите сумму');
    setMoneyEntries(current => [{ id: uid(), date, kind: moneyForm.kind, channel: moneyForm.channel, amount: num(moneyForm.amount), category: moneyForm.category, person: moneyForm.person, note: moneyForm.note }, ...current]);
    setMoneyForm(x => ({ ...x, amount: '', category: '', person: '', note: '' }));
  }

  function addEmployee() {
    const name = employeeForm.name.trim();
    if (!name) return notify('Введите имя сотрудника');
    setEmployees(current => [...current, { id: uid(), name }]);
    setEmployeeForm({ name: '' });
  }

  function addEmployeeTx() {
    if (!employeeTxForm.employeeId || num(employeeTxForm.amount) <= 0) return notify('Заполните сотрудника и сумму');
    setEmployeeTx(current => [{ id: uid(), date, employeeId: employeeTxForm.employeeId, kind: employeeTxForm.kind, amount: num(employeeTxForm.amount), note: employeeTxForm.note }, ...current]);
    setEmployeeTxForm(x => ({ ...x, amount: '', note: '' }));
  }

  function closeDay() {
    const moneyDiff = (num(actualCash) - moneyExpected.CASH) + (num(actualKaspi) - moneyExpected.KASPI) + (num(actualTransfer) - moneyExpected.TRANSFER);
    const stockDiffs = products.map(p => ({ product: p, actual: num(actualStock[p.id]), expected: stock[p.id]?.kg || 0, diff: num(actualStock[p.id]) - (stock[p.id]?.kg || 0) })).filter(x => Math.abs(x.diff) > 0.0001);
    if ((Math.abs(moneyDiff) > 0.0001 || stockDiffs.length > 0) && !closeNote.trim()) return notify('Укажите пояснение к расхождению');
    const rec: DayClose = { id: uid(), date, actualCash: num(actualCash), actualKaspi: num(actualKaspi), actualTransfer: num(actualTransfer), actualStock: Object.fromEntries(products.map(p => [p.id, num(actualStock[p.id])])), note: closeNote, closed: true, createdAt: new Date().toISOString() };
    setCloses(current => [rec, ...current.filter(c => c.date !== date)]);
    notify('День закрыт ✅');
  }

  const productSummary = products.map(product => {
    const s = stock[product.id] || { kg: 0, value: 0, inKg: 0, inValue: 0, clientKg: 0, clientSales: 0, clientCogs: 0, angarKg: 0, angarCost: 0 };
    return { product, ...s, avg: s.kg > 0 ? s.value / s.kg : 0 };
  });

  return (
    <section className="panel receiving-integrated" style={{ marginTop: 12 }}>
      <div className="panel-head receiving-integrated-head">
        <div>
          <h2>📥 Пункт приёмки</h2>
          <span className="muted">Единый складской режим · вечерний учёт владельца · без отдельного каталога и без контрагентов</span>
        </div>
        <span className="loc-badge">Локация: Пункт</span>
      </div>

      <div className="chips receiving-nav">
        {(['monitor', 'entry', 'journal', 'stock', 'report', 'closing'] as const).map(x => (
          <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
            {{ monitor: 'Монитор', entry: 'Операция', journal: 'Журнал', stock: 'Остатки', report: 'Отчёты', closing: '🔒 Закрытие дня' }[x]}
          </button>
        ))}
      </div>

      {tab === 'monitor' && (
        <div className="receiving-section">
          <div className="grid-cards">
            <div className="stat-card"><span>Принято сегодня</span><b>{qty(dayInKg)} кг</b><small>{money(dayInSum)}</small></div>
            <div className="stat-card"><span>В Ангар</span><b>{qty(dayAngarKg)} кг</b><small>{money(dayAngarCost)} себестоимость</small></div>
            <div className="stat-card"><span>Продано клиентам</span><b>{qty(dayClientKg)} кг</b><small>{money(dayClientSales)}</small></div>
            <div className="stat-card"><span>Валовая</span><b className={dayProfit >= 0 ? 'green' : 'red'}>{money(dayProfit)}</b><small>COGS {money(dayClientCogs)}</small></div>
            <div className="stat-card"><span>Остаток пункта</span><b>{qty(totalStockKg)} кг</b><small>{money(totalStockValue)}</small></div>
          </div>
          <div className="panel-lite">
            <div className="panel-head"><h3>Что делать с товаром</h3><span className="muted">Как в Ангаре: остаток и средняя себестоимость</span></div>
            <div className="table-wrap"><table><thead><tr><th>Товар</th><th>Остаток</th><th>Средняя себестоимость</th><th>Стоимость</th><th>Статус</th></tr></thead><tbody>
              {productSummary.map(x => <tr key={x.product.id}><td><b>{x.product.name}</b></td><td>{qty(x.kg)} кг</td><td>{money(x.avg)}</td><td>{money(x.value)}</td><td><select value={loadStatus[x.product.id] || 'LOAD'} onChange={e => setLoadStatus(s => ({ ...s, [x.product.id]: e.target.value as any }))}><option value="LOAD">🟢 Грузить</option><option value="HOLD">🟡 Пока не грузить</option><option value="CHECK">🔴 Проверить</option></select></td></tr>)}
            </tbody></table></div>
          </div>
        </div>
      )}

      {tab === 'entry' && (
        <div className="receiving-section">
          <div className="seg">
            <button className={kind === 'ARRIVAL' ? 'active' : ''} onClick={() => setKind('ARRIVAL')}>📥 Приём за день</button>
            <button className={kind === 'SHIPMENT' ? 'active' : ''} onClick={() => setKind('SHIPMENT')}>🚚 Отгрузка</button>
          </div>
          {kind === 'SHIPMENT' && <div className="seg"><button className={destination === 'CLIENT' ? 'active' : ''} onClick={() => setDestination('CLIENT')}>Клиенту</button><button className={destination === 'ANGAR' ? 'active' : ''} onClick={() => setDestination('ANGAR')}>В Ангар</button></div>}
          <div className="form-grid compact-grid">
            <label>Дата<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
            {kind === 'SHIPMENT' && <label>{destination === 'ANGAR' ? 'Назначение' : 'Кому'}<input value={destination === 'ANGAR' ? 'АНГАР' : party} onChange={e => destination === 'CLIENT' && setParty(e.target.value)} placeholder={destination === 'CLIENT' ? 'Клиент' : ''} disabled={destination === 'ANGAR'} /></label>}
            <label>Комментарий<input value={note} onChange={e => setNote(e.target.value)} placeholder="Необязательно" /></label>
          </div>
          <div className="entry-hint">Вводится вечерний итог. Для отгрузки количество не может превышать остаток пункта. Отгрузка «В Ангар» считается обычной отгрузкой из этого склада, но без выручки.</div>
          <div className="local-op-table">
            <div className="local-op-head"><span>Товар</span><span>Кг</span><span>Цена</span><span>Сумма</span><span>{kind === 'SHIPMENT' ? 'Себестоимость / кг' : 'Средняя / заметка'}</span></div>
            {products.map(p => {
              const r = rows[p.id] ?? { kg: '', price: String(p.default_price || ''), sum: '', cogs: '' };
              const avg = stock[p.id]?.kg ? stock[p.id].value / stock[p.id].kg : num(r.price);
              const defaultCogs = num(r.kg) * avg;
              return <div className="local-op-row" key={p.id}>
                <div className="local-op-name"><b>{p.name}</b><small>{kind === 'ARRIVAL' ? 'Итог приёма за день' : `Остаток ${qty(stock[p.id]?.kg || 0)} кг`}</small></div>
                <input inputMode="decimal" placeholder="Кг" value={r.kg} onChange={e => updateRow(p.id, 'kg', e.target.value)} />
                <input inputMode="decimal" placeholder="Цена" value={r.price} onChange={e => updateRow(p.id, 'price', e.target.value)} />
                <input inputMode="decimal" placeholder="Сумма" value={r.sum} onChange={e => updateRow(p.id, 'sum', e.target.value)} />
                {kind === 'SHIPMENT' && destination === 'ANGAR' ? <input inputMode="decimal" placeholder={money(defaultCogs)} value={r.cogs} onChange={e => updateRow(p.id, 'cogs', e.target.value)} /> : <span className="cost-badge">{kind === 'ARRIVAL' ? '—' : money(avg) + '/кг'}</span>}
              </div>;
            })}
          </div>
          <button className="primary big" onClick={addOperation}>{kind === 'ARRIVAL' ? 'Сохранить приём' : destination === 'ANGAR' ? 'Сохранить отгрузку в Ангар' : 'Сохранить прямую отгрузку'}</button>
        </div>
      )}

      {tab === 'journal' && (
        <div className="receiving-section">
          <div className="filters"><select value={productFilter} onChange={e => setProductFilter(e.target.value)}><option value="">Все товары</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input type="date" value={from} onChange={e => setFrom(e.target.value)} /><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div className="table-wrap"><table><thead><tr><th>№</th><th>Дата</th><th>Тип</th><th>Товар</th><th>Кг</th><th>Сумма</th><th>COGS</th><th>Валовая</th><th>Куда/кому</th></tr></thead><tbody>
            {filteredOps.map(o => <tr key={o.id}><td>#{o.number}</td><td>{o.date}</td><td>{o.kind === 'ARRIVAL' ? 'Приём' : o.destination === 'ANGAR' ? 'Отгрузка в Ангар' : 'Отгрузка клиенту'}</td><td>{o.items.map(i => products.find(p => p.id === i.productId)?.name || '').join(', ')}</td><td>{qty(o.items.reduce((s, i) => s + i.kg, 0))}</td><td>{o.destination === 'ANGAR' ? '—' : money(o.items.reduce((s, i) => s + i.sum, 0))}</td><td>{money(o.items.reduce((s, i) => s + i.cogs, 0))}</td><td>{o.kind === 'SHIPMENT' && o.destination === 'CLIENT' ? money(o.items.reduce((s, i) => s + i.sum - i.cogs, 0)) : '—'}</td><td>{o.party || '—'}</td></tr>)}
          </tbody></table></div>
        </div>
      )}

      {tab === 'stock' && (
        <div className="receiving-section">
          <div className="panel"><div className="panel-head"><div><h3>Начальный остаток пункта</h3><span className="muted">Используется только для старта локального учёта</span></div></div><div className="opening-grid">{products.map(p => <div className="opening-row" key={p.id}><b>{p.name}</b><input inputMode="decimal" placeholder="Кг" value={opening[p.id]?.kg ?? ''} onChange={e => setOpening(x => ({ ...x, [p.id]: { kg: e.target.value, price: x[p.id]?.price ?? '' } }))} /><input inputMode="decimal" placeholder="Себестоимость/кг" value={opening[p.id]?.price ?? ''} onChange={e => setOpening(x => ({ ...x, [p.id]: { kg: x[p.id]?.kg ?? '', price: e.target.value } }))} /></div>)}</div></div>
          <div className="grid-cards"><div className="stat-card"><span>Общий вес</span><b>{qty(totalStockKg)} кг</b></div><div className="stat-card"><span>Стоимость склада пункта</span><b>{money(totalStockValue)}</b></div></div>
          <div className="table-wrap"><table><thead><tr><th>Товар</th><th>Остаток</th><th>Средняя себестоимость</th><th>Стоимость</th><th>Статус</th></tr></thead><tbody>{productSummary.map(x => <tr key={x.product.id}><td><b>{x.product.name}</b></td><td>{qty(x.kg)} кг</td><td>{money(x.avg)}</td><td>{money(x.value)}</td><td><select value={loadStatus[x.product.id] || 'LOAD'} onChange={e => setLoadStatus(s => ({ ...s, [x.product.id]: e.target.value as any }))}><option value="LOAD">🟢 Грузить</option><option value="HOLD">🟡 Пока не грузить</option><option value="CHECK">🔴 Проверить</option></select></td></tr>)}</tbody></table></div>
        </div>
      )}

      {tab === 'report' && (
        <div className="receiving-section">
          <div className="grid-cards"><div className="stat-card"><span>Приём</span><b>{qty(dayInKg)} кг</b><small>{money(dayInSum)}</small></div><div className="stat-card"><span>В Ангар</span><b>{qty(dayAngarKg)} кг</b><small>{money(dayAngarCost)} себестоимость</small></div><div className="stat-card"><span>Клиентам</span><b>{qty(dayClientKg)} кг</b><small>{money(dayClientSales)}</small></div><div className="stat-card"><span>Валовая</span><b className={dayProfit >= 0 ? 'green' : 'red'}>{money(dayProfit)}</b><small>COGS {money(dayClientCogs)}</small></div></div>
          <div className="table-wrap"><table><thead><tr><th>Товар</th><th>Приём кг</th><th>Приём ₸</th><th>Ангар кг</th><th>Себестоимость в Ангар</th><th>Клиент кг</th><th>Продажа ₸</th><th>Валовая</th></tr></thead><tbody>{products.map(p => { const arr = dayItems.filter(i => i.productId === p.id && i.kind === 'ARRIVAL'); const an = dayItems.filter(i => i.productId === p.id && i.kind === 'SHIPMENT' && i.destination === 'ANGAR'); const cl = dayItems.filter(i => i.productId === p.id && i.kind === 'SHIPMENT' && i.destination === 'CLIENT'); return <tr key={p.id}><td><b>{p.name}</b></td><td>{qty(arr.reduce((s, i) => s + i.kg, 0))}</td><td>{money(arr.reduce((s, i) => s + i.sum, 0))}</td><td>{qty(an.reduce((s, i) => s + i.kg, 0))}</td><td>{money(an.reduce((s, i) => s + i.cogs, 0))}</td><td>{qty(cl.reduce((s, i) => s + i.kg, 0))}</td><td>{money(cl.reduce((s, i) => s + i.sum, 0))}</td><td>{money(cl.reduce((s, i) => s + i.sum - i.cogs, 0))}</td></tr>; })}</tbody></table></div>
        </div>
      )}

      {tab === 'closing' && (
        <div className="receiving-section">
          <div className="panel evening-close">
            <div className="panel-head"><div><h3>🔒 Вечерний отчёт · {date}</h3><span className="muted">Приём + отгрузки + деньги + расходы + сотрудники + факт склада</span></div><button className="primary" onClick={closeDay}>Закрыть день</button></div>
            <div className="grid-cards"><div className="stat-card"><span>Принято</span><b>{qty(dayInKg)} кг</b><small>{money(dayInSum)}</small></div><div className="stat-card"><span>В Ангар</span><b>{qty(dayAngarKg)} кг</b><small>{money(dayAngarCost)}</small></div><div className="stat-card"><span>Продано</span><b>{qty(dayClientKg)} кг</b><small>{money(dayClientSales)}</small></div><div className="stat-card"><span>Остаток</span><b>{qty(totalStockKg)} кг</b><small>{money(totalStockValue)}</small></div></div>
            <div className="evening-grid">
              <div className="panel-lite"><h4>1. Фактический остаток по товару</h4>{products.map(p => { const expected = stock[p.id]?.kg || 0; const actual = num(actualStock[p.id]); const diff = actual - expected; return <div className="close-row" key={p.id}><div><b>{p.name}</b><small>По системе {qty(expected)} кг</small></div><input inputMode="decimal" placeholder="Факт кг" value={actualStock[p.id] ?? ''} onChange={e => setActualStock(x => ({ ...x, [p.id]: e.target.value }))} /><span className={Math.abs(diff) > 0.0001 ? 'bad' : 'ok'}>{Math.abs(diff) > 0.0001 ? `Δ ${qty(diff)} кг` : '✅'}</span></div>; })}</div>
              <div className="panel-lite"><h4>2. Деньги</h4><div className="close-money"><div><span>Ожидается наличных</span><b>{money(moneyExpected.CASH)}</b></div><input inputMode="decimal" placeholder="Факт наличных" value={actualCash} onChange={e => setActualCash(e.target.value)} /><div><span>Ожидается Kaspi</span><b>{money(moneyExpected.KASPI)}</b></div><input inputMode="decimal" placeholder="Факт Kaspi" value={actualKaspi} onChange={e => setActualKaspi(e.target.value)} /><div><span>Ожидается переводов</span><b>{money(moneyExpected.TRANSFER)}</b></div><input inputMode="decimal" placeholder="Факт переводов" value={actualTransfer} onChange={e => setActualTransfer(e.target.value)} /></div></div>
            </div>
            <div className="two-col">
              <div className="panel-lite"><h4>3. Расходы / деньги</h4><div className="form-grid compact-grid"><select value={moneyForm.kind} onChange={e => setMoneyForm({ ...moneyForm, kind: e.target.value as any })}><option value="OUT">Расход</option><option value="IN">Приход денег</option></select><select value={moneyForm.channel} onChange={e => setMoneyForm({ ...moneyForm, channel: e.target.value as Channel })}><option value="CASH">Наличные</option><option value="KASPI">Kaspi</option><option value="TRANSFER">Перевод</option></select><input inputMode="decimal" placeholder="Сумма" value={moneyForm.amount} onChange={e => setMoneyForm({ ...moneyForm, amount: e.target.value })} /><input placeholder="Категория" value={moneyForm.category} onChange={e => setMoneyForm({ ...moneyForm, category: e.target.value })} /><input placeholder="Кому / от кого" value={moneyForm.person} onChange={e => setMoneyForm({ ...moneyForm, person: e.target.value })} /></div><button className="secondary" onClick={addMoney}>Добавить</button><div className="small-list">{moneyEntries.filter(e => e.date === date).slice(0, 10).map(e => <div key={e.id}><span>{e.kind === 'OUT' ? 'Расход' : 'Приход'} · {e.category || 'Без категории'}</span><b>{e.kind === 'OUT' ? '-' : '+'}{money(e.amount)}</b></div>)}</div></div>
              <div className="panel-lite"><h4>4. Сотрудники</h4><div className="form-grid compact-grid"><input placeholder="Новый сотрудник" value={employeeForm.name} onChange={e => setEmployeeForm({ name: e.target.value })} /><button className="secondary" onClick={addEmployee}>Добавить</button><select value={employeeTxForm.employeeId} onChange={e => setEmployeeTxForm({ ...employeeTxForm, employeeId: e.target.value })}><option value="">Сотрудник</option>{employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><select value={employeeTxForm.kind} onChange={e => setEmployeeTxForm({ ...employeeTxForm, kind: e.target.value as EmployeeTxKind })}><option value="SALARY">Зарплата</option><option value="ADVANCE">Аванс</option><option value="DEBT">Взял в долг</option><option value="DEBT_REPAY">Погасил долг</option></select><input inputMode="decimal" placeholder="Сумма" value={employeeTxForm.amount} onChange={e => setEmployeeTxForm({ ...employeeTxForm, amount: e.target.value })} /></div><button className="secondary" onClick={addEmployeeTx}>Записать</button><div className="small-list">{employees.map(e => { const tx = employeeTx.filter(t => t.employeeId === e.id); const salary = tx.filter(t => t.kind === 'SALARY').reduce((s, t) => s + t.amount, 0); const advance = tx.filter(t => t.kind === 'ADVANCE').reduce((s, t) => s + t.amount, 0); const debt = tx.filter(t => t.kind === 'DEBT').reduce((s, t) => s + t.amount, 0) - tx.filter(t => t.kind === 'DEBT_REPAY').reduce((s, t) => s + t.amount, 0); return <div key={e.id}><span>{e.name} · зарплата {money(salary)} · аванс {money(advance)}</span><b>долг {money(debt)}</b></div>; })}</div></div>
            </div>
            <div className="panel-lite"><h4>5. Пояснение / итог</h4><textarea placeholder="Если есть расхождения — обязательно укажи причину" value={closeNote} onChange={e => setCloseNote(e.target.value)} /><div className="close-summary"><div><span>По деньгам</span><b>{money((num(actualCash) - moneyExpected.CASH) + (num(actualKaspi) - moneyExpected.KASPI) + (num(actualTransfer) - moneyExpected.TRANSFER))}</b></div><div><span>Принято</span><b>{qty(dayInKg)} кг · {money(dayInSum)}</b></div><div><span>В Ангар</span><b>{qty(dayAngarKg)} кг · {money(dayAngarCost)}</b></div><div><span>Клиентам</span><b>{qty(dayClientKg)} кг · {money(dayClientSales)}</b></div></div></div>
          </div>
          {closes.length > 0 && <div className="panel"><div className="panel-head"><h3>История закрытия</h3></div>{closes.slice(0, 10).map(c => <div className="detail-row" key={c.id}><b>{c.date}</b><span>Закрыт · наличные {money(c.actualCash)} · Kaspi {money(c.actualKaspi)} · перевод {money(c.actualTransfer)}</span></div>)}</div>}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}

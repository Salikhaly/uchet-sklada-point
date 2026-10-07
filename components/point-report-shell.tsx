'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// Оболочка отчёта Точки: каждая часть — отдельный «экран» (влезает в один экран без бесконечной прокрутки).
// Переключение: вкладки, кнопки, стрелки ← → на клавиатуре, свайп на телефоне. Экраны выезжают с анимацией,
// числа в карточках «набегают».

export type Screen = { key: string; label: string; icon: string; node: ReactNode };

export function CountUp({ value, format }: { value: number; format: (v: number) => string }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !Number.isFinite(value)) { setV(value); return; }
    let raf = 0;
    let start = -1; // старт берём из первого кадра анимации: те же часы, что и дальше
    const dur = 750;
    const tick = (t: number) => {
      if (start < 0) start = t;
      const p = Math.min(1, Math.max(0, (t - start) / dur));
      setV(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(v)}</>;
}

export function ReportScreens({ screens }: { screens: Screen[] }) {
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const idxRef = useRef(0);
  idxRef.current = idx;
  const count = screens.length;
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = useCallback((i: number) => {
    const k = Math.max(0, Math.min(count - 1, i));
    if (k === idxRef.current) return;
    setDir(k > idxRef.current ? 1 : -1);
    setIdx(k);
  }, [count]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') go(idxRef.current + 1);
      else if (e.key === 'ArrowLeft') go(idxRef.current - 1);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [go]);

  const onTouchStart = (e: React.TouchEvent) => {
    if ((e.target as HTMLElement).closest('[data-noswipe]')) { touch.current = null; return; }
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current; touch.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) go(idxRef.current + (dx < 0 ? 1 : -1));
  };

  if (!count) return null;
  const cur = screens[Math.min(idx, count - 1)];

  return (
    <div className="rs">
      <div className="rs-nav" role="tablist">
        <span className="rs-ind" style={{ width: `calc((100% - 8px) / ${count})`, transform: `translateX(${idx * 100}%)` }} />
        {screens.map((s, i) => (
          <button key={s.key} type="button" role="tab" aria-selected={i === idx} className={`rs-tab${i === idx ? ' on' : ''}`} onClick={() => go(i)} title={s.label}>
            <span className="rs-ico">{s.icon}</span><span className="rs-lab">{s.label}</span>
          </button>
        ))}
      </div>
      <div className="rs-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div key={cur.key} className={`rs-pane ${dir > 0 ? 'r' : 'l'}`}>{cur.node}</div>
      </div>
      <div className="rs-foot">
        <button type="button" disabled={idx === 0} onClick={() => go(idx - 1)}>‹ Назад</button>
        <div className="rs-dots">{screens.map((s, i) => <i key={s.key} className={i === idx ? 'on' : ''} onClick={() => go(i)} />)}</div>
        <button type="button" disabled={idx === count - 1} onClick={() => go(idx + 1)}>Дальше ›</button>
      </div>
    </div>
  );
}

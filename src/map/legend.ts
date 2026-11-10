// Легенда раскраски с количеством рёбер в каждой категории. Клик по строке — подсветить только эту категорию.
import type { Doc } from '../core/types.ts';
import { categorize, catalog, isDrawn, isUnderpass, MODE_TITLES } from '../core/roadStyle.ts';
import type { ColorMode } from '../core/roadStyle.ts';
import { signalStats } from './signals.ts';

export function renderLegend(el: HTMLElement, doc: Doc, mode: ColorMode, hl: string | null, onPick: (key: string | null) => void) {
  const counts = new Map<string, number>();
  for (const w of doc.ways.values()) if (isDrawn(w.tags)) {
    const k = categorize(mode, w.tags).key; counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dashKeys = new Set(catalog(mode).filter(c => (c as { dash?: boolean }).dash).map(c => c.key));
  const rows = catalog(mode).filter(c => counts.has(c.key)).map(c => {
    const dash = dashKeys.has(c.key);
    const bg = dash ? `repeating-linear-gradient(90deg,${c.color} 0 5px,transparent 5px 8px)` : c.color;
    return `<div class="lg${hl === c.key ? ' on' : ''}${hl && hl !== c.key ? ' dim' : ''}" data-k="${c.key}"><i style="background:${bg}"></i><span>${c.label}</span><b>${counts.get(c.key)}</b></div>`;
  });
  const st = signalStats(doc);
  const ug = [...doc.ways.values()].filter(w => isUnderpass(w.tags)).length;
  const nodes = `<div class="lgt" style="margin-top:8px">Обозначения на узлах</div>
    <div class="lg"><svg class="ico" viewBox="0 0 16 22"><rect x="3" y="1" width="10" height="20" rx="3" fill="#1b1f23" stroke="#fff"/><circle cx="8" cy="6" r="2.6" fill="#ff3b30"/><circle cx="8" cy="11" r="2.6" fill="#ffcc00"/><circle cx="8" cy="16" r="2.6" fill="#34c759"/></svg><span>Светофор на перекрёстке</span><b>${st.atJunction}</b></div>
    ${st.offJunction ? `<div class="lg"><svg class="ico" viewBox="0 0 16 22"><rect x="3" y="1" width="10" height="20" rx="3" fill="#1b1f23" stroke="#ff2d2d" stroke-width="2" stroke-dasharray="3 2"/><circle cx="8" cy="6" r="2.6" fill="#ff3b30"/><circle cx="8" cy="11" r="2.6" fill="#ffcc00"/><circle cx="8" cy="16" r="2.6" fill="#34c759"/></svg><span>Светофор вне перекрёстка (проверить)</span><b>${st.offJunction}</b></div>` : ''}
    <div class="lg"><svg class="ico" viewBox="0 0 16 22"><rect x="1" y="5" width="14" height="12" rx="2" fill="#1b4dff" stroke="#fff"/><path d="M4 8h2v6H4zM8 8h2v6H8zM12 8h1v6h-1z" fill="#fff"/><circle cx="13" cy="4" r="3.2" fill="#ff8a00" stroke="#fff"/></svg><span>Переход со светофором</span><b>${st.crossSignal}</b></div>
    <div class="lg"><svg class="ico" viewBox="0 0 16 22"><rect x="1" y="5" width="14" height="12" rx="2" fill="#1b4dff" stroke="#fff"/><path d="M4 8h2v6H4zM8 8h2v6H8zM12 8h1v6h-1z" fill="#fff"/></svg><span>Нерегулируемый переход</span><b>${st.crossPlain}</b></div>
    ${ug ? `<div class="lg"><svg class="ico" viewBox="0 0 28 28"><circle cx="14" cy="14" r="12" fill="#5b21b6" stroke="#fff" stroke-width="2"/><path d="M14 6v9M9.5 12l4.5 5 4.5-5M7 21h4v-2h4v2h6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Подземный пешеходный переход (фиолетовая подсветка)</span><b>${ug}</b></div>` : ''}
    <div class="lg"><i class="dot" style="background:#555"></i><span>Перекрёсток без светофора</span><b>${st.plainJunctions}</b></div>`;
  el.innerHTML = `<div class="lgt">${MODE_TITLES[mode]}</div>${rows.join('') || '<div class="muted">нет данных</div>'}<div class="muted lgh">Клик по строке — подсветить только эту категорию${hl ? ' · <a href="#" data-k="">сбросить</a>' : ''}</div>${nodes}`;
  el.querySelectorAll<HTMLElement>('[data-k]').forEach(r => r.onclick = ev => { ev.preventDefault(); const k = r.dataset.k!; onPick(k === '' || k === hl ? null : k); });
}

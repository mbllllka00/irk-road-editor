// Легенда раскраски с количеством рёбер в каждой категории.
import type { Doc } from '../core/types.ts';
import { categorize, catalog, isDrawn, MODE_TITLES } from '../core/roadStyle.ts';
import type { ColorMode } from '../core/roadStyle.ts';

export function renderLegend(el: HTMLElement, doc: Doc, mode: ColorMode) {
  const counts = new Map<string, number>();
  for (const w of doc.ways.values()) if (isDrawn(w.tags)) {
    const k = categorize(mode, w.tags).key; counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = catalog(mode).filter(c => counts.has(c.key)).map(c => {
    const dash = (c.key === 'ped' || c.key === 'tram' || c.key === 'steps');
    const bg = dash ? `repeating-linear-gradient(90deg,${c.color} 0 5px,transparent 5px 8px)` : c.color;
    return `<div class="lg"><i style="background:${bg}"></i><span>${c.label}</span><b>${counts.get(c.key)}</b></div>`;
  });
  el.innerHTML = `<div class="lgt">${MODE_TITLES[mode]}</div>${rows.join('') || '<div class="muted">нет данных</div>'}`;
}

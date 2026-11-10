// [P3] Панель свойств (теги, быстрые действия, массовая правка) и [P4] список ошибок.
import type { Store } from '../core/store.ts';
import type { Issue, Tags, Doc, OsmWay } from '../core/types.ts';
import { HIGHWAY_CLASSES, SURFACES, SPEED_QUICK, LINK_INFO, LINK_RULE, CLASS_CATS, recommendLink, PSEUDO_CLASSES, hwKey } from '../core/roadStyle.ts';
import { onewayDir, isRoad } from '../core/osm.ts';
import { junctionNodes } from '../map/signals.ts';
import { PEAK_TAG, PEAK_PRESETS, normalizePeak } from '../core/peak.ts';
import * as ops from './ops.ts';
import { lineOfWay, describeLine } from '../semantic/lines.ts';

export interface PanelActions {
  reverse(): void; toggleOneway(): void; bridge(): void; smooth(): void; signal(): void; crossing(signalized: boolean): void; removeCrossing(): void; del(): void;
  copyAttrs(): void; pasteAttrs(): void; hasCopy(): boolean; selectLine(): void; mergeWays(): void; applyTemplate(): void; focusIssue(i: Issue): void; msg(s: string): void;
}
const COMMON_KEYS = ['highway', 'oneway', 'lanes', 'lanes:forward', 'lanes:backward', 'maxspeed', 'turn:lanes', 'junction', 'bridge', 'layer', 'tunnel', 'surface', 'name', 'ele'];

function btn(label: string, fn: () => void, title = '') {
  const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; return b;
}
function tagTable(tags: Record<string, string>, onSet: (k: string, v: string) => void): HTMLElement {
  const box = document.createElement('div');
  const t = document.createElement('table'); t.className = 'tags';
  for (const [k, v] of Object.entries(tags)) {
    const tr = t.insertRow(); tr.insertCell().textContent = k;
    const inp = document.createElement('input'); inp.value = v; inp.onchange = () => onSet(k, inp.value.trim());
    tr.insertCell().appendChild(inp);
    const x = tr.insertCell(); x.appendChild(btn('×', () => onSet(k, ''), 'Удалить тег'));
  }
  box.appendChild(t);
  const add = document.createElement('div'); add.className = 'add';
  const k = document.createElement('input'); k.placeholder = 'ключ'; k.setAttribute('list', 'keys');
  const v = document.createElement('input'); v.placeholder = 'значение';
  const go = () => { if (k.value.trim()) onSet(k.value.trim(), v.value.trim()); };
  v.onkeydown = e => { if (e.key === 'Enter') go(); };
  add.append(k, v, btn('+', go));
  box.appendChild(add);
  if (!document.getElementById('keys')) {
    const dl = document.createElement('datalist'); dl.id = 'keys';
    dl.innerHTML = COMMON_KEYS.map(x => `<option value="${x}">`).join(''); document.body.appendChild(dl);
  }
  return box;
}

function common(doc: Doc, ways: number[], f: (w: OsmWay) => string): string | null {
  const vs = new Set(ways.map(id => f(doc.ways.get(id)!)));
  return vs.size === 1 ? [...vs][0] : null; // null = у выбранных рёбер значения разные
}
function selectRow(label: string, options: [string, string][], current: string | null, onPick: (v: string) => void, groups?: Record<string, string>): HTMLElement {
  const row = document.createElement('label'); row.className = 'srow';
  const sp = document.createElement('span'); sp.textContent = label;
  const sel = document.createElement('select');
  if (current === null) { const o = new Option('— разные значения —', '__mixed'); o.disabled = true; sel.add(o); }
  const gEl = new Map<string, HTMLOptGroupElement>();
  for (const [v, t] of options) {
    const g = groups?.[v];
    if (!g) { sel.add(new Option(t, v)); continue; }
    let og = gEl.get(g); if (!og) { og = document.createElement('optgroup'); og.label = g; sel.appendChild(og); gEl.set(g, og); }
    og.appendChild(new Option(t, v));
  }
  sel.value = current === null ? '__mixed' : current;
  sel.onchange = () => onPick(sel.value);
  row.append(sp, sel); return row;
}

/** Справка по пяти видам съездов: чем отличаются. */
function linkGuide(): HTMLElement {
  const d = document.createElement('details'); d.className = 'links';
  const rows = LINK_INFO.map(l => {
    const c = CLASS_CATS.find(x => x.key === l.value)!, p = CLASS_CATS.find(x => x.key === l.parent)!;
    return `<tr><td><span class="sw" style="background:${c.color}"></span>${l.value}</td><td><b>${l.short}</b> — рукав главной дороги класса <span class="sw" style="background:${p.color}"></span>${l.parent}. ${l.when}</td></tr>`;
  }).join('');
  d.innerHTML = `<summary>Съезды: 5 видов и чем они отличаются</summary><div class="muted" style="margin-top:4px">${LINK_RULE}</div><table class="linkt">${rows}</table>`;
  return d;
}
/** Для выбранного съезда: какой он вид и какой стоит поставить по соседним дорогам. */
function linkHint(store: Store, wayId: number, apply: (t: Tags) => void): HTMLElement {
  const box = document.createElement('div');
  const doc = store.doc, w = doc.ways.get(wayId)!;
  if (store.dragging || !isRoad(w.tags)) return box;
  const ends = new Set([w.nodes[0], w.nodes[w.nodes.length - 1]]);
  const near: string[] = [];
  for (const o of doc.ways.values()) if (o.id !== wayId && isRoad(o.tags) && o.tags.highway && o.nodes.some(n => ends.has(n))) near.push(o.tags.highway);
  const isLink = /_link$/.test(w.tags.highway ?? '');
  const info = LINK_INFO.find(l => l.value === w.tags.highway);
  const rec = recommendLink(near.filter(h => !/_link$/.test(h)));
  if (!isLink) return box;
  const h = document.createElement('div'); h.className = 'hint';
  let html = info ? `<b>${info.short}.</b> ${info.when}` : '';
  if (near.length) html += `<br>К концам примыкают: ${[...new Set(near)].join(', ')}.`;
  else html += '<br>К концам не примыкают другие дороги: съезд ни с чем не соединён.';
  if (rec && rec !== w.tags.highway) html += `<br>По соседним дорогам подходит <b>${rec}</b>.`;
  else if (rec) html += '<br>Класс совпадает с рекомендуемым по соседним дорогам.';
  h.innerHTML = html;
  if (rec && rec !== w.tags.highway) { const b = document.createElement('div'); b.className = 'btns'; b.appendChild(btn(`Поставить ${rec}`, () => apply({ highway: rec }))); h.appendChild(b); }
  box.appendChild(h); return box;
}

/** Класс дороги, покрытие и ограничение скорости: быстрые контролы для одного или многих рёбер. */
function styleControls(store: Store, ways: number[]): HTMLElement {
  const box = document.createElement('div'); box.className = 'style';
  const doc = store.doc;
  const apply = (tags: Tags) => store.commit(d => ops.applyTags(d, ways, tags));
  const get = (k: string) => common(doc, ways, w => w.tags[k] ?? '');

  const hw = common(doc, ways, w => hwKey(w.tags));
  const hwOpts = HIGHWAY_CLASSES.map(c => [c.value, c.label] as [string, string]);
  if (hw && !HIGHWAY_CLASSES.some(c => c.value === hw)) hwOpts.push([hw, hw]);
  const grp = Object.fromEntries(HIGHWAY_CLASSES.map(c => [c.value, c.group]));
  box.append(selectRow('Класс дороги', hwOpts, hw, v => {
    if (!v) return;
    store.commit(d => ops.applyClass(d, ways, v));
  }, grp));
  const sw = CLASS_CATS.find(c => c.key === (PSEUDO_CLASSES[hw ?? '']?.cat ?? hw));
  if (sw) { const d = document.createElement('div'); d.className = 'muted'; d.innerHTML = `<span class="sw" style="background:${sw.color}"></span>цвет на карте в раскраске «класс»`; box.appendChild(d); }
  if (ways.length === 1) box.appendChild(linkHint(store, ways[0], apply));
  box.appendChild(linkGuide());

  const sf = get('surface');
  const sfOpts: [string, string][] = [['', '— не задано —'], ...SURFACES.map(s => [s.value, s.label] as [string, string])];
  if (sf && !sfOpts.some(o => o[0] === sf)) sfOpts.push([sf, sf]);
  box.append(selectRow('Покрытие', sfOpts, sf, v => apply({ surface: v })));

  const ms = get('maxspeed');
  const sp = document.createElement('div'); sp.className = 'srow col';
  const lab = document.createElement('span');
  lab.textContent = `Макс. скорость, км/ч: ${ms === null ? 'разная' : ms || 'не задана'}`;
  sp.appendChild(lab);
  const quick = document.createElement('div'); quick.className = 'btns';
  for (const v of SPEED_QUICK) {
    const b = btn(String(v), () => apply({ maxspeed: String(v) }), `maxspeed=${v}`);
    if (ms === String(v)) b.style.cssText = 'background:#1b4dff;color:#fff;border-color:#1b4dff';
    quick.appendChild(b);
  }
  const inp = document.createElement('input'); inp.type = 'number'; inp.min = '5'; inp.max = '130'; inp.placeholder = 'другая'; inp.style.width = '64px';
  const set = () => { if (inp.value) apply({ maxspeed: String(Math.round(+inp.value)) }); };
  inp.onkeydown = e => { if (e.key === 'Enter') set(); };
  quick.append(inp, btn('OK', set), btn('Убрать', () => apply({ maxspeed: '' }), 'Удалить maxspeed'));
  sp.appendChild(quick); box.appendChild(sp);
  box.appendChild(peakRow(store, ways));
  return box;
}

const HW_SHORT: Record<string, string> = Object.fromEntries(HIGHWAY_CLASSES.map(c => [c.value, c.label.replace(/ \(.*\)$/, '')]));
const SURF_RU: Record<string, string> = Object.fromEntries(SURFACES.map(x => [x.value, x.label]));
/** Линия целиком: участки с атрибутами и точечные метки, прочитанные из тегов. */
function lineInfo(store: Store, wayId: number, a: PanelActions): HTMLElement {
  const box = document.createElement('div'); box.className = 'line';
  if (store.dragging) return box;
  const l = lineOfWay(store.doc, wayId); if (!l) return box;
  const { runs, marks } = describeLine(store.doc, l);
  const head = document.createElement('div');
  head.innerHTML = `<b>Линия:</b> ${l.kind === 'road' ? 'дорога' : 'тротуар/тропа'} · ${Math.round(l.total)} м · рёбер ${l.segs.length} `;
  head.appendChild(btn('Выбрать всю (L)', a.selectLine)); box.appendChild(head);
  const t = document.createElement('table');
  const m = (x: number) => Math.round(x);
  for (const r of runs) {
    const parts = [HW_SHORT[r.hw] ?? r.hw, r.maxspeed ? `${r.maxspeed} км/ч` : '', r.lanes ? `${r.lanes} пол.` : '', r.surface ? (SURF_RU[r.surface] ?? r.surface) : '', r.peak ? `пик ${r.peak}` : '', r.ug ? 'ПОДЗЕМНЫЙ ПЕРЕХОД' : '', r.dir === 'both' ? '↔' : r.dir === 'forward' ? '→ по линии' : '← против линии'].filter(Boolean);
    t.insertRow().innerHTML = `<td>${m(r.from)}–${m(r.to)} м</td><td>${parts.join(' · ')}</td>`;
  }
  for (const k of marks) t.insertRow().innerHTML = `<td>${m(k.dist)} м</td><td>◆ ${k.label}</td>`;
  box.appendChild(t); return box;
}

export function renderProps(el: HTMLElement, store: Store, a: PanelActions, issues: Issue[] = []) {
  el.innerHTML = '';
  const ways = store.selWays(), nodes = store.selNodes(), doc = store.doc;
  const h = document.createElement('h4'); el.appendChild(h);
  const ib = document.createElement('div'); el.appendChild(ib);
  const fillIssues = () => {
    if (store.dragging || (!ways.length && !nodes.length)) return;
    const mine = issuesFor(issues, doc, ways, nodes);
    ib.className = 'selissues';
    if (!mine.length) { ib.innerHTML = '<div class="ok">✓ В выделении ошибок и предупреждений нет</div>'; return; }
    ib.innerHTML = `<div class="selh">В выделении: ${mine.filter(i => i.severity === 'error').length} ошиб., ${mine.filter(i => i.severity === 'warn').length} предупр.</div>`;
    for (const i of mine.slice(0, 15)) {
      const d = document.createElement('div'); d.className = 'issue'; d.innerHTML = `<span class="dot ${i.severity}"></span><span>${i.msg}</span>`;
      d.onclick = () => a.focusIssue(i); ib.appendChild(d);
    }
    if (mine.length > 15) ib.insertAdjacentHTML('beforeend', `<div class="muted">… и ещё ${mine.length - 15}</div>`);
  };
  if (ways.length === 0 && nodes.length === 0) { h.textContent = 'Свойства'; el.insertAdjacentHTML('beforeend', '<div class="muted">Ничего не выбрано. Кликните по ребру или узлу (Shift — несколько). Список горячих клавиш: «?»</div>'); return; }

  if (ways.length === 1 && !nodes.length && doc.ways.get(ways[0])!.tags.amenity === 'parking' && !doc.ways.get(ways[0])!.tags.highway) {
    const w = doc.ways.get(ways[0])!;
    h.textContent = `Парковка #${w.id} · вершин: ${new Set(w.nodes).size}`;
    const b = document.createElement('div'); b.className = 'btns'; b.append(btn('Удалить', a.del)); el.appendChild(b);
    el.insertAdjacentHTML('beforeend', '<div class="hint">Тяните вершины, чтобы изменить форму, или потяните за заливку, чтобы сдвинуть всю парковку. Новая вершина: режим «Узел» (N), клик по контуру. Удалить вершину: выбрать её и Delete.</div>');
    el.appendChild(selectRow('Тип парковки', [['', '— не задано —'], ['surface', 'Наземная'], ['multi-storey', 'Многоуровневая'], ['underground', 'Подземная'], ['street_side', 'Вдоль улицы']], w.tags.parking ?? '', v => store.commit(d => ops.setTag(d.ways.get(w.id)!, 'parking', v))));
    el.appendChild(tagTable(w.tags, (k, v) => store.commit(d => ops.setTag(d.ways.get(w.id)!, k, v))));
  } else if (ways.length === 1 && !nodes.length) {
    const w = doc.ways.get(ways[0])!;
    h.textContent = `${w.tags.name ? w.tags.name + ' · ' : ''}Ребро #${w.id} · узлов: ${w.nodes.length} · ${onewayDir(w.tags) ? 'одностороннее' : 'двустороннее'}`;
    const b = document.createElement('div'); b.className = 'btns';
    b.append(btn('Копировать характеристики (Alt+C)', a.copyAttrs, 'Запомнить highway, oneway, lanes, maxspeed, surface и др.'), ...(a.hasCopy() ? [btn('Вставить (Alt+V)', a.pasteAttrs)] : []), btn('Развернуть (R)', a.reverse), btn('Oneway (O)', a.toggleOneway), btn('Мост (B)', a.bridge), btn('Высота ele (F)', a.smooth), btn('Удалить', a.del));
    el.appendChild(b);
    const row = document.createElement('div'); row.className = 'btns';
    const sel = document.getElementById('tpl') as HTMLSelectElement;
    row.append(btn(`Применить шаблон: «${sel.value}»`, a.applyTemplate));
    el.appendChild(row);
    el.appendChild(lineInfo(store, w.id, a));
    el.appendChild(styleControls(store, [w.id]));
    el.appendChild(tagTable(w.tags, (k, v) => store.commit(d => ops.setTag(d.ways.get(w.id)!, k, v))));
  } else if (ways.length > 1) {
    h.textContent = `Выбрано рёбер: ${ways.length}`;
    const b = document.createElement('div'); b.className = 'btns';
    b.append(...(a.hasCopy() ? [btn('Вставить скопированное (Alt+V)', a.pasteAttrs)] : []), btn('Копировать с первого выбранного (Alt+C)', a.copyAttrs, 'Источник — ребро, выбранное первым'), btn('Oneway (O)', a.toggleOneway), btn('Мост (B)', a.bridge));
    if (ways.length === 2) b.append(btn('Слить (M)', a.mergeWays));
    b.append(btn('Применить шаблон', a.applyTemplate), btn('Удалить', a.del));
    el.appendChild(b);
    el.appendChild(styleControls(store, ways));
    el.insertAdjacentHTML('beforeend', '<div class="muted">Массовая правка: тег будет записан во все выбранные рёбра</div>');
    el.appendChild(tagTable({}, (k, v) => store.commit(d => ops.applyTags(d, ways, { [k]: v }))));
  } else if (nodes.length === 1) {
    const n = doc.nodes.get(nodes[0])!;
    h.textContent = `Узел #${n.id} · ${n.lat.toFixed(6)}, ${n.lon.toFixed(6)}`;
    const b = document.createElement('div'); b.className = 'btns';
    b.append(btn(n.tags.highway === 'traffic_signals' ? 'Убрать светофор (S)' : 'Светофор (S)', a.signal));
    if (n.tags.highway === 'crossing') b.append(btn('Убрать переход', a.removeCrossing));
    b.append(btn('Переход нерегулируемый (P)', () => a.crossing(false)), btn('Переход регулируемый', () => a.crossing(true)), btn('Удалить', a.del));
    el.appendChild(b);
    if (n.tags.highway === 'traffic_signals') {
      const at = junctionNodes(doc).has(n.id);
      el.insertAdjacentHTML('beforeend', at ? '<div class="hint"><b>Светофор на перекрёстке</b> (красная иконка с ореолом): в узле сходятся несколько дорог.</div>' : '<div class="hint" style="border-color:#ff9b9b"><b>Светофор вне перекрёстка.</b> В этом узле не сходятся дороги: переставьте на перекрёсток или уберите (S). Для пешеходного светофора используйте метку «Переход → регулируемый».</div>');
    } else if (n.tags.highway === 'crossing') el.insertAdjacentHTML('beforeend', `<div class="hint"><b>${n.tags.crossing === 'traffic_signals' ? 'Регулируемый' : 'Нерегулируемый'} пешеходный переход</b> (синяя иконка${n.tags.crossing === 'traffic_signals' ? ' с оранжевой точкой' : ''}). Светофор перекрёстка — отдельная иконка.</div>`);
    el.appendChild(tagTable(n.tags, (k, v) => store.commit(d => ops.setTag(d.nodes.get(n.id)!, k, v))));
  } else {
    h.textContent = `Выбрано узлов: ${nodes.length}`;
    const b = document.createElement('div'); b.className = 'btns'; b.append(btn('Удалить', a.del)); el.appendChild(b);
  }
  fillIssues();
}

export interface IssueFilter { sev: 'all' | 'error' | 'warn'; kind: string; selOnly: boolean }
export const KIND_RU: Record<string, string> = {
  connectivity: 'Связность сети', 'not-strongly-connected': 'Нет проезда в обе стороны', isolated: 'Изолированные рёбра', 'missing-node': 'Ссылка на несуществующий узел',
  degenerate: 'Ребро из < 2 узлов', 'duplicate-nodes': 'Дубликаты узлов', 'lanes-format': 'lanes: неверный формат', 'lanes-sum': 'lanes: сумма не сходится',
  'maxspeed-format': 'maxspeed: неверный формат', 'maxspeed-range': 'maxspeed: вне диапазона', 'oneway-backward': 'oneway: теги обратного направления',
  'oneway-sink': 'oneway: тупик (нет выезда)', 'oneway-source': 'oneway: нет въезда', overmerged: 'Слишком много рёбер в узле', 'sign-far': 'Знак далеко от перекрёстка',
  'signal-off-road': 'Светофор вне дороги', 'peak-format': 'peak_hours: неверный формат', crossing: 'Переходы', 'crossing-off-way': 'Переход вне линии',
};
/** Применить фильтр к списку замечаний (используется и списком, и подсветкой на карте). */
export function filterIssues(issues: Issue[], f: IssueFilter, scope: Issue[] | null = null): Issue[] {
  const inScope = scope ? new Set(scope) : null;
  return issues.filter(i => i.severity !== 'info' && (!inScope || inScope.has(i)) && (f.sev === 'all' || i.severity === f.sev) && (f.kind === 'all' || i.kind === f.kind));
}
/** Замечания, относящиеся к выбранным рёбрам/узлам (в том числе к узлам выбранных рёбер). */
export function issuesFor(issues: Issue[], doc: Doc, selWays: number[], selNodes: number[]): Issue[] {
  const W = new Set(selWays), N = new Set(selNodes);
  for (const id of selWays) doc.ways.get(id)?.nodes.forEach(n => N.add(n));
  return issues.filter(i => i.severity !== 'info' && (i.wayIds.some(w => W.has(w)) || i.nodeIds.some(n => N.has(n))));
}
/** Строка «время максимальной загрузки участка» (peak_hours). */
function peakRow(store: Store, ways: number[]): HTMLElement {
  const box = document.createElement('div'); box.className = 'srow col';
  const cur = common(store.doc, ways, w => w.tags[PEAK_TAG] ?? '');
  const lab = document.createElement('span');
  lab.title = 'Когда участок загружен сильнее всего. Не стандартный тег OSM (peak_hours): симуляторы его не читают, он нужен как справочная метка и для отчётов.';
  lab.textContent = `Время макс. загрузки: ${cur === null ? 'разное' : cur || 'не задано'}`;
  box.appendChild(lab);
  const row = document.createElement('div'); row.className = 'btns';
  const inp = document.createElement('input'); inp.placeholder = '07:30-09:30;17:00-19:00'; inp.style.width = '150px';
  if (cur) inp.value = cur;
  const set = (raw: string) => {
    const v = normalizePeak(raw);
    if (v === null) { inp.style.borderColor = 'var(--err)'; lab.textContent = 'Время макс. загрузки: неверный формат (пример: 07:30-09:30;17:00-19:00)'; return; }
    store.commit(d => ops.applyTags(d, ways, { [PEAK_TAG]: v }));
  };
  inp.onkeydown = e => { if (e.key === 'Enter') set(inp.value); };
  row.append(inp, btn('OK', () => set(inp.value)), btn('Убрать', () => store.commit(d => ops.applyTags(d, ways, { [PEAK_TAG]: '' }))));
  box.appendChild(row);
  const q = document.createElement('div'); q.className = 'btns';
  for (const [t, v] of PEAK_PRESETS) q.appendChild(btn(t, () => set(v)));
  box.appendChild(q); return box;
}

export function renderIssues(el: HTMLElement, issues: Issue[], a: PanelActions, f: IssueFilter, setF: (f: IssueFilter) => void, scope: Issue[] | null = null) {
  const all = issues.filter(i => i.severity !== 'info');
  const e = all.filter(i => i.severity === 'error').length;
  el.innerHTML = `<h4>Ошибки графа: <span style="color:var(--err)">${e}</span> · предупреждений: <span style="color:var(--warn)">${all.length - e}</span></h4>`;
  const info = issues.find(i => i.kind === 'connectivity');
  if (info) el.insertAdjacentHTML('beforeend', `<div class="muted" style="margin-bottom:6px">${info.msg}</div>`);
  // фильтры: тяжесть и тип
  const bar = document.createElement('div'); bar.className = 'btns ifilter';
  for (const [v, t] of [['all', `Все (${all.length})`], ['error', `Ошибки (${e})`], ['warn', `Предупр. (${all.length - e})`]] as const) {
    const b = btn(t, () => setF({ ...f, sev: v })); if (f.sev === v) b.classList.add('on'); bar.appendChild(b);
  }
  const so = btn(f.selOnly ? '☑ Только выделенное' : '☐ Только выделенное', () => setF({ ...f, selOnly: !f.selOnly }), 'Показывать замечания только для выбранных рёбер/узлов');
  if (f.selOnly) so.classList.add('on'); bar.appendChild(so);
  el.appendChild(bar);
  const kinds = new Map<string, number>(); for (const i of all) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  const ks = document.createElement('select'); ks.className = 'kfilter';
  ks.add(new Option('Все типы проверок', 'all'));
  for (const [k, n] of [...kinds].sort((x, y) => y[1] - x[1])) ks.add(new Option(`${KIND_RU[k] ?? k} (${n})`, k));
  ks.value = kinds.has(f.kind) ? f.kind : 'all'; ks.onchange = () => setF({ ...f, kind: ks.value });
  el.appendChild(ks);
  const real = filterIssues(issues, f, scope);
  if (scope && !scope.length) el.insertAdjacentHTML('beforeend', '<div class="muted" style="margin:4px 0">В выделении замечаний нет (или ничего не выбрано).</div>');
  if (real.length !== all.length && !(scope && !scope.length)) el.insertAdjacentHTML('beforeend', `<div class="muted" style="margin:4px 0">Показано ${real.length} из ${all.length}. Те же замечания подсвечены на карте.</div>`);
  const sorted = real.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1)).slice(0, 200);
  for (const i of sorted) {
    const d = document.createElement('div'); d.className = 'issue';
    d.innerHTML = `<span class="dot ${i.severity}"></span><span>${i.msg}</span>`;
    d.onclick = () => a.focusIssue(i); el.appendChild(d);
  }
  if (real.length > 200) el.insertAdjacentHTML('beforeend', `<div class="muted">… и ещё ${real.length - 200}</div>`);
  if (!real.length) el.insertAdjacentHTML('beforeend', '<div class="muted">Ошибок не найдено</div>');
}

// [P3] Панель свойств (теги, быстрые действия, массовая правка) и [P4] список ошибок.
import type { Store } from '../core/store.ts';
import type { Issue, Tags, Doc, OsmWay } from '../core/types.ts';
import { HIGHWAY_CLASSES, SURFACES, SPEED_QUICK } from '../core/roadStyle.ts';
import { onewayDir } from '../core/osm.ts';
import * as ops from './ops.ts';
import { lineOfWay, describeLine } from '../semantic/lines.ts';

export interface PanelActions {
  reverse(): void; toggleOneway(): void; bridge(): void; smooth(): void; signal(): void; del(): void;
  copyAttrs(): void; selectLine(): void; mergeWays(): void; applyTemplate(): void; focusIssue(i: Issue): void; msg(s: string): void;
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
function selectRow(label: string, options: [string, string][], current: string | null, onPick: (v: string) => void): HTMLElement {
  const row = document.createElement('label'); row.className = 'srow';
  const sp = document.createElement('span'); sp.textContent = label;
  const sel = document.createElement('select');
  if (current === null) { const o = new Option('— разные значения —', '__mixed'); o.disabled = true; sel.add(o); }
  for (const [v, t] of options) sel.add(new Option(t, v));
  sel.value = current === null ? '__mixed' : current;
  sel.onchange = () => onPick(sel.value);
  row.append(sp, sel); return row;
}

/** Класс дороги, покрытие и ограничение скорости: быстрые контролы для одного или многих рёбер. */
function styleControls(store: Store, ways: number[]): HTMLElement {
  const box = document.createElement('div'); box.className = 'style';
  const doc = store.doc;
  const apply = (tags: Tags) => store.commit(d => ops.applyTags(d, ways, tags));
  const get = (k: string) => common(doc, ways, w => w.tags[k] ?? '');

  const hw = get('highway');
  const hwOpts = HIGHWAY_CLASSES.map(c => [c.value, c.label] as [string, string]);
  if (hw && !HIGHWAY_CLASSES.some(c => c.value === hw)) hwOpts.push([hw, hw]);
  box.append(selectRow('Класс дороги', hwOpts, hw, v => v && apply({ highway: v })));

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
    const parts = [HW_SHORT[r.hw] ?? r.hw, r.maxspeed ? `${r.maxspeed} км/ч` : '', r.lanes ? `${r.lanes} пол.` : '', r.surface ? (SURF_RU[r.surface] ?? r.surface) : '', r.dir === 'both' ? '↔' : r.dir === 'forward' ? '→ по линии' : '← против линии'].filter(Boolean);
    t.insertRow().innerHTML = `<td>${m(r.from)}–${m(r.to)} м</td><td>${parts.join(' · ')}</td>`;
  }
  for (const k of marks) t.insertRow().innerHTML = `<td>${m(k.dist)} м</td><td>◆ ${k.label}</td>`;
  box.appendChild(t); return box;
}

export function renderProps(el: HTMLElement, store: Store, a: PanelActions) {
  el.innerHTML = '';
  const ways = store.selWays(), nodes = store.selNodes(), doc = store.doc;
  const h = document.createElement('h4'); el.appendChild(h);
  if (ways.length === 0 && nodes.length === 0) { h.textContent = 'Свойства'; el.insertAdjacentHTML('beforeend', '<div class="muted">Ничего не выбрано. Кликните по ребру или узлу (Shift — несколько). Список горячих клавиш: «?»</div>'); return; }

  if (ways.length === 1 && !nodes.length) {
    const w = doc.ways.get(ways[0])!;
    h.textContent = `Ребро #${w.id} · узлов: ${w.nodes.length} · ${onewayDir(w.tags) ? 'одностороннее' : 'двустороннее'}`;
    const b = document.createElement('div'); b.className = 'btns';
    b.append(btn('Развернуть (R)', a.reverse), btn('Oneway (O)', a.toggleOneway), btn('Мост (B)', a.bridge), btn('Высота ele (F)', a.smooth), btn('Удалить', a.del));
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
    b.append(btn('Копировать атрибуты с первого (Alt+C)', a.copyAttrs), btn('Oneway (O)', a.toggleOneway), btn('Мост (B)', a.bridge));
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
    b.append(btn(n.tags.highway === 'traffic_signals' ? 'Убрать светофор (S)' : 'Светофор (S)', a.signal), btn('Удалить', a.del));
    el.appendChild(b);
    el.appendChild(tagTable(n.tags, (k, v) => store.commit(d => ops.setTag(d.nodes.get(n.id)!, k, v))));
  } else {
    h.textContent = `Выбрано узлов: ${nodes.length}`;
    const b = document.createElement('div'); b.className = 'btns'; b.append(btn('Удалить', a.del)); el.appendChild(b);
  }
}

export function renderIssues(el: HTMLElement, issues: Issue[], a: PanelActions) {
  const real = issues.filter(i => i.severity !== 'info');
  const e = real.filter(i => i.severity === 'error').length;
  el.innerHTML = `<h4>Ошибки графа: <span style="color:var(--err)">${e}</span> · предупреждений: <span style="color:var(--warn)">${real.length - e}</span></h4>`;
  const info = issues.find(i => i.kind === 'connectivity');
  if (info) el.insertAdjacentHTML('beforeend', `<div class="muted" style="margin-bottom:6px">${info.msg}</div>`);
  const sorted = real.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'error' ? -1 : 1)).slice(0, 200);
  for (const i of sorted) {
    const d = document.createElement('div'); d.className = 'issue';
    d.innerHTML = `<span class="dot ${i.severity}"></span><span>${i.msg}</span>`;
    d.onclick = () => a.focusIssue(i); el.appendChild(d);
  }
  if (real.length > 200) el.insertAdjacentHTML('beforeend', `<div class="muted">… и ещё ${real.length - 200}</div>`);
  if (!real.length) el.insertAdjacentHTML('beforeend', '<div class="muted">Ошибок не найдено</div>');
}

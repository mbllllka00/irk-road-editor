// Точка входа: связывает Store (P1), MapView (P2), операции/панель/hotkeys (P3), валидатор (P4).
import './style.css';
import { Store } from './core/store.ts';
import { parseOsm, serializeOsm, onewayDir } from './core/osm.ts';
import type { Issue } from './core/types.ts';
import { MapView } from './map/mapView.ts';
import { renderLegend } from './map/legend.ts';
import * as SM from './semantic/marks.ts';
import { compileForExport } from './semantic/compile.ts';
import { lineOfWay, wayIdsOf } from './semantic/lines.ts';
import type { ColorMode } from './core/roadStyle.ts';
import { SURFACES } from './core/roadStyle.ts';
import type { Doc } from './core/types.ts';
import type { Base, ClickInfo } from './map/mapView.ts';
import * as ops from './tools/ops.ts';
import { bindHotkeys, HELP } from './tools/hotkeys.ts';
import { renderProps, renderIssues } from './tools/panel.ts';
import type { PanelActions } from './tools/panel.ts';
import { validate, countBy } from './validator/validate.ts';

type Mode = 'select' | 'node' | 'draw' | 'split' | 'merge' | 'mark' | 'repair';
interface DraftPt { lat: number; lon: number; nodeId?: number; wayId?: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = new Store();
let mode: Mode = 'select';
let draft: DraftPt[] = [];
let pendingMerge: number | null = null;
let issues: Issue[] = [];
let issueIdx = -1;
let vTimer: number | undefined;
let cmode: ColorMode = 'class';
let markStart: SM.PointRef | null = null;
let repair: { a?: SM.PointRef; b?: SM.PointRef; mid: { lat: number; lon: number }[] } = { mid: [] };

// ---------- метки «по смыслу» ----------
type MKey = 'speed' | 'lanes' | 'oneway' | 'surface' | 'stairs' | 'crossing' | 'give_way' | 'stop';
const MTYPES: { id: MKey; label: string; range: boolean; hint: string }[] = [
  { id: 'speed', label: 'Скорость', range: true, hint: 'Кликните начало и конец участка: на нём будет заданная скорость' },
  { id: 'lanes', label: 'Полосы', range: true, hint: 'Кликните начало и конец участка: число полос' },
  { id: 'oneway', label: 'Направление', range: true, hint: 'Кликните начало, затем конец: движение пойдёт от первой точки ко второй (или наоборот / в обе стороны)' },
  { id: 'surface', label: 'Покрытие', range: true, hint: 'Кликните начало и конец участка' },
  { id: 'stairs', label: 'Лестница (начало–конец)', range: true, hint: 'Кликните начало лестницы, затем конец, на тротуаре' },
  { id: 'crossing', label: 'Переход', range: false, hint: 'Кликните по линии в месте перехода' },
  { id: 'give_way', label: 'Знак «Уступи»', range: false, hint: 'Кликните по дороге на подходе к перекрёстку: знак встанет за 5 м до него' },
  { id: 'stop', label: 'Знак «Стоп»', range: false, hint: 'Кликните по дороге на подходе к перекрёстку' },
];
const curType = () => MTYPES.find(m => m.id === $<HTMLSelectElement>('mtype').value)!;
const mval = () => ($('mval').firstElementChild as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';

function buildMarkControl() {
  const t = curType(), box = $('mval'); box.innerHTML = '';
  const select = (opts: [string, string][]) => { const s = document.createElement('select'); opts.forEach(([v, l]) => s.add(new Option(l, v))); box.appendChild(s); };
  const num = (def: string, min: number, max: number, unit: string) => {
    const i = document.createElement('input'); i.type = 'number'; i.value = def; i.min = String(min); i.max = String(max); i.style.width = '64px'; box.append(i, unit);
  };
  if (t.id === 'speed') num('40', 5, 130, ' км/ч');
  else if (t.id === 'lanes') num('2', 1, 8, ' полос');
  else if (t.id === 'oneway') select([['forward', '→ от 1-й точки ко 2-й'], ['backward', '← от 2-й точки к 1-й'], ['both', '↔ двустороннее']]);
  else if (t.id === 'surface') select(SURFACES.map(x => [x.value, x.label] as [string, string]));
  else if (t.id === 'crossing') select([['signals', 'регулируемый'], ['uncontrolled', 'нерегулируемый']]);
  $('mwholel').hidden = !t.range || t.id === 'oneway';
  markStart = null; draft = []; redraw(); msg(t.hint);
}

function runSem(fn: (d: Doc) => SM.Res) {
  let res: SM.Res = {};
  const err = store.tryCommit(d => { res = fn(d); return res.err ?? null; });
  msg(err ?? res.msg ?? 'Готово');
}
function pickOne(title: string, opts: [number, string][]): Promise<number | null> {
  return new Promise(resolve => {
    const dlg = $<HTMLDialogElement>('pickDlg'); dlg.innerHTML = `<h3>${title}</h3>`;
    for (const [v, t] of opts) { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { dlg.close(); resolve(v); }; dlg.appendChild(b); }
    const c = document.createElement('button'); c.textContent = 'Отмена'; c.onclick = () => { dlg.close(); resolve(null); }; dlg.appendChild(c);
    dlg.onclose = () => resolve(null); dlg.showModal();
  });
}
async function handleMark(e: ClickInfo) {
  if (e.wayId === undefined) return msg('Кликните по линии (дороге или тротуару)');
  const mt = curType(), p: SM.PointRef = { wayId: e.wayId, lat: e.lat, lon: e.lng };
  const kind = lineOfWay(store.doc, p.wayId)?.kind;
  if (mt.id === 'crossing') return runSem(d => SM.addCrossing(d, p, mval() === 'signals'));
  if (mt.id === 'give_way' || mt.id === 'stop') {
    if (kind !== 'road') return msg('Знаки ставятся на дороги');
    const ap = SM.findApproach(store.doc, p);
    if (!ap) return msg('На этой линии нет перекрёстков');
    let to = ap.others[0].wayId;
    if (ap.others.length > 1) {
      const pick = await pickOne(mt.id === 'stop' ? 'Кому уступаем (перед кем останавливаемся)?' : 'Кому уступаем?', ap.others.map(o => [o.wayId, o.label] as [number, string]));
      if (pick === null) return; to = pick;
    }
    return runSem(d => SM.addSign(d, p, mt.id as 'give_way' | 'stop', to));
  }
  if ((mt.id === 'speed' || mt.id === 'lanes') && kind !== 'road') return msg('Скорость и полосы задаются для дорог, а не тротуаров');
  if (mt.id === 'stairs' && kind !== 'sidewalk') return msg('Лестница ставится на тротуар или пешеходную линию');
  let edit: SM.Edit;
  const v = mval();
  if (mt.id === 'speed') { const n = Math.round(+v); if (!(n >= 5 && n <= 130)) return msg('Скорость: число от 5 до 130'); edit = { tags: { maxspeed: String(n) } }; }
  else if (mt.id === 'lanes') { const n = Math.round(+v); if (!(n >= 1 && n <= 12)) return msg('Полосы: число от 1 до 12'); edit = { tags: { lanes: String(n), 'lanes:forward': '', 'lanes:backward': '' } }; }
  else if (mt.id === 'oneway') edit = { oneway: v as SM.OnewaySpec };
  else if (mt.id === 'surface') edit = { tags: { surface: v } };
  else edit = { tags: { highway: 'steps' } };
  if ($<HTMLInputElement>('mwhole').checked && !$('mwholel').hidden) return runSem(d => SM.applyWhole(d, p.wayId, edit));
  if (!markStart) { markStart = p; draft = [{ lat: p.lat, lon: p.lon }]; redraw(); return msg(`${mt.label}: первая точка поставлена. Кликните вторую точку участка`); }
  const a = markStart; markStart = null; draft = []; redraw();
  runSem(d => SM.applyRange(d, a, p, edit));
}

// ---------- починка участка ----------
function syncRepairDraft() {
  const pts = [repair.a, ...repair.mid, repair.b].filter(Boolean) as { lat: number; lon: number }[];
  draft = pts.map(q => ({ lat: q.lat, lon: q.lon })); redraw();
}
function handleRepair(e: ClickInfo) {
  const p = e.wayId !== undefined ? { wayId: e.wayId, lat: e.lat, lon: e.lng } : null;
  if (!repair.a) {
    if (!p) return msg('Кликните по линии: начало участка, который нужно перечертить');
    repair.a = p; syncRepairDraft(); return msg('Начало задано. Кликните конец участка на этой же линии');
  }
  if (!repair.b) {
    if (!p) return msg('Кликните по той же линии: конец участка');
    repair.b = p; syncRepairDraft(); return msg('Теперь кликайте новую форму участка. Enter: применить (без точек участок выпрямится), Esc: отмена');
  }
  repair.mid.push({ lat: e.lat, lon: e.lng }); syncRepairDraft();
}
function finishRepair() {
  if (!repair.a || !repair.b) return;
  const { a, b, mid } = repair; repair = { mid: [] }; draft = [];
  runSem(d => SM.replaceSection(d, a, b, mid));
}

const msg = (s: string) => { $('status').textContent = s; };

// ---------- действия ----------
const actions: PanelActions = {
  msg,
  reverse() {
    const ws = store.selWays(); if (!ws.length) return;
    const err = store.tryCommit(d => { for (const w of ws) { const e = ops.reverseWay(d, w); if (e) return e; } return null; });
    msg(err ?? `Направление развёрнуто (${ws.length})`);
  },
  toggleOneway() {
    const ws = store.selWays(); if (!ws.length) return;
    const first = store.doc.ways.get(ws[0])!;
    store.commit(d => ops.setOneway(d, ws, onewayDir(first.tags) ? 'no' : 'yes'));
  },
  bridge() { const ws = store.selWays(); if (ws.length) store.commit(d => ops.toggleBridge(d, ws)); },
  smooth() {
    const ws = store.selWays(); if (!ws.length) return;
    msg(store.tryCommit(d => ops.smoothEle(d, ws[0])) ?? 'Высота ele интерполирована по длине ребра');
  },
  signal() { const ns = store.selNodes(); if (ns.length) store.commit(d => ns.forEach(n => ops.toggleSignal(d, n))); },
  del() {
    const ws = store.selWays(), ns = store.selNodes(); if (!ws.length && !ns.length) return;
    store.commit(d => { ws.forEach(w => ops.deleteWay(d, w)); ns.forEach(n => ops.deleteNode(d, n)); });
    store.sel = []; store.notify();
  },
  copyAttrs() {
    const ws = store.selWays(); if (ws.length < 2) return msg('Выберите минимум два ребра: атрибуты копируются с первого');
    store.commit(d => ops.copyTags(d, ws[0], ws.slice(1)));
    msg(`Атрибуты ребра #${ws[0]} скопированы на ${ws.length - 1}`);
  },
  selectLine() {
    const ids = new Set<number>();
    for (const w of store.selWays()) { const l = lineOfWay(store.doc, w); if (l) wayIdsOf(l).forEach(i => ids.add(i)); }
    if (ids.size) store.setSel([...ids].map(id => ({ type: 'way' as const, id })));
  },
  mergeWays() {
    const ws = store.selWays(); if (ws.length !== 2) return;
    msg(store.tryCommit(d => ops.mergeWays(d, ws[0], ws[1])) ?? 'Рёбра слиты');
  },
  applyTemplate() {
    const ws = store.selWays(); if (ws.length) store.commit(d => ops.applyTemplate(d, ws, $<HTMLSelectElement>('tpl').value));
  },
  focusIssue(i) {
    store.sel = [...i.wayIds.slice(0, 20).map(id => ({ type: 'way' as const, id })), ...i.nodeIds.slice(0, 20).map(id => ({ type: 'node' as const, id }))];
    store.notify();
    if (i.lat !== undefined) view.flyTo(i.lat, i.lon!);
  },
};

// ---------- карта ----------
const view = new MapView('map', {
  onClick: handleClick,
  onDblClick: () => { if (mode === 'draw') finishDraft(); else if (mode === 'repair') finishRepair(); },
  dragAllowed: id => mode === 'select' && (store.selNodes().includes(id) || store.selWays().some(w => store.doc.ways.get(w)?.nodes.includes(id))),
  onDragStart: () => { store.dragging = true; store.checkpoint(); },
  onDrag: (id, lat, lon) => { ops.moveNode(store.doc, id, lat, lon); store.notify(); },
  onDragEnd: () => { store.dragging = false; store.notify(); msg('Узел перемещён'); },
});

function handleClick(e: ClickInfo) {
  const doc = store.doc;
  switch (mode) {
    case 'select': {
      const hit = e.nodeId !== undefined ? { type: 'node' as const, id: e.nodeId } : e.wayId !== undefined ? { type: 'way' as const, id: e.wayId } : null;
      if (!hit) { if (!e.shift) store.setSel([]); return; }
      const has = store.sel.some(s => s.type === hit.type && s.id === hit.id);
      store.setSel(e.shift ? (has ? store.sel.filter(s => !(s.type === hit.type && s.id === hit.id)) : [...store.sel, hit]) : [hit]);
      break;
    }
    case 'node':
      if (e.nodeId !== undefined) { store.setSel([{ type: 'node', id: e.nodeId }]); break; }
      store.commit(d => {
        const id = (e.wayId !== undefined ? ops.nodeOnWayAt(d, e.wayId, e.lat, e.lng) : null) ?? ops.addNode(d, e.lat, e.lng);
        store.sel = [{ type: 'node', id }];
      });
      break;
    case 'draw': {
      const n = e.nodeId !== undefined ? doc.nodes.get(e.nodeId) : undefined;
      draft.push({ lat: n?.lat ?? e.lat, lon: n?.lon ?? e.lng, nodeId: e.nodeId, wayId: e.nodeId === undefined ? e.wayId : undefined });
      redraw(); msg(`Точек: ${draft.length}. Enter или двойной клик — завершить, Esc — отмена`);
      break;
    }
    case 'split': {
      let err: string | null;
      if (e.nodeId !== undefined) {
        const cand = [...doc.ways.values()].filter(w => w.nodes.indexOf(e.nodeId!) > 0 && w.nodes.indexOf(e.nodeId!) < w.nodes.length - 1);
        const w = cand.find(c => store.selWays().includes(c.id)) ?? cand[0];
        err = w ? store.tryCommit(d => ops.splitWay(d, w.id, e.nodeId!)) : 'Узел не внутренний ни для одного ребра';
      } else if (e.wayId !== undefined) err = store.tryCommit(d => ops.splitAt(d, e.wayId!, e.lat, e.lng));
      else return;
      msg(err ?? 'Ребро разрезано');
      break;
    }
    case 'mark': handleMark(e); break;
    case 'repair': handleRepair(e); break;
    case 'merge':
      if (e.nodeId === undefined) return;
      if (pendingMerge === null) { pendingMerge = e.nodeId; msg('Первый узел выбран (он останется). Кликните по второму — он будет склеен с первым'); }
      else {
        const keep = pendingMerge, rem = e.nodeId; pendingMerge = null;
        msg(store.tryCommit(d => ops.mergeNodes(d, keep, rem)) ?? 'Узлы склеены');
      }
      break;
  }
}

function finishDraft() {
  const pts = draft.filter((p, i) => i === 0 || !(Math.abs(p.lat - draft[i - 1].lat) < 1e-9 && Math.abs(p.lon - draft[i - 1].lon) < 1e-9));
  draft = [];
  if (pts.length < 2) { redraw(); return; }
  const tags = ops.templateTags($<HTMLSelectElement>('tpl').value);
  store.commit(d => {
    const raw = pts.map(p => p.nodeId ?? (p.wayId !== undefined ? ops.nodeOnWayAt(d, p.wayId, p.lat, p.lon) : null) ?? ops.addNode(d, p.lat, p.lon));
    const ids = raw.filter((x, i) => i === 0 || x !== raw[i - 1]);
    if (ids.length > 1) store.sel = [{ type: 'way', id: ops.addWay(d, ids, Object.keys(tags).length ? tags : { highway: 'residential' }) }];
  });
  msg('Ребро создано');
}

function setMode(m: Mode) {
  mode = m; draft = []; pendingMerge = null; markStart = null; repair = { mid: [] };
  $('markbar').hidden = m !== 'mark'; if (m === 'mark') buildMarkControl();
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  view.setCursor(m === 'select' ? '' : 'crosshair'); redraw();
  msg({ select: 'Выбор: клик по ребру/узлу, перетаскивание узлов выбранного ребра', node: 'Узел: клик по карте или по ребру (вставка узла-перекрёстка)', draw: 'Ребро: кликайте точки, клик по узлу/ребру присоединяет к сети', split: 'Разрезать: клик по узлу или точке на ребре', merge: 'Склейка: выберите два узла подряд', mark: curType().hint, repair: 'Участок: кликните начало и конец на линии, затем новую форму, Enter' }[m]);
}

// ---------- валидация и перерисовка ----------
function redraw() {
  view.render(store.doc, store.sel, issues, draft.map(p => [p.lon, p.lat]));
  renderProps($('props'), store, actions);
  renderIssues($('issues'), issues, actions);
  renderLegend($('legend'), store.doc, cmode);
  $<HTMLButtonElement>('undo').disabled = !store.canUndo(); $<HTMLButtonElement>('redo').disabled = !store.canRedo();
}
function runValidation() { issues = validate(store.doc); redraw(); }
store.onChange(() => { redraw(); clearTimeout(vTimer); vTimer = window.setTimeout(runValidation, 500); });

function nextIssue() {
  const real = issues.filter(i => i.severity !== 'info'); if (!real.length) return msg('Ошибок нет');
  issueIdx = (issueIdx + 1) % real.length; actions.focusIssue(real[issueIdx]);
}

// ---------- файлы ----------
async function openFile(f: File) {
  try {
    const doc = parseOsm(await f.text());
    store.load(doc); view.fitToDoc(doc); runValidation();
    msg(`Загружено: ${f.name} — узлов ${doc.nodes.size}, рёбер ${doc.ways.size}, отношений ${doc.relations.size}`);
  } catch (e) { alert('Не удалось открыть файл: ' + (e as Error).message); }
}
function save() {
  issues = validate(store.doc); redraw();
  const c = countBy(issues);
  const conn = issues.find(i => i.kind === 'connectivity')?.msg ?? '';
  if (c.error && !confirm(`Перед сохранением найдено критичных ошибок: ${c.error} (предупреждений: ${c.warn}).\n${conn}\n\nСохранить всё равно?`)) { actions.focusIssue(issues.find(i => i.severity === 'error')!); return; }
  const name = ($<HTMLInputElement>('fname').value.trim() || 'team1').replace(/[^\w.-]/g, '_').replace(/\.osm$/i, '');
  localStorage.setItem('fname', name);
  const out = structuredClone(store.doc);
  const rep = compileForExport(out); // автоматика: направление, склейка рёбер, полосы по направлениям, разметка
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([serializeOsm(out)], { type: 'application/xml' }));
  a.download = name + '.osm'; a.click(); URL.revokeObjectURL(a.href);
  store.dirty = false;
  msg(`Сохранено: ${name}.osm. Склеено рёбер: ${rep.merged}, направлений приведено: ${rep.flipped}, полос вычислено: ${rep.lanesDerived}, разметка: ${rep.markings}. ${conn}`);
}

function setColorMode(m: ColorMode) {
  cmode = m; $<HTMLSelectElement>('cmode').value = m; view.setColorMode(m);
  renderLegend($('legend'), store.doc, m);
}
function cycleColorMode() {
  const order: ColorMode[] = ['class', 'lanes', 'surface', 'speed'];
  setColorMode(order[(order.indexOf(cmode) + 1) % order.length]);
}

// ---------- UI ----------
$<HTMLSelectElement>('mtype').innerHTML = MTYPES.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
$<HTMLSelectElement>('mtype').onchange = buildMarkControl;
$<HTMLSelectElement>('cmode').onchange = e => setColorMode((e.target as HTMLSelectElement).value as ColorMode);
$<HTMLSelectElement>('tpl').innerHTML = Object.keys(ops.TEMPLATES).map(k => `<option>${k}</option>`).join('');
$<HTMLInputElement>('fname').value = localStorage.getItem('fname') ?? 'team1';
$('open').onclick = () => $('file').click();
$<HTMLInputElement>('file').onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) openFile(f); (e.target as HTMLInputElement).value = ''; };
$('save').onclick = save;
$('undo').onclick = () => store.undo(); $('redo').onclick = () => store.redo();
document.querySelectorAll<HTMLButtonElement>('#modes button').forEach(b => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$<HTMLSelectElement>('base').onchange = e => view.setBase((e.target as HTMLSelectElement).value as Base);
$<HTMLInputElement>('op').oninput = e => view.setOpacity(Number((e.target as HTMLInputElement).value));
$<HTMLInputElement>('tiles').onchange = e => { const v = (e.target as HTMLInputElement).value.trim(); if (v) { view.setCustomTiles(v); $<HTMLSelectElement>('base').value = 'custom'; } };
$('b3d').onclick = () => $('b3d').classList.toggle('on', view.toggle3D());
$('help').onclick = () => $<HTMLDialogElement>('helpDlg').showModal();
$('helpTbl').innerHTML = HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) openFile(f); });
window.addEventListener('beforeunload', e => { if (store.dirty) e.preventDefault(); });

bindHotkeys({
  t: () => setMode('mark'), u: () => setMode('repair'), l: actions.selectLine,
  v: () => setMode('select'), n: () => setMode('node'), w: () => setMode('draw'), x: () => setMode('split'), c: () => setMode('merge'),
  m: actions.mergeWays, r: actions.reverse, o: actions.toggleOneway, s: actions.signal, b: actions.bridge, f: actions.smooth,
  'alt+c': actions.copyAttrs, delete: actions.del, backspace: actions.del, e: nextIssue,
  k: cycleColorMode, '3': () => $('b3d').click(), '?': () => $('help').click(),
  'ctrl+z': () => store.undo(), 'ctrl+shift+z': () => store.redo(), 'ctrl+y': () => store.redo(),
  'ctrl+s': save, 'ctrl+o': () => $('open').click(),
  enter: () => { if (mode === 'draw') finishDraft(); else if (mode === 'repair') finishRepair(); },
  escape: () => { draft = []; pendingMerge = null; markStart = null; repair = { mid: [] }; store.setSel([]); redraw(); },
});
setMode('select');

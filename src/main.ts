// Точка входа: связывает Store (P1), MapView (P2), операции/панель/hotkeys (P3), валидатор (P4).
import './style.css';
import { Store } from './core/store.ts';
import { diffDocs, changeTitle } from './core/diff.ts';
import { parseOsm, serializeOsm, onewayDir } from './core/osm.ts';
import { dist, ellipsePoints, shapeFromCorners } from './core/geo.ts';
import { lineCrossesBuilding } from './core/obstacles.ts';
import { validateBuildingPlacement } from './core/buildingPlacement.ts';
import { normalizePeak, PEAK_TAG, PEAK_PRESETS } from './core/peak.ts';
import type { Issue } from './core/types.ts';
import { MapView } from './map/mapView.ts';
import { renderLegend } from './map/legend.ts';
import { signalStats } from './map/signals.ts';
import * as SM from './semantic/marks.ts';
import { compileForExport } from './semantic/compile.ts';
import { lineOfWay, wayIdsOf } from './semantic/lines.ts';
import type { ColorMode } from './core/roadStyle.ts';
import { SURFACES, CLASS_CATS, classKey } from './core/roadStyle.ts';
import type { Doc } from './core/types.ts';
import type { Base, ClickInfo } from './map/mapView.ts';
import * as ops from './tools/ops.ts';
import { bindHotkeys, HELP } from './tools/hotkeys.ts';
import { renderProps, renderIssues, filterIssues, issuesFor, KIND_RU } from './tools/panel.ts';
import type { IssueFilter } from './tools/panel.ts';
import type { PanelActions } from './tools/panel.ts';
import { validate, countBy } from './validator/validate.ts';
import { drawBusStopIcon } from './map/mapView.ts';

type Mode =
  | 'select'
  | 'node'
  | 'draw'
  | 'split'
  | 'merge'
  | 'mark'
  | 'repair'
  | 'ring'
  | 'area'
  | 'busstop'
  | 'building';
interface DraftPt { lat: number; lon: number; nodeId?: number; wayId?: number }

const isArea = (t: Record<string, string>) => t.amenity === 'parking' && !t.highway;
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
let ifilter: IssueFilter = { sev: 'all', kind: 'all', selOnly: false };
let copyBuf: { from: number; tags: Record<string, string> } | null = null;
let multi = false; // режим «Мульти»: каждый клик добавляет/убирает объект из выделения
let hl: string | null = null; // подсвеченная категория легенды
let ringConfig = { radius: 18, segments: 24, lanes: 1, speed: 30 };
let comparisonOn = false;
let comparedRevision = -1;
let legendWanted = true;

// ---------- метки «по смыслу» ----------
type MKey = 'underpass' | 'peak' | 'speed' | 'lanes' | 'oneway' | 'surface' | 'stairs' | 'crossing' | 'give_way' | 'stop';
const MTYPES: { id: MKey; label: string; range: boolean; hint: string }[] = [
  { id: 'speed', label: 'Скорость', range: true, hint: 'Кликните начало и конец участка: на нём будет заданная скорость' },
  { id: 'lanes', label: 'Полосы', range: true, hint: 'Кликните начало и конец участка: число полос' },
  { id: 'oneway', label: 'Направление', range: true, hint: 'Кликните начало, затем конец: движение пойдёт от первой точки ко второй (или наоборот / в обе стороны)' },
  { id: 'peak', label: 'Время макс. загрузки', range: true, hint: 'Кликните начало и конец участка: на нём будет записано время максимальной загрузки (peak_hours), например 07:30-09:30;17:00-19:00' },
  { id: 'surface', label: 'Покрытие', range: true, hint: 'Кликните начало и конец участка' },
  { id: 'underpass', label: 'Подземный пеш. переход', range: true, hint: 'Кликните начало и конец подземного перехода на пешеходной линии: ребро станет footway + tunnel=yes + layer=-1' },
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
  if (t.id === 'peak') {
    const i = document.createElement('input'); i.value = '07:30-09:30;17:00-19:00'; i.setAttribute('list', 'peakList'); i.style.width = '190px'; i.title = 'ЧЧ:ММ-ЧЧ:ММ, несколько через «;»';
    const dl = document.createElement('datalist'); dl.id = 'peakList'; dl.innerHTML = PEAK_PRESETS.map(([, v]) => `<option value="${v}">`).join('');
    box.append(i, dl);
  } else if (t.id === 'speed') num('40', 5, 130, ' км/ч');
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
  // клик попал в узел, а не в линию: берём любое ребро, которому узел принадлежит
  if (e.wayId === undefined && e.nodeId !== undefined) e.wayId = [...store.doc.ways.values()].find(w => w.tags.highway && w.nodes.includes(e.nodeId!))?.id;
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
  if ((mt.id === 'stairs' || mt.id === 'underpass') && kind !== 'sidewalk') return msg('Лестница ставится на тротуар или пешеходную линию');
  let edit: SM.Edit;
  const v = mval();
  if (mt.id === 'speed') { const n = Math.round(+v); if (!(n >= 5 && n <= 130)) return msg('Скорость: число от 5 до 130'); edit = { tags: { maxspeed: String(n) } }; }
  else if (mt.id === 'lanes') { const n = Math.round(+v); if (!(n >= 1 && n <= 12)) return msg('Полосы: число от 1 до 12'); edit = { tags: { lanes: String(n), 'lanes:forward': '', 'lanes:backward': '' } }; }
  else if (mt.id === 'oneway') edit = { oneway: v as SM.OnewaySpec };
  else if (mt.id === 'peak') { const n = normalizePeak(v); if (!n) return msg('Время: формат ЧЧ:ММ-ЧЧ:ММ, несколько интервалов через «;»'); edit = { tags: { [PEAK_TAG]: n } }; }
  else if (mt.id === 'surface') edit = { tags: { surface: v } };
  else if (mt.id === 'underpass') edit = { tags: { highway: 'footway', tunnel: 'yes', layer: '-1' } };
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
  crossing(signalized) {
    const ns = store.selNodes(); if (ns.length !== 1) return msg('Выберите один узел на линии (режим «Выбор», клик по узлу), затем нажмите P');
    runSem(d => SM.setCrossing(d, ns[0], signalized));
  },
  removeCrossing() { const ns = store.selNodes(); if (ns.length === 1) runSem(d => SM.removeCrossing(d, ns[0])); },
  del() {
    const ws = store.selWays(), ns = store.selNodes(); if (!ws.length && !ns.length) return;
    store.commit(d => { ws.forEach(w => ops.deleteWay(d, w)); ns.forEach(n => ops.deleteNode(d, n)); });
    store.sel = []; store.notify();
  },
  copyAttrs() {
    const ws = store.selWays(); if (!ws.length) return msg('Выберите ребро-источник и нажмите Alt+C, затем выберите целевые и Alt+V');
    const src = store.doc.ways.get(ws[0])!, snap = ops.snapshotTags(store.doc, ws[0])!;
    const nm = src.tags.name ? `«${src.tags.name}» ` : '';
    if (ws.length === 1) { copyBuf = { from: ws[0], tags: snap }; redraw(); return msg(`Скопированы характеристики ребра ${nm}#${ws[0]}: ${Object.entries(snap).filter(([, v]) => v).map(([k, v]) => k + '=' + v).join(', ') || 'нет тегов'}. Выберите целевые рёбра и нажмите Alt+V`); }
    let n = 0; store.commit(d => { n = ops.pasteTags(d, ws.slice(1), snap); });
    msg(`Характеристики ребра ${nm}#${ws[0]} (первое выбранное) записаны в ${n} из ${ws.length - 1} рёбер`);
  },
  pasteAttrs() {
    const ws = store.selWays(); if (!copyBuf) return msg('Буфер пуст: выберите одно ребро и нажмите Alt+C');
    if (!ws.length) return msg('Выберите рёбра, куда вставить характеристики');
    let n = 0; store.commit(d => { n = ops.pasteTags(d, ws, copyBuf!.tags); });
    msg(n ? `Вставлено из ребра #${copyBuf.from}: изменено рёбер ${n} из ${ws.length}` : 'Выбранные рёбра уже имеют те же характеристики');
  },
  hasCopy: () => copyBuf !== null,
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
    if (ifilter.selOnly) ifilter = { ...ifilter, selOnly: false }; // иначе выбор замечания схлопнет список
    store.sel = [...i.wayIds.slice(0, 20).map(id => ({ type: 'way' as const, id })), ...i.nodeIds.slice(0, 20).map(id => ({ type: 'node' as const, id }))];
    store.notify();
    if (i.lat !== undefined) view.flyTo(i.lat, i.lon!);
  },
};

// ---------- дополнительные инструменты качества графа ----------
function autoMergeExactDuplicates() {
  const duplicateIssues = validate(store.doc).filter(i => i.kind === 'duplicate-nodes' && i.nodeIds.length > 1);
  if (!duplicateIssues.length) return msg('Дубликаты узлов не найдены');
  const groups = duplicateIssues.map(i => i.nodeIds.filter(id => store.doc.nodes.has(id)));
  const pairs = groups.flatMap(g => {
    const keep = g[0];
    return g.slice(1).filter(id => dist(store.doc.nodes.get(keep)!, store.doc.nodes.get(id)!) < 0.2).map(id => [keep, id] as [number, number]);
  });
  const total = pairs.length;
  if (!total) return msg('Найдены близкие узлы, но ни одна пара не совпадает достаточно точно (< 0,2 м). Объединение не выполнено во избежание искажения геометрии.');
  if (!confirm(`Найдено ${groups.length} групп дублирующихся узлов. Будет объединено до ${total} узлов. Продолжить?`)) return;
  const err = store.tryCommit(d => {
    for (const [keep, remove] of pairs) if (d.nodes.has(keep) && d.nodes.has(remove)) {
      const e = ops.mergeNodes(d, keep, remove); if (e) return e;
    }
    return null;
  });
  if (err) return msg(err);
  runValidation(); msg(`Автоисправление завершено: объединено ${total} пар практически совпадающих узлов. Проверьте результат на карте.`);
}

interface Stats {
  file: string; date: string; nodes: number; ways: number; relations: number; roads: number; lengthKm: number;
  tramWays: number; tramKm: number;
  oneway: number; bridges: number; tunnels: number; signalsAtJunction: number; signalsOffJunction: number; crossings: number;
  lanesMissing: number; maxspeedMissing: number; peakSet: number; components: number; largestPct: number;
  byClass: { key: string; label: string; count: number; km: number }[];
  issues: { errors: number; warnings: number; byKind: { kind: string; label: string; severity: string; count: number }[] };
}
function collectStats(): Stats {
  const d = store.doc, DRIVE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service']);
  const roads = [...d.ways.values()].filter(w => DRIVE.has(w.tags.highway));
  const trams = [...d.ways.values()].filter(w => !w.tags.highway && w.tags.railway === 'tram');
  const count = (fn: (w: typeof roads[number]) => boolean) => roads.filter(fn).length;
  const len = (w: typeof roads[number]) => { let m = 0; for (let i = 1; i < w.nodes.length; i++) { const a = d.nodes.get(w.nodes[i - 1]), b = d.nodes.get(w.nodes[i]); if (a && b) m += dist(a, b); } return m; };
  const parent = new Map<number, number>();
  const find = (x: number): number => { const p = parent.get(x); if (p === undefined || p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const w of roads) for (const id of w.nodes) if (!parent.has(id)) parent.set(id, id);
  for (const w of roads) for (let i = 0; i < w.nodes.length - 1; i++) { const a = find(w.nodes[i]), b = find(w.nodes[i + 1]); if (a !== b) parent.set(a, b); }
  const comps = new Map<number, number>();
  for (const id of parent.keys()) { const r = find(id); comps.set(r, (comps.get(r) ?? 0) + 1); }
  const sig = signalStats(d);
  const cls = new Map<string, { count: number; m: number }>();
  let total = 0;
  for (const w of roads) { const k = classKey(w.tags), l = len(w), c = cls.get(k) ?? { count: 0, m: 0 }; c.count++; c.m += l; cls.set(k, c); total += l; }
  const real = issues.filter(i => i.severity !== 'info');
  const kinds = new Map<string, { severity: string; count: number }>();
  for (const i of real) { const k = kinds.get(i.kind) ?? { severity: i.severity, count: 0 }; k.count++; if (i.severity === 'error') k.severity = 'error'; kinds.set(i.kind, k); }
  return {
    file: ($<HTMLInputElement>('fname').value.trim() || 'team1'), date: new Date().toLocaleString('ru-RU'),
    tramWays: trams.length, tramKm: Math.round(trams.reduce((m, w) => m + len(w), 0) / 10) / 100,
    nodes: d.nodes.size, ways: d.ways.size, relations: d.relations.size, roads: roads.length, lengthKm: Math.round(total / 10) / 100,
    oneway: count(w => onewayDir(w.tags) !== 0), bridges: count(w => !!w.tags.bridge && w.tags.bridge !== 'no'), tunnels: count(w => !!w.tags.tunnel && w.tags.tunnel !== 'no'),
    signalsAtJunction: sig.atJunction, signalsOffJunction: sig.offJunction, crossings: sig.crossSignal + sig.crossPlain,
    lanesMissing: count(w => !w.tags.lanes), maxspeedMissing: count(w => !w.tags.maxspeed), peakSet: count(w => !!w.tags[PEAK_TAG]),
    components: comps.size, largestPct: parent.size ? Math.round(Math.max(0, ...comps.values()) / parent.size * 100) : 0,
    byClass: CLASS_CATS.filter(c => cls.has(c.key)).map(c => ({ key: c.key, label: c.label, count: cls.get(c.key)!.count, km: Math.round(cls.get(c.key)!.m / 10) / 100 })),
    issues: { errors: real.filter(i => i.severity === 'error').length, warnings: real.filter(i => i.severity === 'warn').length,
      byKind: [...kinds].map(([kind, v]) => ({ kind, label: KIND_RU[kind] ?? kind, severity: v.severity, count: v.count })).sort((x, y) => y.count - x.count) },
  };
}
function statsText(s: Stats): string {
  const L = [
    `Статистика дорожной сети: ${s.file}`, `Сформировано: ${s.date}`, '',
    `Узлы: ${s.nodes} · рёбра (все way): ${s.ways} · отношения: ${s.relations}`,
    `Автомобильные рёбра: ${s.roads} · общая длина: ${s.lengthKm} км`,
    `Трамвайные пути: ${s.tramWays} рёбер · ${s.tramKm} км`,
    `Односторонние: ${s.oneway} · мосты: ${s.bridges} · тоннели: ${s.tunnels}`,
    `Светофоры: ${s.signalsAtJunction} на перекрёстках, ${s.signalsOffJunction} вне перекрёстков · пешеходные переходы: ${s.crossings}`,
    `Полосы не заданы: ${s.lanesMissing} · maxspeed не задан: ${s.maxspeedMissing} · время пика задано: ${s.peakSet}`,
    `Компонент связности: ${s.components} · узлов в крупнейшей: ${s.largestPct}%`, '',
    'По классам дорог (рёбер · км):', ...s.byClass.map(c => `  ${c.label}: ${c.count} · ${c.km}`), '',
    `Проверка графа: ошибок ${s.issues.errors}, предупреждений ${s.issues.warnings}`,
    ...s.issues.byKind.map(k => `  ${k.severity === 'error' ? 'ОШИБКА' : 'предупр.'} · ${k.label}: ${k.count}`),
  ];
  return L.join('\n');
}
function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: type + ';charset=utf-8' })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function showStats() {
  issues = validate(store.doc);
  const st = collectStats(), text = statsText(st);
  $('statsText').textContent = text;
  const base = (st.file.replace(/[^\w.-]/g, '_').replace(/\.osm$/i, '') || 'team1') + '_stats';
  $('statsTxt').onclick = () => { download(base + '.txt', text, 'text/plain'); msg(`Статистика сохранена: ${base}.txt`); };
  $('statsJson').onclick = () => { download(base + '.json', JSON.stringify(st, null, 2), 'application/json'); msg(`Статистика сохранена: ${base}.json`); };
  $('statsCsv').onclick = () => {
    const rows = [['показатель', 'значение'], ['узлы', st.nodes], ['рёбра', st.ways], ['отношения', st.relations], ['автомобильные рёбра', st.roads], ['длина, км', st.lengthKm],
      ['трамвайные рёбра', st.tramWays], ['трамвай, км', st.tramKm], ['односторонние', st.oneway], ['мосты', st.bridges], ['тоннели', st.tunnels], ['светофоры на перекрёстках', st.signalsAtJunction], ['светофоры вне перекрёстков', st.signalsOffJunction],
      ['пешеходные переходы', st.crossings], ['полосы не заданы', st.lanesMissing], ['maxspeed не задан', st.maxspeedMissing], ['время пика задано', st.peakSet],
      ['компонент связности', st.components], ['узлов в крупнейшей компоненте, %', st.largestPct], ['ошибок', st.issues.errors], ['предупреждений', st.issues.warnings],
      [], ['класс', 'рёбер', 'км'], ...st.byClass.map(c => [c.label, c.count, c.km])];
    download(base + '.csv', rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\r\n'), 'text/csv'); msg(`Статистика сохранена: ${base}.csv`);
  };
  $<HTMLDialogElement>('statsDlg').showModal();
}

/** Читает настройки кольца из панели справа от кнопок режима. */
function readRingCfg() {
  const n = (id: string, def: number, lo: number, hi: number) => { const v = Math.round(Number($<HTMLInputElement>(id).value)); return Number.isFinite(v) && v >= lo && v <= hi ? v : def; };
  ringConfig = { radius: n('ringR', ringConfig.radius, 5, 100), segments: n('ringN', ringConfig.segments, 8, 48), lanes: n('ringL', ringConfig.lanes, 1, 6), speed: n('ringV', ringConfig.speed, 5, 130) };
  return ringConfig;
}
function ringShape(a: { lat: number; lng: number }, b: { lat: number; lng: number }, shift: boolean) {
  return shapeFromCorners({ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }, shift || $<HTMLInputElement>('ringCircle').checked);
}
/** Кольцо как эллипс в Paint: тянем рамку от угла к углу. Против часовой стрелки (правостороннее движение). */
function createRoundabout(lat: number, lon: number, rx: number, ry: number) {
  const { segments, lanes, speed } = readRingCfg();
  const ids: number[] = [];
  store.commit(d => {
    for (const p of ellipsePoints(lat, lon, rx, ry, segments)) ids.push(ops.addNode(d, p.lat, p.lon));
    const wayId = ops.addWay(d, [...ids, ids[0]], { highway: 'residential', junction: 'roundabout', oneway: 'yes', lanes: String(lanes), maxspeed: String(speed) });
    store.sel = [{ type: 'way', id: wayId }];
  });
  setMode('select');
  msg(`Кольцо создано: ${Math.round(rx * 2)}×${Math.round(ry * 2)} м, ${segments} сегментов. Подведите въезды и выезды инструментом «Ребро» (клик по кольцу присоединяет).`);
}

// ---------- карта ----------
const view = new MapView('map', {
  onClick: handleClick,
  onDblClick: () => {
    if (mode === 'area') finishArea();
    else if (mode === 'building') finishBuilding();
    else if (mode === 'draw') finishDraft();
    else if (mode === 'repair') finishRepair();
  },
  dragAllowed: id => mode === 'select' && (store.selNodes().includes(id) || store.selWays().some(w => store.doc.ways.get(w)?.nodes.includes(id))),
  onDragStart: () => { store.dragging = true; store.checkpoint(); },
  onDrag: (id, lat, lon) => {
    // O(1) изменение координат вместо обхода ВСЕХ дорог + полной перерисовки на каждом mousemove.
    const node = store.doc.nodes.get(id);
    if (!node) return;
    node.lat = lat; node.lon = lon;
    view.previewMovedNode(store.doc, id);
  },
  shapeAllowed: () => mode === 'ring',
  onShape: (phase, a, b, shift) => {
    const sh = ringShape(a, b, shift);
    const pts = ellipsePoints(sh.lat, sh.lon, Math.max(sh.rx, 0.5), Math.max(sh.ry, 0.5), 48);
    if (phase === 'move') { view.setDraftOnly([...pts, pts[0]].map(p => [p.lon, p.lat])); return; }
    view.setDraftOnly([]);
    if (sh.rx < 3 || sh.ry < 3) return msg('Кольцо слишком маленькое: тяните рамку от угла к углу (минимум 6 м)');
    createRoundabout(sh.lat, sh.lon, sh.rx, sh.ry);
  },
  onDragEnd: id => {
    const node = store.doc.nodes.get(id);

    if (!node) {
      store.dragging = false;
      return;
    }

    // Ищем здания, которым принадлежит перемещённая вершина.
    const affectedBuildings = [...store.doc.ways.values()]
      .filter(w =>
        w.tags.building &&
        w.tags.building !== 'no' &&
        w.nodes.includes(id)
      );

    // Проверяем каждый изменённый контур.
    for (const building of affectedBuildings) {
      const points = building.nodes
        .map(nodeId => store.doc.nodes.get(nodeId))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map(n => ({
          lat: n.lat,
          lon: n.lon
        }));

      const error = validateBuildingPlacement(
        store.doc,
        points,
        building.id
      );

      if (error) {
        // checkpoint был создан в onDragStart,
        // поэтому undo возвращает исходные координаты.
        store.undo();

        store.dragging = false;
        msg(`Перемещение отменено: ${error}`);
        return;
      }
    }

    ops.moveNode(store.doc, id, node.lat, node.lon);

    store.dragging = false;
    store.notify();

    msg('Узел перемещён');
  },
  areaDragAllowed: id => {
    if (mode !== 'select' || !store.selWays().includes(id)) {
      return false;
    }

    const tags = store.doc.ways.get(id)?.tags ?? {};

    const isBuilding =
      !!tags.building &&
      tags.building !== 'no';

    return isArea(tags) || isBuilding;
  },
  onAreaStart: () => { store.dragging = true; store.checkpoint(); },
  onAreaMove: (id, dLat, dLon) => {
    const way = store.doc.ways.get(id);

    if (!way) return;

    const isBuilding =
      !!way.tags.building &&
      way.tags.building !== 'no';

    // Парковки перемещаются по старой логике.
    if (!isBuilding) {
      ops.moveWayBy(store.doc, id, dLat, dLon);
      store.notify();
      return;
    }

    // Сначала пробуем переместить здание.
    ops.moveWayBy(store.doc, id, dLat, dLon);

    const points = way.nodes
      .map(nodeId => store.doc.nodes.get(nodeId))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .map(n => ({
        lat: n.lat,
        lon: n.lon
      }));

    // Проверяем новое положение, исключая само здание.
    const error = validateBuildingPlacement(
      store.doc,
      points,
      id
    );

    if (error) {
      // Если положение недопустимо, отменяем только
      // последнее перемещение, а не весь drag.
      ops.moveWayBy(store.doc, id, -dLat, -dLon);

      msg(`Перемещение остановлено: ${error}`);
      return;
    }

    store.notify();
  },
  onAreaEnd: () => {
    store.dragging = false;
    store.notify();

    const selectedBuilding = store.selWays().some(id => {
      const tags = store.doc.ways.get(id)?.tags ?? {};
      return !!tags.building && tags.building !== 'no';
    });

    msg(
      selectedBuilding
        ? 'Здание перемещено'
        : 'Область перемещена'
    );
  },
  boxAllowed: () => mode === 'select',
  onBox: (ways, nodes, additive) => {
    const picked = [...ways.map(id => ({ type: 'way' as const, id })), ...nodes.map(id => ({ type: 'node' as const, id }))].filter(p => (p.type === 'way' ? store.doc.ways : store.doc.nodes).has(p.id));
    const seen = new Set((additive ? store.sel : []).map(s => s.type + s.id));
    store.setSel([...(additive ? store.sel : []), ...picked.filter(p => !seen.has(p.type + p.id))]);
    msg(`Рамкой добавлено: ${picked.length}. Выбрано всего: ${store.sel.length}`);
  },
});

function handleClick(e: ClickInfo) {
  if (e.buildingId !== undefined) {
    store.setSel([
      { type: 'way', id: e.buildingId }
    ]);
    return;
  }
  const doc = store.doc;
  switch (mode) {
    case 'select': {
      const wid = e.wayId ?? e.areaId; // дорога/тротуар важнее области под ними
      const hit = e.nodeId !== undefined ? { type: 'node' as const, id: e.nodeId } : wid !== undefined ? { type: 'way' as const, id: wid } : null;
      const add = e.shift || e.ctrl || multi;
      if (!hit) { if (!add) store.setSel([]); return; }
      const has = store.sel.some(s => s.type === hit.type && s.id === hit.id);
      store.setSel(add ? (has ? store.sel.filter(s => !(s.type === hit.type && s.id === hit.id)) : [...store.sel, hit]) : [hit]);
      break;
    }
    case 'node':
      if (e.nodeId !== undefined) { store.setSel([{ type: 'node', id: e.nodeId }]); break; }
      store.commit(d => {
        const onWay = e.wayId ?? e.edgeId;
        const id = (onWay !== undefined ? ops.nodeOnWayAt(d, onWay, e.lat, e.lng) : null) ?? ops.addNode(d, e.lat, e.lng);
        store.sel = [{ type: 'node', id }];
      });
      break;
    case 'busstop': {
      let id = 0;

      store.commit(d => {
        id =
          e.nodeId ??
          (e.wayId !== undefined
            ? ops.nodeOnWayAt(d, e.wayId, e.lat, e.lng)
            : null) ??
          ops.addNode(d, e.lat, e.lng);

        const n = d.nodes.get(id)!;

        n.tags.highway = 'bus_stop';
        n.tags.public_transport = 'platform';
        n.tags.bus = 'yes';

        store.sel = [{ type: 'node', id }];
      });

      msg('Остановка общественного транспорта создана');
      break;
    }
    case 'draw': {
      const n = e.nodeId !== undefined ? doc.nodes.get(e.nodeId) : undefined;
      draft.push({ lat: n?.lat ?? e.lat, lon: n?.lon ?? e.lng, nodeId: e.nodeId, wayId: e.nodeId === undefined ? e.wayId : undefined });
      redraw(); msg(`Точек: ${draft.length}. Enter или двойной клик — завершить, Backspace — убрать последнюю точку, Esc — отмена`);
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
    case 'area':
      draft.push({ lat: e.lat, lon: e.lng });
      redraw(); msg(`Парковка: точек ${draft.length}. Enter или двойной клик — завершить (нужно минимум 3), Backspace — убрать последнюю точку, Esc — отмена`);
      break;
    case 'mark': handleMark(e); break;
    case 'repair': handleRepair(e); break;
    case 'ring': { const r = readRingCfg().radius; createRoundabout(e.lat, e.lng, r, r); break; }
    case 'merge':
      if (e.nodeId === undefined) return;
      if (pendingMerge === null) { pendingMerge = e.nodeId; msg('Первый узел выбран (он останется). Кликните по второму — он будет склеен с первым'); }
      else {
        const keep = pendingMerge, rem = e.nodeId; pendingMerge = null;
        msg(store.tryCommit(d => ops.mergeNodes(d, keep, rem)) ?? 'Узлы склеены');
      }
      break;
    case 'building':
      draft.push({
        lat: e.lat,
        lon: e.lng
      });

      redraw();

      msg(
        `Здание: добавлено вершин ${draft.length}. Enter — завершить, Backspace — отменить последнюю вершину`
      );

      break;
  }
}

/** Отменить последнюю поставленную точку незавершённого построения (ребро, парковка, участок, метка). true — было что отменять. */
function undoDraftPoint(): boolean {
  if (mode === 'draw' || mode === 'area' || mode === 'building') {
    if (!draft.length) return false;

    const removed = draft.pop();

    redraw();

    if (mode === 'draw') {
      msg(`Последний узел ребра отменён. Осталось точек: ${draft.length}`);
    } else if (mode === 'building') {
      msg(`Последняя вершина здания отменена. Осталось точек: ${draft.length}`);
    } else {
      msg(`Последняя точка отменена. Осталось точек: ${draft.length}`);
    }

    return true;
  }
  if (mode === 'repair') {
    if (repair.mid.length) repair.mid.pop();
    else if (repair.b) repair.b = undefined;
    else if (repair.a) repair.a = undefined;
    else return false;
    syncRepairDraft(); msg('Последняя точка участка отменена'); return true;
  }
  if (mode === 'mark' && markStart) { markStart = null; draft = []; redraw(); msg('Первая точка участка отменена'); return true; }
  return false;
}
function finishArea() {
  const pts = draft.map(p => ({ lat: p.lat, lon: p.lon })); draft = [];
  let id: number | null = null;
  store.commit(d => { id = ops.addPolygon(d, pts, { amenity: 'parking', parking: 'surface' }); if (id !== null) store.sel = [{ type: 'way', id }]; });
  if (id === null) { redraw(); return msg('Для парковки нужно минимум 3 разные точки'); }
  setMode('select');
  msg('Парковка создана. Тяните вершины или всю область; новую вершину добавляет режим «Узел» (N) кликом по контуру');
}

function finishBuilding() {
  const pts = draft.map(p => ({
    lat: p.lat,
    lon: p.lon
  }));

  if (pts.length < 3) {
    return msg('Для здания необходимо минимум 3 вершины');
  }

  const rawHeight = prompt(
    'Введите высоту здания в метрах:',
    '9'
  );

  if (rawHeight === null) return;

  const height = Number(rawHeight);

  if (!Number.isFinite(height) || height <= 0 || height > 500) {
    return msg('Высота должна быть числом от 0 до 500 метров');
  }

  const placementError = validateBuildingPlacement(
  store.doc,
  pts
);

if (placementError) {
  return msg(placementError);
}

  let id: number | null = null;

  store.commit(d => {
    id = ops.addPolygon(
      d,
      pts,
      {
        building: 'yes',
        height: String(height)
      }
    );

    if (id !== null) {
      store.sel = [
        {
          type: 'way',
          id
        }
      ];
    }
  });

  draft = [];

  if (id === null) {
    redraw();
    return msg('Не удалось создать здание');
  }

  setMode('select');

  msg(
    `Здание создано. Высота: ${height} м`
  );
}
function finishDraft() {
  const pts = draft.filter(
    (p, i) =>
      i === 0 ||
      !(
        Math.abs(p.lat - draft[i - 1].lat) < 1e-9 &&
        Math.abs(p.lon - draft[i - 1].lon) < 1e-9
      )
  );

  const tags = ops.templateTags($<HTMLSelectElement>('tpl').value);

  // Проверяем автомобильные и железнодорожные линии
  if (
    (tags.highway || tags.railway) &&
    lineCrossesBuilding(store.doc, pts)
  ) {
    redraw();
    return msg(
      'Нельзя проложить дорогу через здание. Измените траекторию.'
    );
  }

  draft = [];
  if (pts.length < 2) { redraw(); return; }
  store.commit(d => {
    const raw = pts.map(p => p.nodeId ?? (p.wayId !== undefined ? ops.nodeOnWayAt(d, p.wayId, p.lat, p.lon) : null) ?? ops.addNode(d, p.lat, p.lon));
    const ids = raw.filter((x, i) => i === 0 || x !== raw[i - 1]);
    if (ids.length > 1) store.sel = [{ type: 'way', id: ops.addWay(d, ids, Object.keys(tags).length ? tags : { highway: 'residential' }) }];
  });
  msg('Ребро создано');
}

function setMode(m: Mode) {
  // Инструменты рисования должны работать в обычном режиме со своими черновиками.
  if (comparisonOn && m !== 'select') stopComparison();
  mode = m; draft = []; pendingMerge = null; markStart = null; repair = { mid: [] };
  $('ringbar').hidden = m !== 'ring'; $('ring').classList.toggle('on', m === 'ring');
  $('markbar').hidden = m !== 'mark'; if (m === 'mark') buildMarkControl();
  document.querySelectorAll<HTMLButtonElement>('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  view.setCursor(m === 'select' ? '' : 'crosshair'); redraw();
  msg({ select: 'Выбор: клик по ребру/узлу, перетаскивание узлов выбранного ребра', node: 'Узел: клик по карте или по ребру (вставка узла-перекрёстка)', busstop: 'Остановка ОТ: кликните по карте или по дороге, чтобы разместить остановку', building: 'Здание: кликайте по карте, чтобы задать углы здания. Enter — завершить', draw: 'Ребро: кликайте точки, клик по узлу/ребру присоединяет к сети', split: 'Разрезать: клик по узлу или точке на ребре', merge: 'Склейка: выберите два узла подряд', mark: curType().hint, repair: 'Участок: кликните начало и конец на линии, затем новую форму, Enter', area: 'Парковка: кликайте углы области, Enter или двойной клик — завершить (минимум 3 точки)', ring: 'Кольцо: зажмите кнопку и тяните рамку от угла к углу (как эллипс в Paint). Shift — ровный круг. Просто клик — кольцо радиуса из поля «R»' }[m]);
}

function addBusStopLegend() {
  const legend = $('legend');

  // Не добавляем повторно при каждой перерисовке
  if (legend.querySelector('[data-legend-busstop]')) return;

  const item = document.createElement('div');
  item.dataset.legendBusstop = 'true';

  item.style.display = 'flex';
  item.style.alignItems = 'center';
  item.style.gap = '7px';
  item.style.marginTop = '5px';
  item.style.width = '100%';
  item.style.boxSizing = 'border-box';

  // Иконка остановки
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;

  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);
  drawBusStopIcon(ctx);

  const icon = document.createElement('img');
  icon.src = canvas.toDataURL();
  icon.style.width = '28px';
  icon.style.height = '28px';

  // Название
  const label = document.createElement('span');
  label.textContent = 'Автобусная остановка';

  // Количество справа
  const count = document.createElement('span');

  const busStopsCount = [...store.doc.nodes.values()].filter(
    n => n.tags.highway === 'bus_stop'
  ).length;

  count.textContent = String(busStopsCount);
  count.style.marginLeft = 'auto';
  count.style.fontWeight = '';
  count.style.textAlign = 'right';

  item.append(icon, label, count);
  legend.appendChild(item);
}

// ---------- валидация и перерисовка ----------
function redraw() {
  const scope = selScope();
  const vis = filterIssues(issues, ifilter, scope);
  view.render(store.doc, store.sel, vis, draft.map(p => [p.lon, p.lat]));
  if (comparisonOn) refreshComparison();
  view.setLabels(streetLabels());
  renderProps($('props'), store, actions, issues);
  renderIssues($('issues'), issues, actions, ifilter, f => { ifilter = f; redraw(); }, scope);
  renderLegend($('legend'), store.doc, cmode, hl, pickLegend);
  $<HTMLButtonElement>('undo').disabled = !store.canUndo(); $<HTMLButtonElement>('redo').disabled = !store.canRedo();
  $<HTMLButtonElement>('compare').disabled = !store.original;
}
/** Названия улиц выбранных рёбер: одна подпись на название, у середины самого длинного ребра. */
function streetLabels(): { lat: number; lon: number; text: string }[] {
  const best = new Map<string, { n: number; lat: number; lon: number }>();
  for (const id of store.selWays()) {
    const w = store.doc.ways.get(id); const name = w?.tags.name || w?.tags.ref; if (!w || !name) continue;
    const mid = store.doc.nodes.get(w.nodes[Math.floor(w.nodes.length / 2)]); if (!mid) continue;
    const cur = best.get(name); if (!cur || w.nodes.length > cur.n) best.set(name, { n: w.nodes.length, lat: mid.lat, lon: mid.lon });
  }
  return [...best].slice(0, 12).map(([text, v]) => ({ text, lat: v.lat, lon: v.lon }));
}
/** Замечания выделения (когда включён фильтр «Только выделенное»), иначе null = без ограничения. */
function selScope() { return ifilter.selOnly ? issuesFor(issues, store.doc, store.selWays(), store.selNodes()) : null; }
function setLegendVisible(on: boolean) {
  legendWanted = on;
  $('legend').hidden = !on || comparisonOn; $('legtoggle').textContent = on ? '✕ Скрыть легенду' : '☰ Легенда'; $('legtoggle').classList.toggle('closed', !on);
  try { localStorage.setItem('legend', on ? '1' : '0'); } catch { /* ignore */ }
}
// ---------- поиск улицы ----------
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
const nameOf = (t: Record<string, string>) => t.name || '';
function streetNames(q: string): [string, number][] {
  const n = norm(q), m = new Map<string, number>();
  for (const w of store.doc.ways.values()) if (w.tags.highway && nameOf(w.tags) && (!n || norm(nameOf(w.tags)).includes(n))) m.set(nameOf(w.tags), (m.get(nameOf(w.tags)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 40);
}
function searchStreet(q: string) {
  const n = norm(q); if (!n) return msg('Введите название улицы');
  const all = [...store.doc.ways.values()].filter(w => w.tags.highway && nameOf(w.tags));
  const exact = all.filter(w => norm(nameOf(w.tags)) === n);
  const hit = exact.length ? exact : all.filter(w => norm(nameOf(w.tags)).includes(n));
  if (!hit.length) return msg(`Улица «${q}» не найдена: проверьте написание (ищется по тегу name)`);
  if (mode !== 'select') setMode('select');
  store.setSel(hit.map(w => ({ type: 'way' as const, id: w.id })));
  const pts: [number, number][] = []; let len = 0;
  for (const w of hit) { let prev: { lat: number; lon: number } | undefined; for (const id of w.nodes) { const nd = store.doc.nodes.get(id); if (!nd) continue; pts.push([nd.lon, nd.lat]); if (prev) len += dist(prev, nd); prev = nd; } }
  view.fitToPoints(pts);
  const names = new Set(hit.map(w => nameOf(w.tags)));
  msg(`Найдено рёбер: ${hit.length}, длина ≈ ${Math.round(len)} м · ${names.size === 1 ? `«${[...names][0]}»` : `названий: ${names.size} (${[...names].slice(0, 4).join(', ')}${names.size > 4 ? '…' : ''})`}`);
}
function pickLegend(k: string | null) { hl = k; view.setHighlight(k); redraw(); }
function runValidation() {
  if (store.dragging) { clearTimeout(vTimer); vTimer = window.setTimeout(runValidation, 500); return; }
  issues = validate(store.doc); redraw();
}
store.onChange(() => {
  if (store.dragging) return;
  redraw(); clearTimeout(vTimer); vTimer = window.setTimeout(runValidation, 500);
});

function nextIssue() {
  const real = filterIssues(issues, ifilter, selScope()); if (!real.length) return msg('Ошибок нет (с учётом фильтра)');
  issueIdx = (issueIdx + 1) % real.length; actions.focusIssue(real[issueIdx]);
}

// ---------- файлы ----------
async function openFile(f: File) {
  try {
    const doc = parseOsm(await f.text());
    stopComparison();
    store.load(doc, f.name); view.fitToDoc(doc); runValidation();
    msg(`Загружено: ${f.name} — узлов ${doc.nodes.size}, рёбер ${doc.ways.size}, отношений ${doc.relations.size}`);
  } catch (e) { alert('Не удалось открыть файл: ' + (e as Error).message); }
}
/** Пересчёт цветного сравнения только после реальной правки, а не при выборе объектов. */
function refreshComparison() {
  if (!comparisonOn || !store.original || comparedRevision === store.revision) return;
  const report = diffDocs(store.original, store.doc);
  view.setComparison(store.original, store.doc, report);
  comparedRevision = store.revision;
  const changedNodes = report.counts.node;
  const changedWays = report.counts.way;
  $('compareCounts').textContent = `Узлы: +${changedNodes.added} / −${changedNodes.removed} / ~${changedNodes.modified}. ` +
    `Рёбра: +${changedWays.added} / −${changedWays.removed} / ~${changedWays.modified}.`;
}

function syncComparisonUI() {
  const b = $('compare');
  b.textContent = comparisonOn ? 'Вернуться к редактору' : 'Сравнить с исходным';
  b.classList.toggle('on', comparisonOn);
  $('comparePanel').hidden = !comparisonOn;
  $('legend').hidden = comparisonOn || !legendWanted;
  $('legtoggle').hidden = comparisonOn;
}
function stopComparison() {
  if (comparisonOn) view.clearComparison();
  comparisonOn = false;
  comparedRevision = -1;
  syncComparisonUI();
}
function toggleComparison() {
  if (comparisonOn) { stopComparison(); redraw(); msg('Режим сравнения выключен'); return; }
  if (!store.original) return msg('Сначала откройте исходный .osm-файл');
  comparisonOn = true;
  comparedRevision = -1;
  refreshComparison();
  $('compareFile').textContent = `Исходный: ${store.originalName || 'OSM'}`;
  syncComparisonUI();
  msg('Сравнение с исходным файлом: серый — без изменений, зелёный — добавлено, красный — удалено, синий — изменено');
}

/** Отчёт в стиле контроля версий: сравнение ВСЕГДА с моментом открытия файла,
 * а не с последним сохранением, Undo или предыдущим сравнением. */
function showDiffReport() {
  const original = store.original;
  if (!original) return msg('Сначала откройте исходный .osm-файл');
  const report = diffDocs(original, store.doc);
  const types = [
    ['node', 'Узлы'], ['way', 'Рёбра'], ['relation', 'Отношения'],
  ] as const;
  $('diffName').textContent = `Исходный файл: ${store.originalName || 'OSM'} · Сравнение с текущим состоянием редактора`;
  const summary = $('diffSummary'); summary.replaceChildren();
  for (const [type, label] of types) {
    const box = document.createElement('div'); box.className = 'diff-count';
    const heading = document.createElement('b'); heading.textContent = label;
    const line = document.createElement('span');
    const c = report.counts[type]; line.textContent = `Добавлено: ${c.added} · Удалено: ${c.removed} · Изменено: ${c.modified}`;
    box.append(heading, line); summary.append(box);
  }
  const list = $('diffList'); list.replaceChildren();
  if (!report.changes.length) list.textContent = 'Изменений относительно исходного файла нет.';
  else {
    const fragment = document.createDocumentFragment();
    for (const change of report.changes.slice(0, 300)) {
      const details = document.createElement('details'); details.className = 'diff-item';
      const title = document.createElement('summary');
      const verb = change.kind === 'added' ? '+ Добавлено' : change.kind === 'removed' ? '− Удалено' : '≈ Изменено';
      title.className = change.kind === 'added' ? 'diff-add' : change.kind === 'removed' ? 'diff-remove' : 'diff-mod';
      title.textContent = `${verb}: ${changeTitle(change)}`; details.append(title);
      if (change.details.length) {
        const ul = document.createElement('ul');
        for (const description of change.details) { const li = document.createElement('li'); li.textContent = description; ul.append(li); }
        details.append(ul);
      }
      fragment.append(details);
    }
    if (report.changes.length > 300) {
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = `Показаны первые 300 из ${report.changes.length} изменений. Полный список — в JSON-отчёте.`;
      fragment.append(p);
    }
    list.append(fragment);
  }
  $('diffJson').onclick = () => {
    const name = (store.originalName || 'roads.osm').replace(/\.osm$|\.xml$/i, '').replace(/[^\p{L}\p{N}_.-]/gu, '_');
    download(`${name}_changes.json`, JSON.stringify({ source: store.originalName, generatedAt: new Date().toISOString(), ...report }, null, 2), 'application/json');
  };
  $<HTMLDialogElement>('diffDlg').showModal();
}

function closeDropdowns(except?: HTMLElement | null) {
  document.querySelectorAll<HTMLDetailsElement>('details[open]')
    .forEach(menu => {
      if (except && menu.contains(except)) return;
      menu.open = false;
    });
}
document.addEventListener('click', e => {
  const target = e.target as HTMLElement;

  // Клик внутри любого раскрытого меню — не закрываем его
  const menu = target.closest('details');

  if (menu) {
    return;
  }
  closeDropdowns();
});

document.addEventListener('toggle', e => {
  const current = e.target as HTMLDetailsElement;

  if (!(current instanceof HTMLDetailsElement) || !current.open) return;

  document.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => {
    if (menu !== current) {
      menu.removeAttribute('open');
    }
  });
}, true);

document.addEventListener('change', e => {
  const target = e.target as HTMLElement;

  // Изменение параметров внутри меню не закрывает его
  if (target.closest('details')) {
    return;
  }
});
function save() {
  issues = validate(store.doc); redraw();
  const c = countBy(issues);
  const conn = issues.find(i => i.kind === 'connectivity')?.msg ?? '';
  if (c.error) {
    alert(`Сохранение заблокировано: найдено критичных ошибок — ${c.error}.\n${conn}\nИсправьте ошибки и повторите экспорт.`);
    const first = issues.find(i => i.severity === 'error'); if (first) actions.focusIssue(first);
    return;
  }
  if (c.warn && !confirm(`Найдены предупреждения: ${c.warn}. Они не блокируют экспорт, но могут повлиять на симуляцию.\n${conn}\n\nСохранить файл всё равно?`)) return;
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
  cmode = m; hl = null; $<HTMLSelectElement>('cmode').value = m; view.setColorMode(m);
  renderLegend($('legend'), store.doc, m, hl, pickLegend);
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
$('ring').onclick = () => setMode(mode === 'ring' ? 'select' : 'ring');
$('autofix').onclick = autoMergeExactDuplicates;
$('stats').onclick = showStats;
$('compare').onclick = toggleComparison;
$('compareClose').onclick = () => { stopComparison(); redraw(); msg('Режим сравнения выключен'); };
$('compareDetails').onclick = showDiffReport;
$('undo').onclick = () => { if (!undoDraftPoint()) store.undo(); }; $('redo').onclick = () => store.redo();
document.querySelectorAll<HTMLButtonElement>('#modes button').forEach(b => (b.onclick = () => setMode(b.dataset.mode as Mode)));
$<HTMLSelectElement>('base').onchange = e => view.setBase((e.target as HTMLSelectElement).value as Base);
$<HTMLInputElement>('op').oninput = e => view.setOpacity(Number((e.target as HTMLInputElement).value));
$<HTMLInputElement>('tiles').onchange = e => { const v = (e.target as HTMLInputElement).value.trim(); if (v) { view.setCustomTiles(v); $<HTMLSelectElement>('base').value = 'custom'; } };
$('multi').onclick = () => { multi = !multi; $('multi').classList.toggle('on', multi); msg(multi ? 'Мульти: каждый клик по ребру/узлу добавляет или убирает его из выделения' : 'Мульти выключено'); };
const sInp = $<HTMLInputElement>('search');
sInp.oninput = () => { $('streetList').innerHTML = streetNames(sInp.value).map(([n, c]) => `<option value="${n.replace(/"/g, '&quot;')}" label="рёбер: ${c}">`).join(''); };
sInp.onkeydown = e => { if (e.key === 'Enter') { searchStreet(sInp.value); sInp.blur(); } e.stopPropagation(); };
$('searchBtn').onclick = () => searchStreet(sInp.value);
$('legtoggle').onclick = () => setLegendVisible(Boolean($('legend').hidden));
try { legendWanted = localStorage.getItem('legend') !== '0'; } catch { /* ignore */ }
setLegendVisible(legendWanted);
syncComparisonUI();
$('b3d').onclick = () => $('b3d').classList.toggle('on', view.toggle3D());
$('help').onclick = () => $<HTMLDialogElement>('helpDlg').showModal();
$('helpTbl').innerHTML = HELP.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files[0]; if (f) openFile(f); });
window.addEventListener('beforeunload', e => { if (store.dirty) e.preventDefault(); });

bindHotkeys({
  a: () => setMode('area'), t: () => setMode('mark'), u: () => setMode('repair'), l: actions.selectLine,
  v: () => setMode('select'), n: () => setMode('node'), w: () => setMode('draw'), x: () => setMode('split'), c: () => setMode('merge'),
  m: actions.mergeWays, r: actions.reverse, o: actions.toggleOneway, s: actions.signal, p: () => actions.crossing(false), b: actions.bridge, f: actions.smooth,
  'alt+c': actions.copyAttrs, 'alt+v': actions.pasteAttrs, delete: actions.del, backspace: () => { if (!undoDraftPoint()) actions.del(); }, e: nextIssue,
  k: cycleColorMode, '/': () => $<HTMLInputElement>('search').focus(), '.': () => $<HTMLInputElement>('search').focus(), g: () => $('legtoggle').click(), '3': () => $('b3d').click(), '?': () => $('help').click(),
  'ctrl+z': () => { if (!undoDraftPoint()) store.undo(); }, 'ctrl+shift+z': () => store.redo(), 'ctrl+y': () => store.redo(),
  'ctrl+s': save, 'ctrl+o': () => $('open').click(),
  enter: () => {
    if (mode === 'area') finishArea();
    else if (mode === 'building') finishBuilding();
    else if (mode === 'draw') finishDraft();
    else if (mode === 'repair') finishRepair();
  },
  escape: () => { if (hl) pickLegend(null); draft = []; pendingMerge = null; markStart = null; repair = { mid: [] }; store.setSel([]); redraw(); },
});

// Эксклюзивное раскрытие только пунктов главного меню
const mainMenus = document.querySelectorAll<HTMLDetailsElement>(
  '#mainMenu > details'
);

mainMenus.forEach(menu => {
  menu.addEventListener('toggle', () => {
    if (!menu.open) return;

    mainMenus.forEach(otherMenu => {
      if (otherMenu !== menu) {
        otherMenu.open = false;
      }
    });
  });
});
setMode('select');

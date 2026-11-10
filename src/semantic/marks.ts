// Правка «по смыслу»: пользователь указывает точки/участки линии и значение,
// движок сам режет рёбра, ставит теги и склеивает одинаковые куски обратно.
import type { Doc, Tags } from '../core/types.ts';
import { isRoad } from '../core/osm.ts';
import * as ops from '../tools/ops.ts';
import { dist } from '../core/geo.ts';
import { buildLines, lineOfWay, locate, pointAt, wayIdsOf } from './lines.ts';
import type { Line } from './lines.ts';
import { canonicalOneway, normalize } from './compile.ts';

export interface PointRef { wayId: number; lat: number; lon: number }
export interface Res { err?: string; msg?: string }
export type OnewaySpec = 'forward' | 'backward' | 'both'; // относительно направления «первая точка → вторая»
export interface Edit { tags?: Tags; oneway?: OnewaySpec }

const fail = (err: string): Res => ({ err });

/** Разрезать рёбра линии по узлу (если узел внутри ребра). */
function splitAtNode(doc: Doc, set: Set<number>, nodeId: number) {
  for (const id of [...set]) {
    const w = doc.ways.get(id); if (!w) continue;
    const i = w.nodes.indexOf(nodeId);
    if (i > 0 && i < w.nodes.length - 1 && w.nodes.indexOf(nodeId, i + 1) < 0) {
      const before = new Set(doc.ways.keys());
      if (ops.splitWay(doc, id, nodeId) === null) for (const k of doc.ways.keys()) if (!before.has(k)) set.add(k);
      return;
    }
  }
}
function findLine(doc: Doc, a: number, b: number, set: Set<number>): Line | null {
  return buildLines(doc).find(l => l.nodes.includes(a) && l.nodes.includes(b) && l.segs.some(s => set.has(s.wayId))) ?? null;
}
/** Привести точку клика к узлу линии (вставить узел, если нужно). */
function nodeFor(doc: Doc, l: Line, d: number): number | null {
  const p = pointAt(doc, l, d);
  return ops.nodeOnWayAt(doc, p.wayId, p.lat, p.lon);
}

/** Применить значение на участке между двумя точками одной линии. */
export function applyRange(doc: Doc, p1: PointRef, p2: PointRef, edit: Edit): Res {
  const l0 = lineOfWay(doc, p1.wayId); if (!l0) return fail('Линия не найдена');
  const a = locate(doc, l0, p1.lat, p1.lon), b = locate(doc, l0, p2.lat, p2.lon);
  if (b.d > 3) return fail('Вторая точка должна лежать на той же линии');
  if (Math.abs(a.dist - b.dist) < 1.5) return fail('Точки совпадают: укажите начало и конец участка');
  const pa = pointAt(doc, l0, a.dist), pb = pointAt(doc, l0, b.dist);
  const na = ops.nodeOnWayAt(doc, pa.wayId, pa.lat, pa.lon), nb = ops.nodeOnWayAt(doc, pb.wayId, pb.lat, pb.lon);
  if (na === null || nb === null) return fail('Не удалось поставить границу участка');
  const set = new Set(wayIdsOf(l0));
  splitAtNode(doc, set, na); splitAtNode(doc, set, nb);
  const l = findLine(doc, na, nb, set); if (!l) return fail('После разрезания линия потеряна');
  const ia = l.nodes.indexOf(na), ib = l.nodes.indexOf(nb);
  return applyToSegs(doc, l, Math.min(ia, ib), Math.max(ia, ib), ia < ib ? 1 : -1, edit);
}

/** Применить значение ко всей линии. Направление «вперёд» — по порядку узлов линии. */
export function applyWhole(doc: Doc, wayId: number, edit: Edit): Res {
  const l = lineOfWay(doc, wayId); if (!l) return fail('Линия не найдена');
  return applyToSegs(doc, l, 0, l.nodes.length - 1, 1, edit);
}

function applyToSegs(doc: Doc, l: Line, lo: number, hi: number, travel: 1 | -1, edit: Edit): Res {
  const ids: number[] = [];
  l.segs.forEach((s, k) => {
    if (l.segStart[k] >= lo && l.segStart[k + 1] <= hi) ids.push(s.wayId);
  });
  if (!ids.length) return fail('Участок не содержит рёбер');
  for (const id of ids) {
    const w = doc.ways.get(id)!, seg = l.segs.find(s => s.wayId === id)!;
    if (edit.tags) ops.applyTags(doc, [id], edit.tags);
    if (edit.oneway) {
      if (edit.oneway === 'both') { if (w.tags.junction !== 'roundabout') delete w.tags.oneway; delete w.tags['lanes:forward']; delete w.tags['lanes:backward']; }
      else {
        const orderVsTravel = (seg.reversed ? -1 : 1) * travel; // +1: порядок узлов ребра совпадает с выбранным направлением
        w.tags.oneway = (edit.oneway === 'forward' ? orderVsTravel : -orderVsTravel) === 1 ? 'yes' : '-1';
      }
      ops.touch(w);
    }
  }
  canonicalOneway(doc, ids);
  const merged = normalize(doc);
  return { msg: `Участок обработан: рёбер ${ids.length}${merged ? `, склеено ${merged}` : ''}` };
}

// ---------- переходы ----------
function writeCrossing(n: { tags: Tags; id: number; attrs: Record<string, string> }, signalized: boolean) {
  n.tags.highway = 'crossing';
  n.tags.crossing = signalized ? 'traffic_signals' : 'uncontrolled';
  if (signalized) n.tags['crossing:signals'] = 'yes'; else delete n.tags['crossing:signals'];
  ops.touch(n);
}

/** Поставить/изменить переход на уже существующем узле (выбранном вручную). */
export function setCrossing(doc: Doc, nodeId: number, signalized: boolean): Res {
  const n = doc.nodes.get(nodeId); if (!n) return fail('Узел не найден');
  if (n.tags.highway === 'traffic_signals') return fail('В этом узле светофор перекрёстка: выберите соседний узел или поставьте переход в стороне');
  if (![...doc.ways.values()].some(w => w.nodes.includes(nodeId))) return fail('Узел не принадлежит ни одной линии');
  writeCrossing(n, signalized);
  return { msg: signalized ? 'Переход: регулируемый' : 'Переход: нерегулируемый' };
}

/** Убрать переход с узла (сам узел остаётся в линии). */
export function removeCrossing(doc: Doc, nodeId: number): Res {
  const n = doc.nodes.get(nodeId); if (!n || n.tags.highway !== 'crossing') return fail('В этом узле нет перехода');
  delete n.tags.highway; delete n.tags.crossing; delete n.tags['crossing:signals'];
  ops.touch(n);
  return { msg: 'Переход убран' };
}

/**
 * Переход одним кликом по линии (дорога, тротуар, пешеходная линия — любое ребро с highway).
 * Не зависит от построения «линий»: узел вставляется прямо в кликнутое ребро.
 * Если рядом (≤ 3 м) уже есть переход, он просто переключается, а не дублируется.
 */
export function addCrossing(doc: Doc, p: PointRef, signalized: boolean): Res {
  const w = doc.ways.get(p.wayId);
  if (!w || !w.tags.highway) return fail('Кликните по дороге или тротуару');
  const near = ops.nearestOnWay(doc, p.wayId, p.lat, p.lon);
  if (!near) return fail('Не удалось найти точку на линии');
  for (const id of w.nodes) {
    const x = doc.nodes.get(id);
    if (x && x.tags.highway === 'crossing' && dist(x, near) <= 3) { writeCrossing(x, signalized); return { msg: signalized ? 'Переход переключён: регулируемый' : 'Переход переключён: нерегулируемый' }; }
  }
  const id = ops.nodeOnWayAt(doc, p.wayId, p.lat, p.lon); if (id === null) return fail('Не удалось поставить переход');
  const n = doc.nodes.get(id)!;
  if (n.tags.highway === 'traffic_signals') return fail('В этом узле уже светофор перекрёстка: кликните чуть в стороне от него (> 2 м)');
  writeCrossing(n, signalized);
  return { msg: signalized ? 'Переход: регулируемый' : 'Переход: нерегулируемый' };
}

// ---------- знаки приоритета ----------
export interface Cross { wayId: number; label: string; hw: string }
export interface Approach { nodeIdx: number; nodeId: number; dist: number; forward: boolean; others: Cross[] }

const RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
const rank = (hw: string) => { const i = RANK.indexOf(hw.replace('_link', '')); return i < 0 ? RANK.length : i; };

/** Ближайший к точке клика перекрёсток линии и список пересекающих дорог. */
export function findApproach(doc: Doc, p: PointRef): Approach | null {
  const l = lineOfWay(doc, p.wayId); if (!l) return null;
  const own = new Set(wayIdsOf(l)), loc = locate(doc, l, p.lat, p.lon);
  const lineOf = new Map<number, number>(); // ребро → номер линии: половинки одной дороги не считаем двумя
  buildLines(doc).forEach((x, i) => x.segs.forEach(s => lineOf.set(s.wayId, i)));
  let best: Approach | null = null;
  l.nodes.forEach((id, i) => {
    const others: Cross[] = [], seen = new Set<number>();
    for (const w of doc.ways.values()) {
      if (own.has(w.id) || !isRoad(w.tags) || !w.nodes.includes(id)) continue;
      const li = lineOf.get(w.id) ?? -w.id;
      if (seen.has(li)) continue; seen.add(li);
      others.push({ wayId: w.id, hw: w.tags.highway, label: `${w.tags.name ?? 'без названия'} (${w.tags.highway}, #${w.id})` });
    }
    if (!others.length) return;
    if (!best || Math.abs(l.cum[i] - loc.dist) < Math.abs(best.dist - loc.dist))
      best = { nodeIdx: i, nodeId: id, dist: l.cum[i], forward: l.cum[i] >= loc.dist, others };
  });
  return best;
}

/** «Здесь уступи»/«Стоп»: знак ставится на подходе к перекрёстку (за 5 м), направление вычисляется само. */
export function addSign(doc: Doc, p: PointRef, type: 'give_way' | 'stop', toWayId?: number): Res {
  const l = lineOfWay(doc, p.wayId); if (!l) return fail('Линия не найдена');
  const ap = findApproach(doc, p); if (!ap) return fail('На этой линии нет перекрёстков: знаку не у чего стоять');
  const to = toWayId === undefined ? ap.others[0] : ap.others.find(o => o.wayId === toWayId);
  if (!to) return fail('Выбранная дорога не проходит через ближайший перекрёсток');
  const i = ap.nodeIdx, gap = ap.forward ? (i > 0 ? l.cum[i] - l.cum[i - 1] : 0) : (i < l.nodes.length - 1 ? l.cum[i + 1] - l.cum[i] : 0);
  if (gap <= 0) return fail('У перекрёстка нет подхода по этой линии');
  const off = Math.min(5, gap / 2);
  const d = ap.forward ? ap.dist - off : ap.dist + off;
  const pt = pointAt(doc, l, d);
  const id = ops.nodeOnWayAt(doc, pt.wayId, pt.lat, pt.lon); if (id === null) return fail('Не удалось поставить знак');
  const seg = l.segs.find(s => s.wayId === pt.wayId)!;
  const travel = ap.forward ? 1 : -1;
  const n = doc.nodes.get(id)!;
  n.tags.highway = type;
  n.tags.direction = (seg.reversed ? -travel : travel) === 1 ? 'forward' : 'backward';
  n.tags.note = `${type === 'stop' ? 'Остановиться перед' : 'Уступить'}: ${to.label}`;
  ops.touch(n);
  const own = doc.ways.get(pt.wayId)!.tags.highway ?? '';
  const warn = rank(to.hw) > rank(own) ? ` Внимание: уступаем дороге более низкого класса (${to.hw} ниже ${own}).` : '';
  return { msg: `Знак поставлен (${n.tags.direction}).${warn}` };
}

// ---------- починка участка ----------
const TRACKED = ['crossing', 'give_way', 'stop', 'traffic_signals'];

/** Заменить участок линии между p1 и p2 новой геометрией mid (по порядку от p1 к p2). Атрибуты и подключения сохраняются. */
export function replaceSection(doc: Doc, p1: PointRef, p2: PointRef, mid: { lat: number; lon: number }[]): Res {
  const l0 = lineOfWay(doc, p1.wayId); if (!l0) return fail('Линия не найдена');
  const a = locate(doc, l0, p1.lat, p1.lon), b = locate(doc, l0, p2.lat, p2.lon);
  if (b.d > 3) return fail('Вторая точка должна лежать на той же линии');
  if (Math.abs(a.dist - b.dist) < 3) return fail('Участок слишком короткий');
  const pa = pointAt(doc, l0, a.dist), pb = pointAt(doc, l0, b.dist);
  const na = ops.nodeOnWayAt(doc, pa.wayId, pa.lat, pa.lon), nb = ops.nodeOnWayAt(doc, pb.wayId, pb.lat, pb.lon);
  if (na === null || nb === null) return fail('Не удалось поставить границы участка');
  const set = new Set(wayIdsOf(l0));
  splitAtNode(doc, set, na); splitAtNode(doc, set, nb);
  const l = findLine(doc, na, nb, set); if (!l) return fail('После разрезания линия потеряна');
  const ia = l.nodes.indexOf(na), ib = l.nodes.indexOf(nb), lo = Math.min(ia, ib), hi = Math.max(ia, ib);
  const rangeSegs = l.segs.map((s, k) => ({ s, k })).filter(x => l.segStart[x.k] >= lo && l.segStart[x.k + 1] <= hi);
  if (!rangeSegs.length) return fail('Участок не содержит рёбер');

  // шаблон тегов — от первого ребра участка, приведённого к направлению линии
  const first = doc.ways.get(rangeSegs[0].s.wayId)!;
  const tmpl = { id: 0, nodes: [...first.nodes], tags: { ...first.tags }, attrs: {} as Record<string, string> };
  if (rangeSegs[0].s.reversed) ops.flipKeepSemantics(tmpl);

  const inner = l.nodes.slice(lo + 1, hi);
  const lost = inner.filter(id => TRACKED.includes(doc.nodes.get(id)?.tags.highway ?? '')).length;
  const pts = ia < ib ? mid : [...mid].reverse(); // новая геометрия — в порядке линии
  const ids = [l.nodes[lo], ...pts.map(m => ops.addNode(doc, m.lat, m.lon)), l.nodes[hi]];
  const newId = ops.addWay(doc, ids, tmpl.tags);

  const oldIds = rangeSegs.map(x => x.s.wayId);
  for (const id of oldIds) ops.deleteWay(doc, id); // новое ребро уже держит границы, их не удалит

  // автосшивка: боковые улицы, которые держались за снесённую геометрию, переезжают на новую
  let stitched = 0;
  for (const nid of inner) {
    const nd = doc.nodes.get(nid); if (!nd) continue;
    const usedBy = [...doc.ways.values()].some(w => w.id !== newId && w.nodes.includes(nid));
    if (!usedBy) continue;
    const near = ops.nearestOnWay(doc, newId, nd.lat, nd.lon);
    if (!near || near.d > 25) continue;
    const k = ops.nodeOnWayAt(doc, newId, near.lat, near.lon);
    if (k !== null && k !== nid && ops.mergeNodes(doc, k, nid) === null) stitched++;
  }
  const merged = normalize(doc);
  const parts = [`Участок заменён (${oldIds.length} рёбер → 1)`];
  if (stitched) parts.push(`пристыковано боковых улиц: ${stitched}`);
  if (lost) parts.push(`потеряно меток на старом участке: ${lost}`);
  if (merged) parts.push(`склеено: ${merged}`);
  return { msg: parts.join(', ') };
}

// Слой «линий»: цепочки рёбер OSM, которые пользователь воспринимает как одну дорогу/тротуар.
// Линия строится на лету из документа (ничего не хранится отдельно, расхождения невозможны).
import type { Doc, OsmWay, Tags } from '../core/types.ts';
import { isUnderpass } from '../core/roadStyle.ts';
import { isRoad, onewayDir } from '../core/osm.ts';
import { isPed, isTram } from '../core/roadStyle.ts';
import { dist, projectOnSegment } from '../core/geo.ts';

export type LineKind = 'road' | 'sidewalk' | 'tram';
export interface LineSeg { wayId: number; reversed: boolean }
export interface Line {
  kind: LineKind;
  segs: LineSeg[];
  segStart: number[]; // segStart[k] — индекс узла, с которого начинается сегмент k; последний элемент — индекс последнего узла
  nodes: number[];
  cum: number[];      // расстояние от начала линии до каждого узла, м
  total: number;
}
export const kindOf = (t: Tags): LineKind | null => (isRoad(t) ? 'road' : isPed(t) ? 'sidewalk' : isTram(t) ? 'tram' : null);
const dirIn = (w: OsmWay, rev: boolean) => onewayDir(w.tags) * (rev ? -1 : 1);

interface Index { use: Map<number, number>; join: Map<string, string>; ways: Map<number, OsmWay> }
const key = (w: number, e: number) => `${w}:${e}`;

function outVec(doc: Doc, w: OsmWay, e: 0 | 1): [number, number] | null {
  const n = doc.nodes.get(e === 0 ? w.nodes[0] : w.nodes[w.nodes.length - 1]);
  const m = doc.nodes.get(e === 0 ? w.nodes[1] : w.nodes[w.nodes.length - 2]);
  if (!n || !m) return null;
  const k = Math.cos(n.lat * Math.PI / 180);
  return [(m.lon - n.lon) * k, m.lat - n.lat];
}
const deviation = (a: [number, number], b: [number, number]) => {
  const l = Math.hypot(...a) * Math.hypot(...b);
  if (!l) return 180;
  const c = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / l));
  return 180 - Math.acos(c) * 180 / Math.PI; // 0 = идеально прямо
};

function buildIndex(doc: Doc): Index {
  const use = new Map<number, number>(), ends = new Map<number, { w: OsmWay; e: 0 | 1 }[]>(), ways = new Map<number, OsmWay>();
  for (const w of doc.ways.values()) {
    if (!kindOf(w.tags) || w.nodes.length < 2) continue;
    ways.set(w.id, w);
    for (const id of new Set(w.nodes)) use.set(id, (use.get(id) ?? 0) + 1);
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) {
      for (const [id, e] of [[w.nodes[0], 0], [w.nodes[w.nodes.length - 1], 1]] as [number, 0 | 1][]) {
        if (!ends.has(id)) ends.set(id, []); ends.get(id)!.push({ w, e });
      }
    }
  }
  const join = new Map<string, string>();
  const ok = (a: { w: OsmWay; e: 0 | 1 }, b: { w: OsmWay; e: 0 | 1 }) => {
    if (a.w === b.w || kindOf(a.w.tags) !== kindOf(b.w.tags)) return false;
    const d1 = dirIn(a.w, a.e === 0), d2 = dirIn(b.w, b.e === 1); // a заходит в узел, b выходит из него
    return d1 === 0 || d2 === 0 || d1 === d2;
  };
  for (const [n, L] of ends) {
    if (L.length < 2) continue;
    const pairs: { i: number; j: number; dev: number }[] = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      if (!ok(L[i], L[j])) continue;
      if (use.get(n) === 2 && L.length === 2) { pairs.push({ i, j, dev: 0 }); continue; }
      const v1 = outVec(doc, L[i].w, L[i].e), v2 = outVec(doc, L[j].w, L[j].e);
      if (!v1 || !v2) continue;
      const dev = deviation(v1, v2);
      if (dev <= 35) pairs.push({ i, j, dev });
    }
    pairs.sort((x, y) => x.dev - y.dev);
    const taken = new Set<number>();
    for (const p of pairs) {
      if (taken.has(p.i) || taken.has(p.j)) continue;
      taken.add(p.i); taken.add(p.j);
      const a = key(L[p.i].w.id, L[p.i].e), b = key(L[p.j].w.id, L[p.j].e);
      join.set(a, b); join.set(b, a);
    }
  }
  return { use, join, ways };
}

function chain(doc: Doc, ix: Index, seed: OsmWay, visited: Set<number>): Line {
  const segs: LineSeg[] = [{ wayId: seed.id, reversed: false }];
  visited.add(seed.id);
  for (;;) { // вперёд
    const last = segs[segs.length - 1], p = join_(ix, key(last.wayId, last.reversed ? 0 : 1));
    if (!p || visited.has(p.w)) break;
    visited.add(p.w); segs.push({ wayId: p.w, reversed: p.e === 1 });
  }
  for (;;) { // назад
    const first = segs[0], p = join_(ix, key(first.wayId, first.reversed ? 1 : 0));
    if (!p || visited.has(p.w)) break;
    visited.add(p.w); segs.unshift({ wayId: p.w, reversed: p.e === 0 });
  }
  return assemble(doc, ix, segs);
}
function join_(ix: Index, k: string) {
  const v = ix.join.get(k); if (!v) return null;
  const [w, e] = v.split(':').map(Number); return { w, e };
}
function assemble(doc: Doc, ix: Index, segs: LineSeg[]): Line {
  const nodes: number[] = [], segStart: number[] = [];
  for (const s of segs) {
    const w = ix.ways.get(s.wayId)!; const ns = s.reversed ? [...w.nodes].reverse() : w.nodes;
    segStart.push(nodes.length ? nodes.length - 1 : 0);
    nodes.push(...(nodes.length ? ns.slice(1) : ns));
  }
  segStart.push(nodes.length - 1);
  const cum = [0];
  for (let i = 1; i < nodes.length; i++) {
    const a = doc.nodes.get(nodes[i - 1]), b = doc.nodes.get(nodes[i]);
    cum.push(cum[i - 1] + (a && b ? dist(a, b) : 0));
  }
  return { kind: kindOf(ix.ways.get(segs[0].wayId)!.tags)!, segs, segStart, nodes, cum, total: cum[cum.length - 1] };
}

export function buildLines(doc: Doc): Line[] {
  const ix = buildIndex(doc), visited = new Set<number>(), out: Line[] = [];
  for (const w of ix.ways.values()) if (!visited.has(w.id)) out.push(chain(doc, ix, w, visited));
  return out;
}
export function lineOfWay(doc: Doc, wayId: number): Line | null {
  const ix = buildIndex(doc), w = ix.ways.get(wayId);
  return w ? chain(doc, ix, w, new Set()) : null;
}
export const wayIdsOf = (l: Line) => l.segs.map(s => s.wayId);

/** Ближайшая к точке позиция на линии. dist — расстояние от начала линии. */
export function locate(doc: Doc, l: Line, lat: number, lon: number) {
  let best = { dist: 0, seg: 0, lat, lon, d: Infinity };
  for (let i = 0; i < l.nodes.length - 1; i++) {
    const a = doc.nodes.get(l.nodes[i]), b = doc.nodes.get(l.nodes[i + 1]); if (!a || !b) continue;
    const p = projectOnSegment({ lat, lon }, a, b);
    if (p.d < best.d) best = { dist: l.cum[i] + p.t * (l.cum[i + 1] - l.cum[i]), seg: i, lat: p.lat, lon: p.lon, d: p.d };
  }
  return best;
}
/** Точка на расстоянии d от начала линии и ребро, которому она принадлежит. */
export function pointAt(doc: Doc, l: Line, d: number) {
  const x = Math.max(0, Math.min(l.total, d));
  let i = 0; while (i < l.nodes.length - 2 && l.cum[i + 1] < x) i++;
  const a = doc.nodes.get(l.nodes[i])!, b = doc.nodes.get(l.nodes[i + 1])!;
  const span = l.cum[i + 1] - l.cum[i], t = span > 0 ? (x - l.cum[i]) / span : 0;
  let k = 0; while (k < l.segs.length - 1 && l.segStart[k + 1] <= i) k++;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, nodeSeg: i, segIdx: k, wayId: l.segs[k].wayId };
}

// ---------- чтение «меток» из тегов ----------
export interface Run { from: number; to: number; hw: string; maxspeed: string; lanes: string; surface: string; peak: string; ug: boolean; dir: 'both' | 'forward' | 'backward' }
export interface PointMark { dist: number; nodeId: number; type: 'crossing' | 'give_way' | 'stop' | 'signals'; label: string }

export function describeLine(doc: Doc, l: Line): { runs: Run[]; marks: PointMark[] } {
  const runs: Run[] = [];
  l.segs.forEach((s, k) => {
    const t = doc.ways.get(s.wayId)!.tags, d = dirIn(doc.ways.get(s.wayId)!, s.reversed);
    const r: Run = {
      from: l.cum[l.segStart[k]], to: l.cum[l.segStart[k + 1]], hw: t.highway ?? '', maxspeed: t.maxspeed ?? '',
      lanes: t.lanes ?? '', surface: t.surface ?? '', peak: t.peak_hours ?? '', ug: isUnderpass(t), dir: d === 0 ? 'both' : d === 1 ? 'forward' : 'backward',
    };
    const p = runs[runs.length - 1];
    if (p && p.hw === r.hw && p.maxspeed === r.maxspeed && p.lanes === r.lanes && p.surface === r.surface && p.peak === r.peak && p.ug === r.ug && p.dir === r.dir) p.to = r.to;
    else runs.push(r);
  });
  const marks: PointMark[] = [];
  l.nodes.forEach((id, i) => {
    const t = doc.nodes.get(id)?.tags; if (!t) return;
    if (t.highway === 'crossing') marks.push({ dist: l.cum[i], nodeId: id, type: 'crossing', label: t.crossing === 'traffic_signals' ? 'переход регулируемый' : 'переход нерегулируемый' });
    else if (t.highway === 'give_way') marks.push({ dist: l.cum[i], nodeId: id, type: 'give_way', label: 'знак «Уступи»' + (t.note ? ` (${t.note})` : '') });
    else if (t.highway === 'stop') marks.push({ dist: l.cum[i], nodeId: id, type: 'stop', label: 'знак «Стоп»' + (t.note ? ` (${t.note})` : '') });
    else if (t.highway === 'traffic_signals') marks.push({ dist: l.cum[i], nodeId: id, type: 'signals', label: 'светофор' });
  });
  return { runs, marks };
}

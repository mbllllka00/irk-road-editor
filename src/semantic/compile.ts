// Автоматика при экспорте: канонизация направления, склейка одинаковых рёбер, вычисление полос и разметки.
import type { Doc } from '../core/types.ts';
import { isRoad, onewayDir } from '../core/osm.ts';
import * as ops from '../tools/ops.ts';

export interface Report { merged: number; flipped: number; lanesDerived: number; markings: number; signsFixed: number }

/** oneway=-1 → порядок узлов по ходу движения и oneway=yes (так читают все три уровня). */
export function canonicalOneway(doc: Doc, wayIds?: number[]): number {
  let n = 0;
  for (const w of (wayIds ? wayIds.map(i => doc.ways.get(i)!).filter(Boolean) : doc.ways.values())) {
    if (w.tags.oneway === '-1' || w.tags.oneway === 'reverse') { ops.flipKeepSemantics(w); n++; }
  }
  return n;
}

/** Склеить подряд идущие рёбра с одинаковыми тегами (после правок по участкам их остаётся много). */
export function normalize(doc: Doc): number {
  const protectedWays = new Set<number>();
  for (const r of doc.relations.values()) if (r.tags.type === 'restriction')
    for (const m of r.members) if (m.type === 'way') protectedWays.add(m.ref);
  let total = 0;
  for (let pass = 0; pass < 100; pass++) {
    const use = new Map<number, number>(), ends = new Map<number, number[]>();
    for (const w of doc.ways.values()) {
      if (!w.tags.highway || w.nodes.length < 2) continue;
      for (const id of new Set(w.nodes)) use.set(id, (use.get(id) ?? 0) + 1);
      if (w.nodes[0] !== w.nodes[w.nodes.length - 1])
        for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) (ends.get(id) ?? ends.set(id, []).get(id)!).push(w.id);
    }
    const used = new Set<number>(); let merged = 0;
    for (const [n, ws] of ends) {
      if (use.get(n) !== 2 || ws.length !== 2 || ws[0] === ws[1]) continue;
      const [a, b] = ws;
      if (used.has(a) || used.has(b) || protectedWays.has(a) || protectedWays.has(b)) continue;
      const wa = doc.ways.get(a)!, wb = doc.ways.get(b)!;
      if (Object.keys(wa.tags).length !== Object.keys(wb.tags).length || Object.keys(wa.tags).some(k => wa.tags[k] !== wb.tags[k])) continue;
      if (doc.nodes.get(n) && Object.keys(doc.nodes.get(n)!.tags).some(k => ['highway', 'crossing'].includes(k))) continue; // метка в узле — не склеиваем
      if (ops.mergeWays(doc, a, b) === null) { used.add(a); used.add(b); merged++; }
    }
    total += merged;
    if (!merged) break;
  }
  return total;
}

/** Вычислить производные атрибуты из «смысла»: полосы по направлениям, разметку, направление знаков. */
export function derive(doc: Doc): Pick<Report, 'lanesDerived' | 'markings' | 'signsFixed'> {
  let lanesDerived = 0, markings = 0, signsFixed = 0;
  for (const w of doc.ways.values()) {
    if (!isRoad(w.tags)) continue;
    const t = w.tags, oneway = onewayDir(t) !== 0, n = parseInt(t.lanes);
    let changed = false;
    if (oneway) {
      for (const k of ['lanes:forward', 'lanes:backward', 'maxspeed:backward']) if (t[k] !== undefined) { delete t[k]; changed = true; }
    } else if (n >= 2 && n % 2 === 0 && t['lanes:forward'] === undefined && t['lanes:backward'] === undefined) {
      t['lanes:forward'] = t['lanes:backward'] = String(n / 2); lanesDerived++; changed = true;
    }
    if (!oneway && n >= 2 && t.lane_markings === undefined) { t.lane_markings = 'yes'; markings++; changed = true; }
    if (t.lanes === undefined && t.width && !isNaN(parseFloat(t.width))) {
      const l = Math.max(1, Math.floor(parseFloat(t.width) / 3)); t.lanes = String(l); lanesDerived++; changed = true;
    }
    if (changed) ops.touch(w);
  }
  for (const nd of doc.nodes.values()) {
    if ((nd.tags.highway === 'give_way' || nd.tags.highway === 'stop') && !nd.tags.direction) {
      nd.tags.direction = 'forward'; ops.touch(nd); signsFixed++;
    }
  }
  return { lanesDerived, markings, signsFixed };
}

/** Полный экспортный проход. Меняет переданный документ (передавайте копию). */
export function compileForExport(doc: Doc): Report {
  const flipped = canonicalOneway(doc);
  const merged = normalize(doc);
  return { merged, flipped, ...derive(doc) };
}

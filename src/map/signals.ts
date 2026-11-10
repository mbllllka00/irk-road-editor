// Светофоры и перекрёстки: чем является узел и сколько их.
import type { Doc } from '../core/types.ts';
import { isRoad } from '../core/osm.ts';

/** id узлов, в которых сходятся ≥ 2 разных автомобильных рёбер (или это конец/начало и внутренний узел другого ребра). */
export function junctionNodes(doc: Doc): Set<number> {
  const waysAt = new Map<number, Set<number>>();
  for (const w of doc.ways.values()) if (isRoad(w.tags)) for (const id of w.nodes) {
    let s = waysAt.get(id); if (!s) waysAt.set(id, s = new Set()); s.add(w.id);
  }
  const out = new Set<number>();
  for (const [id, s] of waysAt) if (s.size > 1) out.add(id);
  return out;
}

export interface SignalStats { atJunction: number; offJunction: number; crossSignal: number; crossPlain: number; plainJunctions: number }
export function signalStats(doc: Doc): SignalStats {
  const j = junctionNodes(doc);
  const r: SignalStats = { atJunction: 0, offJunction: 0, crossSignal: 0, crossPlain: 0, plainJunctions: 0 };
  for (const n of doc.nodes.values()) {
    if (n.tags.highway === 'traffic_signals') j.has(n.id) ? r.atJunction++ : r.offJunction++;
    else if (n.tags.highway === 'crossing') n.tags.crossing === 'traffic_signals' || n.tags['crossing:signals'] === 'yes' ? r.crossSignal++ : r.crossPlain++;
  }
  for (const id of j) { const n = doc.nodes.get(id); if (n && n.tags.highway !== 'traffic_signals') r.plainJunctions++; }
  return r;
}

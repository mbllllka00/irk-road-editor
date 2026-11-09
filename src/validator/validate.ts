// [P4] Валидатор графа УДС: чистая функция validate(doc) → Issue[].
import type { Doc, Issue, OsmWay } from '../core/types.ts';
import { isRoad, onewayDir } from '../core/osm.ts';
import { segIntersect } from '../core/geo.ts';
import { speedKmh } from '../core/roadStyle.ts';

type NewIssue = Omit<Issue, 'id'>;

/** Тарджан без рекурсии (на больших графах рекурсия переполнит стек). */
export function scc(adj: Map<number, number[]>): Map<number, number> {
  let idx = 0, c = 0;
  const index = new Map<number, number>(), low = new Map<number, number>(), comp = new Map<number, number>();
  const on = new Set<number>(), stack: number[] = [];
  for (const s of adj.keys()) {
    if (index.has(s)) continue;
    const work: [number, number][] = [[s, 0]];
    index.set(s, idx); low.set(s, idx); idx++; stack.push(s); on.add(s);
    while (work.length) {
      const top = work[work.length - 1], v = top[0], nb = adj.get(v) ?? [];
      if (top[1] < nb.length) {
        const w = nb[top[1]++];
        if (!index.has(w)) { index.set(w, idx); low.set(w, idx); idx++; stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p)!, low.get(v)!)); }
        if (low.get(v) === index.get(v)) { let w: number; do { w = stack.pop()!; on.delete(w); comp.set(w, c); } while (w !== v); c++; }
      }
    }
  }
  return comp;
}

export function validate(doc: Doc): Issue[] {
  const list: NewIssue[] = [];
  const roads = [...doc.ways.values()].filter(w => isRoad(w.tags));
  const pt = (w: OsmWay) => { for (const id of w.nodes) { const n = doc.nodes.get(id); if (n) return { lat: n.lat, lon: n.lon }; } return {}; };

  // 1. Битые ссылки и вырожденные рёбра
  for (const w of roads) {
    const miss = w.nodes.filter(id => !doc.nodes.has(id));
    if (miss.length) list.push({ severity: 'error', kind: 'missing-node', msg: `Ребро ссылается на несуществующие узлы (${miss.length})`, wayIds: [w.id], nodeIds: [], ...pt(w) });
    if (w.nodes.length < 2) list.push({ severity: 'error', kind: 'degenerate', msg: 'Ребро содержит меньше двух узлов', wayIds: [w.id], nodeIds: [], ...pt(w) });
  }

  // 2. Теги lanes / oneway / maxspeed
  for (const w of roads) {
    const t = w.tags, p = pt(w);
    if (t.lanes !== undefined && !/^[1-9]\d*$/.test(t.lanes))
      list.push({ severity: 'error', kind: 'lanes-format', msg: `lanes="${t.lanes}" — должно быть целое число ≥ 1`, wayIds: [w.id], nodeIds: [], ...p });
    const f = t['lanes:forward'], b = t['lanes:backward'];
    if (t.lanes && f && b && +f + +b !== +t.lanes && t.lanes !== undefined)
      list.push({ severity: 'warn', kind: 'lanes-sum', msg: `lanes:forward(${f}) + lanes:backward(${b}) ≠ lanes(${t.lanes})`, wayIds: [w.id], nodeIds: [], ...p });
    if (onewayDir(w.tags) !== 0 && (b || t['maxspeed:backward']))
      list.push({ severity: 'warn', kind: 'oneway-backward', msg: 'Одностороннее ребро содержит теги обратного направления', wayIds: [w.id], nodeIds: [], ...p });
    if (t.maxspeed && !/^\d+( ?(km\/h|mph))?$/.test(t.maxspeed) && !/^[A-Z]{2}:\w+$/.test(t.maxspeed) && !['walk', 'none'].includes(t.maxspeed))
      list.push({ severity: 'warn', kind: 'maxspeed-format', msg: `maxspeed="${t.maxspeed}" не распознаётся адаптерами`, wayIds: [w.id], nodeIds: [], ...p });
  }

  // 2b. Нереалистичные ограничения скорости
  for (const w of roads) {
    const v = speedKmh(w.tags);
    if (v !== null && (v < 5 || v > 130))
      list.push({ severity: 'warn', kind: 'maxspeed-range', msg: `maxspeed=${w.tags.maxspeed} (${v} км/ч) вне разумных пределов 5–130`, wayIds: [w.id], nodeIds: [], ...pt(w) });
  }

  // 3. Дубликаты узлов (разорванные перекрёстки) и подозрительно «склеенные» узлы
  const used = new Map<number, number>(); // nodeId → число сегментов
  for (const w of roads) for (let i = 0; i < w.nodes.length; i++) {
    const inc = (i > 0 ? 1 : 0) + (i < w.nodes.length - 1 ? 1 : 0);
    used.set(w.nodes[i], (used.get(w.nodes[i]) ?? 0) + inc);
  }
  const cells = new Map<string, number[]>();
  for (const id of used.keys()) {
    const n = doc.nodes.get(id); if (!n) continue;
    const key = `${n.lat.toFixed(5)},${n.lon.toFixed(5)}`;
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(id);
  }
  for (const ids of cells.values()) if (ids.length > 1) {
    const n = doc.nodes.get(ids[0])!;
    list.push({ severity: 'error', kind: 'duplicate-nodes', msg: `Дубликаты узлов в одной точке (${ids.length}): перекрёсток разорван — склейте узлы (C)`, wayIds: [], nodeIds: ids, lat: n.lat, lon: n.lon });
  }
  for (const [id, deg] of used) if (deg >= 8) {
    const n = doc.nodes.get(id); if (n)
      list.push({ severity: 'warn', kind: 'overmerged', msg: `В узле сходятся ${deg} сегментов — возможно, склеены два перекрёстка`, wayIds: [], nodeIds: [id], lat: n.lat, lon: n.lon });
  }

  // 4. Пересечения без общего узла
  const grid = new Map<string, number[]>();
  const segs: { w: OsmWay; a: number; b: number }[] = [];
  const CELL = 0.0005;
  for (const w of roads) for (let i = 0; i < w.nodes.length - 1; i++) {
    const A = doc.nodes.get(w.nodes[i]), B = doc.nodes.get(w.nodes[i + 1]); if (!A || !B) continue;
    const si = segs.push({ w, a: w.nodes[i], b: w.nodes[i + 1] }) - 1;
    for (let x = Math.floor(Math.min(A.lon, B.lon) / CELL); x <= Math.floor(Math.max(A.lon, B.lon) / CELL); x++)
      for (let y = Math.floor(Math.min(A.lat, B.lat) / CELL); y <= Math.floor(Math.max(A.lat, B.lat) / CELL); y++) {
        const k = `${x}:${y}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(si);
      }
  }
  const seen = new Set<string>();
  const level = (w: OsmWay) => (w.tags.bridge && w.tags.bridge !== 'no') || (w.tags.tunnel && w.tags.tunnel !== 'no') ? 'x' + w.id : w.tags.layer ?? '0';
  for (const arr of grid.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const s = segs[arr[i]], u = segs[arr[j]];
    if (s.w === u.w) continue;
    const key = Math.min(arr[i], arr[j]) + '|' + Math.max(arr[i], arr[j]);
    if (seen.has(key)) continue; seen.add(key);
    if (s.a === u.a || s.a === u.b || s.b === u.a || s.b === u.b) continue;
    if (level(s.w) !== level(u.w)) continue;
    const hit = segIntersect(doc.nodes.get(s.a)!, doc.nodes.get(s.b)!, doc.nodes.get(u.a)!, doc.nodes.get(u.b)!);
    if (hit) list.push({ severity: 'error', kind: 'crossing', msg: 'Дороги пересекаются без общего узла (нет перекрёстка). Вставьте узел (N) или задайте bridge/layer', wayIds: [s.w.id, u.w.id], nodeIds: [], ...hit });
  }

  // 5. Связность: неориентированные компоненты
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  for (const w of roads) for (const id of w.nodes) if (!parent.has(id)) parent.set(id, id);
  for (const w of roads) for (let i = 0; i < w.nodes.length - 1; i++) parent.set(find(w.nodes[i]), find(w.nodes[i + 1]));
  const comps = new Map<number, OsmWay[]>();
  for (const w of roads) if (w.nodes.length) (comps.get(find(w.nodes[0])) ?? comps.set(find(w.nodes[0]), []).get(find(w.nodes[0]))!).push(w);
  const flagged = new Set<number>();
  if (comps.size > 1) {
    const main = [...comps.values()].sort((a, b) => b.length - a.length)[0];
    for (const ws of comps.values()) if (ws !== main) {
      ws.forEach(w => flagged.add(w.id));
      list.push({ severity: 'warn', kind: 'isolated', msg: `Изолированный участок: ${ws.length} рёбер не связаны с основной сетью`, wayIds: ws.map(w => w.id), nodeIds: [], ...pt(ws[0]) });
    }
  }

  // 6. Связность с учётом направлений (SCC) + «ловушки» oneway
  const adj = new Map<number, number[]>(), indeg = new Map<number, number>(), outdeg = new Map<number, number>();
  const edge = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b); outdeg.set(a, (outdeg.get(a) ?? 0) + 1); indeg.set(b, (indeg.get(b) ?? 0) + 1);
  };
  for (const w of roads) {
    const d = onewayDir(w.tags);
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1];
      if (!doc.nodes.has(a) || !doc.nodes.has(b)) continue;
      if (d >= 0) edge(a, b);
      if (d <= 0) edge(b, a);
    }
  }
  for (const id of adj.keys()) {
    const n = doc.nodes.get(id)!;
    if (!(outdeg.get(id) ?? 0)) list.push({ severity: 'error', kind: 'oneway-sink', msg: 'Тупик по направлению: въехать можно, выехать нельзя (проверьте oneway)', wayIds: [], nodeIds: [id], lat: n.lat, lon: n.lon });
    else if (!(indeg.get(id) ?? 0)) list.push({ severity: 'error', kind: 'oneway-source', msg: 'Источник по направлению: выехать можно, въехать нельзя (проверьте oneway)', wayIds: [], nodeIds: [id], lat: n.lat, lon: n.lon });
  }
  const comp = scc(adj);
  const size = new Map<number, number>();
  for (const c of comp.values()) size.set(c, (size.get(c) ?? 0) + 1);
  let mainC = -1, best = 0;
  for (const [c, s] of size) if (s > best) { best = s; mainC = c; }
  let outside = 0;
  for (const w of roads) {
    if (flagged.has(w.id) || !w.nodes.every(id => comp.has(id))) continue;
    if (w.nodes.some(id => comp.get(id) !== mainC)) {
      outside++;
      list.push({ severity: 'warn', kind: 'not-strongly-connected', msg: 'Ребро вне главной сильно-связной компоненты: по нему нельзя въехать/выехать в основную сеть', wayIds: [w.id], nodeIds: [], ...pt(w) });
    }
  }
  const pct = adj.size ? Math.round(100 * best / adj.size) : 0;
  list.push({ severity: 'info', kind: 'connectivity', msg: `Связность: в главной сильно-связной компоненте ${pct}% узлов (${best} из ${adj.size}); рёбер вне неё: ${outside}`, wayIds: [], nodeIds: [] });

  // 7. Светофоры
  const onRoad = new Set<number>(); for (const w of roads) w.nodes.forEach(id => onRoad.add(id));
  for (const n of doc.nodes.values()) if (n.tags.highway === 'traffic_signals' && !onRoad.has(n.id))
    list.push({ severity: 'error', kind: 'signal-off-road', msg: 'Светофор не лежит ни на одной дороге — адаптеры его проигнорируют', wayIds: [], nodeIds: [n.id], lat: n.lat, lon: n.lon });

  // 8. Метки: переходы и знаки
  const wayUse = new Map<number, number>();
  for (const w of roads) for (const id of new Set(w.nodes)) wayUse.set(id, (wayUse.get(id) ?? 0) + 1);
  const inAnyWay = new Set<number>(); for (const w of doc.ways.values()) w.nodes.forEach(id => inAnyWay.add(id));
  for (const n of doc.nodes.values()) {
    if (n.tags.highway === 'crossing' && !inAnyWay.has(n.id))
      list.push({ severity: 'error', kind: 'crossing-off-way', msg: 'Переход не лежит ни на одной линии', wayIds: [], nodeIds: [n.id], lat: n.lat, lon: n.lon });
    if (n.tags.highway !== 'give_way' && n.tags.highway !== 'stop') continue;
    let near = false;
    for (const w of roads) {
      const i = w.nodes.indexOf(n.id); if (i < 0) continue;
      if ((wayUse.get(n.id) ?? 0) >= 2) { near = true; break; }
      for (const step of [1, -1]) {
        let acc = 0, prev = n;
        for (let j = i + step; j >= 0 && j < w.nodes.length && acc <= 40 && !near; j += step) {
          const q = doc.nodes.get(w.nodes[j]); if (!q) break;
          acc += Math.hypot((q.lat - prev.lat) * 110574, (q.lon - prev.lon) * 68000); prev = q;
          if ((wayUse.get(q.id) ?? 0) >= 2 && acc <= 40) near = true;
        }
      }
    }
    if (!near) list.push({ severity: 'warn', kind: 'sign-far', msg: `Знак «${n.tags.highway === 'stop' ? 'Стоп' : 'Уступи'}» дальше 40 м от перекрёстка — адаптеры могут его не привязать`, wayIds: [], nodeIds: [n.id], lat: n.lat, lon: n.lon });
  }

  return list.map((x, i) => ({ id: 'i' + i, ...x }));
}

export const countBy = (is: Issue[]) => ({
  error: is.filter(i => i.severity === 'error').length,
  warn: is.filter(i => i.severity === 'warn').length,
});

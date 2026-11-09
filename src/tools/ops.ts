// [P3] Операции правки графа. Все функции мутируют Doc и вызываются внутри store.commit().
// Возвращают строку с ошибкой (если операцию выполнить нельзя) или null.
import type { Doc, Attrs, Tags, OsmWay } from '../core/types.ts';
import { onewayDir } from '../core/osm.ts';
import { dist, projectOnSegment } from '../core/geo.ts';

export const newId = (doc: Doc) => doc.nextId--;
export function touch(o: { id: number; attrs: Attrs }) { if (o.id > 0) o.attrs.action = 'modify'; }

export function setTag(o: { id: number; tags: Tags; attrs: Attrs }, k: string, v: string) {
  if (v === '') delete o.tags[k]; else o.tags[k] = v;
  touch(o);
}
export function applyTags(doc: Doc, wayIds: number[], tags: Tags) {
  for (const id of wayIds) { const w = doc.ways.get(id); if (w) for (const [k, v] of Object.entries(tags)) setTag(w, k, v); }
}

export function addNode(doc: Doc, lat: number, lon: number, tags: Tags = {}): number {
  const id = newId(doc);
  doc.nodes.set(id, { id, lat, lon, tags, attrs: {} });
  return id;
}
export function addWay(doc: Doc, nodes: number[], tags: Tags): number {
  const id = newId(doc);
  doc.ways.set(id, { id, nodes: [...nodes], tags: { ...tags }, attrs: {} });
  return id;
}
export function moveNode(doc: Doc, id: number, lat: number, lon: number) {
  const n = doc.nodes.get(id); if (!n) return;
  n.lat = lat; n.lon = lon; touch(n);
  for (const w of doc.ways.values()) if (w.nodes.includes(id)) touch(w); // геометрия way изменилась
}

// ---------- привязка к ребру / вставка узла ----------
export function nearestOnWay(doc: Doc, wayId: number, lat: number, lon: number) {
  const w = doc.ways.get(wayId); if (!w) return null;
  let best: { seg: number; lat: number; lon: number; d: number } | null = null;
  for (let i = 0; i < w.nodes.length - 1; i++) {
    const a = doc.nodes.get(w.nodes[i]), b = doc.nodes.get(w.nodes[i + 1]);
    if (!a || !b) continue;
    const p = projectOnSegment({ lat, lon }, a, b);
    if (!best || p.d < best.d) best = { seg: i, lat: p.lat, lon: p.lon, d: p.d };
  }
  return best;
}
/** Вставить узел в ребро в точке клика (или вернуть существующий, если рядом <1.5 м). */
export function nodeOnWayAt(doc: Doc, wayId: number, lat: number, lon: number): number | null {
  const w = doc.ways.get(wayId); const p = nearestOnWay(doc, wayId, lat, lon);
  if (!w || !p) return null;
  for (const id of [w.nodes[p.seg], w.nodes[p.seg + 1]]) {
    const n = doc.nodes.get(id); if (n && dist(n, p) < 1.5) return id;
  }
  const id = addNode(doc, p.lat, p.lon);
  w.nodes.splice(p.seg + 1, 0, id); touch(w);
  return id;
}

// ---------- удаление ----------
function dropEmptyWays(doc: Doc) {
  for (const w of [...doc.ways.values()]) if (w.nodes.length < 2) deleteWay(doc, w.id);
}
function nodeUsed(doc: Doc, id: number) {
  for (const w of doc.ways.values()) if (w.nodes.includes(id)) return true;
  for (const r of doc.relations.values()) if (r.members.some(m => m.type === 'node' && m.ref === id)) return true;
  return false;
}
export function deleteWay(doc: Doc, id: number) {
  const w = doc.ways.get(id); if (!w) return;
  doc.ways.delete(id);
  for (const r of doc.relations.values()) r.members = r.members.filter(m => !(m.type === 'way' && m.ref === id));
  for (const nid of new Set(w.nodes)) {
    const n = doc.nodes.get(nid);
    if (n && !Object.keys(n.tags).length && !nodeUsed(doc, nid)) doc.nodes.delete(nid); // чистим «осиротевшие» узлы
  }
}
export function deleteNode(doc: Doc, id: number) {
  for (const w of doc.ways.values()) {
    if (!w.nodes.includes(id)) continue;
    w.nodes = w.nodes.filter(x => x !== id); touch(w);
  }
  for (const r of doc.relations.values()) r.members = r.members.filter(m => !(m.type === 'node' && m.ref === id));
  doc.nodes.delete(id);
  dropEmptyWays(doc);
}

// ---------- направление ----------
const SWAP: [string, string][] = [
  ['lanes:forward', 'lanes:backward'], ['turn:lanes:forward', 'turn:lanes:backward'],
  ['maxspeed:forward', 'maxspeed:backward'],
];
/** Перевернуть порядок узлов, НЕ меняя реальной картины движения: oneway и парные теги подстраиваются. */
export function flipKeepSemantics(w: { nodes: number[]; tags: Tags; attrs: Attrs; id: number }) {
  const dir = onewayDir(w.tags);
  w.nodes.reverse();
  for (const [a, b] of SWAP) {
    const va = w.tags[a], vb = w.tags[b];
    delete w.tags[a]; delete w.tags[b];
    if (vb !== undefined) w.tags[a] = vb;
    if (va !== undefined) w.tags[b] = va;
  }
  if (dir !== 0) w.tags.oneway = dir === 1 ? '-1' : 'yes'; // направление относительно нового порядка узлов
  touch(w);
}
/** Развернуть направление одностороннего ребра (порядок узлов + парные теги). */
export function reverseWay(doc: Doc, id: number): string | null {
  const w = doc.ways.get(id); if (!w) return 'Ребро не найдено';
  if (onewayDir(w.tags) === 0) return 'Ребро двустороннее: сначала задайте oneway=yes';
  w.nodes.reverse();
  if (w.tags.oneway === '-1' || w.tags.oneway === 'reverse') w.tags.oneway = 'yes'; // нормализуем: -1 → yes + реверс
  else if (w.tags.oneway === undefined) { /* неявное направление: кольцо/магистраль — реверс узлов достаточно */ }
  for (const [a, b] of SWAP) {
    const va = w.tags[a], vb = w.tags[b];
    delete w.tags[a]; delete w.tags[b];
    if (vb !== undefined) w.tags[a] = vb;
    if (va !== undefined) w.tags[b] = va;
  }
  touch(w); return null;
}
export function setOneway(doc: Doc, wayIds: number[], v: 'yes' | 'no') {
  for (const id of wayIds) { const w = doc.ways.get(id); if (!w) continue; if (v === 'no') delete w.tags.oneway; else w.tags.oneway = 'yes'; touch(w); }
}

// ---------- светофоры, мосты ----------
export function toggleSignal(doc: Doc, nodeId: number) {
  const n = doc.nodes.get(nodeId); if (!n) return;
  if (n.tags.highway === 'traffic_signals') { delete n.tags.highway; delete n.tags.traffic_signals; } else n.tags.highway = 'traffic_signals';
  touch(n);
}
export function toggleBridge(doc: Doc, wayIds: number[]) {
  for (const id of wayIds) {
    const w = doc.ways.get(id); if (!w) continue;
    if (w.tags.bridge && w.tags.bridge !== 'no') { delete w.tags.bridge; delete w.tags.layer; } else { w.tags.bridge = 'yes'; w.tags.layer = '1'; }
    touch(w);
  }
}
/** Плавный переход высоты: интерполяция ele по длине между первым и последним узлом. */
export function smoothEle(doc: Doc, wayId: number): string | null {
  const w = doc.ways.get(wayId); if (!w) return 'Ребро не найдено';
  const ns = w.nodes.map(i => doc.nodes.get(i)!).filter(Boolean);
  const e0 = parseFloat(ns[0]?.tags.ele), e1 = parseFloat(ns[ns.length - 1]?.tags.ele);
  if (isNaN(e0) || isNaN(e1)) return 'Задайте тег ele на первом и последнем узле';
  const cum = [0]; for (let i = 1; i < ns.length; i++) cum.push(cum[i - 1] + dist(ns[i - 1], ns[i]));
  const total = cum[cum.length - 1] || 1;
  for (let i = 1; i < ns.length - 1; i++) { ns[i].tags.ele = (e0 + (e1 - e0) * cum[i] / total).toFixed(1); touch(ns[i]); }
  return null;
}

// ---------- топология ----------
export function splitWay(doc: Doc, wayId: number, nodeId: number): string | null {
  const w = doc.ways.get(wayId); if (!w) return 'Ребро не найдено';
  const idx = w.nodes.indexOf(nodeId);
  if (idx <= 0 || idx >= w.nodes.length - 1) return 'Разрезать можно только по внутреннему узлу ребра';
  const id = newId(doc);
  doc.ways.set(id, { id, nodes: w.nodes.slice(idx), tags: { ...w.tags }, attrs: {} });
  w.nodes = w.nodes.slice(0, idx + 1); touch(w);
  for (const r of doc.relations.values()) {
    const at = r.members.findIndex(m => m.type === 'way' && m.ref === wayId);
    if (at >= 0) r.members.splice(at + 1, 0, { type: 'way', ref: id, role: r.members[at].role });
  }
  return null;
}
export function splitAt(doc: Doc, wayId: number, lat: number, lon: number): string | null {
  const nid = nodeOnWayAt(doc, wayId, lat, lon);
  return nid === null ? 'Не удалось найти точку на ребре' : splitWay(doc, wayId, nid);
}

export function mergeWays(doc: Doc, aId: number, bId: number): string | null {
  const a = doc.ways.get(aId), b = doc.ways.get(bId);
  if (!a || !b || a === b) return 'Выберите два разных ребра';
  const keys = new Set([...Object.keys(a.tags), ...Object.keys(b.tags)]);
  for (const k of keys) if (a.tags[k] !== b.tags[k]) return `Теги различаются (${k}): выровняйте их перед слиянием`;
  const oneWay = onewayDir(a.tags) !== 0;
  const A = a.nodes, B = b.nodes;
  let res: number[] | null = null;
  if (A[A.length - 1] === B[0]) res = A.concat(B.slice(1));
  else if (B[B.length - 1] === A[0]) res = B.concat(A.slice(1));
  else if (!oneWay && A[A.length - 1] === B[B.length - 1]) res = A.concat([...B].reverse().slice(1));
  else if (!oneWay && A[0] === B[0]) res = [...B].reverse().concat(A.slice(1));
  if (!res) return oneWay ? 'Односторонние рёбра не стыкуются «хвост к голове»' : 'У рёбер нет общего конца';
  a.nodes = res; touch(a);
  doc.ways.delete(bId);
  for (const r of doc.relations.values()) {
    r.members = r.members.map(m => (m.type === 'way' && m.ref === bId ? { ...m, ref: aId } : m))
      .filter((m, i, arr) => !(m.type === 'way' && m.ref === aId && arr.findIndex(x => x.type === 'way' && x.ref === aId && x.role === m.role) !== i));
  }
  return null;
}

/** Склеить узел `remove` в `keep` (починка разорванного перекрёстка). */
export function mergeNodes(doc: Doc, keepId: number, removeId: number): string | null {
  const k = doc.nodes.get(keepId), r = doc.nodes.get(removeId);
  if (!k || !r || k === r) return 'Выберите два разных узла';
  for (const w of doc.ways.values()) {
    if (!w.nodes.includes(removeId)) continue;
    const mapped = w.nodes.map(x => (x === removeId ? keepId : x));
    w.nodes = mapped.filter((x, i) => i === 0 || x !== mapped[i - 1]); // убираем (a,a)
    touch(w);
  }
  for (const rel of doc.relations.values()) for (const m of rel.members) if (m.type === 'node' && m.ref === removeId) m.ref = keepId;
  for (const [t, v] of Object.entries(r.tags)) if (!(t in k.tags)) k.tags[t] = v;
  touch(k);
  doc.nodes.delete(removeId);
  dropEmptyWays(doc);
  return null;
}

// ---------- копирование атрибутов и шаблоны ----------
export const COPY_KEYS = ['highway', 'oneway', 'lanes', 'lanes:forward', 'lanes:backward', 'turn:lanes', 'turn:lanes:forward',
  'turn:lanes:backward', 'maxspeed', 'surface', 'width', 'sidewalk', 'cycleway', 'junction'];

export function copyTags(doc: Doc, srcId: number, dstIds: number[], keys: string[] = COPY_KEYS) {
  const s = doc.ways.get(srcId); if (!s) return;
  for (const id of dstIds) {
    const d = doc.ways.get(id); if (!d || d === s) continue;
    for (const k of keys) setTag(d, k, s.tags[k] ?? '');
  }
}

/** Шаблоны: пустая строка = удалить тег. */
export const TEMPLATES: Record<string, Tags> = {
  'Улица: 2 полосы, двустороннее': { highway: 'residential', lanes: '2', oneway: '', maxspeed: '40', 'lanes:forward': '', 'lanes:backward': '' },
  'Магистраль: 4 полосы (2+2)': { highway: 'primary', lanes: '4', oneway: '', maxspeed: '60', 'lanes:forward': '2', 'lanes:backward': '2' },
  'Односторонняя: 2 полосы': { highway: 'secondary', lanes: '2', oneway: 'yes', maxspeed: '60', 'lanes:forward': '', 'lanes:backward': '' },
  'Односторонняя: 1 полоса (двор)': { highway: 'service', lanes: '1', oneway: 'yes', maxspeed: '20', 'lanes:forward': '', 'lanes:backward': '' },
  'Кольцо': { highway: 'residential', junction: 'roundabout', oneway: 'yes', lanes: '1', maxspeed: '30' },
};
export function applyTemplate(doc: Doc, wayIds: number[], name: string) {
  const t = TEMPLATES[name]; if (t) applyTags(doc, wayIds, t);
}
export function templateTags(name: string): Tags {
  const out: Tags = {}; for (const [k, v] of Object.entries(TEMPLATES[name] ?? {})) if (v !== '') out[k] = v; return out;
}
export type { OsmWay };

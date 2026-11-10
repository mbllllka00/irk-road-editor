// Сравнение с исходным OSM: фиксируем реальные изменения объектов и геометрии дорог.
import type { Attrs, Doc, OsmNode, OsmWay, OsmRelation, Tags } from './types.ts';

export type EntityKind = 'node' | 'way' | 'relation';
export type ChangeKind = 'added' | 'removed' | 'modified';
export interface Change { type: EntityKind; id: number; kind: ChangeKind; details: string[] }
export interface ChangeCounts { added: number; removed: number; modified: number }
export interface DiffReport { counts: Record<EntityKind, ChangeCounts>; changes: Change[] }

const names: Record<EntityKind, string> = { node: 'Узел', way: 'Ребро', relation: 'Отношение' };
export const changeTitle = (item: Change): string => `${names[item.type]} #${item.id}`;

function objectChanges(label: string, before: Tags | Attrs, after: Tags | Attrs): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    if (!(key in before)) out.push(`${label} «${key}» добавлен: ${after[key]}`);
    else if (!(key in after)) out.push(`${label} «${key}» удалён (был: ${before[key]})`);
    else out.push(`${label} «${key}»: ${before[key]} → ${after[key]}`);
  }
  return out;
}
const sameArray = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const loc = (n: OsmNode) => `${n.lat.toFixed(7)}, ${n.lon.toFixed(7)}`;

function nodeChanges(a: OsmNode, b: OsmNode): string[] {
  const out: string[] = [];
  if (a.lat !== b.lat || a.lon !== b.lon) out.push(`Координаты: ${loc(a)} → ${loc(b)}`);
  return [...out, ...objectChanges('Тег', a.tags, b.tags), ...objectChanges('Атрибут', a.attrs, b.attrs)];
}
function wayChanges(a: OsmWay, b: OsmWay, original: Doc, current: Doc): string[] {
  const out: string[] = [];
  if (!sameArray(a.nodes, b.nodes)) out.push(`Состав / порядок узлов: ${a.nodes.length} → ${b.nodes.length}`);
  // Координаты узлов могут измениться без смены списка ссылок на узлы.
  if (b.nodes.some(id => {
    const x = original.nodes.get(id), y = current.nodes.get(id);
    return (x && !y) || (x && y && (x.lat !== y.lat || x.lon !== y.lon));
  })) out.push('Геометрия дороги изменена: перемещены или удалены связанные узлы');
  return [...out, ...objectChanges('Тег', a.tags, b.tags), ...objectChanges('Атрибут', a.attrs, b.attrs)];
}
function relationChanges(a: OsmRelation, b: OsmRelation): string[] {
  const ma = a.members.map(m => `${m.type}:${m.ref}:${m.role}`);
  const mb = b.members.map(m => `${m.type}:${m.ref}:${m.role}`);
  const out = sameArray(ma, mb) ? [] : [`Участники отношения: ${ma.length} → ${mb.length}`];
  return [...out, ...objectChanges('Тег', a.tags, b.tags), ...objectChanges('Атрибут', a.attrs, b.attrs)];
}

export function diffDocs(original: Doc, current: Doc): DiffReport {
  const counts = {
    node: { added: 0, removed: 0, modified: 0 },
    way: { added: 0, removed: 0, modified: 0 },
    relation: { added: 0, removed: 0, modified: 0 },
  };
  const changes: Change[] = [];
  function compare<T extends { id: number }>(type: EntityKind, left: Map<number, T>, right: Map<number, T>, details: (a: T, b: T) => string[]) {
    for (const [id, a] of left) {
      const b = right.get(id);
      if (!b) { counts[type].removed++; changes.push({ type, id, kind: 'removed', details: [] }); continue; }
      const d = details(a, b);
      if (d.length) { counts[type].modified++; changes.push({ type, id, kind: 'modified', details: d }); }
    }
    for (const [id] of right) if (!left.has(id)) {
      counts[type].added++; changes.push({ type, id, kind: 'added', details: [] });
    }
  }
  compare('node', original.nodes, current.nodes, nodeChanges);
  compare('way', original.ways, current.ways, (a, b) => wayChanges(a, b, original, current));
  compare('relation', original.relations, current.relations, relationChanges);
  return { counts, changes };
}

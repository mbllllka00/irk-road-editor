// Геометрия для цветного сравнения на карте. Удалённые элементы берутся ИЗ ИСХОДНОГО OSM.
import type { Doc, OsmWay } from './types.ts';
import type { ChangeKind, DiffReport } from './diff.ts';

export type CompareStatus = 'unchanged' | ChangeKind;
export type CompareFeature = {
  type: 'Feature';
  properties: { id: number; status: CompareStatus };
  geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Point'; coordinates: [number, number] };
};
export interface CompareFeatures { roads: CompareFeature[]; nodes: CompareFeature[] }

// В редакторе именно эти OSM way показываются как линии дорог и тротуаров.
export const graphWay = (way: OsmWay | undefined): boolean => !!way && !!(way.tags.highway || way.tags.railway === 'tram');

function wayFeature(way: OsmWay, doc: Doc, status: CompareStatus): CompareFeature | null {
  const coordinates = way.nodes.map(id => doc.nodes.get(id)).filter(n => n !== undefined).map(n => [n.lon, n.lat]);
  if (coordinates.length < 2) return null;
  return { type: 'Feature', properties: { id: way.id, status }, geometry: { type: 'LineString', coordinates } };
}

/** Только исходный снимок и текущее состояние: никаких промежуточных версий. */
export function buildCompareFeatures(original: Doc, current: Doc, report: DiffReport): CompareFeatures {
  const wayStatus = new Map<number, ChangeKind>();
  const nodeStatus = new Map<number, ChangeKind>();
  for (const c of report.changes) {
    if (c.type === 'way') wayStatus.set(c.id, c.kind);
    if (c.type === 'node') nodeStatus.set(c.id, c.kind);
  }
  const roads: CompareFeature[] = [], nodes: CompareFeature[] = [];
  for (const way of current.ways.values()) {
    if (!graphWay(way) && !graphWay(original.ways.get(way.id))) continue;
    const feature = wayFeature(way, current, wayStatus.get(way.id) ?? 'unchanged');
    if (feature) roads.push(feature);
  }
  // Красные рёбра не могут находиться в текущем документе: рисуем их по старым координатам.
  for (const way of original.ways.values()) {
    if (current.ways.has(way.id) || !graphWay(way)) continue;
    const feature = wayFeature(way, original, 'removed');
    if (feature) roads.push(feature);
  }
  for (const node of current.nodes.values()) {
    nodes.push({ type: 'Feature', properties: { id: node.id, status: nodeStatus.get(node.id) ?? 'unchanged' }, geometry: { type: 'Point', coordinates: [node.lon, node.lat] } });
  }
  for (const node of original.nodes.values()) if (!current.nodes.has(node.id)) {
    nodes.push({ type: 'Feature', properties: { id: node.id, status: 'removed' }, geometry: { type: 'Point', coordinates: [node.lon, node.lat] } });
  }
  return { roads, nodes };
}

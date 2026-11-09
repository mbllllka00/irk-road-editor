// [P1] Модель данных в стиле OSM. Теги и неизвестные атрибуты хранятся как есть.
export type Tags = Record<string, string>;
export type Attrs = Record<string, string>;

export interface OsmNode { id: number; lat: number; lon: number; tags: Tags; attrs: Attrs }
export interface OsmWay { id: number; nodes: number[]; tags: Tags; attrs: Attrs }
export interface OsmMember { type: string; ref: number; role: string }
export interface OsmRelation { id: number; members: OsmMember[]; tags: Tags; attrs: Attrs }

export interface Doc {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
  osmAttrs: Attrs;
  bounds: Attrs | null;
  nextId: number; // новые объекты получают отрицательные id: -1, -2, ...
}

export interface Sel { type: 'node' | 'way'; id: number }

export interface Issue {
  id: string;
  severity: 'error' | 'warn' | 'info';
  kind: string;
  msg: string;
  wayIds: number[];
  nodeIds: number[];
  lat?: number;
  lon?: number;
}

export const newDoc = (): Doc => ({
  nodes: new Map(), ways: new Map(), relations: new Map(),
  osmAttrs: { version: '0.6' }, bounds: null, nextId: -1,
});

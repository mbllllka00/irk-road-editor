// [P1] Парсер и сериализатор OSM XML. Не теряет теги, версии и чужие атрибуты.
import { newDoc } from './types.ts';
import type { Doc, Attrs, Tags } from './types.ts';

const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service',
]);
export const isRoad = (t: Tags): boolean => !!t.highway && DRIVABLE.has(t.highway);
export const hasTag = (t: Tags, k: string): boolean => !!t[k] && t[k] !== 'no';

/** Реальное направление движения вдоль way: 1 — по порядку узлов, -1 — против, 0 — двустороннее. */
export function onewayDir(t: Tags): 1 | -1 | 0 {
  const o = t.oneway;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === 'no') return 0;
  if (t.junction === 'roundabout' || t.highway === 'motorway' || t.highway === 'motorway_link') return 1;
  return 0;
}

function readAttrs(el: Element, skip: string[] = []): Attrs {
  const a: Attrs = {};
  for (const at of Array.from(el.attributes)) if (!skip.includes(at.name)) a[at.name] = at.value;
  return a;
}
function readTags(el: Element): Tags {
  const t: Tags = {};
  for (const c of Array.from(el.children)) if (c.tagName === 'tag') t[c.getAttribute('k') ?? ''] = c.getAttribute('v') ?? '';
  return t;
}

export function parseOsm(xml: string): Doc {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) throw new Error('Файл не является корректным XML');
  const root = dom.documentElement;
  if (root.tagName !== 'osm') throw new Error('Корневой элемент должен быть <osm>');
  const doc = newDoc();
  doc.osmAttrs = readAttrs(root);
  let minId = 0;
  for (const el of Array.from(root.children)) {
    const id = Number(el.getAttribute('id'));
    if (id < minId) minId = id;
    switch (el.tagName) {
      case 'bounds': doc.bounds = readAttrs(el); break;
      case 'node':
        doc.nodes.set(id, {
          id, lat: Number(el.getAttribute('lat')), lon: Number(el.getAttribute('lon')),
          tags: readTags(el), attrs: readAttrs(el, ['id', 'lat', 'lon']),
        });
        break;
      case 'way':
        doc.ways.set(id, {
          id, tags: readTags(el), attrs: readAttrs(el, ['id']),
          nodes: Array.from(el.children).filter(c => c.tagName === 'nd').map(c => Number(c.getAttribute('ref'))),
        });
        break;
      case 'relation':
        doc.relations.set(id, {
          id, tags: readTags(el), attrs: readAttrs(el, ['id']),
          members: Array.from(el.children).filter(c => c.tagName === 'member').map(c => ({
            type: c.getAttribute('type') ?? '', ref: Number(c.getAttribute('ref')), role: c.getAttribute('role') ?? '',
          })),
        });
        break;
    }
  }
  doc.nextId = Math.min(-1, minId - 1);
  return doc;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const attrStr = (a: Attrs) => Object.entries(a).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

/** При изменении объекта поднимаем version (action="modify"), как делает JOSM. */
function outAttrs(a: Attrs): Attrs {
  if (a.action === 'modify' && a.version && /^\d+$/.test(a.version)) return { ...a, version: String(Number(a.version) + 1) };
  return a;
}
const tagLines = (t: Tags) => Object.entries(t).map(([k, v]) => `    <tag k="${esc(k)}" v="${esc(v)}"/>`);

export function serializeOsm(doc: Doc): string {
  const out: string[] = ["<?xml version='1.0' encoding='UTF-8'?>"];
  out.push(`<osm${attrStr({ ...doc.osmAttrs, version: doc.osmAttrs.version ?? '0.6', generator: 'irk-road-editor' })}>`);
  if (doc.bounds) out.push(`  <bounds${attrStr(doc.bounds)}/>`);
  const ids = <T extends { id: number }>(m: Map<number, T>) => [...m.values()].sort((a, b) => (a.id < 0 ? 1 : 0) - (b.id < 0 ? 1 : 0) || Math.abs(a.id) - Math.abs(b.id));
  for (const n of ids(doc.nodes)) {
    const head = `  <node id="${n.id}"${attrStr(outAttrs(n.attrs))} lat="${n.lat.toFixed(7)}" lon="${n.lon.toFixed(7)}"`;
    const t = tagLines(n.tags);
    if (t.length) out.push(head + '>', ...t, '  </node>'); else out.push(head + '/>');
  }
  for (const w of ids(doc.ways)) {
    out.push(`  <way id="${w.id}"${attrStr(outAttrs(w.attrs))}>`);
    for (const r of w.nodes) out.push(`    <nd ref="${r}"/>`);
    out.push(...tagLines(w.tags), '  </way>');
  }
  for (const r of ids(doc.relations)) {
    out.push(`  <relation id="${r.id}"${attrStr(outAttrs(r.attrs))}>`);
    for (const m of r.members) out.push(`    <member type="${esc(m.type)}" ref="${m.ref}" role="${esc(m.role)}"/>`);
    out.push(...tagLines(r.tags), '  </relation>');
  }
  out.push('</osm>', '');
  return out.join('\n');
}

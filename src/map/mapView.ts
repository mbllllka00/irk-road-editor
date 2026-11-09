// [P2] Карта: MapLibre GL. 2D-рендер графа, выделение, drag узлов, подложка, подсветка ошибок, псевдо-3D.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Doc, Issue, Sel } from '../core/types.ts';
import { isRoad, onewayDir } from '../core/osm.ts';
import { categorize, lineWidth } from '../core/roadStyle.ts';
import type { ColorMode } from '../core/roadStyle.ts';

export interface ClickInfo { lng: number; lat: number; nodeId?: number; wayId?: number; shift: boolean }
export interface Handlers {
  onClick(e: ClickInfo): void;
  onDblClick(): void;
  dragAllowed(nodeId: number): boolean;
  onDragStart(): void;
  onDrag(nodeId: number, lat: number, lon: number): void;
  onDragEnd(): void;
}
export type Base = 'sat' | 'osm' | 'none' | 'custom';
type Args = [Doc, Sel[], Issue[], [number, number][]];

const EMPTY = { type: 'FeatureCollection', features: [] as any[] };
const tiles = {
  osm: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  sat: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
};

export class MapView {
  map: maplibregl.Map;
  private loaded = false;
  private last?: Args;
  private dragging: number | null = null;
  private suppressClick = false;
  private base: Base = 'sat';
  private opacity = 0.85;
  private is3d = false;
  private mode: ColorMode = 'class';

  constructor(container: string, private h: Handlers) {
    this.map = new maplibregl.Map({
      container,
      center: [104.28, 52.28], zoom: 13, doubleClickZoom: false,
      style: {
        version: 8,
        sources: {
          osm: { type: 'raster', tiles: tiles.osm, tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap' },
          sat: { type: 'raster', tiles: tiles.sat, tileSize: 256, maxzoom: 19, attribution: 'Esri World Imagery' },
          custom: { type: 'raster', tiles: tiles.osm, tileSize: 256, maxzoom: 19 },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#d9dde0' } },
          { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
          { id: 'sat', type: 'raster', source: 'sat' },
          { id: 'custom', type: 'raster', source: 'custom', layout: { visibility: 'none' } },
        ],
      },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.on('load', () => { this.initLayers(); this.loaded = true; this.setBase(this.base); if (this.last) this.render(...this.last); });
    this.bindEvents();
  }

  private initLayers() {
    const m = this.map;
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(3, 2); g.lineTo(14, 8); g.lineTo(3, 14); g.lineTo(6, 8); g.closePath(); g.stroke(); g.fill();
    m.addImage('arrow', g.getImageData(0, 0, 16, 16));

    for (const s of ['buildings', 'roads', 'nodes', 'issues', 'draft', 'draftpts']) m.addSource(s, { type: 'geojson', data: EMPTY as any });

    m.addLayer({ id: 'buildings', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': '#b9b3a8', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0 } });
    // ширина линии: zoom-выражение должно быть верхнего уровня, поэтому смещение вшито внутрь
    const lw = (off: number): any => ['interpolate', ['linear'], ['zoom'], 12, ['+', ['max', 1, ['/', ['get', 'lw'], 3]], off], 18, ['+', ['get', 'lw'], off]];
    m.addLayer({ id: 'roads-sel', type: 'line', source: 'roads', filter: ['==', ['get', 'sel'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00e5ff', 'line-opacity': 0.9, 'line-width': lw(8) } });
    m.addLayer({ id: 'roads-case', type: 'line', source: 'roads', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#111', 'line-opacity': 0.65, 'line-width': lw(2) } });
    m.addLayer({ id: 'roads', type: 'line', source: 'roads', filter: ['==', ['get', 'dash'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-width': lw(0) } });
    m.addLayer({ id: 'roads-dash', type: 'line', source: 'roads', filter: ['==', ['get', 'dash'], 1], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-width': lw(0), 'line-dasharray': [2, 1.5] } });
    m.addLayer({ id: 'roads-bridge', type: 'line', source: 'roads', filter: ['==', ['get', 'bridge'], 1], paint: { 'line-color': '#2b6cff', 'line-width': 2, 'line-offset': 0 } });
    m.addLayer({ id: 'roads-bad', type: 'line', source: 'roads', filter: ['==', ['get', 'bad'], 1], paint: { 'line-color': '#ff2d2d', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
    m.addLayer({
      id: 'arrows', type: 'symbol', source: 'roads', filter: ['!=', ['get', 'dir'], 0], minzoom: 15,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 55, 'icon-image': 'arrow', 'icon-size': 0.75, 'icon-allow-overlap': true, 'icon-rotation-alignment': 'map', 'icon-rotate': ['case', ['==', ['get', 'dir'], -1], 180, 0] },
    });
    const nodePaint: any = {
      'circle-radius': ['case', ['==', ['get', 'sel'], 1], 8, ['==', ['get', 'sig'], 1], 7, ['!=', ['get', 'mk'], ''], 7, ['==', ['get', 'wsel'], 1], 5, 3.5],
      'circle-color': ['case', ['==', ['get', 'sel'], 1], '#00e5ff', ['==', ['get', 'sig'], 1], '#ff8a00',
        ['==', ['get', 'mk'], 'crossing'], '#1b4dff', ['==', ['get', 'mk'], 'give_way'], '#ffffff', ['==', ['get', 'mk'], 'stop'], '#d62828',
        ['==', ['get', 'wsel'], 1], '#ffffff', '#555'],
      'circle-stroke-width': ['case', ['==', ['get', 'mk'], 'give_way'], 3, ['==', ['get', 'wsel'], 1], 2, 1],
      'circle-stroke-color': ['case', ['==', ['get', 'mk'], 'give_way'], '#d62828', ['==', ['get', 'wsel'], 1], '#1b4dff', '#fff'],
    };
    m.addLayer({ id: 'nodes', type: 'circle', source: 'nodes', minzoom: 15, paint: nodePaint });
    m.addLayer({ id: 'nodes-sel', type: 'circle', source: 'nodes', filter: ['any', ['==', ['get', 'sel'], 1], ['==', ['get', 'wsel'], 1], ['==', ['get', 'sig'], 1], ['!=', ['get', 'mk'], '']], paint: nodePaint });
    m.addLayer({
      id: 'issues', type: 'circle', source: 'issues',
      paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'sev'], 'error', '#ff2d2d', '#ff9f1a'], 'circle-opacity': 0.35, 'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get', 'sev'], 'error', '#ff2d2d', '#ff9f1a'] },
    });
    m.addLayer({ id: 'draft', type: 'line', source: 'draft', paint: { 'line-color': '#1b4dff', 'line-width': 3, 'line-dasharray': [2, 1] } });
    m.addLayer({ id: 'draftpts', type: 'circle', source: 'draftpts', paint: { 'circle-radius': 5, 'circle-color': '#1b4dff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }

  private bindEvents() {
    const m = this.map;
    const hit = (p: maplibregl.Point, layers: string[], r: number) =>
      m.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: layers.filter(l => m.getLayer(l)) });
    m.on('click', e => {
      if (this.suppressClick || !this.loaded) return;
      const n = hit(e.point, ['nodes-sel', 'nodes'], 7)[0], r = hit(e.point, ['roads', 'roads-dash'], 6)[0];
      this.h.onClick({ lng: e.lngLat.lng, lat: e.lngLat.lat, nodeId: n ? Number(n.properties!.id) : undefined, wayId: r ? Number(r.properties!.id) : undefined, shift: e.originalEvent.shiftKey });
    });
    m.on('dblclick', () => this.h.onDblClick());
    m.on('mousedown', e => {
      if (!this.loaded) return;
      const n = hit(e.point, ['nodes-sel', 'nodes'], 7)[0]; if (!n) return;
      const id = Number(n.properties!.id);
      if (!this.h.dragAllowed(id)) return;
      e.preventDefault(); this.dragging = id; m.dragPan.disable(); this.h.onDragStart(); m.getCanvas().style.cursor = 'grabbing';
    });
    m.on('mousemove', e => {
      if (this.dragging !== null) this.h.onDrag(this.dragging, e.lngLat.lat, e.lngLat.lng);
    });
    m.on('mouseup', () => {
      if (this.dragging === null) return;
      this.dragging = null; m.dragPan.enable(); m.getCanvas().style.cursor = ''; this.h.onDragEnd();
      this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50);
    });
  }

  render(doc: Doc, sel: Sel[], issues: Issue[], draft: [number, number][]) {
    this.last = [doc, sel, issues, draft];
    if (!this.loaded) return;
    const selWays = new Set(sel.filter(s => s.type === 'way').map(s => s.id));
    const selNodes = new Set(sel.filter(s => s.type === 'node').map(s => s.id));
    const badWays = new Set(issues.filter(i => i.severity !== 'info').flatMap(i => i.wayIds));
    const roads: any[] = [], blds: any[] = [], usage = new Map<number, number>(), inSel = new Set<number>(), show = new Set<number>();
    for (const w of doc.ways.values()) {
      const t = w.tags;
      const coords = w.nodes.map(id => doc.nodes.get(id)).filter(Boolean).map(n => [n!.lon, n!.lat]);
      if (t.building && coords.length > 3) {
        const h = parseFloat(t.height) || (parseFloat(t['building:levels']) || 3) * 3;
        blds.push({ type: 'Feature', properties: { h }, geometry: { type: 'Polygon', coordinates: [coords] } });
        continue;
      }
      if (!(t.highway || t.railway === 'tram') || coords.length < 2) continue;
      const dir = onewayDir(t), cat = categorize(this.mode, t);
      roads.push({
        type: 'Feature',
        properties: {
          id: w.id, hw: t.highway ?? 'tram', dir, col: cat.color, dash: cat.dash ? 1 : 0, lw: lineWidth(t),
          sel: selWays.has(w.id) ? 1 : 0, bad: badWays.has(w.id) ? 1 : 0, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0,
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
      if (isRoad(t)) for (const id of w.nodes) { usage.set(id, (usage.get(id) ?? 0) + 1); if (selWays.has(w.id)) inSel.add(id); }
    }
    for (const [id, c] of usage) if (c > 1 || inSel.has(id)) show.add(id);
    const MK = ['crossing', 'give_way', 'stop'];
    for (const n of doc.nodes.values()) if (n.tags.highway === 'traffic_signals' || MK.includes(n.tags.highway) || selNodes.has(n.id)) show.add(n.id);
    const nodes = [...show].map(id => doc.nodes.get(id)).filter(Boolean).map(n => ({
      type: 'Feature', properties: { id: n!.id, mk: MK.includes(n!.tags.highway) ? n!.tags.highway : '', sig: n!.tags.highway === 'traffic_signals' ? 1 : 0, sel: selNodes.has(n!.id) ? 1 : 0, wsel: inSel.has(n!.id) ? 1 : 0 },
      geometry: { type: 'Point', coordinates: [n!.lon, n!.lat] },
    }));
    const pts: any[] = issues.filter(i => i.lat !== undefined).map(i => ({ type: 'Feature', properties: { sev: i.severity }, geometry: { type: 'Point', coordinates: [i.lon, i.lat] } }));
    const set = (id: string, features: any[]) => (this.map.getSource(id) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
    set('roads', roads); set('nodes', nodes); set('buildings', blds); set('issues', pts);
    set('draft', draft.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: draft } }] : []);
    set('draftpts', draft.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })));
  }

  setColorMode(m: ColorMode) { this.mode = m; if (this.last) this.render(...this.last); }

  fitToDoc(doc: Doc) {
    let a = 180, b = 90, c = -180, d = -90;
    for (const n of doc.nodes.values()) { a = Math.min(a, n.lon); c = Math.max(c, n.lon); b = Math.min(b, n.lat); d = Math.max(d, n.lat); }
    if (a < c) this.map.fitBounds([[a, b], [c, d]], { padding: 40, duration: 0 });
  }
  flyTo(lat: number, lon: number, zoom = 18) { this.map.flyTo({ center: [lon, lat], zoom: Math.max(zoom, this.map.getZoom()) }); }
  setCursor(c: string) { this.map.getCanvas().style.cursor = c; }

  setBase(b: Base) {
    this.base = b;
    if (!this.loaded) return;
    for (const id of ['osm', 'sat', 'custom']) this.map.setLayoutProperty(id, 'visibility', id === b ? 'visible' : 'none');
    this.setOpacity(this.opacity);
  }
  setOpacity(v: number) {
    this.opacity = v;
    if (this.loaded) for (const id of ['osm', 'sat', 'custom']) this.map.setPaintProperty(id, 'raster-opacity', v);
  }
  setCustomTiles(url: string) {
    (this.map.getSource('custom') as maplibregl.RasterTileSource).setTiles([url]);
    this.setBase('custom');
  }
  /** Псевдо-3D: наклон камеры + выдавленные здания (высота из height / building:levels). */
  set3D(on: boolean) {
    this.is3d = on;
    this.map.easeTo({ pitch: on ? 60 : 0, bearing: on ? -20 : 0, duration: 600 });
    if (this.loaded) this.map.setPaintProperty('buildings', 'fill-extrusion-opacity', on ? 0.85 : 0);
  }
  toggle3D() { this.set3D(!this.is3d); return this.is3d; }
}

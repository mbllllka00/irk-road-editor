// [P2] Карта: MapLibre GL. 2D-рендер графа, выделение, drag узлов, подложка, подсветка ошибок, псевдо-3D.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Doc, Issue, Sel } from '../core/types.ts';
import { isRoad, onewayDir } from '../core/osm.ts';
import { junctionNodes } from './signals.ts';
import { categorize, lineWidth, isUnderpass, isPed, isTram } from '../core/roadStyle.ts';
import type { ColorMode } from '../core/roadStyle.ts';
import { buildCompareFeatures, graphWay } from '../core/compareMap.ts';
import type { DiffReport } from '../core/diff.ts';

export function drawBusStopIcon(g: CanvasRenderingContext2D) {
  // Синий квадрат со скруглёнными углами
  g.beginPath();
  g.roundRect(1, 1, 26, 26, 5);
  g.fillStyle = '#1677D2';
  g.fill();

  g.lineWidth = 1.5;
  g.strokeStyle = '#ffffff';
  g.stroke();

  // Белый корпус автобуса
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(7, 5, 14, 17, 3);
  g.fill();

  // Окно
  g.fillStyle = '#1677D2';
  g.fillRect(9, 7, 10, 5);

  // Нижняя часть автобуса
  g.fillStyle = '#1677D2';
  g.fillRect(9, 14, 10, 4);

  // Колёса
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(9, 23, 2, 0, Math.PI * 2);
  g.arc(19, 23, 2, 0, Math.PI * 2);
  g.fill();
}

export interface ClickInfo {
  lng: number;
  lat: number;
  nodeId?: number;
  wayId?: number;
  buildingId?: number;
  areaId?: number;
  edgeId?: number;
  shift: boolean;
  ctrl: boolean;
}
export interface Handlers {
  onClick(e: ClickInfo): void;
  onDblClick(): void;
  dragAllowed(nodeId: number): boolean;
  onDragStart(nodeId: number): void;
  onDrag(nodeId: number, lat: number, lon: number): void;
  onDragEnd(nodeId: number): void;
  boxAllowed(): boolean;
  areaDragAllowed?(areaId: number): boolean;
  onAreaStart?(): void;
  onAreaMove?(areaId: number, dLat: number, dLon: number): void;
  onAreaEnd?(): void;
  shapeAllowed?(): boolean;
  onShape?(phase: 'move' | 'end', a: { lat: number; lng: number }, b: { lat: number; lng: number }, shift: boolean): void;
  onBox(ways: number[], nodes: number[], additive: boolean): void;
}
export type Base = 'sat' | 'osm' | 'none' | 'custom';
type HitFeature = ReturnType<maplibregl.Map['queryRenderedFeatures']>[number];
type Args = [Doc, Sel[], Issue[], [number, number][]];

const EMPTY = { type: 'FeatureCollection', features: [] as any[] };
const NORMAL_LAYERS = [
  'parking-fill', 'parking-line', 'parking-sel', 'buildings', 'roads-sel', 'roads-ug-halo', 'roads-case', 'roads',
  'roads-dash', 'roads-bridge', 'roads-bad', 'arrows', 'nodes', 'sig-halo', 'nodes-ic',
  'nodes-sel', 'nodes-selring', 'issues', 'ug-ic', 'draft', 'draftpts',
];
const COMPARE_LAYERS = ['compare-roads', 'compare-removed-roads', 'compare-unchanged-nodes', 'compare-changed-nodes'];
const compareColor: any = ['match', ['get', 'status'], 'added', '#159447', 'removed', '#dd2637', 'modified', '#2162e5', '#828992'];
const tiles = {
  osm: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  sat: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
};

export class MapView {
  map: maplibregl.Map;
  private loaded = false;
  private last?: Args;
  private dragging: number | null = null;
  private dragCandidate: { id: number; x: number; y: number } | null = null;
  private dragFrame = 0;
  private preview: { doc: Doc; nodeId: number } | null = null;
  private roadsByNode = new Map<number, number[]>();
  private visibleNodes = new Set<number>();
  private parkByNode = new Map<number, number[]>();
  private comparison = false;
  private pendingComparison: { original: Doc; current: Doc; report: DiffReport } | null = null;
  private comparisonRoadsByNode = new Map<number, number[]>();
  private areaDrag: { id: number; lat: number; lng: number } | null = null;
  private suppressClick = false;
  private base: Base = 'sat';
  private opacity = 0.85;
  private is3d = false;
  private mode: ColorMode = 'class';
  private hl: string | null = null;
  private labels: maplibregl.Marker[] = [];
  private shape: { a: { lat: number; lng: number }; x: number; y: number; active: boolean } | null = null;
  private box: { x: number; y: number; el: HTMLDivElement } | null = null;

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
    this.map.on('load', () => { this.initLayers(); this.loaded = true; this.setBase(this.base); if (this.last) this.render(...this.last);
      if (this.pendingComparison) { const p = this.pendingComparison; this.setComparison(p.original, p.current, p.report); } });
    this.bindEvents();
  }

  private initLayers() {
    const m = this.map;
    const c = document.createElement('canvas'); c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(3, 2); g.lineTo(14, 8); g.lineTo(3, 14); g.lineTo(6, 8); g.closePath(); g.stroke(); g.fill();
    m.addImage('arrow', g.getImageData(0, 0, 16, 16));

    const icon = (name: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => {
      const k = 2, cv = document.createElement('canvas'); cv.width = w * k; cv.height = h * k;
      const g = cv.getContext('2d')!; g.scale(k, k); draw(g);
      m.addImage(name, g.getImageData(0, 0, w * k, h * k), { pixelRatio: k });
    };
    const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
    const light = (g: CanvasRenderingContext2D, warn: boolean) => {
      rr(g, 3, 1.5, 14, 29, 4); g.fillStyle = '#1b1f23'; g.fill();
      g.lineWidth = 2; g.strokeStyle = warn ? '#ff2d2d' : '#ffffff'; if (warn) g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
      for (const [cy, col] of [[8, '#ff3b30'], [16, '#ffcc00'], [24, '#34c759']] as [number, string][]) { g.beginPath(); g.arc(10, cy, 3.6, 0, 7); g.fillStyle = col; g.fill(); }
    };
    icon('tl', 20, 32, g => light(g, false));
    icon('tl-warn', 20, 32, g => light(g, true));
    const zebra = (g: CanvasRenderingContext2D, sig: boolean) => {
      rr(g, 1.5, 6, 21, 16, 3); g.fillStyle = '#1b4dff'; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = '#fff'; for (let x = 5; x < 20; x += 5) g.fillRect(x, 9, 2.6, 10);
      if (sig) { g.beginPath(); g.arc(20, 5, 4.2, 0, 7); g.fillStyle = '#ff8a00'; g.fill(); g.strokeStyle = '#fff'; g.stroke(); }
    };
    // подземный переход: фиолетовый круг со стрелкой вниз и ступеньками
    icon('ug', 28, 28, g => {
      g.beginPath(); g.arc(14, 14, 12, 0, 7); g.fillStyle = '#5b21b6'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(14, 6); g.lineTo(14, 15); g.stroke();
      g.beginPath(); g.moveTo(9.5, 12); g.lineTo(14, 17); g.lineTo(18.5, 12); g.stroke();
      g.beginPath(); g.moveTo(7, 21); g.lineTo(11, 21); g.lineTo(11, 19.2); g.lineTo(15, 19.2); g.lineTo(15, 21); g.lineTo(21, 21); g.stroke();
    });
    icon('cr', 24, 24, g => zebra(g, false));
    icon('cr-sig', 24, 24, g => zebra(g, true));
    icon('busstop', 28, 28, drawBusStopIcon);

    for (const s of ['ug', 'parking', 'buildings', 'roads', 'nodes', 'issues', 'draft', 'draftpts', 'compare-roads', 'compare-nodes']) m.addSource(s, { type: 'geojson', data: EMPTY as any, ...(['roads', 'nodes', 'parking', 'compare-roads', 'compare-nodes'].includes(s) ? { promoteId: 'id' } : {}) });

    m.addLayer({ id: 'parking-fill', type: 'fill', source: 'parking', paint: { 'fill-color': '#a21caf', 'fill-opacity': 0.22 } });
    m.addLayer({ id: 'parking-line', type: 'line', source: 'parking', paint: { 'line-color': '#a21caf', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'parking-sel', type: 'line', source: 'parking', filter: ['==', ['get', 'sel'], 1], layout: { 'line-join': 'round' }, paint: { 'line-color': '#00e5ff', 'line-width': 4, 'line-opacity': 0.95 } });
    m.addLayer({ id: 'buildings', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': '#b9b3a8', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0 } });
    // Контуры зданий на 2D-карте
    m.addLayer({
      id: 'building-footprints',
      type: 'fill',
      source: 'buildings',
      paint: {
        'fill-color': '#9ca3af',
        'fill-opacity': 0.28
      }
    });

    m.addLayer({
      id: 'building-outlines',
      type: 'line',
      source: 'buildings',
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'sel'], 1],
          '#a855f7',
          '#777777'
        ],
        'line-width': [
          'case',
          ['==', ['get', 'sel'], 1],
          3,
          1
        ]
      }
    });
    // ширина линии: zoom-выражение должно быть верхнего уровня, поэтому смещение вшито внутрь
    const lw = (off: number): any => ['interpolate', ['linear'], ['zoom'], 12, ['+', ['max', 1, ['/', ['get', 'lw'], 3]], off], 18, ['+', ['get', 'lw'], off]];
    m.addLayer({ id: 'roads-sel', type: 'line', source: 'roads', filter: ['==', ['get', 'sel'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00e5ff', 'line-opacity': 0.9, 'line-width': lw(8) } });
    // подземка: тёмная широкая подсветка под линией, чтобы не путать с обычным тротуаром
    m.addLayer({ id: 'roads-ug-halo', type: 'line', source: 'roads', filter: ['==', ['get', 'ug'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2e1065', 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.12, 0.6], 'line-width': lw(9) } });
    m.addLayer({ id: 'roads-case', type: 'line', source: 'roads', layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': '#111', 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.1, 0.65], 'line-width': lw(2) } });
    m.addLayer({ id: 'roads', type: 'line', source: 'roads', filter: ['all',['==', ['get', 'dash'], 0],['==', ['get', 'rail'], 0]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.15, 1], 'line-width': lw(0) } });
    m.addLayer({ id: 'roads-dash', type: 'line', source: 'roads', filter: ['all',['==', ['get', 'dash'], 1],['==', ['get', 'rail'], 0]], layout: { 'line-cap': 'butt', 'line-join': 'round' }, paint: { 'line-color': ['get', 'col'], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.15, 1], 'line-width': lw(0), 'line-dasharray': [2, 1.5] } });
    // Основа железнодорожного полотна
    m.addLayer({
      id: 'railway-base',
      type: 'line',
      source: 'roads',
      filter: ['==', ['get', 'rail'], 1],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#3f4650',
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10, 2,
          16, 5,
          19, 7
        ]
      }
    });

    // Светлая штриховая линия поверх полотна
    m.addLayer({
      id: 'railway-center',
      type: 'line',
      source: 'roads',
      filter: ['==', ['get', 'rail'], 1],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#e5e7eb',
        'line-width': 1.5,
        'line-dasharray': [2, 2]
      }
    });
    m.addLayer({ id: 'roads-bridge', type: 'line', source: 'roads', filter: ['==', ['get', 'bridge'], 1], paint: { 'line-color': '#2b6cff', 'line-width': 2, 'line-offset': 0 } });
    m.addLayer({ id: 'roads-bad', type: 'line', source: 'roads', filter: ['==', ['get', 'bad'], 1], paint: { 'line-color': '#ff2d2d', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
    m.addLayer({
      id: 'arrows', type: 'symbol', source: 'roads', filter: ['!=', ['get', 'dir'], 0], minzoom: 15,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 55, 'icon-image': 'arrow', 'icon-size': 0.75, 'icon-allow-overlap': true, 'icon-rotation-alignment': 'map', 'icon-rotate': ['case', ['==', ['get', 'dir'], -1], 180, 0] },
    });
    const nodePaint: any = {
      'circle-radius': ['case', ['==', ['get', 'sel'], 1], 8, ['!=', ['get', 'mk'], ''], 7, ['==', ['get', 'wsel'], 1], 5, 3.5],
      'circle-color': ['case', ['==', ['get', 'sel'], 1], '#00e5ff',
        ['==', ['get', 'mk'], 'give_way'], '#ffffff', ['==', ['get', 'mk'], 'stop'], '#d62828', 
        ['==', ['get', 'wsel'], 1], '#ffffff', '#555'],
      'circle-stroke-width': ['case', ['==', ['get', 'mk'], 'give_way'], 3, ['==', ['get', 'wsel'], 1], 2, 1],
      'circle-stroke-color': ['case', ['==', ['get', 'mk'], 'give_way'], '#d62828', ['==', ['get', 'wsel'], 1], '#1b4dff', '#fff'],
    };
    const noIcon: any = ['==', ['get', 'ic'], ''];
    m.addLayer({ id: 'nodes', type: 'circle', source: 'nodes', minzoom: 15, filter: noIcon, paint: nodePaint });
    // светофор на перекрёстке: заметное гало + иконка (видны с z13, чтобы перекрёстки читались и на обзоре)
    m.addLayer({ id: 'sig-halo', type: 'circle', source: 'nodes', minzoom: 13, filter: ['==', ['get', 'ic'], 'tl'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 8, 18, 20], 'circle-color': '#ff3b30', 'circle-opacity': 0.28, 'circle-stroke-color': '#ff3b30', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.8 } });
    m.addLayer({ id: 'nodes-ic', type: 'symbol', source: 'nodes', minzoom: 13, filter: ['!=', ['get', 'ic'], ''],
      layout: { 'icon-image': ['get', 'ic'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.5, 16, 0.75, 19, 1.05] } });
    m.addLayer({ id: 'nodes-sel', type: 'circle', source: 'nodes', filter: ['all', noIcon, ['any', ['==', ['get', 'sel'], 1], ['==', ['get', 'wsel'], 1], ['!=', ['get', 'mk'], '']]], paint: nodePaint });
    m.addLayer({ id: 'nodes-selring', type: 'circle', source: 'nodes', filter: ['all', ['!=', ['get', 'ic'], ''], ['==', ['get', 'sel'], 1]], paint: { 'circle-radius': 17, 'circle-color': '#00e5ff', 'circle-opacity': 0.15, 'circle-stroke-color': '#00e5ff', 'circle-stroke-width': 3 } });
    m.addLayer({
      id: 'issues', type: 'circle', source: 'issues',
      paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'sev'], 'error', '#ff2d2d', '#ff9f1a'], 'circle-opacity': 0.35, 'circle-stroke-width': 2, 'circle-stroke-color': ['match', ['get', 'sev'], 'error', '#ff2d2d', '#ff9f1a'] },
    });
    m.addLayer({ id: 'ug-ic', type: 'symbol', source: 'ug', minzoom: 14, layout: { 'icon-image': 'ug', 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.55, 17, 0.8, 19, 1.1] } });
    m.addLayer({ id: 'draft', type: 'line', source: 'draft', paint: { 'line-color': '#1b4dff', 'line-width': 3, 'line-dasharray': [2, 1] } });
    m.addLayer({ id: 'draftpts', type: 'circle', source: 'draftpts', paint: { 'circle-radius': 5, 'circle-color': '#1b4dff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    // Режим сравнения рисуется ВМЕСТО обычных цветов. Удалённые дороги — пунктиром
    // по исходной геометрии; изменённые и добавленные — сплошными линиями.
    m.addLayer({ id: 'compare-roads', type: 'line', source: 'compare-roads',
      filter: ['!=', ['get', 'status'], 'removed'], layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': compareColor, 'line-opacity': 1,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 15, 4.5, 19, 7] },
    });
    m.addLayer({ id: 'compare-removed-roads', type: 'line', source: 'compare-roads',
      filter: ['==', ['get', 'status'], 'removed'], layout: { visibility: 'none', 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': '#dd2637', 'line-opacity': 1,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 5, 19, 7.5],
        'line-dasharray': [2, 1.5] },
    });
    // На общем масштабе оставляем все изменённые узлы, неизменённые появляются
    // при приближении, иначе тысячи серых точек закрыли бы карту.
    m.addLayer({ id: 'compare-unchanged-nodes', type: 'circle', source: 'compare-nodes', minzoom: 14,
      filter: ['==', ['get', 'status'], 'unchanged'], layout: { visibility: 'none' },
      paint: { 'circle-color': '#828992', 'circle-radius': 3, 'circle-stroke-color': '#fff', 'circle-stroke-width': 0.8 },
    });
    m.addLayer({ id: 'compare-changed-nodes', type: 'circle', source: 'compare-nodes', minzoom: 11,
      filter: ['!=', ['get', 'status'], 'unchanged'], layout: { visibility: 'none' },
      paint: { 'circle-color': compareColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 6.5, 19, 8],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
    });
  }

  /** Удалённые объекты в режиме сравнения нельзя выделить или передвинуть. */
  private hitCurrentNodes(p: maplibregl.Point, r: number, hit: (p: maplibregl.Point, layers: string[], r: number) => HitFeature[]) {
    return hit(p, this.comparison ? ['compare-changed-nodes', 'compare-unchanged-nodes'] : ['nodes-ic', 'nodes-sel', 'nodes'], r)
      .find(f => f.properties!.status !== 'removed');
  }
  private hitCurrentWays(p: maplibregl.Point, r: number, hit: (p: maplibregl.Point, layers: string[], r: number) => HitFeature[]) {
    return hit(
      p,
      this.comparison
        ? ['compare-roads']
        : ['roads', 'roads-dash', 'railway-base'],
      r
    )
      .find(f => f.properties!.status !== 'removed');
  }

  private bindEvents() {
    const m = this.map;
    const hit = (p: maplibregl.Point, layers: string[], r: number) =>
      m.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: layers.filter(l => m.getLayer(l)) });
    m.on('click', e => {
      if (this.suppressClick || !this.loaded) return;
      const n = this.hitCurrentNodes(e.point, 9, hit), r = this.hitCurrentWays(e.point, 8, hit);
      const ar = this.comparison ? undefined : hit(e.point, ['parking-fill'], 0)[0], ed = this.comparison ? undefined : hit(e.point, ['parking-line'], 8)[0];
      const building = this.comparison
        ? undefined
        : hit(e.point, ['building-footprints', 'building-outlines'], 0)[0];

      const buildingId = building
        ? Number(building.properties?.id)
        : undefined;
      this.h.onClick({
        lng: e.lngLat.lng,
        lat: e.lngLat.lat,
        nodeId: n ? Number(n.properties!.id) : undefined,
        wayId: r ? Number(r.properties!.id) : undefined,
        buildingId: Number.isFinite(buildingId) ? buildingId : undefined,
        areaId: ar ? Number(ar.properties!.id) : undefined,
        edgeId: ed ? Number(ed.properties!.id) : undefined,
        shift: e.originalEvent.shiftKey,
        ctrl: e.originalEvent.ctrlKey || e.originalEvent.metaKey
      });
    });
    m.on('dblclick', () => this.h.onDblClick());
    // Shift+клик в MapLibre по умолчанию запускает zoom-рамку и подавляет click: из-за этого множественное выделение не работало.
    m.boxZoom.disable();
    m.on('mousedown', e => {
      if (!this.loaded) return;
      const oe = e.originalEvent;
      if (oe.button === 0 && this.h.shapeAllowed?.()) { this.shape = { a: { lat: e.lngLat.lat, lng: e.lngLat.lng }, x: e.point.x, y: e.point.y, active: false }; m.dragPan.disable(); return; }
      if (oe.shiftKey && oe.button === 0 && this.h.boxAllowed()) {
        // рамка выделения: Shift + перетаскивание; если мышь не сдвинулась, это обычный Shift+клик
        const el = document.createElement('div'); el.className = 'selbox'; el.hidden = true; m.getContainer().appendChild(el);
        this.box = { x: e.point.x, y: e.point.y, el }; m.dragPan.disable(); return;
      }
      if (oe.shiftKey || oe.ctrlKey || oe.metaKey) return;
      const n = this.hitCurrentNodes(e.point, 8, hit);
      if (!n) { // перетаскивание выбранной области (парковки) целиком; если под курсором дорога, дорога важнее
        if (this.comparison || this.hitCurrentWays(e.point, 6, hit)) return;
        const ar = hit(
          e.point,
          ['parking-fill', 'building-footprints', 'building-outlines'],
          0
        )[0];

        const aid = ar ? Number(ar.properties!.id) : NaN;

        if (Number.isFinite(aid) && this.h.areaDragAllowed?.(aid)) {
          e.preventDefault();

          this.areaDrag = {
            id: aid,
            lat: e.lngLat.lat,
            lng: e.lngLat.lng
          };

          m.dragPan.disable();
          this.h.onAreaStart?.();
          m.getCanvas().style.cursor = 'grabbing';
        }
        return;
      }
      const id = Number(n.properties!.id);
      if (!this.h.dragAllowed(id)) return;
      // Не начинаем правку от одного клика: drag начинается только после сдвига на 3 px.
      e.preventDefault(); this.dragCandidate = { id, x: e.point.x, y: e.point.y }; m.dragPan.disable();
    });
    m.on('mousemove', e => {
      if (this.dragCandidate && this.dragging === null && Math.hypot(e.point.x - this.dragCandidate.x, e.point.y - this.dragCandidate.y) >= 3) {
        this.dragging = this.dragCandidate.id; this.h.onDragStart(this.dragging);
        m.getCanvas().style.cursor = 'grabbing';
      }
      if (this.dragging !== null) this.h.onDrag(this.dragging, e.lngLat.lat, e.lngLat.lng);
      if (this.areaDrag) { const a = this.areaDrag; this.h.onAreaMove?.(a.id, e.lngLat.lat - a.lat, e.lngLat.lng - a.lng); a.lat = e.lngLat.lat; a.lng = e.lngLat.lng; }
      const sp = this.shape;
      if (sp) {
        if (!sp.active && Math.hypot(e.point.x - sp.x, e.point.y - sp.y) > 5) sp.active = true;
        if (sp.active) this.h.onShape?.('move', sp.a, { lat: e.lngLat.lat, lng: e.lngLat.lng }, e.originalEvent.shiftKey);
      }
      const b = this.box;
      if (b) {
        const x0 = Math.min(b.x, e.point.x), y0 = Math.min(b.y, e.point.y), w = Math.abs(e.point.x - b.x), h = Math.abs(e.point.y - b.y);
        if (w + h > 6) { b.el.hidden = false; b.el.style.cssText = `left:${x0}px;top:${y0}px;width:${w}px;height:${h}px`; }
      }
    });
    m.on('mouseup', e => {
      const sp = this.shape;
      if (sp) {
        this.shape = null; m.dragPan.enable();
        if (sp.active) { this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50); this.h.onShape?.('end', sp.a, { lat: e.lngLat.lat, lng: e.lngLat.lng }, e.originalEvent.shiftKey); }
        return;
      }
      const b = this.box;
      if (b) {
        this.box = null; b.el.remove(); m.dragPan.enable();
        const x0 = Math.min(b.x, e.point.x), y0 = Math.min(b.y, e.point.y), x1 = Math.max(b.x, e.point.x), y1 = Math.max(b.y, e.point.y);
        if (x1 - x0 + (y1 - y0) > 6) {
          const q = (layers: string[]) => m.queryRenderedFeatures([[x0, y0], [x1, y1]], { layers: layers.filter(l => m.getLayer(l)) });
          const ways = [...new Set(q(this.comparison ? ['compare-roads'] : ['roads', 'roads-dash', 'railway-base'])
            .filter(f => f.properties!.status !== 'removed').map(f => Number(f.properties!.id)))];
          const nodes = ways.length ? [] : [...new Set(q(this.comparison ? ['compare-changed-nodes', 'compare-unchanged-nodes'] : ['nodes-ic', 'nodes-sel', 'nodes'])
            .filter(f => f.properties!.status !== 'removed').map(f => Number(f.properties!.id)))];
          this.h.onBox(ways, nodes, true);
          this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50);
        }
        return;
      }
      if (this.areaDrag) {
        this.areaDrag = null; m.dragPan.enable(); m.getCanvas().style.cursor = ''; this.h.onAreaEnd?.();
        this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50); return;
      }
      if (!this.dragCandidate) return;
      this.dragCandidate = null; m.dragPan.enable(); m.getCanvas().style.cursor = '';
      if (this.dragging === null) return; // обычный клик без перемещения
      const id = this.dragging;
      this.dragging = null; this.stopDragPreview(); this.h.onDragEnd(id);
      this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 50);
    });
    // Если отпустить кнопку за пределами карты, завершаем drag и возвращаем dragPan.
    window.addEventListener('mouseup', () => {
      if (this.areaDrag) { this.areaDrag = null; m.dragPan.enable(); m.getCanvas().style.cursor = ''; this.h.onAreaEnd?.(); return; }
      if (!this.dragCandidate) return;
      this.dragCandidate = null; m.dragPan.enable(); m.getCanvas().style.cursor = '';
      if (this.dragging !== null) {
        const id = this.dragging; this.dragging = null;
        this.stopDragPreview(); this.h.onDragEnd(id);
      }
    });
  }

  render(doc: Doc, sel: Sel[], issues: Issue[], draft: [number, number][]) {
    this.last = [doc, sel, issues, draft];
    if (!this.loaded || this.comparison) return;
    const selWays = new Set(sel.filter(s => s.type === 'way').map(s => s.id));
    const selNodes = new Set(sel.filter(s => s.type === 'node').map(s => s.id));
    const badWays = new Set(issues.filter(i => i.severity !== 'info').flatMap(i => i.wayIds));
    const roadIndex = new Map<number, number[]>(), parkIndex = new Map<number, number[]>();
    const roads: any[] = [], blds: any[] = [], park: any[] = [], ugs: any[] = [], usage = new Map<number, number>(), inSel = new Set<number>(), show = new Set<number>();
    for (const w of doc.ways.values()) {
      const t = w.tags;
      const coords = w.nodes.map(id => doc.nodes.get(id)).filter(Boolean).map(n => [n!.lon, n!.lat]);
      if (t.building && coords.length > 3) {
        const h = parseFloat(t.height) ||
          (parseFloat(t['building:levels']) || 3) * 3;

        blds.push({
          type: 'Feature',
          properties: {
            id: w.id,
            h,
            sel: selWays.has(w.id) ? 1 : 0
          },
          geometry: {
            type: 'Polygon',
            coordinates: [coords]
          }
        });

        continue;
      }
      if (t.amenity === 'parking' && coords.length > 3) {
        park.push({ type: 'Feature', properties: { id: w.id, sel: selWays.has(w.id) ? 1 : 0 }, geometry: { type: 'Polygon', coordinates: [coords] } });
        if (selWays.has(w.id)) for (const id of w.nodes) inSel.add(id); // вершины выбранной парковки
        for (const id of new Set(w.nodes)) { const l = parkIndex.get(id) ?? []; l.push(w.id); parkIndex.set(id, l); }
        continue;
      }
      if (!(t.highway || t.railway) || coords.length < 2) continue;
      for (const id of new Set(w.nodes)) {
        const links = roadIndex.get(id) ?? []; links.push(w.id); roadIndex.set(id, links);
      }
      const dir = onewayDir(t), cat = categorize(this.mode, t);
      roads.push({
        type: 'Feature',
        properties: {
          id: w.id, hw: t.highway ?? 'tram', rail: t.railway ? 1 : 0, dir, col: cat.color, dash: cat.dash ? 1 : 0, lw: lineWidth(t), ug: isUnderpass(t) ? 1 : 0,
          sel: selWays.has(w.id) ? 1 : 0, dim: this.hl && cat.key !== this.hl ? 1 : 0, bad: badWays.has(w.id) ? 1 : 0, bridge: t.bridge && t.bridge !== 'no' ? 1 : 0,
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
      if (isUnderpass(t)) { const c = coords[Math.floor(coords.length / 2)]; ugs.push({ type: 'Feature', properties: { id: w.id }, geometry: { type: 'Point', coordinates: c } }); }
      // вершины выбранного ребра показываем и для тротуаров/пешеходных линий (раньше только для дорог: тротуар нельзя было тянуть за узлы)
      if (isRoad(t)) for (const id of w.nodes) usage.set(id, (usage.get(id) ?? 0) + 1);
      if ((isRoad(t) || isPed(t) || isTram(t)) && selWays.has(w.id)) for (const id of w.nodes) inSel.add(id);
    }
    for (const [id, c] of usage) if (c > 1) show.add(id);
    for (const id of inSel) show.add(id); // вершины выбранных тротуаров/трамвая/парковок (раньше терялись: цикл шёл только по узлам дорог)
    const MK = ['crossing', 'give_way', 'stop'], junc = junctionNodes(doc);
    for (const n of doc.nodes.values()) {
      if (
        n.tags.highway === 'traffic_signals' ||
        n.tags.highway === 'bus_stop' ||
        n.tags.public_transport === 'platform' ||
        MK.includes(n.tags.highway) ||
        selNodes.has(n.id)
      ) {
        show.add(n.id);
      }
    }
    const iconOf = (t: Record<string, string>, id: number) => {
      if (t.highway === 'traffic_signals') {
        return junc.has(id) ? 'tl' : 'tl-warn';
      }

      if (t.highway === 'crossing') {
        return (
          t.crossing === 'traffic_signals' ||
          t['crossing:signals'] === 'yes'
        ) ? 'cr-sig' : 'cr';
      }

      if (
        t.highway === 'bus_stop' ||
        (t.public_transport === 'platform' && t.bus === 'yes')
      ) {
        return 'busstop';
      }

      return '';
    };
    const nodes = [...show].map(id => doc.nodes.get(id)).filter(Boolean).map(n => ({
      type: 'Feature', 
      properties: {
        id: n!.id,
        mk: n!.tags.highway === 'give_way' ||
            n!.tags.highway === 'stop'
              ? n!.tags.highway
              : (n!.tags.highway === 'bus_stop' ||
                n!.tags.public_transport === 'platform')
                ? 'busstop'
                : '',
        ic: iconOf(n!.tags, n!.id),
        sel: selNodes.has(n!.id) ? 1 : 0,
        wsel: inSel.has(n!.id) ? 1 : 0
      },
      geometry: { type: 'Point', coordinates: [n!.lon, n!.lat] },
    }));
    this.roadsByNode = roadIndex; this.parkByNode = parkIndex; this.visibleNodes = show;
    const pts: any[] = issues.filter(i => i.lat !== undefined).map(i => ({ type: 'Feature', properties: { sev: i.severity }, geometry: { type: 'Point', coordinates: [i.lon, i.lat] } }));
    const set = (id: string, features: any[]) => (this.map.getSource(id) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
    set('roads', roads); set('nodes', nodes); set('buildings', blds); set('parking', park); set('ug', ugs); set('issues', pts);
    set('draft', draft.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: draft } }] : []);
    set('draftpts', draft.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })));
  }

  /** Переключить карту в сравнение с исходным загруженным документом. */
  setComparison(original: Doc, current: Doc, report: DiffReport) {
    this.comparison = true;
    this.pendingComparison = { original, current, report };
    if (!this.loaded) return;
    // Линии текущего документа можно продолжать перетаскивать без полного пересчёта в mousemove.
    this.comparisonRoadsByNode.clear();
    for (const way of current.ways.values()) {
      if (!graphWay(way) && !graphWay(original.ways.get(way.id))) continue;
      for (const id of new Set(way.nodes)) {
        const related = this.comparisonRoadsByNode.get(id) ?? [];
        related.push(way.id); this.comparisonRoadsByNode.set(id, related);
      }
    }
    const features = buildCompareFeatures(original, current, report);
    (this.map.getSource('compare-roads') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: features.roads } as any);
    (this.map.getSource('compare-nodes') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: features.nodes } as any);
    for (const id of NORMAL_LAYERS) this.map.setLayoutProperty(id, 'visibility', 'none');
    for (const id of COMPARE_LAYERS) this.map.setLayoutProperty(id, 'visibility', 'visible');
    this.labels.forEach(l => l.remove()); this.labels = [];
  }

  /** Исходный стиль редактора восстанавливается без изменения OSM. */
  clearComparison() {
    this.comparison = false; this.pendingComparison = null;
    this.comparisonRoadsByNode.clear();
    if (!this.loaded) return;
    for (const id of COMPARE_LAYERS) this.map.setLayoutProperty(id, 'visibility', 'none');
    for (const id of NORMAL_LAYERS) this.map.setLayoutProperty(id, 'visibility', 'visible');
    if (this.last) this.render(...this.last);
  }

  /** Во время drag обновляем только изменённые объекты через GeoJSON-diff, раз в кадр.
   * Полный пересчёт дорог/подписей/панелей делается единожды после mouseup. */
  previewMovedNode(doc: Doc, nodeId: number) {
    if (!this.loaded) return;
    this.preview = { doc, nodeId };
    if (this.dragFrame) return;
    this.dragFrame = requestAnimationFrame(() => {
      this.dragFrame = 0;
      const pending = this.preview; if (!pending || !this.loaded) return;
      const { doc, nodeId } = pending;
      const updates: { id: number; newGeometry: any }[] = [];
      for (const id of (this.comparison ? this.comparisonRoadsByNode : this.roadsByNode).get(nodeId) ?? []) {
        const w = doc.ways.get(id); if (!w) continue;
        const coordinates = w.nodes.map(nid => doc.nodes.get(nid)).filter(Boolean).map(n => [n!.lon, n!.lat]);
        if (coordinates.length >= 2) updates.push({ id, newGeometry: { type: 'LineString', coordinates } });
      }
      if (updates.length) (this.map.getSource(this.comparison ? 'compare-roads' : 'roads') as maplibregl.GeoJSONSource).updateData({ update: updates });
      if (!this.comparison) { // контур парковки следует за перетаскиваемой вершиной
        const pu: { id: number; newGeometry: any }[] = [];
        for (const id of this.parkByNode.get(nodeId) ?? []) {
          const w = doc.ways.get(id); if (!w) continue;
          pu.push({ id, newGeometry: { type: 'Polygon', coordinates: [w.nodes.map(nid => doc.nodes.get(nid)).filter(Boolean).map(n => [n!.lon, n!.lat])] } });
        }
        if (pu.length) (this.map.getSource('parking') as maplibregl.GeoJSONSource).updateData({ update: pu });
      }
      const n = doc.nodes.get(nodeId);
      if (n && (this.comparison || this.visibleNodes.has(nodeId))) (this.map.getSource(this.comparison ? 'compare-nodes' : 'nodes') as maplibregl.GeoJSONSource)
        .updateData({ update: [{ id: nodeId, newGeometry: { type: 'Point', coordinates: [n.lon, n.lat] } }] });
    });
  }

  private stopDragPreview() {
    if (this.dragFrame) cancelAnimationFrame(this.dragFrame);
    this.dragFrame = 0; this.preview = null;
  }

  /** Подписи (названия улиц выбранных рёбер) как HTML-маркеры: в стиле карты нет шрифтов для text-слоёв. */
  setLabels(items: { lat: number; lon: number; text: string }[]) {
    this.labels.forEach(l => l.remove()); this.labels = [];
    if (this.comparison) return;
    for (const it of items) {
      const el = document.createElement('div'); el.className = 'wlabel'; el.textContent = it.text;
      this.labels.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat([it.lon, it.lat]).addTo(this.map));
    }
  }
  /** Быстрое обновление только черновика (предпросмотр кольца при перетаскивании), без перерисовки графа. */
  setDraftOnly(coords: [number, number][]) {
    if (!this.loaded) return;
    const set = (id: string, features: any[]) => (this.map.getSource(id) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features } as any);
    set('draft', coords.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }] : []); set('draftpts', []);
  }
  setColorMode(m: ColorMode) { this.mode = m; this.hl = null; if (this.last) this.render(...this.last); }
  /** Подсветить одну категорию легенды, остальные приглушить. */
  setHighlight(k: string | null) { this.hl = k; if (this.last) this.render(...this.last); }

  fitToPoints(pts: [number, number][]) {
    if (!pts.length) return;
    let a = 180, b = 90, c = -180, d = -90;
    for (const [lon, lat] of pts) { a = Math.min(a, lon); c = Math.max(c, lon); b = Math.min(b, lat); d = Math.max(d, lat); }
    if (a === c && b === d) this.map.flyTo({ center: [a, b], zoom: 18 });
    else this.map.fitBounds([[a, b], [c, d]], { padding: { top: 60, bottom: 60, left: 60, right: 380 }, maxZoom: 18, duration: 600 });
  }
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

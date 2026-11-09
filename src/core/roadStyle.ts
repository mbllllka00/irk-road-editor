// Классификация дорог для отображения и правки: класс, полосность, покрытие, скорость.
import type { Tags } from './types.ts';
import { onewayDir } from './osm.ts';

export type ColorMode = 'class' | 'lanes' | 'surface' | 'speed';
export interface Cat { key: string; label: string; color: string }
export interface RoadCat extends Cat { dash: boolean }

export const MODE_TITLES: Record<ColorMode, string> = {
  class: 'Класс дороги', lanes: 'Число полос', surface: 'Покрытие', speed: 'Ограничение скорости, км/ч',
};

// ---------- тип полотна ----------
const PED = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway']);
export const isPed = (t: Tags) => !!t.highway && PED.has(t.highway);
export const isTram = (t: Tags) => !t.highway && t.railway === 'tram';
export const isDrawn = (t: Tags) => !!t.highway || t.railway === 'tram';

export const CLASS_CATS: Cat[] = [
  { key: 'main', label: 'Главные (motorway, trunk, primary)', color: '#ffd21f' },
  { key: 'secondary', label: 'Второстепенные (secondary)', color: '#ff9f1c' },
  { key: 'local', label: 'Местные (tertiary, unclassified)', color: '#ffffff' },
  { key: 'residential', label: 'Жилые улицы, дворы', color: '#b8c4cc' },
  { key: 'service', label: 'Служебные проезды (service)', color: '#7d848a' },
  { key: 'ped', label: 'Пешеходные, велодорожки (пунктир)', color: '#a58bff' },
  { key: 'steps', label: 'Лестницы (пунктир)', color: '#ff5cc8' },
  { key: 'tram', label: 'Трамвай (пунктир)', color: '#d0d0d0' },
  { key: 'other', label: 'Прочее (track и др.)', color: '#c49a6c' },
];
const classCat = (key: string) => CLASS_CATS.find(c => c.key === key)!;
export function classKey(t: Tags): string {
  if (isTram(t)) return 'tram';
  const h = t.highway ?? '';
  if (/^(motorway|trunk|primary)(_link)?$/.test(h)) return 'main';
  if (/^secondary(_link)?$/.test(h)) return 'secondary';
  if (/^tertiary(_link)?$|^unclassified$/.test(h)) return 'local';
  if (h === 'residential' || h === 'living_street') return 'residential';
  if (h === 'service') return 'service';
  if (h === 'steps') return 'steps';
  if (PED.has(h)) return 'ped';
  return 'other';
}
export const HIGHWAY_CLASSES: { value: string; label: string }[] = [
  { value: 'motorway', label: 'Автомагистраль (motorway)' }, { value: 'trunk', label: 'Скоростная (trunk)' },
  { value: 'primary', label: 'Главная (primary)' }, { value: 'secondary', label: 'Второстепенная (secondary)' },
  { value: 'tertiary', label: 'Местная (tertiary)' }, { value: 'unclassified', label: 'Прочая (unclassified)' },
  { value: 'residential', label: 'Жилая улица (residential)' }, { value: 'living_street', label: 'Двор, жилая зона (living_street)' },
  { value: 'service', label: 'Служебный проезд (service)' },
  { value: 'motorway_link', label: 'Съезд motorway' }, { value: 'trunk_link', label: 'Съезд trunk' },
  { value: 'primary_link', label: 'Съезд primary' }, { value: 'secondary_link', label: 'Съезд secondary' }, { value: 'tertiary_link', label: 'Съезд tertiary' },
  { value: 'pedestrian', label: 'Пешеходная улица' }, { value: 'footway', label: 'Пешеходная дорожка (footway)' },
  { value: 'path', label: 'Тропа (path)' }, { value: 'cycleway', label: 'Велодорожка (cycleway)' }, { value: 'steps', label: 'Лестница (steps)' },
];

// ---------- полосы ----------
export const LANE_CATS: Cat[] = [
  { key: 'l1', label: '1 полоса', color: '#4dabf7' }, { key: 'l2', label: '2 полосы', color: '#51cf66' },
  { key: 'l3', label: '3 полосы', color: '#ffa94d' }, { key: 'l4', label: '4 и более', color: '#e64980' },
  { key: 'ln', label: 'lanes не задано', color: '#b0b0b0' },
];
const laneCat = (t: Tags) => {
  const n = parseInt(t.lanes);
  return LANE_CATS.find(c => c.key === (isNaN(n) || n < 1 ? 'ln' : n >= 4 ? 'l4' : 'l' + n))!;
};

// ---------- покрытие ----------
export const SURFACES: { value: string; label: string; color: string }[] = [
  { value: 'asphalt', label: 'Асфальт', color: '#6b7280' }, { value: 'concrete', label: 'Бетон', color: '#cbd5e1' },
  { value: 'paving_stones', label: 'Плитка, брусчатка', color: '#e76f51' }, { value: 'sett', label: 'Брусчатка колотая (sett)', color: '#c2410c' },
  { value: 'cobblestone', label: 'Булыжник', color: '#92400e' }, { value: 'paved', label: 'Твёрдое (не уточнено)', color: '#9ca3af' },
  { value: 'compacted', label: 'Уплотнённый щебень/грунт', color: '#d9b44a' }, { value: 'gravel', label: 'Гравий, щебень', color: '#e9c46a' },
  { value: 'unpaved', label: 'Грунтовое (не уточнено)', color: '#bc8a5f' }, { value: 'dirt', label: 'Грунт', color: '#8b5e34' },
  { value: 'sand', label: 'Песок', color: '#f2d492' }, { value: 'grass', label: 'Трава', color: '#7cb342' },
  { value: 'wood', label: 'Дерево, металл', color: '#2a9d8f' },
];
const SURF_ALIAS: Record<string, string> = {
  fine_gravel: 'gravel', ground: 'dirt', earth: 'dirt', mud: 'dirt', metal: 'wood',
  'concrete:plates': 'concrete', 'concrete:lanes': 'concrete',
};
export const SURF_NONE: Cat = { key: 'none', label: 'Покрытие не задано', color: '#ff5ca8' };
export const SURF_OTHER: Cat = { key: 'other', label: 'Другое значение', color: '#9aa0a6' };
export function surfaceCat(t: Tags): Cat {
  const s = t.surface; if (!s) return SURF_NONE;
  const k = SURF_ALIAS[s] ?? s;
  const f = SURFACES.find(x => x.value === k);
  return f ? { key: f.value, label: f.label, color: f.color } : SURF_OTHER;
}

// ---------- скорость ----------
export function speedKmh(t: Tags): number | null {
  const v = t.maxspeed ?? t['maxspeed:forward'] ?? t['maxspeed:backward'];
  if (!v) return null;
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h)?$/);
  if (m) return Math.round(m[2] === 'mph' ? +m[1] * 1.609 : +m[1]);
  const d: Record<string, number> = { 'RU:urban': 60, 'RU:rural': 90, 'RU:motorway': 110, 'RU:living_street': 20, walk: 7 };
  return d[v] ?? null;
}
export const SPEED_QUICK = [20, 30, 40, 50, 60, 70, 80];
export const SPEED_CATS: Cat[] = [
  { key: 's20', label: '≤ 20', color: '#2e7d32' }, { key: 's30', label: '30', color: '#66bb6a' },
  { key: 's40', label: '40', color: '#cddc39' }, { key: 's50', label: '50', color: '#fdd835' },
  { key: 's60', label: '60', color: '#ff9800' }, { key: 's70', label: '70', color: '#f4511e' },
  { key: 's80', label: '80 и выше', color: '#b71c1c' }, { key: 'sn', label: 'maxspeed не задан', color: '#b0b0b0' },
];
const speedCat = (t: Tags) => {
  const v = speedKmh(t);
  const k = v === null ? 'sn' : v <= 20 ? 's20' : v <= 30 ? 's30' : v <= 40 ? 's40' : v <= 50 ? 's50' : v <= 60 ? 's60' : v <= 70 ? 's70' : 's80';
  return SPEED_CATS.find(c => c.key === k)!;
};

// ---------- общий вход ----------
export function categorize(mode: ColorMode, t: Tags): RoadCat {
  const dash = isPed(t) || isTram(t);
  if (mode === 'class') return { ...classCat(classKey(t)), dash };
  if (isTram(t) || (isPed(t) && mode !== 'surface')) return { ...classCat(classKey(t)), dash };
  const c = mode === 'lanes' ? laneCat(t) : mode === 'surface' ? surfaceCat(t) : speedCat(t);
  return { ...c, dash };
}
/** Все категории режима в порядке показа в легенде. */
export function catalog(mode: ColorMode): Cat[] {
  const ped = [classCat('ped'), classCat('steps'), classCat('tram')];
  if (mode === 'class') return CLASS_CATS;
  if (mode === 'lanes') return [...LANE_CATS, ...ped];
  if (mode === 'surface') return [...SURFACES.map(s => ({ key: s.value, label: s.label, color: s.color })), SURF_OTHER, SURF_NONE, classCat('tram')];
  return [...SPEED_CATS, ...ped];
}
/** Ширина линии в «условных метрах»: ~3.2 на полосу. */
export function lineWidth(t: Tags): number {
  if (isTram(t)) return 2.2;
  if (isPed(t)) return 1.6;
  const n = parseInt(t.lanes);
  return Math.max(1, !isNaN(n) && n > 0 ? n : onewayDir(t) ? 1 : 2) * 3.2;
}

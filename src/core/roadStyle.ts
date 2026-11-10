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
/** Подземный пешеходный переход (подземка): пешеходная линия в тоннеле. */
export const isUnderpass = (t: Tags) => isPed(t) && !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
export const isDrawn = (t: Tags) => !!t.highway || t.railway === 'tram';

export interface ClassCat extends Cat { dash: boolean; hw: string }
const C = (hw: string, label: string, color: string, dash = false): ClassCat => ({ key: hw, hw, label, color, dash });
/** Каждый вид дороги: свой цвет. Съезды (_link) — светлый оттенок цвета «родительского» класса. Ключ категории = значение highway. */
export const CLASS_CATS: ClassCat[] = [
  C('motorway', 'Автомагистраль (motorway)', '#e11d48'),
  C('motorway_link', 'Съезд motorway', '#fb7185'),
  C('trunk', 'Скоростная (trunk)', '#f97316'),
  C('trunk_link', 'Съезд trunk', '#fdba74'),
  C('primary', 'Главная (primary)', '#facc15'),
  C('primary_link', 'Съезд primary', '#fef08a'),
  C('secondary', 'Второстепенная (secondary)', '#a3e635'),
  C('secondary_link', 'Съезд secondary', '#d9f99d'),
  C('tertiary', 'Местная (tertiary)', '#10b981'),
  C('tertiary_link', 'Съезд tertiary', '#6ee7b7'),
  C('unclassified', 'Прочая (unclassified)', '#e5e7eb'),
  C('residential', 'Жилая улица (residential)', '#38bdf8'),
  C('living_street', 'Двор, жилая зона (living_street)', '#6366f1'),
  C('service', 'Служебный проезд (service)', '#94a3b8'),
  C('parking', 'Парковка: проезды (service=parking_aisle)', '#a21caf'),
  C('track', 'Грунтовая дорога (track)', '#a16207'),
  C('underpass', 'Подземный пеш. переход (tunnel, пунктир)', '#8b5cf6', true),
  C('pedestrian', 'Пешеходная улица (пунктир)', '#f0abfc', true),
  C('footway', 'Тротуар, дорожка (footway, пунктир)', '#ec4899', true),
  C('path', 'Тропа (path, пунктир)', '#c4b5fd', true),
  C('cycleway', 'Велодорожка (cycleway, пунктир)', '#2dd4bf', true),
  C('bridleway', 'Конная тропа (bridleway, пунктир)', '#d6a77a', true),
  C('steps', 'Лестница (steps, пунктир)', '#f59e0b', true),
  C('tram', 'Трамвай (пунктир)', '#d0d0d0', true),
  C('other', 'Прочее (construction и др.)', '#c49a6c'),
];
const classCat = (key: string) => CLASS_CATS.find(c => c.key === key)!;
export function classKey(t: Tags): string {
  if (isTram(t)) return 'tram';
  const h = t.highway ?? '';
  if (isUnderpass(t)) return 'underpass';
  if (h === 'service' && t.service === 'parking_aisle') return 'parking';
  return CLASS_CATS.some(c => c.key === h && h !== 'other' && h !== 'tram' && h !== 'parking' && h !== 'underpass') ? h : 'other';
}

/** Пять видов съездов: чем отличаются и когда какой ставить. */
export interface LinkInfo { value: string; parent: string; short: string; when: string }
export const LINK_INFO: LinkInfo[] = [
  { value: 'motorway_link', parent: 'motorway', short: 'Съезд автомагистрали', when: 'Въезд на автомагистраль и выезд с неё (развязки, где нет светофоров и пересечений в одном уровне). Односторонний.' },
  { value: 'trunk_link', parent: 'trunk', short: 'Съезд скоростной дороги', when: 'Рампа, соединяющая скоростную дорогу (trunk) с другими дорогами: путепроводные развязки, въезды на мост.' },
  { value: 'primary_link', parent: 'primary', short: 'Съезд главной дороги', when: 'Поворотный «рукав» или рампа главной улицы: отдельная полоса правого поворота, съезд с путепровода на городскую улицу.' },
  { value: 'secondary_link', parent: 'secondary', short: 'Съезд второстепенной', when: 'То же для второстепенных улиц: короткие повороты, отделённые островком, выезды с развязок меньшего масштаба.' },
  { value: 'tertiary_link', parent: 'tertiary', short: 'Съезд местной дороги', when: 'Мелкие соединительные участки у местных дорог: канализированные повороты, примыкания.' },
];
export const LINK_RULE = 'Класс съезда = класс более высокой из двух дорог, которые он соединяет (например, съезд с primary на residential — primary_link). Это влияет на приоритет в симуляторах и на то, как редактор раскрашивает карту. Рёбра *_link — всегда короткие соединительные участки; если участок длинный и это обычная улица, ставьте её собственный класс.';
const RANK_ORDER = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
/** Какого вида должен быть съезд, соединяющий дороги с данными highway. null — не из чего вывести. */
export function recommendLink(connected: string[]): string | null {
  let best = RANK_ORDER.length;
  for (const h of connected) { const i = RANK_ORDER.indexOf(h.replace(/_link$/, '')); if (i >= 0 && i < best) best = i; }
  // съезды бывают только до tertiary включительно: для unclassified и ниже берём tertiary_link
  if (best >= RANK_ORDER.length) return null;
  return RANK_ORDER[Math.min(best, 4)] + '_link';
}
/** Пункты списка класса, которые задаются набором тегов, а не одним highway. */
export const PSEUDO_CLASSES: Record<string, { set: Tags; clear: string[]; cat: string }> = {
  'service:parking_aisle': { set: { highway: 'service', service: 'parking_aisle' }, clear: ['service'], cat: 'parking' },
  'footway:underpass': { set: { highway: 'footway', tunnel: 'yes', layer: '-1' }, clear: ['tunnel', 'layer'], cat: 'underpass' },
};
export function hwKey(t: Tags): string {
  if (t.highway === 'footway' && isUnderpass(t)) return 'footway:underpass';
  if (t.highway === 'service' && t.service === 'parking_aisle') return 'service:parking_aisle';
  return t.highway ?? '';
}
export const HIGHWAY_CLASSES: { value: string; label: string; group: string }[] = [
  { value: 'motorway', label: 'Автомагистраль (motorway)', group: 'Основные дороги' }, { value: 'trunk', label: 'Скоростная (trunk)', group: 'Основные дороги' },
  { value: 'primary', label: 'Главная (primary)', group: 'Основные дороги' }, { value: 'secondary', label: 'Второстепенная (secondary)', group: 'Основные дороги' },
  { value: 'tertiary', label: 'Местная (tertiary)', group: 'Основные дороги' }, { value: 'unclassified', label: 'Прочая (unclassified)', group: 'Основные дороги' },
  { value: 'residential', label: 'Жилая улица (residential)', group: 'Улицы и проезды' }, { value: 'living_street', label: 'Двор, жилая зона (living_street)', group: 'Улицы и проезды' },
  { value: 'service', label: 'Служебный проезд (service)', group: 'Улицы и проезды' }, { value: 'service:parking_aisle', label: 'Парковка: проезд между местами (service=parking_aisle)', group: 'Улицы и проезды' },
  { value: 'track', label: 'Грунтовая дорога (track)', group: 'Улицы и проезды' },
  ...LINK_INFO.map(l => ({ value: l.value, label: `${l.short} (${l.value})`, group: 'Съезды / рампы (*_link)' })),
  { value: 'footway:underpass', label: 'Подземный пешеходный переход (подземка)', group: 'Пешеходные' },
  { value: 'pedestrian', label: 'Пешеходная улица', group: 'Пешеходные' }, { value: 'footway', label: 'Пешеходная дорожка (footway)', group: 'Пешеходные' },
  { value: 'path', label: 'Тропа (path)', group: 'Пешеходные' }, { value: 'cycleway', label: 'Велодорожка (cycleway)', group: 'Пешеходные' }, { value: 'steps', label: 'Лестница (steps)', group: 'Пешеходные' },
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
  const ped = CLASS_CATS.filter(c => c.dash);
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

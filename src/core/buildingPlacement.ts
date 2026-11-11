
import type { Doc } from './types.ts';

export interface BuildingPoint {
  lat: number;
  lon: number;
}

interface Point {
  x: number;
  y: number;
}

const EARTH = 6371000;

function project(p: BuildingPoint, lat0: number): Point {
  const rad = Math.PI / 180;

  return {
    x: EARTH * p.lon * rad * Math.cos(lat0 * rad),
    y: EARTH * p.lat * rad
  };
}

function cross(a: Point, b: Point, c: Point): number {
  return (
    (b.x - a.x) * (c.y - a.y) -
    (b.y - a.y) * (c.x - a.x)
  );
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  const eps = 1e-7;

  return (
    Math.abs(cross(a, b, p)) < eps &&
    p.x >= Math.min(a.x, b.x) - eps &&
    p.x <= Math.max(a.x, b.x) + eps &&
    p.y >= Math.min(a.y, b.y) - eps &&
    p.y <= Math.max(a.y, b.y) + eps
  );
}

function segmentsIntersect(
  a: Point,
  b: Point,
  c: Point,
  d: Point
): boolean {
  const o1 = cross(a, b, c);
  const o2 = cross(a, b, d);
  const o3 = cross(c, d, a);
  const o4 = cross(c, d, b);

  if (
    ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
  ) {
    return true;
  }

  return (
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;

  for (
    let i = 0, j = polygon.length - 1;
    i < polygon.length;
    j = i++
  ) {
    const a = polygon[i];
    const b = polygon[j];

    if (onSegment(a, b, p)) return true;

    const crosses =
      (a.y > p.y) !== (b.y > p.y) &&
      p.x < (
        (b.x - a.x) * (p.y - a.y) /
        (b.y - a.y) + a.x
      );

    if (crosses) inside = !inside;
  }

  return inside;
}

function pointSegmentDistance(
  p: Point,
  a: Point,
  b: Point
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const len2 = dx * dx + dy * dy;

  if (len2 === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    )
  );

  const x = a.x + t * dx;
  const y = a.y + t * dy;

  return Math.hypot(p.x - x, p.y - y);
}

function segmentDistance(
  a: Point,
  b: Point,
  c: Point,
  d: Point
): number {
  if (segmentsIntersect(a, b, c, d)) return 0;

  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b)
  );
}

function normalizePolygon(points: Point[]): Point[] {
  const result = [...points];

  if (result.length > 1) {
    const a = result[0];
    const b = result[result.length - 1];

    if (
      Math.abs(a.x - b.x) < 1e-7 &&
      Math.abs(a.y - b.y) < 1e-7
    ) {
      result.pop();
    }
  }

  return result;
}

function polygonsIntersect(
  a: Point[],
  b: Point[]
): boolean {
  if (a.length < 3 || b.length < 3) return false;

  // Проверяем пересечение границ.
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];

    for (let j = 0; j < b.length; j++) {
      const b1 = b[j];
      const b2 = b[(j + 1) % b.length];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  // Проверяем случай, когда один полигон целиком внутри другого.
  return (
    pointInPolygon(a[0], b) ||
    pointInPolygon(b[0], a)
  );
}

function roadIntersectsPolygon(
  road: Point[],
  polygon: Point[],
  roadMargin = 3.5
): boolean {
  if (road.length < 2 || polygon.length < 3) return false;

  for (let i = 0; i < road.length - 1; i++) {
    const a = road[i];
    const b = road[i + 1];

    // Дорога проходит через здание.
    if (
      pointInPolygon(a, polygon) ||
      pointInPolygon(b, polygon)
    ) {
      return true;
    }

    for (let j = 0; j < polygon.length; j++) {
      const c = polygon[j];
      const d = polygon[(j + 1) % polygon.length];

      // Дорога пересекает границу здания
      // или проходит слишком близко к ней.
      if (segmentDistance(a, b, c, d) < roadMargin) {
        return true;
      }
    }
  }

  return false;
}

function getWayPoints(
  doc: Doc,
  nodeIds: number[],
  lat0: number
): Point[] {
  return nodeIds
    .map(id => doc.nodes.get(id))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map(n => project(n, lat0));
}

/**
 * Проверяет, можно ли разместить здание.
 *
 * excludeWayId используется при перемещении вершин
 * уже существующего здания.
 */
export function validateBuildingPlacement(
  doc: Doc,
  points: BuildingPoint[],
  excludeWayId?: number
): string | null {
  if (points.length < 3) {
    return 'Для здания необходимо минимум 3 вершины';
  }

  const lat0 =
    points.reduce((sum, p) => sum + p.lat, 0) /
    points.length;

  const candidate = normalizePolygon(
    points.map(p => project(p, lat0))
  );

  if (candidate.length < 3) {
    return 'Некорректный контур здания';
  }

  // Проверка самопересечения контура.
  for (let i = 0; i < candidate.length; i++) {
    const a = candidate[i];
    const b = candidate[(i + 1) % candidate.length];

    for (let j = i + 1; j < candidate.length; j++) {
      if (
        j === i ||
        j === (i + 1) % candidate.length ||
        (j + 1) % candidate.length === i
      ) {
        continue;
      }

      const c = candidate[j];
      const d = candidate[(j + 1) % candidate.length];

      if (segmentsIntersect(a, b, c, d)) {
        return 'Контур здания пересекает сам себя';
      }
    }
  }

  for (const way of doc.ways.values()) {
    if (way.id === excludeWayId) continue;

    const isBuilding =
      !!way.tags.building &&
      way.tags.building !== 'no';

    const isRoad =
      !!way.tags.highway ||
      !!way.tags.railway;

    if (!isBuilding && !isRoad) continue;

    const other = normalizePolygon(
      getWayPoints(doc, way.nodes, lat0)
    );

    if (isBuilding && other.length >= 3) {
      if (polygonsIntersect(candidate, other)) {
        return 'Здание пересекает или накладывается на другое здание';
      }
    }

    if (isRoad && other.length >= 2) {
      if (roadIntersectsPolygon(other, candidate)) {
        return 'Здание пересекает дорогу или расположено слишком близко к ней';
      }
    }
  }

  return null;
}

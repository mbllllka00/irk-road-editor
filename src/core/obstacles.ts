
import type { Doc } from './types.ts';
import { segIntersect } from './geo.ts';

interface Point {
  lat: number;
  lon: number;
}

// Проверка: находится ли точка внутри полигона
function pointInPolygon(
  p: Point,
  polygon: Point[]
): boolean {
  let inside = false;

  for (
    let i = 0, j = polygon.length - 1;
    i < polygon.length;
    j = i++
  ) {
    const a = polygon[i];
    const b = polygon[j];

    const intersect =
      ((a.lat > p.lat) !== (b.lat > p.lat)) &&
      (p.lon <
        (b.lon - a.lon) *
        (p.lat - a.lat) /
        (b.lat - a.lat) +
        a.lon);

    if (intersect) inside = !inside;
  }

  return inside;
}

// Проверка линии на пересечение с контурами зданий
export function lineCrossesBuilding(
  doc: Doc,
  points: Point[]
): boolean {

  const buildings = [...doc.ways.values()]
    .filter(w => w.tags.building && w.nodes.length >= 4)
    .map(w =>
      w.nodes
        .map(id => doc.nodes.get(id))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map(n => ({ lat: n.lat, lon: n.lon }))
    )
    .filter(p => p.length >= 4);

  for (const building of buildings) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];

      // Если середина сегмента находится внутри здания
      const middle = {
        lat: (a.lat + b.lat) / 2,
        lon: (a.lon + b.lon) / 2
      };

      if (pointInPolygon(middle, building)) {
        return true;
      }

      // Если сегмент пересекает границу здания
      for (let j = 0; j < building.length; j++) {
        const c = building[j];
        const d = building[(j + 1) % building.length];

        if (segIntersect(a, b, c, d)) {
          return true;
        }
      }
    }

    // Также проверяем, не находится ли точка линии внутри здания
    for (const p of points) {
      if (pointInPolygon(p, building)) {
        return true;
      }
    }
  }

  return false;
}

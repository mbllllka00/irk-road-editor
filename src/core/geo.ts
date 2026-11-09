// [P1] Геометрия на малых расстояниях (фрагмент города): локальная проекция.
export interface LL { lat: number; lon: number }
const M_LAT = 110574, M_LON = 111320;

export function dist(a: LL, b: LL): number {
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * M_LAT, (a.lon - b.lon) * M_LON * k);
}

/** Проекция точки p на отрезок a-b. */
export function projectOnSegment(p: LL, a: LL, b: LL): { lat: number; lon: number; t: number; d: number } {
  const k = Math.cos(p.lat * Math.PI / 180);
  const ax = a.lon * M_LON * k, ay = a.lat * M_LAT, bx = b.lon * M_LON * k, by = b.lat * M_LAT;
  const px = p.lon * M_LON * k, py = p.lat * M_LAT;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  const lat = a.lat + (b.lat - a.lat) * t, lon = a.lon + (b.lon - a.lon) * t;
  return { lat, lon, t, d: dist(p, { lat, lon }) };
}

/** Пересечение отрезков a-b и c-d (включая касание концом). */
export function segIntersect(a: LL, b: LL, c: LL, d: LL): LL | null {
  const rx = b.lon - a.lon, ry = b.lat - a.lat, sx = d.lon - c.lon, sy = d.lat - c.lat;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-18) return null;
  const qx = c.lon - a.lon, qy = c.lat - a.lat;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { lat: a.lat + ry * t, lon: a.lon + rx * t };
}

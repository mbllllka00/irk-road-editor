// Время максимальной загрузки участка. Не стандартный тег OSM: хранится как пользовательский peak_hours
// («07:30-09:30;17:00-19:00»). Адаптеры SUMO/MatSim его не читают, он нужен как справочная метка и для отчётов.
export const PEAK_TAG = 'peak_hours';
export const PEAK_PRESETS: [string, string][] = [
  ['Утро 07:30–09:30', '07:30-09:30'], ['Вечер 17:00–19:00', '17:00-19:00'], ['Утро + вечер', '07:30-09:30;17:00-19:00'], ['Весь день', '07:00-21:00'],
];
const T = /^(\d{1,2})(?::?(\d{2}))?$/;
function hm(s: string): string | null {
  const m = s.trim().match(T); if (!m) return null;
  const h = +m[1], mi = m[2] ? +m[2] : 0;
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
/** Приводит ввод к виду «HH:MM-HH:MM;…». Допускает «7-9», «7:30–9:30», разделители «,» и «;». Ошибка → null. */
export function normalizePeak(input: string): string | null {
  const parts = input.split(/[;,]/).map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: string[] = [];
  for (const p of parts) {
    const ab = p.split(/\s*[-–—]\s*/);
    if (ab.length !== 2) return null;
    const a = hm(ab[0]), b = hm(ab[1]);
    if (!a || !b || a === b) return null;
    out.push(a + '-' + b);
  }
  return out.join(';');
}

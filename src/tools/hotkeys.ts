// [P3] Горячие клавиши. Ключи: 'v', 'ctrl+z', 'ctrl+shift+z', 'delete', 'enter', 'escape'.
export function bindHotkeys(map: Record<string, () => void>) {
  window.addEventListener('keydown', e => {
    const el = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
    let k = e.key.toLowerCase();
    if (k === ' ') k = 'space';
    const code = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : k; // работает и в русской раскладке
    const name = (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') + (code.length === 1 ? code : k);
    const fn = map[name] ?? map[name.replace('shift+', '')];
    if (fn) { e.preventDefault(); fn(); }
  });
}
export const HELP: [string, string][] = [
  ['V', 'Выбор / перемещение узлов выбранного ребра'], ['N', 'Добавить узел (на ребре — вставка, делает перекрёсток)'],
  ['W', 'Нарисовать ребро (Enter/двойной клик — завершить, Esc — отмена)'], ['X', 'Разрезать ребро (клик по узлу или точке ребра)'],
  ['C', 'Склеить два узла (клик по первому, затем по второму)'], ['M', 'Слить два выбранных ребра'],
  ['T', 'Метка по смыслу: скорость, полосы, направление, покрытие, лестница, переход, знаки'], ['U', 'Починить участок линии без перечерчивания'], ['L', 'Выбрать всю линию'],
  ['R', 'Развернуть направление ребра'], ['O', 'Переключить oneway (двустороннее ↔ одностороннее)'],
  ['S', 'Светофор на выбранном узле'], ['B', 'Мост (bridge=yes, layer=1)'], ['F', 'Плавная высота ele по ребру'],
  ['Alt+C', 'Скопировать атрибуты с первого выбранного ребра на остальные'], ['Delete', 'Удалить выбранное'],
  ['Shift+клик', 'Добавить к выделению'], ['Ctrl+Z / Ctrl+Shift+Z', 'Отмена / повтор'], ['Ctrl+S / Ctrl+O', 'Сохранить / открыть'],
  ['K', 'Сменить раскраску: класс → полосы → покрытие → скорость'], ['3', 'Псевдо-3D'], ['E', 'Следующая ошибка'], ['?', 'Эта справка'],
];

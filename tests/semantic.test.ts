import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc } from '../src/core/types.ts';
import type { Doc, Tags } from '../src/core/types.ts';
import { buildLines, lineOfWay, describeLine } from '../src/semantic/lines.ts';
import * as M from '../src/semantic/marks.ts';
import { compileForExport, normalize } from '../src/semantic/compile.ts';
import { validate } from '../src/validator/validate.ts';
import { serializeOsm } from '../src/core/osm.ts';

const LAT = 52.28, LON = 104.28, DL = 0.001; // 0.001° lat ≈ 110 м
function mk(): { d: Doc; n: (id: number, y: number, x: number) => void; w: (id: number, ns: number[], t: Tags) => void } {
  const d = newDoc();
  return {
    d,
    n: (id, y, x) => d.nodes.set(id, { id, lat: LAT + y * DL, lon: LON + x * DL * 1.6, tags: {}, attrs: { version: '1' } }),
    w: (id, ns, t) => d.ways.set(id, { id, nodes: ns, tags: { ...t }, attrs: { version: '1' } }),
  };
}
/** Главная дорога: 5 узлов с запада на восток (3 ребра), боковая улица упирается в узел 3. */
function scene() {
  const s = mk();
  for (let i = 1; i <= 5; i++) s.n(i, 0, i - 1);
  s.n(6, 1, 2);
  s.w(10, [1, 2, 3], { highway: 'primary', lanes: '2' });
  s.w(11, [3, 4, 5], { highway: 'primary', lanes: '2' });
  s.w(12, [6, 3], { highway: 'residential' });
  return s.d;
}
const at = (d: Doc, wayId: number, frac: number) => { // точка на ребре, frac по первому-последнему узлу
  const w = d.ways.get(wayId)!, a = d.nodes.get(w.nodes[0])!, b = d.nodes.get(w.nodes[w.nodes.length - 1])!;
  return { wayId, lat: a.lat + (b.lat - a.lat) * frac, lon: a.lon + (b.lon - a.lon) * frac };
};

test('линия проходит сквозь Т-перекрёсток, боковая улица остаётся отдельной', () => {
  const d = scene(), lines = buildLines(d);
  assert.equal(lines.length, 2);
  const main = lines.find(l => l.segs.length === 2)!;
  assert.equal(main.nodes.length, 5);
  assert.ok(main.total > 200);
});

test('тротуар и дорога не склеиваются в одну линию', () => {
  const s = mk(); s.n(1, 0, 0); s.n(2, 0, 1); s.n(3, 0, 2);
  s.w(1, [1, 2], { highway: 'residential' }); s.w(2, [2, 3], { highway: 'footway' });
  assert.equal(buildLines(s.d).length, 2);
});

test('«тут 40»: участок режется, остальное не трогается, повтор склеивает обратно', () => {
  const d = scene();
  const r = M.applyRange(d, at(d, 10, 0.25), at(d, 11, 0.75), { tags: { maxspeed: '40' } });
  assert.equal(r.err, undefined);
  const l = lineOfWay(d, 10)!;
  const { runs } = describeLine(d, l);
  assert.equal(runs.length, 3);
  assert.equal(runs[1].maxspeed, '40');
  assert.equal(runs[0].maxspeed, '');
  // вся линия 40 → единый run, рёбра склеиваются
  assert.equal(M.applyWhole(d, 10, { tags: { maxspeed: '40' } }).err, undefined);
  assert.equal(describeLine(d, lineOfWay(d, 10)!).runs.length, 1);
  // на перекрёстке (узел 3) рёбра остаются разрезанными — так и должно быть в OSM
  assert.equal([...d.ways.values()].filter(w => w.tags.highway === 'primary').length, 2);
});

test('направление задаётся порядком клика: от 1-й точки ко 2-й и наоборот', () => {
  const d = scene();
  M.applyRange(d, at(d, 10, 0.2), at(d, 10, 0.8), { oneway: 'forward' });
  let l = lineOfWay(d, 10)!;
  let run = describeLine(d, l).runs.find(r => r.dir !== 'both')!;
  assert.ok(run);
  // клик с востока на запад: движение против порядка узлов
  const d2 = scene();
  M.applyRange(d2, at(d2, 11, 0.8), at(d2, 10, 0.2), { oneway: 'forward' });
  const ow = [...d2.ways.values()].find(w => w.tags.oneway === 'yes')!;
  const first = d2.nodes.get(ow.nodes[0])!, last = d2.nodes.get(ow.nodes[ow.nodes.length - 1])!;
  assert.ok(first.lon > last.lon, 'после канонизации порядок узлов — с востока на запад');
});

test('лестница на тротуаре: пара начало–конец', () => {
  const s = mk(); for (let i = 1; i <= 3; i++) s.n(i, 0, i - 1);
  s.w(1, [1, 2, 3], { highway: 'footway' });
  const r = M.applyRange(s.d, at(s.d, 1, 0.3), at(s.d, 1, 0.6), { tags: { highway: 'steps' } });
  assert.equal(r.err, undefined);
  assert.equal([...s.d.ways.values()].filter(w => w.tags.highway === 'steps').length, 1);
  assert.equal(describeLine(s.d, lineOfWay(s.d, 1)!).runs.length, 3);
});

test('переход: регулируемый и нерегулируемый', () => {
  const d = scene();
  assert.equal(M.addCrossing(d, at(d, 10, 0.5), true).err, undefined);
  const n = [...d.nodes.values()].find(x => x.tags.highway === 'crossing')!;
  assert.equal(n.tags.crossing, 'traffic_signals');
  assert.equal(n.tags['crossing:signals'], 'yes');
  const d2 = scene(); M.addCrossing(d2, at(d2, 10, 0.5), false);
  assert.equal([...d2.nodes.values()].find(x => x.tags.highway === 'crossing')!.tags.crossing, 'uncontrolled');
});

test('«здесь уступи»: знак за 5 м до перекрёстка, направление считается само', () => {
  const d = scene();
  const click = at(d, 12, 0.3); // боковая улица 6→3, клик ближе к началу, перекрёсток впереди
  const ap = M.findApproach(d, click)!;
  assert.equal(ap.nodeId, 3);
  assert.equal(ap.others.length, 1);
  const r = M.addSign(d, click, 'give_way');
  assert.equal(r.err, undefined);
  const sign = [...d.nodes.values()].find(x => x.tags.highway === 'give_way')!;
  assert.equal(sign.tags.direction, 'forward'); // ребро 6→3, движение к перекрёстку по порядку узлов
  assert.match(sign.tags.note, /primary/);
  assert.deepEqual(d.ways.get(12)!.nodes.length, 3); // знак вставлен в ребро
  // если клик у самого перекрёстка, но по другой стороне ребра: то же перекрёсток
  const w = d.ways.get(12)!, p = d.nodes.get(w.nodes[1])!, j = d.nodes.get(3)!;
  const dd = Math.hypot((p.lat - j.lat) * 110574, (p.lon - j.lon) * 68000);
  assert.ok(dd > 3 && dd < 7, 'знак примерно в 5 м от перекрёстка: ' + dd);
});

test('уступаем дороге более низкого класса — предупреждение', () => {
  const d = scene(); d.ways.get(10)!.tags.highway = 'residential'; d.ways.get(11)!.tags.highway = 'residential'; d.ways.get(12)!.tags.highway = 'primary';
  const r = M.addSign(d, at(d, 12, 0.3), 'give_way');
  assert.match(r.msg!, /Внимание/);
});

test('починка участка: геометрия заменяется, атрибуты и боковая улица остаются', () => {
  const d = scene(); d.ways.get(10)!.tags.maxspeed = '60'; d.ways.get(11)!.tags.maxspeed = '60';
  const bend = { lat: LAT - 0.12 * DL, lon: LON + 2 * DL * 1.6 }; // обход южнее узла 3
  const r = M.replaceSection(d, at(d, 10, 0.5), at(d, 11, 0.5), [bend]);
  assert.equal(r.err, undefined, r.err);
  assert.match(r.msg!, /пристыковано/);
  const roads = [...d.ways.values()].filter(w => w.tags.highway === 'primary');
  assert.ok(roads.every(w => w.tags.maxspeed === '60' && w.tags.lanes === '2'));
  const side = d.ways.get(12)!;
  assert.ok(!side.nodes.includes(3) || d.nodes.has(3));
  // боковая улица по-прежнему связана с основной сетью
  assert.ok(!validate(d).some(i => i.kind === 'isolated'), JSON.stringify(validate(d).filter(i => i.kind === 'isolated')));
  assert.ok(!validate(d).some(i => i.kind === 'missing-node'));
});

test('экспорт: oneway=-1 канонизируется, полосы по направлениям, разметка', () => {
  const s = mk(); s.n(1, 0, 0); s.n(2, 0, 1); s.n(3, 1, 0); s.n(4, 1, 1);
  s.w(1, [1, 2], { highway: 'residential', oneway: '-1', lanes: '1', 'lanes:forward': '1' });
  s.w(2, [3, 4], { highway: 'primary', lanes: '4' });
  const rep = compileForExport(s.d);
  assert.equal(s.d.ways.get(1)!.tags.oneway, 'yes');
  assert.deepEqual(s.d.ways.get(1)!.nodes, [2, 1]);
  assert.equal(s.d.ways.get(1)!.tags['lanes:forward'], undefined);
  assert.equal(s.d.ways.get(2)!.tags['lanes:forward'], '2');
  assert.equal(s.d.ways.get(2)!.tags['lanes:backward'], '2');
  assert.equal(s.d.ways.get(2)!.tags.lane_markings, 'yes');
  assert.ok(rep.flipped === 1 && rep.lanesDerived === 1);
  assert.match(serializeOsm(s.d), /<tag k="lane_markings" v="yes"\/>/);
});

test('нормализация не склеивает рёбра с метками в узле и из restriction', () => {
  const d = scene();
  d.nodes.get(3)!.tags.highway = 'give_way';
  assert.equal(normalize(d), 0);
});

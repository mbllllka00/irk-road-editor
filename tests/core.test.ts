import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc } from '../src/core/types.ts';
import { serializeOsm } from '../src/core/osm.ts';
import { validate } from '../src/validator/validate.ts';
import * as ops from '../src/tools/ops.ts';

function grid() {
  // перекрёсток из двух дорог: A(0,0)-C(0,1)-B(0,2) и D(-1,1)-C-E(1,1); C — общий узел
  const d = newDoc();
  const n = (id: number, lat: number, lon: number) => d.nodes.set(id, { id, lat: 52 + lat * 0.001, lon: 104 + lon * 0.001, tags: {}, attrs: { version: '1' } });
  n(1, 0, 0); n(2, 0, 1); n(3, 0, 2); n(4, -1, 1); n(5, 1, 1);
  d.ways.set(10, { id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' }, attrs: { version: '3' } });
  d.ways.set(11, { id: 11, nodes: [4, 2, 5], tags: { highway: 'residential' }, attrs: { version: '1' } });
  return d;
}

test('чистый граф без ошибок', () => {
  assert.equal(validate(grid()).filter(i => i.severity === 'error').length, 0);
});
test('пересечение без общего узла', () => {
  const d = grid(); ops.splitWay(d, 11, 2); d.ways.get(11)!.nodes = [4, 5]; d.ways.delete(-1);
  d.ways.get(10)!.nodes = [1, 3];
  assert.ok(validate(d).some(i => i.kind === 'crossing'));
});
test('oneway-ловушка', () => {
  const d = grid(); d.ways.get(10)!.tags.oneway = 'yes';
  assert.ok(validate(d).some(i => i.kind === 'oneway-sink'));
});
test('изолированный участок', () => {
  const d = grid();
  d.nodes.set(20, { id: 20, lat: 52.1, lon: 104.1, tags: {}, attrs: {} }); d.nodes.set(21, { id: 21, lat: 52.1, lon: 104.101, tags: {}, attrs: {} });
  d.ways.set(12, { id: 12, nodes: [20, 21], tags: { highway: 'service' }, attrs: {} });
  assert.ok(validate(d).some(i => i.kind === 'isolated'));
});
test('split / merge / reverse', () => {
  const d = grid();
  assert.equal(ops.splitWay(d, 10, 2), null);
  const nw = [...d.ways.keys()].find(k => k < 0)!;
  assert.deepEqual(d.ways.get(10)!.nodes, [1, 2]);
  assert.deepEqual(d.ways.get(nw)!.nodes, [2, 3]);
  assert.equal(ops.mergeWays(d, 10, nw), null);
  assert.deepEqual(d.ways.get(10)!.nodes, [1, 2, 3]);
  assert.ok(ops.reverseWay(d, 10)); // двустороннее → ошибка
  ops.setOneway(d, [10], 'yes'); d.ways.get(10)!.tags['lanes:forward'] = '2';
  assert.equal(ops.reverseWay(d, 10), null);
  assert.deepEqual(d.ways.get(10)!.nodes, [3, 2, 1]);
  assert.equal(d.ways.get(10)!.tags['lanes:backward'], '2');
});
test('склейка узлов', () => {
  const d = grid(); const id = ops.addNode(d, 52, 104.001);
  d.ways.set(13, { id: 13, nodes: [id, 5], tags: { highway: 'service' }, attrs: {} });
  assert.ok(validate(d).some(i => i.kind === 'duplicate-nodes'));
  assert.equal(ops.mergeNodes(d, 2, id), null);
  assert.ok(!validate(d).some(i => i.kind === 'duplicate-nodes'));
});
test('сериализация: version+1 и отрицательные id', () => {
  const d = grid(); ops.setTag(d.ways.get(10)!, 'lanes', '2');
  const nid = ops.addNode(d, 52, 104);
  const xml = serializeOsm(d);
  assert.match(xml, /<way id="10" version="4" action="modify">/);
  assert.match(xml, new RegExp(`<node id="${nid}"`));
  assert.match(xml, /<tag k="lanes" v="2"\/>/);
});

import { categorize, speedKmh, surfaceCat, lineWidth, recommendLink, CLASS_CATS } from '../src/core/roadStyle.ts';
test('раскраска: класс, пешеходные с пунктиром', () => {
  assert.equal(categorize('class', { highway: 'primary' }).key, 'primary');
  assert.equal(categorize('class', { highway: 'primary' }).color, '#facc15');
  assert.notEqual(categorize('class', { highway: 'primary_link' }).color, categorize('class', { highway: 'primary' }).color);
  assert.equal(categorize('class', { highway: 'trunk' }).key, 'trunk');
  assert.equal(recommendLink(['primary', 'residential']), 'primary_link');
  assert.equal(recommendLink(['residential', 'service']), 'tertiary_link');
  assert.equal(recommendLink([]), null);
  assert.equal(new Set(CLASS_CATS.map(c => c.color)).size, CLASS_CATS.length);
  assert.equal(categorize('class', { highway: 'footway' }).dash, true);
  assert.equal(categorize('class', { highway: 'residential' }).dash, false);
  assert.equal(categorize('class', { railway: 'tram' }).key, 'tram');
});
test('раскраска: полосы, покрытие, скорость', () => {
  assert.equal(categorize('lanes', { highway: 'residential', lanes: '2' }).key, 'l2');
  assert.equal(categorize('lanes', { highway: 'residential', lanes: '6' }).key, 'l4');
  assert.equal(categorize('lanes', { highway: 'residential' }).key, 'ln');
  assert.equal(surfaceCat({}).key, 'none');
  assert.equal(surfaceCat({ surface: 'fine_gravel' }).key, 'gravel');
  assert.equal(surfaceCat({ surface: 'lava' }).key, 'other');
  assert.equal(categorize('surface', { highway: 'service', surface: 'asphalt' }).key, 'asphalt');
  assert.equal(categorize('speed', { highway: 'residential', maxspeed: '40' }).key, 's40');
  assert.equal(categorize('speed', { highway: 'residential', maxspeed: '90' }).key, 's80');
  assert.equal(categorize('speed', { highway: 'residential' }).key, 'sn');
});
test('скорость: форматы maxspeed', () => {
  assert.equal(speedKmh({ maxspeed: '60' }), 60);
  assert.equal(speedKmh({ maxspeed: '30 mph' }), 48);
  assert.equal(speedKmh({ maxspeed: 'RU:urban' }), 60);
  assert.equal(speedKmh({ 'maxspeed:forward': '50' }), 50);
  assert.equal(speedKmh({ maxspeed: 'abc' }), null);
  assert.equal(speedKmh({}), null);
});
test('ширина линии зависит от полос', () => {
  assert.ok(lineWidth({ highway: 'primary', lanes: '4' }) > lineWidth({ highway: 'primary', lanes: '2' }));
  assert.ok(lineWidth({ highway: 'footway' }) < lineWidth({ highway: 'service' }));
});
test('валидатор: maxspeed вне диапазона', () => {
  const d = grid(); d.ways.get(10)!.tags.maxspeed = '300';
  assert.ok(validate(d).some(i => i.kind === 'maxspeed-range'));
});

import { snapshotTags, pasteTags, copyTags, TEMPLATES, templateTags, addNode, addWay } from '../src/tools/ops.ts';
test('парковочный проезд: своя категория и шаблон', () => {
  assert.equal(categorize('class', { highway: 'service', service: 'parking_aisle' }).key, 'parking');
  assert.equal(categorize('class', { highway: 'service' }).key, 'service');
  assert.equal(templateTags('Парковка: проезд между местами').service, 'parking_aisle');
  assert.equal(TEMPLATES['Улица: 2 полосы, двустороннее'].service, '');
});
test('копирование характеристик: снимок, вставка, удаление отсутствующих тегов', () => {
  const d = newDoc(); const a = addNode(d, 0, 0), b = addNode(d, 0, 0.001), c = addNode(d, 0, 0.002);
  const w1 = addWay(d, [a, b], { highway: 'service', service: 'parking_aisle', maxspeed: '10', name: 'A' });
  const w2 = addWay(d, [b, c], { highway: 'primary', lanes: '4', maxspeed: '60', name: 'B' });
  const snap = snapshotTags(d, w1)!;
  d.ways.get(w1)!.tags.maxspeed = '99'; // правка источника после копирования не влияет на снимок
  assert.equal(pasteTags(d, [w2], snap), 1);
  const t = d.ways.get(w2)!.tags;
  assert.equal(t.highway, 'service'); assert.equal(t.service, 'parking_aisle'); assert.equal(t.maxspeed, '10');
  assert.equal(t.lanes, undefined); assert.equal(t.name, 'B'); // lanes удалён, name не копируется
  assert.equal(pasteTags(d, [w2], snap), 0); // повтор ничего не меняет
  assert.equal(copyTags(d, w1, [w1, w2]), 1); // источник пропускается, w2 получает уже изменённый maxspeed=99
});

import { ellipsePoints, shapeFromCorners } from '../src/core/geo.ts';
import { normalizePeak } from '../src/core/peak.ts';
test('кольцо: эллипс против часовой стрелки, рамка как в Paint', () => {
  const p = ellipsePoints(52, 104, 20, 10, 16);
  assert.equal(p.length, 16);
  assert.ok(p[0].lat > 52 && Math.abs(p[0].lon - 104) < 1e-9); // старт на севере
  assert.ok(p[4].lon < 104);                                      // дальше на запад: против часовой
  const s = shapeFromCorners({ lat: 52, lon: 104 }, { lat: 52.0002, lon: 104.0006 }, false);
  assert.ok(s.rx > s.ry);
  const c = shapeFromCorners({ lat: 52, lon: 104 }, { lat: 52.0002, lon: 104.0006 }, true);
  assert.ok(Math.abs(c.rx - c.ry) < 1e-6);
});
test('время пика: нормализация и ошибки', () => {
  assert.equal(normalizePeak('7-9'), '07:00-09:00');
  assert.equal(normalizePeak('7:30–9:30, 17-19'), '07:30-09:30;17:00-19:00');
  assert.equal(normalizePeak('25-26'), null);
  assert.equal(normalizePeak('abc'), null);
  assert.equal(normalizePeak('08:00-08:00'), null);
});

import { isUnderpass, hwKey, PSEUDO_CLASSES } from '../src/core/roadStyle.ts';
test('подземный пешеходный переход: отличается от тротуара', () => {
  const ug = { highway: 'footway', tunnel: 'yes', layer: '-1' };
  assert.equal(isUnderpass(ug), true);
  assert.equal(isUnderpass({ highway: 'footway' }), false);
  assert.equal(isUnderpass({ highway: 'footway', tunnel: 'building_passage' }), false);
  assert.equal(isUnderpass({ highway: 'primary', tunnel: 'yes' }), false); // дорожный тоннель — не подземка
  assert.equal(categorize('class', ug).key, 'underpass');
  assert.equal(categorize('class', ug).dash, true);
  assert.equal(categorize('lanes', ug).key, 'underpass');
  assert.equal(categorize('class', { highway: 'footway' }).key, 'footway');
  assert.equal(hwKey(ug), 'footway:underpass');
  assert.deepEqual(PSEUDO_CLASSES['footway:underpass'].clear, ['tunnel', 'layer']);
});

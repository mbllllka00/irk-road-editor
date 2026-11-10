import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc } from '../src/core/types.ts';
import { diffDocs } from '../src/core/diff.ts';
import { buildCompareFeatures } from '../src/core/compareMap.ts';
import { Store } from '../src/core/store.ts';

function network() {
  const d = newDoc();
  for (const [id, lon] of [[1, 104], [2, 104.001], [3, 104.002], [4, 104.003]]) {
    d.nodes.set(id, { id, lat: 52, lon, tags: {}, attrs: {} });
  }
  d.ways.set(10, { id: 10, nodes: [1, 2], tags: { highway: 'residential' }, attrs: {} });
  d.ways.set(11, { id: 11, nodes: [3, 4], tags: { highway: 'footway' }, attrs: {} });
  return d;
}

const byId = (items: ReturnType<typeof buildCompareFeatures>['roads'], id: number) => items.find(item => item.properties.id === id);

test('неизменённые дороги и ВСЕ узлы — серые независимо от выделения', () => {
  const original = network(), current = structuredClone(original);
  const f = buildCompareFeatures(original, current, diffDocs(original, current));
  assert.equal(f.roads.length, 2);
  assert.equal(f.nodes.length, 4);
  assert.ok(f.roads.every(x => x.properties.status === 'unchanged'));
  assert.ok(f.nodes.every(x => x.properties.status === 'unchanged'));
});

test('добавлено — зелёное, удалено — красное на старых координатах, изменено — синее', () => {
  const original = network(), current = structuredClone(original);
  current.nodes.get(2)!.lon = 105; // изменённый узел делает связанную дорогу синей
  current.nodes.delete(3);
  current.nodes.delete(4);
  current.ways.delete(11); // удалённое ребро отрисовано ИЗ оригинала
  current.nodes.set(-1, { id: -1, lat: 53, lon: 107, tags: {}, attrs: {} });
  current.nodes.set(-2, { id: -2, lat: 53, lon: 107.001, tags: {}, attrs: {} });
  current.ways.set(-3, { id: -3, nodes: [-1, -2], tags: { highway: 'service' }, attrs: {} });
  const f = buildCompareFeatures(original, current, diffDocs(original, current));
  assert.equal(byId(f.roads, 10)?.properties.status, 'modified');
  assert.equal(byId(f.roads, 11)?.properties.status, 'removed');
  assert.equal(byId(f.roads, -3)?.properties.status, 'added');
  assert.deepEqual(byId(f.roads, 11)?.geometry, { type: 'LineString', coordinates: [[104.002, 52], [104.003, 52]] });
  assert.equal(f.nodes.find(n => n.properties.id === 2)?.properties.status, 'modified');
  assert.equal(f.nodes.find(n => n.properties.id === 3)?.properties.status, 'removed');
  assert.equal(f.nodes.find(n => n.properties.id === -1)?.properties.status, 'added');
  assert.deepEqual(f.nodes.find(n => n.properties.id === 3)?.geometry, { type: 'Point', coordinates: [104.002, 52] });
});

test('изменённая трасса остаётся синей даже если с неё удалили тег highway', () => {
  const original = network(), current = structuredClone(original);
  delete current.ways.get(10)!.tags.highway;
  const report = diffDocs(original, current);
  assert.equal(byId(buildCompareFeatures(original, current, report).roads, 10)?.properties.status, 'modified');
});

test('Undo, Redo и новый файл корректно обновляют сравнение с исходным', () => {
  const s = new Store(); s.load(network(), 'first.osm');
  const firstOriginal = s.original!;
  const initial = s.revision;
  s.commit(d => { d.nodes.get(1)!.lat += 0.001; });
  assert.equal(s.revision, initial + 1);
  assert.equal(diffDocs(s.original!, s.doc).counts.way.modified, 1);
  s.undo();
  assert.deepEqual(diffDocs(s.original!, s.doc).changes, []);
  s.redo();
  assert.equal(diffDocs(s.original!, s.doc).counts.node.modified, 1);
  assert.equal(firstOriginal.nodes.get(1)!.lat, 52);
  s.load(network(), 'second.osm');
  assert.equal(s.originalName, 'second.osm');
  assert.deepEqual(diffDocs(s.original!, s.doc).changes, []);
});

test('удаление узла из текущего графа отмечает изменение геометрии оставшегося way', () => {
  const original = network(), current = structuredClone(original);
  current.nodes.delete(2);
  assert.equal(diffDocs(original, current).counts.way.modified, 1);
});

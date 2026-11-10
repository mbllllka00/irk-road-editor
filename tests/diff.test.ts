import test from 'node:test';
import assert from 'node:assert/strict';
import { newDoc } from '../src/core/types.ts';
import { diffDocs } from '../src/core/diff.ts';
import { Store } from '../src/core/store.ts';

function sample() {
  const d = newDoc();
  d.nodes.set(1, { id: 1, lat: 52, lon: 104, tags: {}, attrs: {} });
  d.nodes.set(2, { id: 2, lat: 52.001, lon: 104.001, tags: {}, attrs: {} });
  d.ways.set(10, { id: 10, nodes: [1, 2], tags: { highway: 'residential' }, attrs: {} });
  d.relations.set(20, { id: 20, members: [{ type: 'way', ref: 10, role: '' }], tags: {}, attrs: {} });
  return d;
}

test('сравнение не находит изменений в исходном состоянии', () => {
  const d = sample();
  assert.deepEqual(diffDocs(d, structuredClone(d)).changes, []);
});

test('новый/удалённый узел, перемещение дороги и изменение тега определяются', () => {
  const original = sample(), current = structuredClone(original);
  current.nodes.get(1)!.lon += 0.0001;
  current.nodes.delete(2);
  current.nodes.set(-1, { id: -1, lat: 52.2, lon: 104.2, tags: {}, attrs: {} });
  current.ways.get(10)!.tags.maxspeed = '40';
  const report = diffDocs(original, current);
  assert.deepEqual(report.counts.node, { added: 1, removed: 1, modified: 1 });
  assert.deepEqual(report.counts.way, { added: 0, removed: 0, modified: 1 });
  assert.equal(report.changes.find(c => c.type === 'way')?.details.some(d => d.includes('Геометрия')), true);
  assert.equal(report.counts.relation.modified, 0);
});

test('исходная версия в Store не изменяется после правок, сохранений и undo', () => {
  const store = new Store(); store.load(sample(), 'original.osm');
  store.commit(d => { d.nodes.get(1)!.lat = 53; });
  assert.equal(diffDocs(store.original!, store.doc).counts.node.modified, 1);
  store.undo();
  assert.equal(diffDocs(store.original!, store.doc).changes.length, 0);
  store.redo();
  assert.equal(diffDocs(store.original!, store.doc).counts.node.modified, 1);
  assert.equal(store.originalName, 'original.osm');
});

test('сравнение отношений учитывает изменения участников', () => {
  const a = sample(), b = structuredClone(a);
  b.relations.get(20)!.members[0].role = 'outer';
  assert.equal(diffDocs(a, b).counts.relation.modified, 1);
});

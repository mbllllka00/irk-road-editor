// [P1] Хранилище документа: undo/redo снимками, события изменения, выделение.
import type { Doc, Sel } from './types.ts';
import { newDoc } from './types.ts';

type Listener = () => void;
const LIMIT = 60;

export class Store {
  doc: Doc = newDoc();
  sel: Sel[] = [];
  dirty = false;
  dragging = false; // во время перетаскивания тяжёлые вычисления панели пропускаются
  private undoStack: Doc[] = [];
  private redoStack: Doc[] = [];
  private listeners = new Set<Listener>();

  onChange(fn: Listener) { this.listeners.add(fn); }
  notify() { this.listeners.forEach(fn => fn()); }

  load(doc: Doc) {
    this.doc = doc; this.sel = []; this.undoStack = []; this.redoStack = []; this.dirty = false;
    this.notify();
  }
  /** Сохранить снимок ДО изменения (для drag: вызвать один раз в начале). */
  checkpoint() {
    this.undoStack.push(structuredClone(this.doc));
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = []; this.dirty = true;
  }
  /** Одна атомарная правка = один шаг undo. */
  commit(fn: (d: Doc) => void) {
    this.checkpoint();
    fn(this.doc);
    this.pruneSelection();
    this.notify();
  }
  /** Правка, которая может не удаться: при ошибке документ остаётся нетронутым, undo-шаг не создаётся. */
  tryCommit(fn: (d: Doc) => string | null): string | null {
    const snap = structuredClone(this.doc);
    const err = fn(this.doc);
    if (err) { this.doc = snap; return err; }
    this.undoStack.push(snap);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = []; this.dirty = true;
    this.pruneSelection(); this.notify();
    return null;
  }
  undo() {
    const prev = this.undoStack.pop(); if (!prev) return;
    this.redoStack.push(structuredClone(this.doc)); this.doc = prev; this.pruneSelection(); this.notify();
  }
  redo() {
    const next = this.redoStack.pop(); if (!next) return;
    this.undoStack.push(structuredClone(this.doc)); this.doc = next; this.pruneSelection(); this.notify();
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  setSel(sel: Sel[]) { this.sel = sel; this.notify(); }
  selWays(): number[] { return this.sel.filter(s => s.type === 'way').map(s => s.id); }
  selNodes(): number[] { return this.sel.filter(s => s.type === 'node').map(s => s.id); }
  private pruneSelection() {
    this.sel = this.sel.filter(s => (s.type === 'way' ? this.doc.ways : this.doc.nodes).has(s.id));
  }
}

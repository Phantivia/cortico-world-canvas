import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasServer } from '../src/server.ts';
import { CanvasStore } from '../src/store.ts';

let server: CanvasServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
const shape = { label: 'base', path: 'M20 20 L90 20 L90 90 L20 90 Z', fill: { color: '#c09070', opacity: 0.8 }, stroke: { color: '#203040', width: 4, pressure: [0.3, 1.5, 0.4] } };
function store() {
  directory = mkdtempSync(join(tmpdir(), 'canvas-edit-'));
  const value = new CanvasStore(directory);
  value.newBoard({ title: 'Edit', width: 128, height: 128 });
  value.board!.steps = value.prepare([shape]);
  return value;
}

it('merges styles without changing geometry or seed and deletes optional nested fields to restore defaults', () => {
  const value = store(), original = structuredClone(value.current().steps[0]);
  const [changed] = value.prepareEdits([{ step_id: original.id, patch: { label: 'recolored', fill: { color: '#80a0c0', opacity: null }, stroke: { width: 2 }, hatch: { color: '#102030', spacing: 12 } } }]);
  expect(changed.id).toBe(original.id);
  expect(changed.seed).toBe(original.seed);
  expect(changed.action.paint!.path).toBe(original.action.paint!.path);
  expect(changed.action.paint!.matrix).toEqual(original.action.paint!.matrix);
  expect(changed.action.paint!.fill).toMatchObject({ color: '#80a0c0', opacity: 1 });
  expect(changed.action.paint!.stroke).toEqual({ ...original.action.paint!.stroke, width: 2 });
  expect(changed.action.paint!.hatch).toMatchObject({ color: '#102030', spacing: 12 });
  expect(value.current().steps[0]).toEqual(original);
});

it('rejects ambiguous edits, duplicate ids and invalid late patches without changing the board or archive', () => {
  const value = store(), id = value.current().steps[0].id;
  value.board!.steps.push(...value.prepare([{ ...shape, label: 'second' }]));
  const second = value.current().steps[1].id;
  const before = structuredClone(value.current());
  const archive = join(directory!, 'boards', `${before.id}.json`), bytes = readFileSync(archive);
  for (const updates of [
    [{ step_id: id }], [{ step_id: id, action: shape, patch: {} }],
    [{ step_id: id, patch: {} }, { step_id: id, patch: {} }],
    [{ step_id: id, patch: { stroke: { color: null } } }],
    [{ step_id: id, patch: { fill: null, stroke: null } }],
    [{ step_id: id, patch: { matrix: null } }],
    [{ step_id: id, patch: { stroke: { pressure: [1, 1] } } }],
    [{ step_id: id, patch: { unknown: true } }],
    [{ step_id: id, patch: { fill: { typo: 1 } } }],
    [{ step_id: id, patch: { fill: { color: '#ffffff' } } }, { step_id: 'missing', action: shape }],
    [{ step_id: id, patch: { fill: { color: '#ffffff' } } }, { step_id: second, patch: { path: 'M0 0 C' } }],
  ]) expect(() => value.prepareEdits(updates)).toThrow();
  expect(value.current()).toEqual(before);
  expect(readFileSync(archive)).toEqual(bytes);
});

it('validates clipping against the whole final batch while allowing a contour to open and its dependent clip to clear', () => {
  const value = store(), base = value.current().steps[0];
  const [shadow] = value.prepare([{ ...shape, label: 'shadow', clip_to: base.id }]);
  value.board!.steps.push(shadow);
  const open = { step_id: base.id, patch: { path: 'M20 20 L90 90', fill: null } };
  expect(() => value.prepareEdits([open])).toThrow('clip_to');
  const changed = value.prepareEdits([{ step_id: shadow.id, patch: { clip_to: null } }, open]);
  expect(changed[0].action.paint!.clip_to).toBeUndefined();
  expect(changed[1].action.paint!.fill).toBeUndefined();
  expect(value.current().steps[1].action.paint!.clip_to).toBe(base.id);
});

it('replaces and clears instances while preserving the global transform and validating the expanded bounds', () => {
  const value = store(), id = value.current().steps[0].id;
  const [repeated] = value.prepareEdits([{ step_id: id, patch: { matrix: [1, 0, 0, 1, 5, 0], instances: [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 10, 0]] } }]);
  value.board!.steps = [repeated];
  const [single] = value.prepareEdits([{ step_id: id, patch: { instances: null } }]);
  expect(single.action.paint!.instances).toBeUndefined();
  expect(single.action.paint!.matrix).toEqual([1, 0, 0, 1, 5, 0]);
  expect(value.current().steps[0].action.paint!.instances).toHaveLength(2);
  expect(() => value.prepareEdits([{ step_id: id, patch: { instances: [[1, 0, 0, 1, 8192, 0]] } }])).toThrow();
  expect(() => value.prepareEdits([{ step_id: id, patch: { instances: [] } }])).toThrow();
});

it('renders a partial edit and restores pixels, transformed geometry, order and seeds with previous', async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-edit-render-'));
  server = new CanvasServer({ directory, port: 0, animationMs: 0 });
  await server.start();
  await server.command('canvas_new', { title: 'Edit render', width: 128, height: 128 });
  await server.command('canvas_draw', { actions: [shape, { label: 'accent', path: 'M30 60 L80 60', stroke: { color: '#506070' } }] });
  const ids = server.store.current().steps.map(s => s.id);
  await server.command('canvas_transform', { step_ids: [ids[0]], dx: 5 });
  const original = server.store.png(), steps = structuredClone(server.store.current().steps);
  const edited = await server.command('canvas_edit', { updates: [{ step_id: ids[0], patch: { fill: { color: '#3050d0' }, stroke: null } }] });
  expect(server.store.png()).not.toEqual(original);
  expect(server.store.current().steps.map(s => [s.id, s.seed])).toEqual(steps.map(s => [s.id, s.seed]));
  expect(server.store.current().steps[0].action.paint!.matrix).toEqual(steps[0].action.paint!.matrix);
  await server.command('canvas_edit', { updates: JSON.parse(edited.text).previous });
  expect(server.store.png()).toEqual(original);
  expect(server.store.current().steps.map(s => s.action)).toEqual(steps.map(s => s.action));
});

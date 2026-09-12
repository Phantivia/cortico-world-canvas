import { afterEach, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasServer } from '../src/server.ts';
import { CanvasStore } from '../src/store.ts';
import { parseActions, type Board } from '../src/drawing.ts';
import { paintContours } from '../src/paint.ts';
import { animateStep } from '../src/motion.ts';

let server: CanvasServer | undefined, directory: string | undefined;
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
const board: Board = { id: 'instances', title: 'Instances', width: 128, height: 128, background: '#ffffff', revision: 0, steps: [] };
const action = { label: 'marks', path: 'M0 0 L12 0 L12 20 L0 20 Z', fill: { color: '#c02020' },
  instances: [[1, 0, 0, 1, 10, 20], [1, 0, 0, 1, 50, 20], [1, 0, 0, 1, 90, 20]] };

it('expands local instances before the component matrix and enforces transformed geometry and work bounds', () => {
  const paint = parseActions([{ ...action, matrix: [2, 0, 0, 2, 5, 7] }], board)[0].paint!;
  expect(paintContours(paint).map((part) => part.points[0])).toEqual([{ x: 25, y: 47 }, { x: 105, y: 47 }, { x: 185, y: 47 }]);
  for (const instances of [[], [[1, 2]], [[1, 0, 0, 1, 8192, 0]], Array(65).fill([1, 0, 0, 1, 0, 0])]) {
    expect(() => parseActions([{ ...action, instances }], board)).toThrow();
  }
  expect(() => parseActions(Array(5).fill({ ...action, instances: Array(64).fill([1, 0, 0, 1, 0, 0]) }), board)).toThrow('256');
  expect(() => parseActions([{ ...action, path: 'M0 0 C600 0 600 600 0 600 Z', instances: Array(64).fill([1, 0, 0, 1, 0, 0]) }], board)).toThrow('8192');
  directory = mkdtempSync(join(tmpdir(), 'canvas-instances-bound-'));
  const store = new CanvasStore(directory);
  store.newBoard({ title: board.title, width: board.width, height: board.height });
  for (let i = 0; i < 5; i++) store.board!.steps.push(...store.prepare([{ ...action, instances: Array(64).fill([1, 0, 0, 1, 0, 0]) }]));
  expect(() => store.prepareTransform({ step_ids: store.current().steps.map(step => step.id), dx: 1 })).toThrow('256');
});

it('renders and clips repeated shapes, transforms the arrangement, restores pixels and lifts between instances', async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-instances-'));
  server = new CanvasServer({ directory, port: 0, animationMs: 0 });
  await server.start();
  await server.command('canvas_new', { title: board.title, width: board.width, height: board.height });
  const reply = JSON.parse((await server.command('canvas_draw', { actions: [action] })).text);
  const id = reply.completed[0].id;
  const shadow = JSON.parse((await server.command('canvas_draw', { actions: [{ label: 'clipped wash', path: 'M0 30 L128 30 L128 128 L0 128 Z', fill: { color: '#006000' }, clip_to: id }] })).text).completed[0].id;
  const ctx = server.store.canvas!.getContext('2d');
  for (const x of [15, 55, 95]) {
    expect(ctx.getImageData(x, 25, 1, 1).data[0]).toBeGreaterThan(120);
    expect(ctx.getImageData(x, 35, 1, 1).data[0]).toBeLessThan(50);
  }
  expect([...ctx.getImageData(35, 35, 1, 1).data]).toEqual([255, 255, 255, 255]);
  const original = server.store.png();
  const moved = JSON.parse((await server.command('canvas_transform', { step_ids: [id, shadow], dx: 5, dy: 15 })).text);
  expect(server.store.png()).not.toEqual(original);
  await server.command('canvas_edit', { updates: moved.previous });
  expect(server.store.png()).toEqual(original);
  const layer = createCanvas(128, 128), step = server.store.current().steps[0];
  const modes: string[] = [];
  await animateStep(layer, server.store.current(), step, { x: 0, y: 0, mode: 'idle' }, 90, (cursor) => {
    modes.push(cursor.mode);
    expect(layer.getContext('2d').getImageData(35, 25, 1, 1).data[3]).toBe(0);
  }, (target) => server!.store.draw(target, server!.store.current(), step));
  expect(modes.filter((mode, i) => mode === 'moving' && modes[i - 1] === 'released')).toHaveLength(2);
});

import { afterEach, expect, it } from 'vitest';
import { createCanvas } from 'canvas';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasServer } from '../src/server.ts';
import { CanvasStore } from '../src/store.ts';
import { contours } from '../src/paint.ts';
import { animateStep } from '../src/motion.ts';

let server: CanvasServer | undefined;
let directory: string | undefined;
afterEach(async () => {
  await server?.stop(); server = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});
async function start() {
  directory = mkdtempSync(join(tmpdir(), 'canvas-brush-'));
  server = new CanvasServer({ directory, port: 0, animationMs: 0 });
  await server.start();
  await server.command('canvas_new', { title: 'Brush integration', width: 128, height: 128 });
  return server;
}
const shape = { label: 'base', path: 'M20 20 L80 20 L80 80 L20 80 Z M40 40 L40 70 L70 70 L70 40 Z', fill: { color: '#e8a080' } };
function pixel(store: CanvasStore, x: number, y: number) { return [...store.canvas!.getContext('2d').getImageData(x, y, 1, 1).data]; }
const ids = (reply: { text: string }) => JSON.parse(reply.text).completed.map((step: { id: string }) => step.id) as string[];

it('samples quadratic and cubic endpoints, keeps disconnected strokes separate, and rejects malformed paths', () => {
  const parts = contours('M0 0 Q20 40 40 0 C50 -20 70 -20 80 0 M100 100 L120 100 L120 120 Z');
  expect(parts).toHaveLength(2);
  expect(parts[0].points).toContainEqual({ x: 40, y: 0 });
  expect(parts[0].points.at(-1)).toEqual({ x: 80, y: 0 });
  expect(parts[0].points.some((p) => p.y > 19)).toBe(true);
  expect(parts[1].closed).toBe(true);
  for (const path of ['M0 0 C10 10 20', 'm0 0 l10 10', 'M0 0 L0 0', 'M0 0 L20 20 Z L40 40', 'M0 0 A10 10 0 0 0 20 20']) expect(() => contours(path)).toThrow();
});

it('renders real p5 layers with clipping, edits and transforms in place, restores pixels, and reopens without a browser', async () => {
  const value = await start();
  await expect(value.command('canvas_draw', { actions: [{ kind: 'paint', label: shape.label, paint: shape }] })).rejects.toThrow('未知 kind');
  const [base] = ids(await value.command('canvas_draw', { actions: [shape] }));
  const [shadow] = ids(await value.command('canvas_draw', { actions: [{ label: 'shadow', path: 'M0 40 L120 40 L120 120 L0 120 Z', fill: { color: '#305090' }, clip_to: base }] }));
  const original = value.store.png();
  expect(pixel(value.store, 60, 60)).not.toEqual(pixel(value.store, 30, 30));
  expect(pixel(value.store, 90, 60)).toEqual([255, 255, 255, 255]);
  await expect(value.command('canvas_undo', { step_id: base })).rejects.toThrow('clip_to');
  const moved = await value.command('canvas_transform', { step_ids: [base, shadow], dx: 20, dy: 10, scale_x: 0.75, origin: { x: 20, y: 20 } });
  expect(pixel(value.store, 25, 50)).toEqual([255, 255, 255, 255]);
  expect(pixel(value.store, 50, 60)).not.toEqual([255, 255, 255, 255]);
  expect(value.store.current().steps.map((s) => s.id)).toEqual([base, shadow]);
  await value.command('canvas_edit', { updates: JSON.parse(moved.text).previous });
  expect(value.store.png()).toEqual(original);
  const beforeRevision = value.store.current().revision;
  await expect(value.command('canvas_edit', { updates: [{ step_id: base, action: { ...shape, path: 'M20 20 L40 40', fill: undefined, stroke: { color: '#000000' } } }] })).rejects.toThrow('clip_to');
  await expect(value.command('canvas_draw', { actions: [shape, { ...shape, path: 'M0 0 L2 2' }] })).rejects.toThrow('闭合');
  expect(value.store.current().revision).toBe(beforeRevision);
  const opened = await value.command('canvas_edit', { updates: [
    { step_id: base, action: { label: 'open contour', path: 'M20 20 L80 20', stroke: { color: '#000000' } } },
    { step_id: shadow, action: { label: 'unclipped shadow', path: shape.path, fill: { color: '#305090' } } },
  ] });
  await value.command('canvas_edit', { updates: JSON.parse(opened.text).previous });
  expect(value.store.png()).toEqual(original);
  const saved = JSON.parse((await value.command('canvas_save', {})).text);
  expect(readFileSync(saved.path)).toEqual(original);
  expect(Buffer.from(await (await fetch(value.url + '/api/canvas.png')).arrayBuffer())).toEqual(original);
  await value.stop();
  expect(new CanvasStore(directory!).png()).toEqual(original);
});

it('renders watercolor, hatching and pressure brushes deterministically and lifts the cursor without drawing connectors', async () => {
  const value = await start();
  await value.command('canvas_draw', { actions: [
    { ...shape, fill: { color: '#e8a080', mode: 'watercolor', opacity: 0.5 }, hatch: { brush: 'HB', color: '#456789', width: 1, spacing: 8, angle: 45 } },
    { label: 'two strokes', path: 'M10 100 L40 100 M90 100 L120 100', stroke: { brush: 'liner', color: '#000000', width: 4, pressure: [0.2, 1.8, 0.2] } },
    { label: 'spray', path: 'M95 20 L100 60', stroke: { brush: 'spray', color: '#886644', width: 2 } },
  ] });
  expect(pixel(value.store, 60, 100)).toEqual([255, 255, 255, 255]);
  expect(pixel(value.store, 25, 100)[0]).toBeLessThan(80);
  const original = value.store.png();
  const snapshot = JSON.parse((await value.command('canvas_snapshot', {})).text);
  await value.command('canvas_edit', { updates: snapshot.board.steps.map((s: { id: string; action: unknown }) => ({ step_id: s.id, action: s.action })) });
  expect(value.store.png()).toEqual(original);
  const step = value.store.current().steps[1], canvas = createCanvas(128, 128);
  const modes: string[] = [];
  await animateStep(canvas, value.store.current(), step, { x: 0, y: 0, mode: 'idle' }, 120, (cursor) => {
    modes.push(cursor.mode);
    expect([...canvas.getContext('2d').getImageData(60, 100, 1, 1).data]).toEqual([0, 0, 0, 0]);
  }, (target) => value.store.draw(target, value.store.current(), step));
  expect(modes.join(',')).toMatch(/released,moving,pressed/);
  expect([...canvas.getContext('2d').getImageData(25, 100, 1, 1).data][3]).toBeGreaterThan(200);
});

it('composites translucent pigment and antialiased edges without baking white paper into layers', async () => {
  const value = await start();
  await value.command('canvas_new', { title: 'Alpha', width: 128, height: 128, background: '#0000ff' });
  const [red] = ids(await value.command('canvas_draw', { actions: [
    { label: 'red wash', path: 'M10 10 L110 30 L90 110 L20 90 Z', fill: { color: '#ff0000', opacity: 0.5 } },
    { label: 'white ink', path: 'M20 120 L100 120', stroke: { color: '#ffffff', width: 4, pressure: [1, 1, 1] } },
  ] }));
  const center = pixel(value.store, 50, 50);
  expect(center[0]).toBeGreaterThan(80);
  expect(center[2]).toBeGreaterThan(80);
  expect(center[1]).toBeLessThan(5);
  const pixels = value.store.canvas!.getContext('2d').getImageData(0, 0, 128, 112).data;
  // Red pigment over blue cannot introduce green, including partially covered edge pixels.
  expect(Array.from(pixels).filter((_v, i) => i % 4 === 1).every((green) => green < 5)).toBe(true);
  expect(pixel(value.store, 50, 120)[1]).toBeGreaterThan(150);
  await value.command('canvas_undo', { step_id: red });
  expect(pixel(value.store, 50, 50)).toEqual([0, 0, 255, 255]);
});

it('flattens upper layers once per edited step during animation and persists canonical replay pixels', async () => {
  const value = await start();
  await value.command('canvas_draw', { actions: Array.from({ length: 48 }, (_, i) => ({
    label: `layer ${i}`, path: `M${10 + i} 10 L110 ${30 + i} L90 110 Z`, fill: { color: '#604080', opacity: 0.2 },
  })) });
  // Keep real raster compositing; the count measures the repeated work that caused dense-edit timeouts.
  const draw = value.store.draw.bind(value.store);
  let draws = 0;
  value.store.draw = (...args) => { draws++; draw(...args); };
  const updates = value.store.current().steps.slice(0, 3).map((step) => ({ step_id: step.id, action: { ...step.action.paint, label: step.action.label } }));
  await value.command('canvas_edit', { updates });
  expect(draws).toBeLessThan(48 * updates.length + updates.length);
  expect(value.store.png()).toEqual(value.store.replay(value.store.current().steps).toBuffer('image/png'));
});

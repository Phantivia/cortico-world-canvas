import { afterEach, describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from 'canvas';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cubicSegments, draw, replay } from '../src/drawing.ts';
import { inspectImage } from '../src/inspect.ts';
import { CanvasStore, imageDimensions } from '../src/store.ts';
import { CanvasServer } from '../src/server.ts';
import { animateStep, pathPrefix, strokePath } from '../src/motion.ts';

const dirs: string[] = [];
const servers: CanvasServer[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'corti-canvas-')); dirs.push(dir); return dir; }
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() { const value = new CanvasStore(directory()); value.newBoard({ title: '头像', width: 128, height: 128 }); return value; }
function paint(value: CanvasStore, actions: unknown) {
  const steps = value.prepare(actions), canvas = value.copyCanvas();
  for (const step of steps) draw(canvas, value.current(), step);
  value.commit([...value.current().steps, ...steps], canvas);
  return steps;
}
function pixel(value: CanvasStore, x: number, y: number) { return Array.from(value.canvas!.getContext('2d').getImageData(x, y, 1, 1).data); }
const rect = { kind: 'rect', points: [{ x: 20, y: 20 }, { x: 100, y: 100 }], color: '#ff0000', filled: true };

describe('canvas raster and persistence', () => {
  it('draws ordered shapes, fills connected regions, and preserves pixels outside the boundary', () => {
    const value = store();
    paint(value, [{ ...rect, filled: false, size: 4 }, { kind: 'fill', points: [{ x: 50, y: 50 }], color: '#00ff00' }]);
    expect(pixel(value, 50, 50)).toEqual([0, 255, 0, 255]);
    expect(pixel(value, 20, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(value, 10, 10)).toEqual([255, 255, 255, 255]);
    expect(value.current().steps).toHaveLength(2);
  });

  it('removes the named step, retains later strokes, and replays spray identically after restart', () => {
    const value = store();
    const steps = paint(value, [rect,
      { kind: 'brush', points: [{ x: 10, y: 60 }, { x: 110, y: 60 }], size: 5, color: '#0000ff' },
      { kind: 'spray', points: [{ x: 60, y: 60 }], size: 60, density: 100, color: '#555555' },
    ]);
    const laterIds = steps.slice(1).map((step) => step.id);
    value.undo(steps[0].id);
    expect(value.current().steps.map((step) => step.id)).toEqual(laterIds);
    expect(pixel(value, 25, 25)).toEqual([255, 255, 255, 255]);
    expect(pixel(value, 15, 60)).toEqual([0, 0, 255, 255]);
    expect(new CanvasStore(value.directory).png().equals(value.png())).toBe(true);
    expect(() => value.undo(steps[0].id)).toThrow('step_id');
  });

  it('validates every action before mutation and refuses out-of-range input', () => {
    const value = store(), initial = value.png();
    expect(() => paint(value, [rect, { kind: 'brush', points: [{ x: 999, y: 0 }] }])).toThrow('x');
    expect(value.current().steps).toHaveLength(0);
    expect(value.png().equals(initial)).toBe(true);
    expect(() => value.prepare([{ ...rect, color: 'red' }])).toThrow('#RRGGBB');
    expect(() => value.prepare([{ ...rect, opacity: NaN }])).toThrow('opacity');
    expect(() => value.prepare(Array(65).fill(rect))).toThrow('64');
  });

  it('uses distinct pen, marker, soft and eraser behavior on real pixels', () => {
    const value = store();
    const stroke = (brush: string, x: number) => ({ kind: 'brush', brush, points: [{ x, y: 60 }], size: 20, color: '#000000' });
    paint(value, [stroke('pen', 20), stroke('marker', 50), stroke('soft', 80), stroke('pen', 110), stroke('eraser', 110)]);
    expect(pixel(value, 20, 60)).toEqual([0, 0, 0, 255]);
    expect(pixel(value, 50, 60)[0]).toBeGreaterThan(100);
    expect(pixel(value, 80, 60)[0]).toBeLessThan(255);
    expect(pixel(value, 87, 60)[0]).toBeGreaterThan(pixel(value, 80, 60)[0]);
    expect(pixel(value, 110, 60)).toEqual([255, 255, 255, 255]);
  });

  it('renders ellipses, polygons, lines and cubic curves independently of preview frames', () => {
    const value = store();
    paint(value, [
      { kind: 'ellipse', points: [{ x: 10, y: 10 }, { x: 40, y: 40 }], filled: true, color: '#ff0000' },
      { kind: 'polygon', points: [{ x: 60, y: 10 }, { x: 100, y: 10 }, { x: 80, y: 40 }], filled: true, color: '#00ff00' },
      { kind: 'line', points: [{ x: 10, y: 60 }, { x: 100, y: 60 }], color: '#0000ff', size: 3 },
      { kind: 'bezier', points: [{ x: 10, y: 110 }, { x: 40, y: 70 }, { x: 80, y: 70 }, { x: 110, y: 110 }], color: '#000000', size: 4 },
    ]);
    expect(pixel(value, 25, 25)).toEqual([255, 0, 0, 255]);
    expect(pixel(value, 80, 20)).toEqual([0, 255, 0, 255]);
    expect(pixel(value, 50, 60)).toEqual([0, 0, 255, 255]);
    expect(pixel(value, 60, 80)).toEqual([0, 0, 0, 255]);
    expect(replay(value.current()).toBuffer().equals(value.png())).toBe(true);
  });

  it('saves distinct PNG files and archives the old board when starting another', async () => {
    const value = store(); paint(value, [rect]);
    const oldId = value.current().id, first = value.save('头像.png'), second = value.save('头像.png');
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path).equals(value.png())).toBe(true);
    const image = await loadImage(readFileSync(first.path)); expect(image.width).toBe(128);
    expect(() => value.save('../../outside')).toThrow('文件名');
    value.newBoard({ title: '下一位' });
    expect(readdirSync(join(value.directory, 'boards'))).toContain(`${oldId}.json`);
    expect(new CanvasStore(value.directory).current().title).toBe('下一位');
  });

  it('fills a connected cubic contour and outlines both segments, with deterministic replay', () => {
    const value = store();
    const [step] = paint(value, [{ kind: 'bezier', filled: true, stroke: '#0000ff', color: '#ff0000', size: 4,
      points: [{ x: 20, y: 64 }, { x: 20, y: 20 }, { x: 108, y: 20 }, { x: 108, y: 64 },
        { x: 108, y: 108 }, { x: 20, y: 108 }, { x: 20, y: 64 }] }]);
    expect(pixel(value, 64, 64)).toEqual([255, 0, 0, 255]);
    expect(pixel(value, 20, 64)).toEqual([0, 0, 255, 255]);
    expect(pixel(value, 108, 64)).toEqual([0, 0, 255, 255]);
    expect(pixel(value, 64, 10)).toEqual([255, 255, 255, 255]);
    expect(strokePath(step.action)).toContainEqual({ x: 108, y: 64 });
    expect(strokePath(step.action).at(-1)).toEqual({ x: 20, y: 64 });
    expect(new CanvasStore(value.directory).png()).toEqual(value.png());
    expect(() => value.prepare([{ ...step.action, points: step.action.points.slice(0, 5) }])).toThrow('bezier');
  });

  it('interpolates curve anchors with continuous tangents and renders the curved segment between them', () => {
    const value = store();
    const points = [{ x: 20, y: 100 }, { x: 64, y: 20 }, { x: 108, y: 100 }];
    const [step] = paint(value, [{ kind: 'curve', points, color: '#000000', size: 3 }]);
    const segments = cubicSegments(step.action);
    expect(segments.map((segment) => segment[3])).toEqual(points.slice(1));
    expect(segments[0][3].x - segments[0][2].x).toBeCloseTo(segments[1][1].x - segments[1][0].x);
    expect(segments[0][3].y - segments[0][2].y).toBeCloseTo(segments[1][1].y - segments[1][0].y);
    expect(pixel(value, 39, 55)).toEqual([0, 0, 0, 255]);
    expect(pixel(value, 42, 60)).toEqual([255, 255, 255, 255]);
    for (const point of points) expect(strokePath(step.action)).toContainEqual(point);
  });

  it('closes smooth filled curves and finishes animated previews with the exact persisted pixels', async () => {
    const value = store();
    const [step] = value.prepare([{ kind: 'curve', filled: true, color: '#ff0000', stroke: '#0000ff', size: 4,
      points: [{ x: 64, y: 20 }, { x: 108, y: 64 }, { x: 64, y: 108 }, { x: 20, y: 64 }] }]);
    const canvas = value.copyCanvas(), modes: string[] = [];
    const end = await animateStep(canvas, value.current(), step, { x: 0, y: 0, mode: 'idle' }, 50, (cursor) => modes.push(cursor.mode));
    expect(end).toEqual({ x: 64, y: 20, mode: 'released' });
    expect(modes).toContain('moving'); expect(modes).toContain('pressed');
    value.commit([step], canvas);
    expect(pixel(value, 64, 64)).toEqual([255, 0, 0, 255]);
    expect(pixel(value, 64, 20)).toEqual([0, 0, 255, 255]);
    expect(value.png()).toEqual(replay(value.current()).toBuffer('image/png'));
    expect(() => value.prepare([{ ...step.action, points: step.action.points.slice(0, 2) }])).toThrow('三个点');
  });

  it('maps magnified inspection pixels back to the source and leaves the artwork unchanged', async () => {
    const value = store(); paint(value, [rect]);
    const before = value.png();
    const result = inspectImage(value.canvas!, { region: { x: 10, y: 10, width: 40, height: 30 }, grid: true });
    expect(result.view).toMatchObject({ region: { x: 10, y: 10, width: 40, height: 30 }, scale: 4, offset: { x: 32, y: 32 }, width: 192, height: 152 });
    const inspected = createCanvas(result.view.width, result.view.height);
    inspected.getContext('2d').drawImage(await loadImage(result.png), 0, 0);
    // Original (27,27) maps to (100,100), between grid lines inside the red shape.
    expect(Array.from(inspected.getContext('2d').getImageData(100, 100, 1, 1).data)).toEqual([255, 0, 0, 255]);
    expect(value.png()).toEqual(before);
    expect(() => inspectImage(value.canvas!, { region: { x: 120, y: 0, width: 20, height: 20 } })).toThrow('region.width');
    expect(() => inspectImage(value.canvas!, { grid: 'yes' })).toThrow('grid');
  });

  it('keeps multiple named references across new boards and restarts without accepting SVG or oversized images', async () => {
    const value = store();
    const image = createCanvas(32, 24); image.getContext('2d').fillRect(0, 0, 32, 24);
    const a = await value.upload('正面', image.toBuffer().toString('base64'));
    const b = await value.upload('侧面', image.toBuffer('image/jpeg').toString('base64'));
    value.renameReference(a.id, '正面 · 蓝眼睛');
    value.newBoard({ title: '头像二' });
    const restored = new CanvasStore(value.directory);
    expect(restored.references.map((ref) => ref.name)).toEqual(['正面 · 蓝眼睛', '侧面']);
    expect(restored.referenceImages([b.id, a.id]).map(({ ref }) => ref.id)).toEqual([b.id, a.id]);
    restored.removeReference(b.id);
    expect(restored.references).toHaveLength(1);
    await expect(value.upload('矢量', Buffer.from('<svg/>').toString('base64'))).rejects.toThrow('PNG/JPEG');
    const huge = image.toBuffer(); huge.writeUInt32BE(100000, 16);
    await expect(value.upload('过大', huge.toString('base64'))).rejects.toThrow('尺寸');
    expect(imageDimensions(image.toBuffer('image/jpeg'))).toEqual({ width: 32, height: 24 });
  });
});

describe('canvas queue and overlay', () => {
  async function start(animationMs = 0) {
    const server = new CanvasServer({ directory: directory(), port: 0, animationMs });
    servers.push(server); await server.start(); return server;
  }
  it('serializes concurrent draw/save requests and returns the completed PNG', async () => {
    const server = await start();
    await server.command('canvas_new', { title: '测试', width: 128, height: 128 });
    const drawing = server.command('canvas_draw', { actions: [rect] });
    const next = server.command('canvas_draw', { actions: [{ ...rect, color: '#0000ff' }] });
    const saving = server.command('canvas_save', {});
    const [red, blue, save] = await Promise.all([drawing, next, saving]);
    expect(red.images![0].png).not.toBe(blue.images![0].png);
    expect(readFileSync(JSON.parse(save.text).path).toString('base64')).toBe(blue.images![0].png);
    expect(server.store.current().steps).toHaveLength(2);
    const response = await fetch(`${server.url}/api/canvas.png`);
    expect(Buffer.from(await response.arrayBuffer()).toString('base64')).toBe(blue.images![0].png);
  });

  it('streams moving and pressed cursor frames before committing and acknowledges after the final frame', async () => {
    const server = await start(180);
    await server.command('canvas_new', { title: '动画', width: 128, height: 128 });
    const connection = new AbortController();
    const response = await fetch(`${server.url}/events`, { signal: connection.signal });
    const frames: { cursor: { x: number; y: number; mode: string }; png: string }[] = [];
    let sawUncommittedPreview = false;
    const decoder = new TextDecoder(); let buffer = '';
    const reading = (async () => {
      for await (const bytes of response.body!) {
        buffer += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!packet.startsWith('data: ')) continue;
          const message = JSON.parse(packet.slice(6));
          if (message.type === 'frame') {
            frames.push(message.data);
            if (message.data.cursor.mode === 'pressed' && server.store.current().steps.length === 0) sawUncommittedPreview = true;
          }
        }
      }
    })().catch((error) => { if (error.name !== 'AbortError') throw error; });
    const result = await server.command('canvas_draw', { actions: [rect] });
    connection.abort(); await reading;
    expect(frames.some((frame) => frame.cursor.mode === 'moving')).toBe(true);
    expect(frames.some((frame) => frame.cursor.mode === 'pressed')).toBe(true);
    expect(sawUncommittedPreview).toBe(true);
    expect(server.store.png().toString('base64')).toBe(result.images![0].png);
    expect(server.store.current().steps).toHaveLength(1);
    expect(server.state().painting).toBeNull();
  });

  it('serves the editor, overlay and pixel cursor and rejects cross-origin writes', async () => {
    const server = await start();
    for (const path of ['/', '/overlay', '/app.js', '/styles.css', '/corti-cursor.svg']) expect((await fetch(server.url + path)).status).toBe(200);
    const response = await fetch(`${server.url}/api/command`, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'canvas_new', args: { title: '不应执行' } }) });
    expect(response.status).toBe(403); expect(server.store.board).toBeNull();
    const good = await fetch(`${server.url}/api/command`, { method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'canvas_new', args: { title: '新画布' } }) });
    expect(good.status).toBe(200);
  });

  it('edits beneath later strokes, validates the entire batch, and restores the previous actions', async () => {
    const server = await start(100);
    await server.command('canvas_new', { title: '修改', width: 128, height: 128 });
    await server.command('canvas_draw', { actions: [rect, { ...rect, points: [{ x: 40, y: 40 }, { x: 60, y: 60 }], color: '#0000ff' }] });
    const original = server.store.png(), oldSteps = server.store.current().steps;
    const updates = [{ step_id: oldSteps[0].id, action: { ...rect, color: '#00ff00' } }];
    const editing = server.command('canvas_edit', { updates });
    await expect.poll(() => server.state().cursor.mode).toBe('pressed');
    const preview = createCanvas(128, 128);
    preview.getContext('2d').drawImage(await loadImage(Buffer.from(server.state().preview!, 'base64')), 0, 0);
    expect(Array.from(preview.getContext('2d').getImageData(50, 50, 1, 1).data)).toEqual([0, 0, 255, 255]);
    const reply = await editing;
    expect(pixel(server.store, 25, 25)).toEqual([0, 255, 0, 255]);
    expect(pixel(server.store, 50, 50)).toEqual([0, 0, 255, 255]);
    expect(server.store.current().steps.map(({ id, seed }) => ({ id, seed }))).toEqual(oldSteps.map(({ id, seed }) => ({ id, seed })));
    expect(server.store.png().toString('base64')).toBe(reply.images![0].png);
    expect(new CanvasStore(server.store.directory).png()).toEqual(server.store.png());
    const edited = server.store.png(), revision = server.store.current().revision;
    await expect(server.command('canvas_edit', { updates: [...updates, { step_id: 'missing', action: rect }] })).rejects.toThrow('step_id');
    await expect(server.command('canvas_edit', { updates: [...updates, ...updates] })).rejects.toThrow('重复');
    expect(server.store.current().revision).toBe(revision);
    expect(server.store.png()).toEqual(edited);
    await server.command('canvas_edit', { updates: JSON.parse(reply.text).previous });
    expect(server.store.png()).toEqual(original);
  });

  it('returns separate reference and canvas coordinate views without altering either source', async () => {
    const server = await start();
    await server.command('canvas_new', { title: '观察', width: 128, height: 128 });
    await server.command('canvas_draw', { actions: [rect] });
    const original = server.store.png();
    const ref = await server.store.upload('局部参考', original.toString('base64'));
    await server.store.upload('另一张', original.toString('base64'));
    const region = { x: 20, y: 20, width: 40, height: 40 };
    const reference = await server.command('canvas_references', { ids: [ref.id], region, grid: true });
    const snapshot = await server.command('canvas_snapshot', { region, grid: true });
    expect(reference.images![0].png).toBe(snapshot.images![0].png);
    expect(JSON.parse(reference.text).views[0]).toMatchObject({ id: ref.id, region, scale: 4 });
    expect(JSON.parse(snapshot.text).board.steps).toHaveLength(1);
    expect(JSON.parse(snapshot.text).view.region).toEqual(region);
    await expect(server.command('canvas_references', { region })).rejects.toThrow('一张');
    expect(server.store.png()).toEqual(original);
    expect(server.store.referenceImages([ref.id])[0].png).toEqual(original);
  });

  it('applies multiple edits in request order while replaying dependent fills in layer order', async () => {
    const server = await start();
    await server.command('canvas_new', { title: '边界修正', width: 128, height: 128 });
    await server.command('canvas_draw', { actions: [
      { ...rect, filled: false, size: 4 },
      { kind: 'fill', points: [{ x: 60, y: 60 }], color: '#0000ff' },
      { kind: 'spray', points: [{ x: 90, y: 60 }], size: 20, density: 100, color: '#555555' },
    ] });
    const original = server.store.png(), steps = server.store.current().steps;
    const reply = await server.command('canvas_edit', { updates: [
      { step_id: steps[1].id, action: { ...steps[1].action, color: '#00ff00' } },
      { step_id: steps[0].id, action: { ...steps[0].action, points: [{ x: 40, y: 40 }, { x: 80, y: 80 }] } },
    ] });
    expect(pixel(server.store, 30, 30)).toEqual([255, 255, 255, 255]);
    expect(pixel(server.store, 60, 60)).toEqual([0, 255, 0, 255]);
    expect(pixel(server.store, 40, 60)).toEqual([255, 0, 0, 255]);
    expect(server.store.png()).toEqual(replay(server.store.current()).toBuffer('image/png'));
    await server.command('canvas_edit', { updates: JSON.parse(reply.text).previous });
    expect(server.store.png()).toEqual(original);
  });

  it('interpolates by distance and samples cubic and ellipse paths to the expected endpoints', () => {
    expect(pathPrefix([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }], 0.5).at(-1)).toEqual({ x: 60, y: 0 });
    const value = store();
    const [curve] = value.prepare([{ kind: 'bezier', points: [{ x: 0, y: 0 }, { x: 30, y: 50 }, { x: 80, y: 50 }, { x: 100, y: 0 }] }]);
    expect(strokePath(curve.action).at(-1)).toEqual({ x: 100, y: 0 });
  });
});

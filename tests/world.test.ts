import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from 'canvas';
import { CanvasWorld } from '../src/world.ts';
import { CanvasStore, imageDimensions } from '../src/store.ts';
import { LogBlobStore, withBlobLines } from 'cortico/core/blobs.ts';
import { renderMessagesWithMedia } from 'cortico/providers/transport/history.ts';
import type { BlobRef, ToolOutcome } from 'cortico/core/types.ts';
import { FakeHost } from './helpers/fake-host.ts';

let module: CanvasWorld | null = null;
let directory: string | null = null;
afterEach(async () => {
  await module?.stop(); module = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

it('runs the child renderer, emits uploaded reference events, and supplies blobs with text-only fallback', async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-module-'));
  const host = new FakeHost();
  module = new CanvasWorld({ cfg: { enabled: true, port: 0, browserFile: '' }, directory: join(directory, 'canvas') });
  await module.start(host);
  const call = (name: string, args = {}) => module!.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: host.log }) as Promise<ToolOutcome>;
  // 回执上的附件是待落库的字节;真 core 在落库刻换句柄,这里用日志附件库替它做同一件事
  const store = new LogBlobStore(directory);
  const bytesOf = (out: ToolOutcome, i = 0): Buffer => { const b = out.blobs![i]; if (!('bytes' in b)) throw new Error('expected bytes'); return Buffer.from(b.bytes); };
  const intern = (out: ToolOutcome): BlobRef[] => out.blobs!.map((b) => { if (!('bytes' in b)) throw new Error('expected bytes'); return { handle: store.put(b.bytes, b.mime), mime: b.mime, fallbackText: b.fallbackText }; });
  await call('canvas_new', { title: '小月', width: 128, height: 128 });
  const reply = await call('canvas_draw', { actions: [{ kind: 'ellipse', points: [{ x: 10, y: 10 }, { x: 100, y: 100 }], color: '#8866ff', filled: true }] });
  const base = module.console().links![0].href;
  const png = Buffer.from(await (await fetch(`${base}/api/canvas.png`)).arrayBuffer());
  expect(bytesOf(reply).equals(png)).toBe(true);
  const saved = await call('canvas_save');
  expect(readFileSync(JSON.parse(saved.text).path).equals(png)).toBe(true);

  const refs = intern(reply);
  const content = withBlobLines(reply.text, refs);
  const messages = [{ role: 'tool' as const, content, tool_call_id: 'paint', blobs: refs }];
  const readBlob = (handle: string) => store.read(handle)?.bytes ?? null;
  const request = (enabled: boolean) => ({ messages: renderMessagesWithMedia(messages, { enabled: () => enabled, read: readBlob }) });
  const visual = request(true).messages as { content: { type: string; image_url?: { url: string } }[] }[];
  expect(visual[0].content.some((item) => item.type === 'image_url' && item.image_url!.url.endsWith(png.toString('base64')))).toBe(true);
  expect(reply.text).not.toMatch(/占位符|查看图片需要/);
  // 附件的文本形态在正文里:模型不吃图时她看到的就是这一行
  const textOnly = request(false).messages as { content: string }[];
  expect(textOnly[0].content).toContain('] [画布截图：小月，128×128，1 步]');
  expect(typeof textOnly[0].content).toBe('string');

  const snapshot = await call('canvas_snapshot');
  const step = JSON.parse(snapshot.text.split('\n')[0]).board.steps[0];
  const edit = await call('canvas_edit', { updates: [{ step_id: step.id, action: { ...step.action, color: '#00aa99' } }] });
  expect(bytesOf(edit).equals(png)).toBe(false);
  const detail = await call('canvas_snapshot', { region: { x: 20, y: 20, width: 16, height: 16 }, grid: true });
  expect(imageDimensions(bytesOf(detail))).toEqual({ width: 96, height: 96 });
  const restore = await call('canvas_edit', { updates: JSON.parse(edit.text.split('\n')[0]).previous });
  expect(bytesOf(restore).equals(png)).toBe(true);

  const refImage = createCanvas(16, 16).toBuffer();
  const upload = await fetch(`${base}/api/references`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: '小月参考', base64: refImage.toString('base64') }) });
  expect(upload.status).toBe(200);
  await expect.poll(() => host.events.length).toBe(1);
  expect(host.events[0].text).toContain('小月参考');
  expect(host.events[0].source).toBe('canvas');
  const references = await call('canvas_references');
  expect(bytesOf(references).equals(refImage)).toBe(true);
  expect(references.blobs![0].fallbackText).toContain('[参考图：小月参考，ID=');
  expect(references.text).not.toMatch(/占位符|查看图片需要/);
  await module.stop();
  await expect(call('canvas_snapshot')).rejects.toThrow('未启动');
  await module.start(host);
  expect(bytesOf(await call('canvas_snapshot')).equals(png)).toBe(true);
});

it('cancels the child before committing an in-flight batch and recovers the last committed board', async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-cancel-'));
  const host = new FakeHost();
  module = new CanvasWorld({ cfg: { enabled: true, port: 0, browserFile: '' }, directory });
  await module.start(host);
  const tool = (name: string) => module!.tools().find((entry) => entry.name === name)!;
  await tool('canvas_new').handler({ title: '取消测试', width: 128, height: 128 }, { role: 'main', log: host.log });
  const abort = new AbortController();
  const painting = tool('canvas_draw').handler({ actions: [{ kind: 'line', points: [{ x: 1, y: 1 }, { x: 120, y: 120 }] }] }, { role: 'main', log: host.log, signal: abort.signal });
  const rejected = expect(painting).rejects.toThrow('取消');
  const base = module.console().links![0].href;
  await expect.poll(async () => ((await (await fetch(`${base}/api/state`)).json()) as { painting: unknown }).painting !== null).toBe(true);
  abort.abort(); await rejected; await module.stop();
  expect(new CanvasStore(directory).current().steps).toHaveLength(0);
  await module.start(host);
  const result = await tool('canvas_snapshot').handler({}, { role: 'main', log: host.log }) as ToolOutcome;
  expect(JSON.parse(result.text.split('\n')[0]).board.steps).toHaveLength(0);
});

it('cancels p5 drawing, closes the renderer, and restarts with the committed media intact', async () => {
  directory = mkdtempSync(join(tmpdir(), 'canvas-p5-cancel-'));
  const host = new FakeHost();
  module = new CanvasWorld({ cfg: { enabled: true, port: 0, browserFile: '' }, directory: join(directory, 'canvas') });
  const bytesOf = (out: ToolOutcome): Buffer => { const b = out.blobs![0]; if (!('bytes' in b)) throw new Error('expected bytes'); return Buffer.from(b.bytes); };
  const tool = (name: string) => module!.tools().find((entry) => entry.name === name)!;
  const call = (name: string, args = {}) => tool(name).handler(args, { role: 'main', log: host.log }) as Promise<ToolOutcome>;
  await module.start(host);
  await call('canvas_new', { title: 'P5 cancellation', width: 128, height: 128 });
  const action = { label: 'ink', path: 'M10 20 C30 80 90 10 115 100', stroke: { brush: '2B', color: '#446688', width: 3 } };
  const committed = await call('canvas_draw', { actions: [action] });
  const abort = new AbortController();
  const painting = tool('canvas_draw').handler({ actions: Array.from({ length: 20 }, () => action) }, { role: 'main', log: host.log, signal: abort.signal });
  const rejected = expect(painting).rejects.toThrow('取消');
  const base = module.console().links![0].href;
  await expect.poll(async () => (await (await fetch(base + '/api/state')).json() as { painting: unknown }).painting !== null).toBe(true);
  abort.abort(); await rejected; await module.stop();
  await module.start(host);
  const restored = await call('canvas_snapshot');
  expect(bytesOf(restored).equals(bytesOf(committed))).toBe(true);
  expect(JSON.parse(restored.text.split('\n')[0]).board.steps).toHaveLength(1);
  const saved = JSON.parse((await call('canvas_save')).text);
  expect(readFileSync(saved.path).equals(bytesOf(committed))).toBe(true);
});

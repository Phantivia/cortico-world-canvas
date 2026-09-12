import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCanvas, Image, loadImage, type Canvas } from 'canvas';
import { blank, color, draw, label, number, object, parseActions, replay, type Board, type DrawStep } from './drawing.ts';
import { contours, multiply, validateTransform, type Matrix } from './paint.ts';

export interface Reference { id: string; name: string; width: number; height: number; url: string }
interface SavedCanvas { filename: string; path: string; url: string }

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

function patchAction(step: DrawStep, input: unknown): Record<string, unknown> {
  if (!step.action.paint) throw new Error('patch 需要 p5.brush 步骤；旧动作请使用 action 完整替换');
  const patch = object(input);
  const styles: Record<string, readonly string[]> = {
    fill: ['color', 'mode', 'opacity', 'bleed', 'texture'],
    stroke: ['brush', 'color', 'width', 'pressure'],
    hatch: ['brush', 'color', 'width', 'spacing', 'angle'],
  };
  const merged: Record<string, unknown> = { ...step.action.paint, label: step.action.label };
  for (const [key, value] of Object.entries(patch)) {
    if (!['label', 'path', 'matrix', 'instances', 'clip_to', ...Object.keys(styles)].includes(key)) throw new Error(`未知 patch 字段: ${key}`);
    if (Object.hasOwn(styles, key)) {
      if (value === null) { delete merged[key]; continue; }
      const nested = { ...(merged[key] as Record<string, unknown> | undefined) };
      for (const [field, change] of Object.entries(object(value))) {
        if (!styles[key].includes(field)) throw new Error(`未知 patch.${key} 字段: ${field}`);
        if (change === null) delete nested[field];
        else nested[field] = change;
      }
      merged[key] = nested;
    } else if ((key === 'clip_to' || key === 'instances') && value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export class CanvasStore {
  board: Board | null = null;
  canvas: Canvas | null = null;
  references: Reference[] = [];
  readonly directory: string;
  private rasters = new Map<string, Image>();
  private rasterBytes = 0;

  constructor(directory: string) {
    this.directory = resolve(directory);
    for (const subdir of ['boards', 'references', 'exports', 'layers']) mkdirSync(join(this.directory, subdir), { recursive: true });
    const indexPath = join(this.directory, 'index.json');
    if (existsSync(indexPath)) {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { boardId: string | null; references: Reference[] };
      this.references = index.references;
      if (index.boardId) {
        this.board = JSON.parse(readFileSync(join(this.directory, 'boards', `${index.boardId}.json`), 'utf8')) as Board;
        this.canvas = this.replay(this.board.steps);
      }
    }
  }

  private persistIndex(board: Board | null, references = this.references): void {
    atomicJson(join(this.directory, 'index.json'), { boardId: board?.id ?? null, references });
  }

  current(): Board {
    if (!this.board) throw new Error('尚未新建画布，请先调用 canvas_new');
    return this.board;
  }

  newBoard(args: Record<string, unknown>): Board {
    const board: Board = {
      id: randomUUID(), title: label(args.title, '标题'),
      width: number(args.width ?? 1024, 'width', 64, 2048, true),
      height: number(args.height ?? 1024, 'height', 64, 2048, true),
      background: color(args.background ?? '#ffffff'), revision: 0, steps: [],
    };
    const canvas = blank(board);
    atomicJson(join(this.directory, 'boards', `${board.id}.json`), board);
    this.persistIndex(board);
    this.board = board;
    this.canvas = canvas;
    return board;
  }

  prepare(input: unknown): DrawStep[] {
    const board = this.current();
    const actions = parseActions(input, board);
    if (board.steps.length + actions.length > 5000) throw new Error('单张画布最多 5000 步，请保存后新建画布');
    return actions.map((action) => ({ id: randomUUID(), action, seed: randomBytes(4).readUInt32LE() }));
  }

  prepareEdits(input: unknown): DrawStep[] {
    const board = this.current();
    if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new Error('每批需要 1–64 个修改');
    const updates = input.map(object);
    const ids = new Set<unknown>();
    const originals = updates.map((update) => {
      const step = board.steps.find((step) => step.id === update.step_id);
      if (!step) throw new Error('找不到当前画布中的 step_id');
      if (ids.has(step.id)) throw new Error('同一批不能重复修改同一个 step_id');
      ids.add(step.id);
      if (Object.hasOwn(update, 'action') === Object.hasOwn(update, 'patch')) throw new Error('每个修改须指定 action 或 patch，且只能指定一项');
      return step;
    });
    const actions = parseActions(updates.map((update, index) => Object.hasOwn(update, 'patch') ? patchAction(originals[index], update.patch) : update.action), board);
    const edits = originals.map((step, index) => {
      return { id: step.id, seed: step.seed, action: actions[index] };
    });
    const byId = new Map(edits.map((step) => [step.id, step]));
    this.validateLayers(board.steps.map((step) => byId.get(step.id) ?? step));
    return edits;
  }

  prepareTransform(args: Record<string, unknown>): DrawStep[] {
    if (!Array.isArray(args.step_ids) || !args.step_ids.length || args.step_ids.length > 64 || new Set(args.step_ids).size !== args.step_ids.length) throw new Error('step_ids 须为 1–64 个不重复的步骤 ID');
    const ids = args.step_ids;
    const dx = number(args.dx ?? 0, 'dx', -4096, 4096), dy = number(args.dy ?? 0, 'dy', -4096, 4096);
    const sx = number(args.scale_x ?? 1, 'scale_x', 0.05, 20), sy = number(args.scale_y ?? sx, 'scale_y', 0.05, 20);
    const angle = number(args.rotate ?? 0, 'rotate', -360, 360) * Math.PI / 180;
    const origin = args.origin === undefined ? { x: 0, y: 0 } : object(args.origin);
    const x = number(origin.x, 'origin.x', -4096, 4096), y = number(origin.y, 'origin.y', -4096, 4096);
    const c = Math.cos(angle), s = Math.sin(angle);
    const matrix: Matrix = [c * sx, s * sx, -s * sy, c * sy, x + dx - c * sx * x + s * sy * y, y + dy - s * sx * x - c * sy * y];
    let instances = 0;
    return ids.map((id) => {
      const step = this.current().steps.find((step) => step.id === id);
      if (!step || step.action.kind !== 'paint') throw new Error('canvas_transform 需要当前画布中的 p5.brush 步骤 ID');
      const paint = { ...step.action.paint!, matrix: multiply(matrix, step.action.paint!.matrix) };
      instances += paint.instances?.length ?? 1;
      if (instances > 256) throw new Error('每批 p5.brush 实例总数最多 256');
      paint.matrix.forEach((value) => number(value, 'matrix', -8192, 8192));
      validateTransform(contours(paint.path), paint.matrix, paint.instances);
      return { id: step.id, seed: step.seed, action: { ...step.action, paint } };
    });
  }

  validateLayers(steps: DrawStep[]): void {
    const earlier = new Map<string, DrawStep>();
    for (const step of steps) {
      const clip = step.action.paint?.clip_to;
      if (clip) {
        const target = earlier.get(clip);
        if (!target?.action.paint || contours(target.action.paint.path).some((part) => !part.closed)) throw new Error(`clip_to ${clip} 必须引用更早的闭合 p5.brush 部件；请先修改或撤销依赖它的步骤`);
      }
      earlier.set(step.id, step);
    }
  }

  cacheRaster(step: DrawStep, png: Buffer): void {
    const hash = createHash('sha256').update(png).digest('hex');
    const path = join(this.directory, 'layers', `${hash}.png`);
    if (!existsSync(path)) writeFileSync(path, png, { flag: 'wx' });
    step.raster = hash;
  }

  private raster(step: DrawStep): Image {
    const key = step.raster!;
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('p5.brush 图层缓存缺失或损坏');
    let image = this.rasters.get(key);
    if (image) this.rasters.delete(key);
    else {
      image = new Image(); image.src = readFileSync(join(this.directory, 'layers', `${key}.png`));
      this.rasterBytes += image.width * image.height * 4;
    }
    this.rasters.set(key, image);
    while (this.rasterBytes > 128 * 1024 * 1024 && this.rasters.size > 1) {
      const [oldKey, old] = this.rasters.entries().next().value!;
      this.rasters.delete(oldKey); this.rasterBytes -= old.width * old.height * 4;
    }
    return image;
  }

  draw(canvas: Canvas, board: Board, step: DrawStep): void { draw(canvas, board, step, (step) => this.raster(step)); }
  replay(steps: DrawStep[]): Canvas {
    this.validateLayers(steps);
    return replay({ ...this.current(), steps }, (step) => this.raster(step));
  }

  copyCanvas(): Canvas {
    const board = this.current();
    const canvas = createCanvas(board.width, board.height);
    canvas.getContext('2d').drawImage(this.canvas!, 0, 0);
    return canvas;
  }

  commit(steps: DrawStep[], canvas: Canvas): void {
    const board = { ...this.current(), revision: this.current().revision + 1, steps };
    atomicJson(join(this.directory, 'boards', `${board.id}.json`), board);
    this.board = board;
    this.canvas = canvas;
  }

  undo(id: unknown): string {
    const board = this.current();
    if (typeof id !== 'string' || !board.steps.some((step) => step.id === id)) throw new Error('找不到当前画布中的 step_id');
    const steps = board.steps.filter((step) => step.id !== id);
    this.commit(steps, this.replay(steps));
    return id;
  }

  png(): Buffer { this.current(); return this.canvas!.toBuffer('image/png'); }

  save(filename?: unknown): SavedCanvas {
    const board = this.current();
    let stem: string;
    if (filename !== undefined) {
      stem = label(filename, '文件名').replace(/\.png$/i, '');
      if (/[<>:"/\\|?*\x00-\x1f]/.test(stem) || /^\.+$/.test(stem)) throw new Error('文件名不能包含目录或特殊字符');
    } else stem = board.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const name = `${stem}-${randomUUID().slice(0, 8)}.png`;
    const path = join(this.directory, 'exports', name);
    writeFileSync(path, this.png(), { flag: 'wx' });
    return { filename: name, path, url: `/exports/${encodeURIComponent(name)}` };
  }

  async upload(name: unknown, data: unknown): Promise<Reference> {
    if (this.references.length >= 64) throw new Error('参考图队列最多 64 张，请先移除不需要的图片');
    const displayName = label(name, '参考图名称');
    if (typeof data !== 'string' || data.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('参考图必须是最多 10 MiB 的 PNG/JPEG');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('参考图不能超过 10 MiB');
    const size = imageDimensions(bytes);
    if (size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw new Error('参考图尺寸必须在 1–4096 像素之间');
    const image = await loadImage(bytes);
    const normalized = createCanvas(image.width, image.height);
    normalized.getContext('2d').drawImage(image, 0, 0);
    const id = randomUUID();
    const reference: Reference = { id, name: displayName, width: image.width, height: image.height, url: `/references/${id}.png` };
    writeFileSync(join(this.directory, 'references', `${id}.png`), normalized.toBuffer('image/png'));
    const next = [...this.references, reference];
    this.persistIndex(this.board, next);
    this.references = next;
    return reference;
  }

  renameReference(id: string, name: unknown): void {
    if (!this.references.some((ref) => ref.id === id)) throw new Error('参考图不存在');
    const next = this.references.map((ref) => ref.id === id ? { ...ref, name: label(name, '参考图名称') } : ref);
    this.persistIndex(this.board, next);
    this.references = next;
  }

  removeReference(id: string): void {
    if (!this.references.some((ref) => ref.id === id)) throw new Error('参考图不存在');
    const next = this.references.filter((ref) => ref.id !== id);
    this.persistIndex(this.board, next);
    this.references = next;
  }

  referenceImages(ids: unknown): { ref: Reference; png: Buffer }[] {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== 'string'))) throw new Error('ids 须为最多 8 个参考图 ID');
    const selected = ids === undefined ? this.references.slice(0, 8).map((ref) => ref.id) : ids as string[];
    return selected.map((id) => {
      const ref = this.references.find((ref) => ref.id === id);
      if (!ref) throw new Error(`参考图不存在: ${id}`);
      return { ref, png: readFileSync(join(this.directory, 'references', `${id}.png`)) };
    });
  }
}

/** Read dimensions before invoking the native decoder; uploads accept PNG and JPEG only. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  throw new Error('无法读取 PNG/JPEG 参考图');
}

import { createCanvas, type Canvas, type CanvasRenderingContext2D, type Image } from 'canvas';
import { paintContours, parsePaint, type PaintSpec } from './paint.ts';

export type Point = { x: number; y: number };
type DrawKind = 'brush' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'bezier' | 'curve' | 'fill' | 'spray' | 'paint';
export interface DrawAction {
  kind: DrawKind;
  points: Point[];
  color: string;
  size: number;
  opacity: number;
  brush: 'pen' | 'marker' | 'soft' | 'eraser';
  filled: boolean;
  closed?: boolean;
  stroke?: string;
  tolerance: number;
  density: number;
  label: string;
  paint?: PaintSpec;
}
export interface DrawStep { id: string; action: DrawAction; seed: number; raster?: string }
export interface Board {
  id: string;
  title: string;
  width: number;
  height: number;
  background: string;
  revision: number;
  steps: DrawStep[];
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象');
  return value as Record<string, unknown>;
}

export function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} 必须是 ${min}–${max} 的${integer ? '整数' : '数值'}`);
  }
  return value;
}

export function label(value: unknown, name = '名称'): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error(`${name} 必须是 1–120 字的文本`);
  return value.trim();
}

export function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('颜色须为 #RRGGBB');
  return value.toLowerCase();
}

export function parseActions(input: unknown, board: Board): DrawAction[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) throw new Error('每批需要 1–64 个绘图动作');
  let totalPoints = 0;
  let pathCharacters = 0;
  let instances = 0;
  return input.map((raw, index) => {
    const a = object(raw);
    if (a.path !== undefined) {
      const parsed = parsePaint(a);
      pathCharacters += parsed.paint!.path.length;
      if (pathCharacters > 64000) throw new Error('每批 path 总长度最多 64000 字符');
      instances += parsed.paint!.instances?.length ?? 1;
      if (instances > 256) throw new Error('每批 p5.brush 实例总数最多 256');
      return parsed;
    }
    const kind = a.kind as DrawKind;
    const ranges: Record<Exclude<DrawKind, 'paint'>, [number, number]> = {
      brush: [1, 1024], line: [2, 2], rect: [2, 2], ellipse: [2, 2], polygon: [3, 1024],
      bezier: [4, 1024], curve: [2, 1024], fill: [1, 1], spray: [1, 1024],
    };
    if (!Object.hasOwn(ranges, kind)) throw new Error(`动作 ${index + 1}: 未知 kind`);
    const [min, max] = ranges[kind as Exclude<DrawKind, 'paint'>];
    if (!Array.isArray(a.points) || a.points.length < min || a.points.length > max) throw new Error(`${kind} 需要 ${min}–${max} 个 points`);
    if (kind === 'bezier' && (a.points.length - 1) % 3 !== 0) throw new Error('bezier 需要一个起点，再接每段的控制点1、控制点2、终点（共 4、7、10… 个点）');
    if (kind === 'curve' && (a.closed || a.filled) && a.points.length < 3) throw new Error('闭合 curve 至少需要三个点');
    totalPoints += a.points.length;
    if (totalPoints > 8192) throw new Error('每批最多 8192 个点');
    const points = a.points.map((rawPoint) => {
      const p = object(rawPoint);
      return { x: number(p.x, 'x', 0, board.width - 1), y: number(p.y, 'y', 0, board.height - 1) };
    });
    const brush = a.brush ?? 'pen';
    if (!['pen', 'marker', 'soft', 'eraser'].includes(brush as string)) throw new Error('未知笔刷');
    if (a.filled !== undefined && typeof a.filled !== 'boolean') throw new Error('filled 必须是布尔值');
    if (a.closed !== undefined && typeof a.closed !== 'boolean') throw new Error('closed 必须是布尔值');
    return {
      kind, points, color: color(a.color ?? '#242333'), size: number(a.size ?? 8, 'size', 1, 512),
      opacity: number(a.opacity ?? 1, 'opacity', 0.01, 1), brush: brush as DrawAction['brush'],
      filled: a.filled === true, tolerance: number(a.tolerance ?? 16, 'tolerance', 0, 255, true),
      ...(a.closed === undefined ? {} : { closed: a.closed }),
      ...(a.stroke === undefined ? {} : { stroke: color(a.stroke) }),
      density: number(a.density ?? 32, 'density', 1, 128, true),
      label: a.label === undefined ? kind : label(a.label, '步骤说明'),
    };
  });
}

/** Rendering and cursor sampling share the same cubic control points. */
export function cubicSegments(a: DrawAction): [Point, Point, Point, Point][] {
  const points = a.points;
  const segments: [Point, Point, Point, Point][] = [];
  if (a.kind === 'bezier') {
    for (let i = 1; i < points.length; i += 3) segments.push([points[i - 1], points[i], points[i + 1], points[i + 2]]);
  } else if (a.kind === 'curve') {
    const closed = a.closed || a.filled;
    const at = (i: number) => closed ? points[(i + points.length) % points.length] : points[Math.max(0, Math.min(i, points.length - 1))];
    for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      segments.push([p1,
        { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2]);
    }
  }
  return segments;
}

export function blank(board: Board): Canvas {
  const canvas = createCanvas(board.width, board.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = board.background;
  ctx.fillRect(0, 0, board.width, board.height);
  return canvas;
}

export function replay(board: Board, raster?: (step: DrawStep) => Image): Canvas {
  const canvas = blank(board);
  for (const step of board.steps) draw(canvas, board, step, raster);
  return canvas;
}

/** Each step starts with a fresh context; spray randomness belongs to the persisted step. */
export function draw(canvas: Canvas, board: Board, step: DrawStep, raster?: (step: DrawStep) => Image): void {
  const a = step.action;
  const ctx = canvas.getContext('2d');
  ctx.save();
  try {
    if (a.kind === 'paint') {
      if (!raster) throw new Error('p5.brush 步骤需要已渲染的图层');
      if (a.paint!.clip_to) {
        const target = board.steps.find((candidate) => candidate.id === a.paint!.clip_to)!;
        ctx.beginPath();
        for (const part of paintContours(target.action.paint!)) {
          const points = part.points;
          // Each p5 subpath fills independently; use matching winding for the union clip.
          const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
          if (area < 0) points.reverse();
          ctx.moveTo(points[0].x, points[0].y);
          for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.closePath();
        }
        ctx.clip();
      }
      ctx.drawImage(raster(step), 0, 0);
      return;
    }
    ctx.globalAlpha = a.opacity;
    ctx.strokeStyle = ctx.fillStyle = a.color;
    ctx.lineWidth = a.size;
    ctx.lineCap = ctx.lineJoin = 'round';
    if (a.kind === 'fill') { flood(ctx, board, a); return; }
    if (a.kind === 'spray') {
      let seed = step.seed;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
      for (const p of a.points) for (let n = 0; n < a.density; n++) {
        const angle = random() * Math.PI * 2;
        const radius = Math.sqrt(random()) * a.size / 2;
        ctx.fillRect(Math.round(p.x + Math.cos(angle) * radius), Math.round(p.y + Math.sin(angle) * radius), 1, 1);
      }
      return;
    }
    if (a.kind === 'brush' && a.brush === 'soft') {
      const stamp = (x: number, y: number) => {
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, a.size / 2);
        gradient.addColorStop(0, a.color + '50');
        gradient.addColorStop(1, a.color + '00');
        ctx.fillStyle = gradient;
        ctx.fillRect(x - a.size / 2, y - a.size / 2, a.size, a.size);
      };
      stamp(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) {
        const p = a.points[i - 1], q = a.points[i];
        const count = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / Math.max(1, a.size / 6));
        for (let n = 1; n <= count; n++) stamp(p.x + (q.x - p.x) * n / count, p.y + (q.y - p.y) * n / count);
      }
      return;
    }
    if (a.kind === 'brush' && a.brush === 'marker') { ctx.globalAlpha *= 0.35; ctx.lineCap = 'square'; }
    if (a.kind === 'brush' && a.brush === 'eraser') ctx.strokeStyle = ctx.fillStyle = board.background;
    ctx.beginPath();
    const [p, q] = a.points;
    if (a.kind === 'rect') ctx.rect(Math.min(p.x, q.x), Math.min(p.y, q.y), Math.abs(q.x - p.x), Math.abs(q.y - p.y));
    else if (a.kind === 'ellipse') ctx.ellipse((p.x + q.x) / 2, (p.y + q.y) / 2, Math.abs(q.x - p.x) / 2, Math.abs(q.y - p.y) / 2, 0, 0, Math.PI * 2);
    else if (a.kind === 'bezier' || a.kind === 'curve') {
      ctx.moveTo(p.x, p.y);
      for (const [, c1, c2, end] of cubicSegments(a)) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
      if (a.closed || a.filled) ctx.closePath();
    } else if (a.points.length === 1) {
      ctx.arc(p.x, p.y, a.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    } else {
      ctx.moveTo(p.x, p.y);
      for (const point of a.points.slice(1)) ctx.lineTo(point.x, point.y);
      if (a.kind === 'polygon') ctx.closePath();
    }
    if (a.filled && ['rect', 'ellipse', 'polygon', 'bezier', 'curve'].includes(a.kind)) {
      ctx.fill();
      if (a.stroke) { ctx.strokeStyle = a.stroke; ctx.stroke(); }
    } else ctx.stroke();
  } finally { ctx.restore(); }
}

function flood(ctx: CanvasRenderingContext2D, board: Board, a: DrawAction): void {
  const { width, height } = board;
  const image = ctx.getImageData(0, 0, width, height);
  const pixels = image.data;
  const start = Math.floor(a.points[0].y) * width + Math.floor(a.points[0].x);
  const original = Array.from(pixels.slice(start * 4, start * 4 + 4));
  const replacement = [1, 3, 5].map((offset) => parseInt(a.color.slice(offset, offset + 2), 16));
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let count = 0;
  const enqueue = (pixel: number) => { if (!seen[pixel]) { seen[pixel] = 1; stack[count++] = pixel; } };
  enqueue(start);
  while (count) {
    const pixel = stack[--count], offset = pixel * 4;
    if (original.some((value, channel) => Math.abs(pixels[offset + channel] - value) > a.tolerance)) continue;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(pixels[offset + channel] * (1 - a.opacity) + replacement[channel] * a.opacity);
    if (pixel % width > 0) enqueue(pixel - 1);
    if (pixel % width < width - 1) enqueue(pixel + 1);
    if (pixel >= width) enqueue(pixel - width);
    if (pixel < width * (height - 1)) enqueue(pixel + width);
  }
  ctx.putImageData(image, 0, 0);
}

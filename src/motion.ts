import { createCanvas, type Canvas } from 'canvas';
import { setTimeout as delay } from 'node:timers/promises';
import { cubicSegments, draw, type Board, type DrawAction, type DrawStep, type Point } from './drawing.ts';
import { paintContours } from './paint.ts';

export interface Cursor extends Point { mode: 'idle' | 'moving' | 'pressed' | 'released' }

export function strokePath(a: DrawAction): Point[] {
  if (a.kind === 'paint') return paintContours(a.paint!).flatMap((part) => {
    const points = part.points;
    return part.closed ? [...points, points[0]] : points;
  });
  const [p, q] = a.points;
  if (a.kind === 'rect') return [p, { x: q.x, y: p.y }, q, { x: p.x, y: q.y }, p];
  if (a.kind === 'polygon') return [...a.points, p];
  if (a.kind === 'ellipse') return Array.from({ length: 65 }, (_, i) => {
    const angle = i / 64 * Math.PI * 2;
    return { x: (p.x + q.x) / 2 + Math.abs(q.x - p.x) / 2 * Math.cos(angle), y: (p.y + q.y) / 2 + Math.abs(q.y - p.y) / 2 * Math.sin(angle) };
  });
  if (a.kind === 'bezier' || a.kind === 'curve') {
    const path = [p];
    for (const [start, c1, c2, end] of cubicSegments(a)) {
      const length = Math.hypot(c1.x - start.x, c1.y - start.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(end.x - c2.x, end.y - c2.y);
      const count = Math.max(4, Math.min(64, Math.ceil(length / 4)));
      for (let i = 1; i <= count; i++) {
        const t = i / count, u = 1 - t;
        path.push({ x: u ** 3 * start.x + 3 * u ** 2 * t * c1.x + 3 * u * t ** 2 * c2.x + t ** 3 * end.x,
          y: u ** 3 * start.y + 3 * u ** 2 * t * c1.y + 3 * u * t ** 2 * c2.y + t ** 3 * end.y });
      }
    }
    if (a.closed || a.filled) path.push(p);
    return path;
  }
  return a.points;
}

export function pathPrefix(points: Point[], fraction: number): Point[] {
  const distances = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let remaining = distances.reduce((sum, value) => sum + value, 0) * fraction;
  const result = [points[0]];
  for (let i = 0; i < distances.length; i++) {
    if (remaining >= distances[i]) { result.push(points[i + 1]); remaining -= distances[i]; }
    else {
      const t = remaining / distances[i];
      result.push({ x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t });
      break;
    }
  }
  return result;
}

/** Preview pixels are temporary. The final frame uses the exact persisted action. */
export async function animateStep(
  canvas: Canvas, board: Board, step: DrawStep, cursor: Cursor, duration: number,
  emit: (cursor: Cursor) => void,
  finish: (target: Canvas) => void = (target) => draw(target, board, step),
): Promise<Cursor> {
  if (step.action.kind === 'paint') return animatePaint(canvas, board, step, cursor, duration, emit, finish);
  const ctx = canvas.getContext('2d');
  const base = ctx.getImageData(0, 0, board.width, board.height);
  const path = strokePath(step.action), start = path[0];
  const travelFrames = duration ? Math.max(2, Math.ceil(duration * 0.22 / 50)) : 0;
  for (let frame = 1; frame <= travelFrames; frame++) {
    const t = frame / travelFrames, eased = t * t * (3 - 2 * t);
    const arc = Math.sin(t * Math.PI) * Math.min(16, Math.hypot(start.x - cursor.x, start.y - cursor.y) * 0.08);
    emit({ x: cursor.x + (start.x - cursor.x) * eased, y: Math.max(0, Math.min(board.height - 1, cursor.y + (start.y - cursor.y) * eased - arc)), mode: 'moving' });
    await delay(duration * 0.22 / travelFrames);
  }
  const frames = duration ? Math.max(2, Math.ceil(duration * 0.78 / 50)) : 0;
  for (let frame = 1; frame <= frames; frame++) {
    const t = frame / frames, prefix = pathPrefix(path, t * t * (3 - 2 * t));
    ctx.putImageData(base, 0, 0);
    const a = step.action;
    if (a.kind !== 'fill') draw(canvas, board, { ...step, action: {
      ...a, kind: a.kind === 'spray' ? 'spray' : 'brush', brush: a.kind === 'brush' ? a.brush : 'pen', points: prefix, filled: false,
      color: a.filled ? a.stroke ?? a.color : a.color,
    } });
    emit({ ...prefix[prefix.length - 1], mode: 'pressed' });
    await delay(duration * 0.78 / frames);
  }
  ctx.putImageData(base, 0, 0);
  finish(canvas);
  const result: Cursor = { ...path[path.length - 1], mode: 'released' };
  emit(result);
  return result;
}

/** Reveal the rendered pixels along each stroke, including its clip, and lift between subpaths. */
async function animatePaint(canvas: Canvas, board: Board, step: DrawStep, cursor: Cursor, duration: number,
  emit: (cursor: Cursor) => void, finish: (target: Canvas) => void): Promise<Cursor> {
  const paint = step.action.paint!;
  const paths = paintContours(paint).map((part) => {
    const points = part.points;
    return part.closed ? [...points, points[0]] : points;
  });
  const ctx = canvas.getContext('2d'), base = ctx.getImageData(0, 0, board.width, board.height);
  const layer = createCanvas(board.width, board.height); finish(layer);
  const mask = createCanvas(board.width, board.height), maskCtx = mask.getContext('2d');
  const revealed = createCanvas(board.width, board.height), revealCtx = revealed.getContext('2d');
  const lengths = paths.map((path) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  maskCtx.lineCap = 'round'; maskCtx.lineJoin = 'round';
  maskCtx.lineWidth = paint.stroke ? paint.stroke.width * Math.max(...paint.stroke.pressure) * (paint.stroke.brush === 'spray' ? 4 : 2) + 2 : 4;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index], start = path[0], time = duration * lengths[index] / total;
    const travelFrames = duration ? Math.max(1, Math.ceil(time * 0.22 / 50)) : 0;
    for (let frame = 1; frame <= travelFrames; frame++) {
      const t = frame / travelFrames, eased = t * t * (3 - 2 * t);
      const arc = Math.sin(t * Math.PI) * Math.min(16, Math.hypot(start.x - cursor.x, start.y - cursor.y) * 0.08);
      emit({ x: cursor.x + (start.x - cursor.x) * eased, y: cursor.y + (start.y - cursor.y) * eased - arc, mode: 'moving' });
      await delay(time * 0.22 / travelFrames);
    }
    const frames = duration ? Math.max(1, Math.ceil(time * 0.78 / 50)) : 0;
    for (let frame = 1; frame <= frames; frame++) {
      const t = frame / frames, prefix = pathPrefix(path, t * t * (3 - 2 * t));
      maskCtx.beginPath(); maskCtx.moveTo(prefix[0].x, prefix[0].y);
      for (const point of prefix.slice(1)) maskCtx.lineTo(point.x, point.y);
      maskCtx.stroke();
      revealCtx.clearRect(0, 0, board.width, board.height);
      revealCtx.drawImage(layer, 0, 0);
      revealCtx.globalCompositeOperation = 'destination-in'; revealCtx.drawImage(mask, 0, 0);
      revealCtx.globalCompositeOperation = 'source-over';
      ctx.putImageData(base, 0, 0); ctx.drawImage(revealed, 0, 0);
      emit({ ...prefix.at(-1)!, mode: 'pressed' });
      await delay(time * 0.78 / frames);
    }
    cursor = { ...path.at(-1)!, mode: 'released' }; emit(cursor);
  }
  ctx.putImageData(base, 0, 0); ctx.drawImage(layer, 0, 0);
  emit(cursor);
  return cursor;
}

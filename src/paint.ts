import { color, label, number, object, type DrawAction, type Point } from './drawing.ts';
import { PAINT_BRUSHES } from './brushes.ts';
export type Matrix = [number, number, number, number, number, number];
interface PaintStroke { brush: typeof PAINT_BRUSHES[number]; color: string; width: number; pressure: [number, number, number] }
export interface PaintSpec {
  path: string;
  fill?: { mode: 'solid' | 'watercolor'; color: string; opacity: number; bleed: number; texture: number };
  stroke?: PaintStroke;
  hatch?: Omit<PaintStroke, 'pressure'> & { spacing: number; angle: number };
  clip_to?: string;
  matrix: Matrix;
  instances?: Matrix[];
}
export interface Contour { points: Point[]; closed: boolean }
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Absolute SVG path commands retain corners and disconnected strokes without adding join lines. */
export function contours(path: string): Contour[] {
  if (typeof path !== 'string' || !path.trim() || path.length > 16000) throw new Error('path 须为 1–16000 字符的 M/L/Q/C/Z 绝对坐标路径');
  const tokens = path.match(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  if (path.replace(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/g, '')) throw new Error('path 只支持大写 M、L、Q、C、Z 与数值');
  let i = 0, current: Point = { x: 0, y: 0 }, contour: Contour | undefined;
  const result: Contour[] = [];
  const point = (): Point => ({ x: number(Number(tokens[i++]), 'path.x', -8192, 8192), y: number(Number(tokens[i++]), 'path.y', -8192, 8192) });
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') { current = point(); contour = { points: [current], closed: false }; result.push(contour); continue; }
    if (!contour || contour.closed) throw new Error('每个子路径必须以 M 开始');
    if (command === 'Z') {
      contour.closed = true; current = contour.points[0];
      if (contour.points.length > 1 && contour.points.at(-1)!.x === current.x && contour.points.at(-1)!.y === current.y) contour.points.pop();
      continue;
    }
    if (command === 'L') { current = point(); contour.points.push(current); continue; }
    if (command !== 'C' && command !== 'Q') throw new Error('每段坐标前须写 M、L、Q 或 C');
    const start = current, control = point(), control2 = command === 'C' ? point() : control, end = point();
    const length = Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(control2.x - control.x, control2.y - control.y) + Math.hypot(end.x - control2.x, end.y - control2.y);
    const count = Math.max(2, Math.min(256, Math.ceil(length / 2)));
    for (let n = 1; n <= count; n++) {
      const t = n / count, u = 1 - t;
      contour.points.push(command === 'C'
        ? { x: u ** 3 * start.x + 3 * u * u * t * control.x + 3 * u * t * t * control2.x + t ** 3 * end.x,
          y: u ** 3 * start.y + 3 * u * u * t * control.y + 3 * u * t * t * control2.y + t ** 3 * end.y }
        : { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y });
    }
    current = end;
  }
  for (const part of result) part.points = part.points.filter((p, i, points) => !i || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (!result.length || result.some((part) => part.points.length < (part.closed ? 3 : 2))) throw new Error('开放路径至少两个不同的点，闭合路径至少三个点');
  if (result.reduce((sum, part) => sum + part.points.length, 0) > 8192) throw new Error('path 展开后最多 8192 个点，请拆分部件');
  return result;
}

function stroke(raw: unknown): PaintStroke {
  const value = object(raw), brush = value.brush ?? 'liner';
  if (!PAINT_BRUSHES.includes(brush as PaintStroke['brush'])) throw new Error(`未知笔刷，可用：${PAINT_BRUSHES.join(', ')}`);
  const pressure = value.pressure ?? [0.7, 1, 0.7];
  if (!Array.isArray(pressure) || pressure.length !== 3) throw new Error('pressure 须为起笔、中段、收笔三个压力值');
  return { brush: brush as PaintStroke['brush'], color: color(value.color), width: number(value.width ?? 3, 'stroke.width', 0.2, 128),
    pressure: pressure.map((p) => number(p, 'pressure', 0.05, 3)) as PaintStroke['pressure'] };
}

export function parsePaint(a: Record<string, unknown>): DrawAction {
  const parts = contours(a.path as string);
  const paint: PaintSpec = { path: a.path as string, matrix: [...IDENTITY] };
  if (a.fill !== undefined) {
    const fill = object(a.fill), mode = fill.mode ?? 'solid';
    if (mode !== 'solid' && mode !== 'watercolor') throw new Error('fill.mode 须为 solid 或 watercolor');
    if (parts.some((part) => !part.closed)) throw new Error('填色路径必须以 Z 闭合');
    paint.fill = { mode, color: color(fill.color), opacity: number(fill.opacity ?? 1, 'fill.opacity', 0.01, 1),
      bleed: number(fill.bleed ?? 0.025, 'fill.bleed', 0, 0.2), texture: number(fill.texture ?? 0.25, 'fill.texture', 0, 1) };
  }
  if (a.stroke !== undefined) paint.stroke = stroke(a.stroke);
  if (a.hatch !== undefined) {
    if (parts.some((part) => !part.closed)) throw new Error('排线路径必须以 Z 闭合');
    const hatch = object(a.hatch);
    const { pressure: _pressure, ...ink } = stroke(hatch);
    paint.hatch = { ...ink, spacing: number(hatch.spacing ?? 6, 'hatch.spacing', 2, 128), angle: number(hatch.angle ?? 45, 'hatch.angle', -360, 360) };
  }
  if (!paint.stroke && !paint.fill && !paint.hatch) throw new Error('至少指定 stroke、fill 或 hatch 中的一项');
  if (a.clip_to !== undefined) paint.clip_to = label(a.clip_to, 'clip_to');
  if (a.matrix !== undefined) {
    paint.matrix = parseMatrix(a.matrix);
  }
  if (a.instances !== undefined) {
    if (!Array.isArray(a.instances) || a.instances.length < 1 || a.instances.length > 64) throw new Error('instances 须包含 1–64 个仿射矩阵');
    paint.instances = a.instances.map(parseMatrix);
  }
  validateTransform(parts, paint.matrix, paint.instances);
  return { kind: 'paint', paint, label: label(a.label, '部件名称'), points: [],
    color: paint.stroke?.color ?? paint.fill?.color ?? paint.hatch!.color, size: paint.stroke?.width ?? 3,
    opacity: 1, brush: 'pen', filled: !!paint.fill, tolerance: 16, density: 32 };
}

function parseMatrix(value: unknown): Matrix {
  if (!Array.isArray(value) || value.length !== 6) throw new Error('matrix 必须包含六个仿射变换参数');
  return value.map((v) => number(v, 'matrix', -8192, 8192)) as Matrix;
}

export function validateTransform(parts: Contour[], matrix: Matrix, instances: Matrix[] = [IDENTITY]): void {
  if (parts.reduce((sum, part) => sum + part.points.length, 0) * instances.length > 8192) throw new Error('部件展开实例后最多 8192 个点，请拆分部件');
  for (const instance of instances) {
    const combined = multiply(matrix, instance);
    for (const part of parts) for (const point of part.points) {
      const p = transformed(point, combined);
      number(p.x, '变换后的 x', -8192, 8192); number(p.y, '变换后的 y', -8192, 8192);
    }
  }
}

/** Instances use local coordinates; the component transform moves their entire arrangement. */
export function paintContours(paint: PaintSpec): Contour[] {
  const parts = contours(paint.path);
  return (paint.instances ?? [IDENTITY]).flatMap((instance) => {
    const matrix = multiply(paint.matrix, instance);
    return parts.map((part) => ({ ...part, points: part.points.map((p) => transformed(p, matrix)) }));
  });
}

export function transformed(point: Point, matrix: Matrix): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function toolAction(action: DrawAction): unknown {
  return action.kind === 'paint' ? { ...action.paint, label: action.label } : action;
}

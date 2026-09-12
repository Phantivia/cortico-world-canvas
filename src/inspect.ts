import { createCanvas, type Canvas, type Image } from 'canvas';
import { number, object } from './drawing.ts';

/** Inspection coordinates refer to source pixels; the grid never enters the artwork. */
export function inspectImage(source: Canvas | Image, args: Record<string, unknown>) {
  if (args.grid !== undefined && typeof args.grid !== 'boolean') throw new Error('grid 必须是布尔值');
  const raw = args.region === undefined ? { x: 0, y: 0, width: source.width, height: source.height } : object(args.region);
  const x = number(raw.x, 'region.x', 0, source.width - 1, true);
  const y = number(raw.y, 'region.y', 0, source.height - 1, true);
  const width = number(raw.width, 'region.width', 1, source.width - x, true);
  const height = number(raw.height, 'region.height', 1, source.height - y, true);
  const scale = Math.min(args.region === undefined ? 1 : 4, 1024 / Math.max(width, height));
  const offset = args.grid ? 32 : 0;
  const canvas = createCanvas(Math.ceil(width * scale) + offset, Math.ceil(height * scale) + offset);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, x, y, width, height, offset, offset, width * scale, height * scale);
  let gridStep: number | undefined;
  if (args.grid) {
    const desired = Math.max(width, height) / 8;
    const unit = 10 ** Math.floor(Math.log10(desired));
    gridStep = [1, 2, 5, 10].map((n) => n * unit).find((n) => n >= desired)!;
    gridStep = Math.max(1, gridStep);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#263047';
    ctx.strokeStyle = '#26304740';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.textAlign = 'center';
    for (let column = Math.ceil(x / gridStep) * gridStep; column < x + width; column += gridStep) {
      const px = offset + (column - x) * scale;
      ctx.beginPath(); ctx.moveTo(px, offset); ctx.lineTo(px, canvas.height); ctx.stroke();
      ctx.fillText(String(column), Math.max(offset + 12, Math.min(canvas.width - 15, px)), 20);
    }
    ctx.textAlign = 'right';
    for (let row = Math.ceil(y / gridStep) * gridStep; row < y + height; row += gridStep) {
      const py = offset + (row - y) * scale;
      ctx.beginPath(); ctx.moveTo(offset, py); ctx.lineTo(canvas.width, py); ctx.stroke();
      ctx.fillText(String(row), offset - 4, Math.max(offset + 12, Math.min(canvas.height - 3, py + 4)));
    }
  }
  return { png: canvas.toBuffer('image/png'), view: {
    region: { x, y, width, height }, scale, offset: { x: offset, y: offset },
    width: canvas.width, height: canvas.height, ...(gridStep === undefined ? {} : { gridStep }),
  } };
}

const inkWidths = { liner: 1, pen: 0.3, rotring: 0.15, '2B': 0.3, HB: 0.3, '2H': 0.2, cpencil: 0.35, charcoal: 0.35, marker: 2, spray: 0.2 };
let target;
globalThis.renderBrushLayer = ({ width, height, parts, paint, seed }) => {
  if (!target) {
    target = brush.createCanvas(width, height, { pixelDensity: 1 });
    brush.scaleBrushes(1);
    brush.add('liner', { type: 'marker', weight: 1, scatter: 0, opacity: 255, spacing: 0.15, pressure: [1, 1], noise: 0, markerTip: false, rotate: 'natural' });
  }
  brush.clear(); brush.seed(seed); brush.noiseSeed(seed); brush.noField(); brush.noClip();
  brush.noFill(); brush.noWash(); brush.noStroke(); brush.noHatch(); brush.noMass();
  brush.push(); brush.translate(-width / 2, -height / 2);
  if (paint.fill) {
    const fill = paint.fill;
    if (fill.mode === 'solid') brush.wash(fill.color, fill.opacity * 255);
    else { brush.fill(fill.color, fill.opacity * 255); brush.fillBleed(fill.bleed); brush.fillTexture(fill.texture, 0.12, false); }
  }
  if (paint.stroke) brush.set(paint.stroke.brush, paint.stroke.color, paint.stroke.width / inkWidths[paint.stroke.brush]);
  if (paint.hatch) {
    const hatch = paint.hatch;
    brush.hatchStyle(hatch.brush, hatch.color, hatch.width / inkWidths[hatch.brush]);
    brush.hatch(hatch.spacing, hatch.angle * Math.PI / 180, { rand: 0.05 });
  }
  for (const part of parts) {
    const pressure = paint.stroke?.pressure ?? [1, 1, 1];
    let distance = 0;
    const lengths = part.points.map((p, i) => i ? Math.hypot(p.x - part.points[i - 1].x, p.y - part.points[i - 1].y) : 0);
    const length = lengths.reduce((sum, value) => sum + value, 0);
    brush.beginShape(0);
    part.points.forEach((p, i) => {
      distance += lengths[i];
      const t = length ? distance / length : 0;
      const value = t < 0.5 ? pressure[0] + (pressure[1] - pressure[0]) * t * 2 : pressure[1] + (pressure[2] - pressure[1]) * (t - 0.5) * 2;
      brush.vertex(p.x, p.y, value);
    });
    brush.endShape(part.closed);
  }
  brush.pop(); brush.render();
  if (!globalThis.canvasPigmentAlphaReady) throw new Error('p5.brush alpha adapter was not applied');
  return target.toDataURL('image/png').split(',')[1];
};

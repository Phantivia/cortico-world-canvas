import { join } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { CANVAS_DEFAULTS, type CanvasConfigSection } from './config.ts';
import { CanvasWorld } from './world.ts';

export const CANVAS: WorldDefinition<CanvasConfigSection> = {
  id: 'canvas',
  label: '头像画室',
  defaults: () => ({ ...CANVAS_DEFAULTS }),
  create: (ctx) => new CanvasWorld({ cfg: ctx.cfg, directory: join(ctx.dataDir, 'canvas'), timezone: ctx.timezone }),
};

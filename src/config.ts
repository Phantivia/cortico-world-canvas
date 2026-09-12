import type { ConfigGroup } from 'cortico/core/types.ts';

export interface CanvasConfigSection { enabled: boolean; port: number }
export const CANVAS_DEFAULTS: CanvasConfigSection = { enabled: false, port: 7795 };
export const CANVAS_CONFIG_GROUP: ConfigGroup = {
  id: 'world:canvas', owner: 'world:canvas',
  schema: {
    type: 'object', title: '画布 · 服务',
    properties: {
      'worlds.canvas.port': { type: 'integer', title: '画布网页端口', minimum: 1, maximum: 65535, 'x-hot': false, description: '重启后生效；占用时顺延。网页只监听本机。' },
    },
  },
};

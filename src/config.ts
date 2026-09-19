import type { ConfigGroup } from 'cortico/core/types.ts';

export interface CanvasConfigSection {
  enabled: boolean;
  port: number;
  /** Chrome executable used for brush rendering; empty finds the locally installed Google Chrome. */
  browserFile: string;
}
export const CANVAS_DEFAULTS: CanvasConfigSection = { enabled: false, port: 7795, browserFile: '' };
export const CANVAS_CONFIG_GROUP: ConfigGroup = {
  id: 'world:canvas', owner: 'world:canvas',
  schema: {
    type: 'object', title: '画布 · 服务',
    properties: {
      'worlds.canvas.port': { type: 'integer', title: '画布网页端口', minimum: 1, maximum: 65535, 'x-hot': false, description: '重启后生效；占用时顺延。网页只监听本机。' },
      'worlds.canvas.browserFile': {
        type: 'string', title: '画笔浏览器（Chrome）', 'x-hot': false, 'x-path': { kind: 'file' },
        description: '留空用本机安装的 Google Chrome。填一个 Chromium 系可执行文件就用它；本 World 不下载浏览器。重启后生效。',
      },
    },
  },
};

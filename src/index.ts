/**
 * 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。
 *
 * 配置段类型一并导出,给 bot 侧在 `declares` 覆盖里写 `worlds.canvas` 的字面量时用。
 */

import { CANVAS } from './definition.ts';

export default CANVAS;

export { CANVAS };
export { CANVAS_DEFAULTS, CANVAS_CONFIG_GROUP } from './config.ts';
export type { CanvasConfigSection } from './config.ts';

import type { ToolSchema, ToolTag } from 'cortico/core/types.ts';
import { PAINT_BRUSHES } from './brushes.ts';

const point = {
  type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false,
};
const title = { type: 'string', minLength: 1, maxLength: 120 };
const id = { type: 'string', description: '快照中返回的完整 ID。' };
const parameters = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const inspection = {
  region: { ...parameters({ x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, ['x', 'y', 'width', 'height']), description: '可选局部区域，使用原图像素坐标；小区域最多放大四倍。' },
  grid: { type: 'boolean', description: '附加原图像素坐标网格，便于定位；不写入画布或参考图。' },
};
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const ink = {
  brush: { type: 'string', enum: PAINT_BRUSHES, default: 'liner', description: 'liner 为清晰线稿；2B/HB/2H/cpencil 为铅笔，marker 为马克笔，charcoal 为炭笔，spray 为喷点。' },
  color,
  width: { type: 'number', minimum: 0.2, maximum: 128, default: 3, description: '标称笔宽，像素；纹理笔刷实际覆盖范围因压力和散布而异。' },
};
const action = parameters({
  label: { ...title, description: '部件名称，便于定位修改，如“左侧刘海底色”“左眼上眼睑”。' },
  path: { type: 'string', maxLength: 16000, description: '绝对像素路径，每段都写命令：M x y 起笔；L x y 直线；Q cx cy x y 二次曲线；C c1x c1y c2x c2y x y 三次曲线；Z 闭合。可用多个 M 表示断开的笔画。填色和排线的每个子路径都必须 Z 闭合。' },
  fill: parameters({ color, mode: { type: 'string', enum: ['solid', 'watercolor'], default: 'solid' }, opacity: { type: 'number', minimum: 0.01, maximum: 1, default: 1 }, bleed: { type: 'number', minimum: 0, maximum: 0.2, default: 0.025, description: '水彩边缘扩散。' }, texture: { type: 'number', minimum: 0, maximum: 1, default: 0.25, description: '水彩纸纹强度。' } }, ['color']),
  stroke: parameters({ ...ink, pressure: { type: 'array', items: { type: 'number', minimum: 0.05, maximum: 3 }, minItems: 3, maxItems: 3, description: '起笔、中段、收笔压力，默认 [0.7,1,0.7]；[1,1,1] 为等宽线。' } }, ['color']),
  hatch: parameters({ ...ink, spacing: { type: 'number', minimum: 2, maximum: 128, default: 6 }, angle: { type: 'number', minimum: -360, maximum: 360, default: 45, description: '排线方向，度。' } }, ['color']),
  clip_to: { ...id, description: '可选：将本动作限制在更早的闭合路径步骤内，填写该步骤 ID。适合阴影、高光和纹理。' },
  matrix: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6, description: '可选仿射矩阵 [a,b,c,d,e,f]；通常保留快照或 previous 中的值，整体改比例用 canvas_transform。' },
  instances: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6 }, minItems: 1, maxItems: 64, description: '可选：用多个局部仿射矩阵重复同一路径，如雨点或刻度。先应用每个 instances，再应用全局 matrix；所有实例共用一个步骤 ID。省略时绘制一次，每批最多 256 个实例。' },
}, ['label', 'path']);
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const patchProperties = Object.fromEntries(Object.entries(action.properties).map(([key, schema]) => {
  if (key === 'fill' || key === 'stroke' || key === 'hatch') {
    const nested = schema as ReturnType<typeof parameters>;
    return [key, nullable(parameters(Object.fromEntries(Object.entries(nested.properties).map(([field, value]) => [field, nullable(value)]))))];
  }
  return [key, key === 'clip_to' || key === 'instances' ? nullable(schema) : schema];
}));
const patch = { ...parameters(patchProperties), description: '仅修改提供的字段；fill/stroke/hatch 按子字段合并。null 删除样式或样式子字段（可选字段恢复默认值），clip_to:null 清除裁剪，instances:null 恢复单次绘制。' };

export const CANVAS_TOOLS: (ToolSchema & { tags: readonly ToolTag[] })[] = [
  {
    name: 'canvas_new', tags: ['act'], description: '新建并命名画布；原画布自动存档，参考图队列保留。返回新画布截图。',
    parameters: parameters({ title, width: { type: 'integer', minimum: 64, maximum: 2048, default: 1024 }, height: { type: 'integer', minimum: 64, maximum: 2048, default: 1024 }, background: { type: 'string', description: '#RRGGBB，默认 #ffffff。' } }, ['title']),
  },
  {
    name: 'canvas_save', tags: ['act'], description: '将当前画布保存为 PNG 文件，返回文件路径和下载地址。每次保存生成新文件。',
    parameters: parameters({ filename: { type: 'string', description: '可选文件名（无需扩展名），不能包含目录。' } }),
  },
  {
    name: 'canvas_draw', tags: ['act'], description: '用 p5.brush 按顺序绘制一批路径部件。每个部件至少指定 fill、stroke、hatch 一项。可组合铺色、带压力的笔画、阴影排线；后画的在上层。整批成功后返回步骤 ID 与截图。坐标原点在左上，单位像素。',
    parameters: parameters({
      actions: { type: 'array', minItems: 1, maxItems: 64, items: action },
    }, ['actions']),
  },
  {
    name: 'canvas_transform', tags: ['act'], description: '整体移动、缩放或旋转选定的 p5.brush 部件，保持笔宽、ID 和遮挡顺序，返回截图和 previous 供 canvas_edit 还原。共同变换轮廓与其阴影时，须同时选中相关步骤。',
    parameters: parameters({ step_ids: { type: 'array', items: id, minItems: 1, maxItems: 64, uniqueItems: true }, dx: { type: 'number', minimum: -4096, maximum: 4096, default: 0 }, dy: { type: 'number', minimum: -4096, maximum: 4096, default: 0 }, scale_x: { type: 'number', minimum: 0.05, maximum: 20, default: 1 }, scale_y: { type: 'number', minimum: 0.05, maximum: 20, description: '默认与 scale_x 相同。' }, rotate: { type: 'number', minimum: -360, maximum: 360, default: 0, description: '顺时针角度。先缩放，再旋转，最后平移。' }, origin: { ...point, description: '缩放和旋转中心，默认 (0,0)。' } }, ['step_ids']),
  },
  {
    name: 'canvas_edit', tags: ['act'], description: '按 step_id 原位修改部件：action 完整替换，或 patch 只改指定字段，二选一。保留 ID、随机种子及遮挡顺序。整批成功后返回截图和 previous；将 previous 作为 updates 再调用即可还原。后续连通填充会重新计算。',
    parameters: parameters({ updates: { type: 'array', minItems: 1, maxItems: 64, items: { ...parameters({ step_id: id, action, patch }, ['step_id']), oneOf: [{ required: ['action'], not: { required: ['patch'] } }, { required: ['patch'], not: { required: ['action'] } }] } } }, ['updates']),
  },
  {
    name: 'canvas_snapshot', tags: ['read', 'snapshot'], description: '查看当前画布截图、尺寸、标题和全部有效绘制步骤（含 ID 和参数）。',
    parameters: parameters(inspection),
  },
  {
    name: 'canvas_undo', tags: ['act'], description: '撤销指定 step_id 的单个步骤，并重放其余步骤。若有 clip_to 引用它，须先修改或撤销那些依赖步骤。返回撤销后的截图。',
    parameters: parameters({ step_id: id }, ['step_id']),
  },
  {
    name: 'canvas_references', tags: ['read', 'snapshot'], description: '列出人类上传的参考图名称与 ID。传入 ids 可查看最多 8 张原图；不传则查看队列前 8 张。',
    parameters: parameters({ ids: { type: 'array', items: id, maxItems: 8, description: '查看 region 局部时须选择一张图片。' }, ...inspection }),
  },
  {
    name: 'canvas_game_enter', tags: ['act'], description: '进入「你画我猜」：画室网页切换为游戏界面（画板 + 计分板），回执附完整主持流程与计分规则。已在游戏中时只重发说明。',
    parameters: parameters({}),
  },
  {
    name: 'canvas_game_round', tags: ['act'], description: '开始一局：登记题目并启动倒计时，网页弹出计时器、字数和公开提示，题目本身不显示。倒计时结束会收到事件。上一局未揭示或未取消时不能开新局。',
    parameters: parameters({
      answer: { type: 'string', minLength: 1, maxLength: 40, description: '题目，观众看不到；揭示前不能说出来。' },
      seconds: { type: 'integer', minimum: 10, maximum: 1800, default: 300, description: '倒计时秒数。' },
      hint: { type: 'string', maxLength: 40, description: '可选公开提示，如「水果」「四字成语」。' },
    }, ['answer']),
  },
  {
    name: 'canvas_game_timer', tags: ['act'], description: '调整本局倒计时：seconds 从现在起重新计时（延长或缩短）；stop 作废本局且不揭示答案。二选一。',
    parameters: parameters({ seconds: { type: 'integer', minimum: 10, maximum: 1800 }, stop: { type: 'boolean' } }),
  },
  {
    name: 'canvas_game_reveal', tags: ['act'], description: '结算本局：停止倒计时，网页弹出揭示动画公布题目。winners 是本局得分者名字（按名次），只用于展示；分数须先用 canvas_game_score 写入。',
    parameters: parameters({ winners: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 20 } }),
  },
  {
    name: 'canvas_game_scoreboard', tags: ['read', 'snapshot'], description: '查看游戏状态：模式、本局题目与剩余秒数、上一局揭示结果，以及按分数排序的完整计分板。',
    parameters: parameters({}),
  },
  {
    name: 'canvas_game_score', tags: ['act'], description: '写入计分板，单个或批量：每项 name 配 add（加减分）或 set（设定分）。remove 删除名字；reset 先清空再写入。回执为更新后的排名。',
    parameters: parameters({
      entries: { type: 'array', maxItems: 64, items: parameters({ name: { type: 'string', minLength: 1, maxLength: 40 }, add: { type: 'integer', minimum: -100000, maximum: 100000 }, set: { type: 'integer', minimum: -100000, maximum: 100000 } }, ['name']) },
      remove: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 40 } },
      reset: { type: 'boolean', description: '清空计分板；与 entries 同时给时先清空再写入。' },
    }),
  },
  {
    name: 'canvas_game_exit', tags: ['act'], description: '退出游戏回到自由画板：未揭示的一局作废，计分板保留（下次进入仍在，reset 才清零）。',
    parameters: parameters({}),
  },
];

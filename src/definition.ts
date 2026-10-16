import { join } from 'node:path';
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { CANVAS_DEFAULTS, type CanvasConfigSection } from './config.ts';
import { CANVAS_TOOLS } from './tools.ts';
import { CanvasWorld } from './world.ts';

export const CANVAS: WorldDefinition<CanvasConfigSection> = {
  id: 'canvas',
  label: '头像画室',
  defaults: () => ({ ...CANVAS_DEFAULTS }),
  create: (ctx) => new CanvasWorld({ cfg: ctx.cfg, directory: join(ctx.dataDir, 'canvas'), timezone: ctx.timezone }),
  describe: {
    tools: describeTools(CANVAS_TOOLS, {
      canvas_new: { zh: '新建一张命名画布,旧画布自动存档。', en: 'Starts a new named canvas; the previous one is archived.' },
      canvas_save: { zh: '把当前画布存成 PNG 文件,给出路径和下载地址。', en: 'Saves the current canvas as a PNG file and returns its path and download link.' },
      canvas_draw: { zh: '用 p5.brush 画一批路径:铺色、带压力的笔画、排线。', en: 'Draws a batch of paths with p5.brush: fills, pressure-sensitive strokes and hatching.' },
      canvas_transform: { zh: '整体移动、缩放或旋转选中的部件。', en: 'Moves, scales or rotates selected parts as a group.' },
      canvas_edit: { zh: '按步骤 ID 原位改一个部件的路径或样式。', en: "Edits a part's path or style in place by step ID." },
      canvas_snapshot: { zh: '看当前画布的截图和全部绘制步骤,可放大局部、加坐标网格。', en: 'Shows the current canvas and all drawing steps, optionally zoomed into a region or with a coordinate grid.' },
      canvas_undo: { zh: '撤销一个步骤并重画其余部分。', en: 'Undoes one step and redraws the rest.' },
      canvas_references: { zh: '列出并查看人上传的参考图。', en: 'Lists and views the reference images people uploaded.' },
      canvas_game_enter: { zh: '把画室网页切成「你画我猜」游戏界面。', en: 'Switches the studio page to the draw-and-guess game.' },
      canvas_game_round: { zh: '出一道题并开始倒计时,网页上只显示字数和提示。', en: 'Starts a round with a secret answer and a countdown; the page shows only its length and a hint.' },
      canvas_game_timer: { zh: '重设本局倒计时,或作废本局。', en: "Resets the round's countdown or cancels the round." },
      canvas_game_reveal: { zh: '结束本局,在网页上揭示答案和得分者。', en: 'Ends the round and reveals the answer and winners on the page.' },
      canvas_game_scoreboard: { zh: '查看游戏状态和计分板。', en: 'Shows the game state and the scoreboard.' },
      canvas_game_score: { zh: '给观众加分、设分或删名字。', en: 'Adds, sets or removes scores for viewers.' },
      canvas_game_exit: { zh: '退出游戏回到画板,计分板保留。', en: 'Leaves the game for the free canvas; the scoreboard is kept.' },
    }),
    events: [
      {
        type: 'canvas.references',
        description: { zh: '有人在画室网页上传或改名了参考图,附这张图的名称与 ID。', en: 'Someone uploaded or renamed a reference image on the studio page; carries its name and ID.' },
      },
      {
        type: 'canvas.game',
        description: { zh: '「你画我猜」本局倒计时结束,附题目。', en: 'The draw-and-guess countdown ran out; carries the answer.' },
        trigger: 'flush',
      },
    ],
  },
};

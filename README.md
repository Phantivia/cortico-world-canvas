# cortico-world-canvas

Owner: `src/definition.ts`

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的画室 World，以独立 npm 包发布：独立网页、参考图队列、
绘画工具和带图片的工具回执，另有一个你画我猜模式。

## 与 Cortico 的关系

这是一个扩展包，不是 Cortico 的一部分。它按 Cortico 的扩展契约声明自己：

```jsonc
"cortico": { "kind": "world", "api": 4 }
```

运行时它以 `cortico/<框架 src 下的路径>` import 框架（`cortico/world.ts`、`cortico/core/types.ts` …），
由框架 `src/extensions/runtime.ts` 注册的模块钩子解析到框架源码本身，扩展与框架共用同一份实例。
因此包必须是 `"type": "module"`。本 World 没有控制台面板，不需要构建产物。

## 安装

```bash
corepack pnpm install
```

然后二选一装进 Cortico：控制台「扩展」页手动安装，填本目录的绝对路径；或在 `<Cortico>/extensions/` 下
`corepack pnpm add --ignore-workspace <本目录绝对路径>`。装完整进程重启 Cortico。

在控制台启用「头像画室」并重启，或在部署配置加入
`"worlds": { "canvas": { "enabled": true, "port": 7795 } }`。 World 默认关闭，
只监听 `127.0.0.1`；端口占用时顺延，实际地址以控制台链接为准。

## 浏览器

绘制新路径需要一个 Chromium 系浏览器。画笔引擎起一个无窗口的独立浏览器进程，
从本地依赖加载 p5.brush 2.2.2 standalone，通过 WebGL2 渲染；无需外网或打开画室页面。
本 World 不下载浏览器：`worlds.canvas.browserFile` 留空用本机安装的 Google Chrome（puppeteer 的
`chrome` channel 定位），填了就用那个可执行文件。找不到浏览器时第一次绘制的工具回执报错，网页与
参考图功能不受影响。

## 开发

`tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 `resolve.alias` 都把 `cortico/*` 指向
`../BOT/src/`，也就是与本目录同级的框架 checkout。框架放在别处时改这两处，它们必须同步。

```bash
corepack pnpm typecheck
corepack pnpm test
```

测试不起浏览器：绘制走 `canvas` 包的软件渲染，图层与网页由本地 HTTP 服务器验证。

## 渲染

透明图层适配器固定对应 p5.brush 2.2.2：图层内使用颜料混色，图层之间使用 alpha 合成。
旧图层缓存保持原像素；重新编辑的部件使用当前适配器渲染。

## 网页

主页面 `/` 提供多图上传、上传前命名、重命名、参考图原图预览、主画布、手绘工具、
新建、保存和步骤撤销。`/overlay` 供 OBS 浏览器源使用，显示画布、参考图和步骤，隐藏操作按钮。
参考图支持 PNG/JPEG，每张最多 10 MiB、4096×4096 像素，队列最多 64 张。
在主页面按 Ctrl+V 可粘贴剪贴板图片，支持连续粘贴及一次粘贴多张；图片进入待上传列表，命名后点击上传。

## 工具

| 工具 | 作用 |
|---|---|
| `canvas_new` | 新建标题、宽高与底色；默认 1024×1024，最大 2048×2048 |
| `canvas_draw` | 顺序执行 1–64 个动作，完成后返回步骤 ID 和最终截图 |
| `canvas_edit` | 按步骤 ID 完整替换或局部修改 1–64 个动作，保留叠加顺序，返回旧参数供还原 |
| `canvas_transform` | 成组平移、缩放、旋转路径部件，保留笔宽和叠加顺序，返回旧参数 |
| `canvas_snapshot` | 当前截图与全部有效步骤（含参数），支持局部放大和坐标网格 |
| `canvas_undo` | 按 `step_id` 撤销单步并重放其余步骤 |
| `canvas_save` | 另存 PNG，返回本地路径与下载地址 |
| `canvas_references` | 列出全部参考图，按 ID 查看最多 8 张，可对单张局部放大 |
| `canvas_game_enter` | 进入你画我猜：网页切到游戏界面，回执附 [GAME_GUIDE.md](GAME_GUIDE.md) 的主持流程与计分规则 |
| `canvas_game_round` | 开局：登记题目（网页只显示字数和公开提示）并启动倒计时，默认 300 秒 |
| `canvas_game_timer` | 从现在起重新计时，或 `stop` 作废本局 |
| `canvas_game_reveal` | 结算：停止倒计时，弹出答案揭示动画，可附本局得分者名单 |
| `canvas_game_scoreboard` | 查看模式、本局题目与剩余秒数、上一局揭示、完整排名 |
| `canvas_game_score` | 单个或批量写计分板：`add` 加减、`set` 设定、`remove` 删除、`reset` 清空 |
| `canvas_game_exit` | 回到自由画板，计分板保留 |

模型通过命名路径部件绘画，路径使用大写绝对坐标 `M/L/Q/C/Z`，支持断开的子路径、
尖角和连续曲线。每个部件可铺实色或水彩、描压力笔画、填排线，并可用 `clip_to`
将阴影与纹理限制在更早的闭合部件内。多个闭合子路径分别填实，不解释为镂空。
线稿、铅笔、马克笔、炭笔和喷点由 p5.brush 渲染；起笔、中段和收笔压力分别可调。
`instances` 接受最多 64 个六数仿射矩阵，将同一路径重复为刻度或雨点等，所有实例共享一个步骤 ID。
先应用局部实例矩阵，再应用动作的 `matrix`；省略时绘制一次，每批最多 256 个实例。
坐标从左上角 `(0,0)` 开始，颜色使用 `#RRGGBB`，参数见 `tools.ts`。
网页手绘保留普通笔、马克笔、软笔、橡皮擦、直线、矩形、椭圆、连通填充与喷漆；旧动作和旧存档继续使用原渲染器。

```json
{
  "actions": [
    {"label":"脸部底色","path":"M300 240 C430 170 650 190 710 280 C760 500 620 690 510 675 C380 670 280 460 300 240 Z","fill":{"color":"#ffe4d6"}},
    {"label":"左眼上眼睑","path":"M365 425 Q405 397 450 417","stroke":{"brush":"liner","color":"#776688","width":4,"pressure":[0.6,1,0.5]}}
  ]
}
```

`canvas_edit` 的每个更新指定 `step_id`，以及 `action` 完整替换或 `patch` 局部修改，二选一。
例如 `{"step_id":"…","patch":{"fill":{"color":"#80b8c0"},"stroke":null}}` 只改填色并移除描边。
`fill/stroke/hatch` 按子字段合并；`null` 移除整项或子字段，删除可选子字段后重新应用默认值。
`clip_to:null` 清除裁剪，`instances:null` 恢复单次绘制，`path/label/matrix/instances` 直接替换；未提供的字段保留。合并后的动作仍须通过完整校验。
回执的 `previous` 是完整旧动作，可直接作为下一次的 `updates` 还原修改。
步骤 ID、随机种子及位置保留；历史仍列出当前有效动作。
`canvas_transform` 将选中部件围绕 `origin` 缩放、旋转，再平移；矩阵存入动作，笔宽不变。
裁剪随目标部件的轮廓变化；整体变换时应同时选中阴影与其目标。删除或打开一个被 `clip_to`
引用的轮廓前，必须先修改或撤销依赖步骤。整批修改按最终依赖关系校验。

快照和参考图的 `region:{x,y,width,height}` 使用源图像素，不能超出图像；局部最长边限制
为 1024，最多放大四倍。`grid:true` 附加原图坐标网格和 32 像素边距，不修改存档。
回执 `view`（参考图为 `views`）中的映射为：输出坐标 = `(源坐标 - region 起点) × scale + offset`。
无观察参数时保持原图大小。带裁剪参数的参考图请求必须选中一张图片。

绘画策略与完整图例见 [ENV_PROMPT.md](ENV_PROMPT.md)，研究来源及质量评估范围见 [RESEARCH.md](RESEARCH.md)。

## 你画我猜

自由画板是默认界面。`canvas_game_enter` 把主页面和 `/overlay` 一起切到游戏界面：画板居中，
右侧计分板显示前十名；开局时舞台上方弹出倒计时（进度环、字数空格、公开提示），揭示时弹出答案
卡片与本局得分者。名次变化、进场、加分和弹窗都有过渡动画。游戏逻辑不在 World 内：谁答对、记几分
由模型按 [GAME_GUIDE.md](GAME_GUIDE.md) 判断后写入计分板， World 只保存状态、隐藏题目和计时。
主持说明在控制台「画布 · 你画我猜主持说明」可编辑，每次进入游戏时读取。

倒计时到点由画布子进程发出内部事件 `canvas.game`（`trigger: flush`），正文带题目和下一步；
之后的回答不计分，先记分再揭示。`data/canvas/game.json` 保存模式、局数、当前一局（含题目）、
上一局揭示与计分板；重启后进行中的倒计时按原截止时间继续，到点照常投递。计分板跨局、跨重启
保留，`canvas_game_score` 的 `reset` 清零；最多 500 人，名字 40 字以内。

## 执行与存储契约

渲染、原图解码、PNG 编码和网页服务在独立子进程中运行。HTTP 操作和模型工具共用
串行队列；整批动作先校验，再播放绘制，最后原子替换步骤档案。播放帧是临时视图，
截图工具和保存工具在队列中读取已提交的画布。模型仅提交路径和样式数据，不能执行浏览器脚本。
调用被取消或超时会关闭画笔浏览器并停止子进程，防止未执行动作迟到写入；重新启用需重启 World。

光标在抬笔移动时走缓入缓出的轻弧线，落笔时按路径长度推进；几何图形描边后填色。
曲线绘制与光标采样共享路径。断开的子路径之间抬笔移动，预览沿笔迹揭示已渲染的像素，
保留材质和部件裁剪。填色在轮廓完成后显示。批量修改按最终构图预览其他部件，
逐个播放选中部件的笔迹，保持同批修改后的遮挡和裁剪关系。
密集编辑预先合成未变化的上层以减少动画开销；含旧连通填充时逐帧重放。
这些预览优化不改变提交结果，最终画布仍按完整步骤顺序重放。
24×24 像素头像光标的图案、调色板和四种动作节奏来自
[cortico-world-pvz 的 cursor-companion 目录](https://github.com/Phantivia/cortico-world-pvz/tree/main/cursor-companion)，
以静态 SVG（`src/public/corti-cursor.svg`）随本 World 自带，不建立运行时依赖。光标属于展示层，不进入作品 PNG。

`data/canvas/index.json` 保存当前画布 ID 与参考图队列；`boards/<id>.json` 保存画布和步骤；
`references/` 保存解码归一化后的 PNG；`exports/` 保存每次另存的作品。新建不会覆盖旧档案，
`layers/` 按内容哈希保存 p5.brush 透明 PNG 图层，步骤引用哈希；未提交批次可能留下未引用图层。
重启、撤销、快照和保存直接重放缓存，无需重新启动画笔浏览器。随机种子随步骤保存，编辑重新渲染该部件。
移出参考图队列保留其文件。每张画布最多 5000 步，每批最多 64 个动作和 64000 个路径字符；
每个路径最多 16000 字符、展开后最多 8192 点。图层解码缓存限制为 128 MiB。

图片通过 Core 的 `media.put` 进入现有工具回执链路。供应商的 `multimodal` 声明
决定请求是否附带图片；非多模态模型保留文字占位符，无额外视觉模型调用。

## 许可

MIT，见 [LICENSE](LICENSE)。框架 Cortico 也是 MIT，两者经扩展契约相连，许可各归各。

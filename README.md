# 头像画室 · Canvas Studio

[中文](#中文) · [English](#english)

让 Coo 在本机画室网页上用 p5.brush 笔触画画，还能主持「你画我猜」。
Lets Coo paint with p5.brush strokes on a local studio page and host a draw-and-guess game.

## 中文

Coo 用工具在画布上一批一批地画，画的过程在网页上实时播放，画完的截图随工具回执回给 Coo,Coo 看着改。
人可以在网页上传参考图让 Coo 临摹。另有一个「你画我猜」模式:Coo 出题作画，观众在聊天或弹幕里猜,Coo 判分。
网页带一个给 OBS 用的直播画面。

画室和你画我猜来自可缇(CortiV)的直播，是在 CortiV 直播里验证过的参考实现，别的 Persona 或非直播场景的兼容性没测过。
网页上的标题「Corti 的头像画室」和画笔光标旁的名字「可缇」是直播画面用的，目前不能改。

### 功能

- 新建画布(默认 1024×1024,最大 2048×2048),用命名的路径部件作画：实色或水彩铺色、带起笔收笔压力的线稿、铅笔、马克笔、炭笔、喷点和排线
- 按步骤改颜色或形状，整体移动、缩放、旋转部件，撤销某一步;新建画布时旧画布自动存档
- 查看当前截图和全部步骤，可放大局部、加坐标网格;另存 PNG 并给出下载地址
- 查看人上传的参考图，可放大局部;有人上传或改名参考图时 Coo 会收到通知
- 你画我猜：网页切到游戏界面，登记题目和倒计时(网页只显示字数和公开提示),到点通知 Coo,揭示答案，计分板跨局保留
- 人在网页上也能手绘、新建、保存、撤销;`/overlay` 直播画面显示画布、参考图和步骤，不显示按钮

### 安装前准备

1. **Chrome 浏览器**。Coo 画新笔画时，画笔引擎在后台起一个无窗口的 Chrome 渲染 p5.brush,不需要外网，也不用打开网页。本扩展不下载浏览器。
   - 装 [Google Chrome](https://www.google.com/chrome/),装在默认位置即可，配置留空就会自动找到。
   - 不用 Chrome 的，在配置「画笔浏览器（Chrome）」里填一个 Chromium 系浏览器的可执行文件路径。
   - 确认方法：启用后让 Coo 画一笔。找不到浏览器时，第一次绘制的工具回执会报错;网页和参考图不受影响。
2. **能看图的模型**(建议)。截图和参考图随工具回执发给模型，供应商声明了多模态时请求才带图。非多模态模型只收到文字占位,Coo 看不到自己画了什么。

### 安装

在 Cortico 或 Coopanion 的扩展页搜 `cortico-world-canvas` 安装，重启后在 World 总览里启用「头像画室」。

依赖里的 `canvas` 是原生模块，安装时要运行它的构建脚本(从 GitHub 下载预编译文件)。扩展页安装会自动放行;命令行安装要带上 `--allow-build`:

```bash
cd extensions && corepack pnpm add --allow-build=canvas cortico-world-canvas
```

下载不到预编译文件，或所在平台没有预编译文件时,`canvas` 会在本机编译，需要 C++ 编译工具链和 Cairo。

### 使用

- World 默认关闭。启用并重启后，网页只监听 `127.0.0.1`,默认端口 7795,被占用时顺延。World 页签上有「打开画室」和「直播 Overlay」两个链接，实际地址以链接为准。
- 在画室网页点「添加参考图」,或拖入、Ctrl+V 粘贴(PNG/JPEG,每张最多 10 MiB、最长边 4096 px,队列最多 64 张),命名后点「上传 N 张参考图」。Coo 会收到通知，可以用工具查看。
- 对 Coo 说想画什么,Coo 自己新建画布、分批画、看截图修改。网页和直播画面同步播放笔迹。
- 你画我猜：让 Coo 进入游戏(`canvas_game_enter`),Coo 出题、开局、作画。观众的猜测要靠别的 World 送进来，比如直播间弹幕。倒计时到点 Coo 会收到通知，先记分再揭示答案。
- 绘画规则和主持流程在 World 页签的「画布 · 环境提示词」「画布 · 你画我猜主持说明」里，可以直接改。默认计分：第一个答对 +5,第二、三个 +3,其余在时限内答对的 +1。
- OBS 里加一个浏览器源，地址填「直播 Overlay」链接。

### 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `worlds.canvas.enabled` | `false` | 是否启用 |
| `worlds.canvas.port` | `7795` | 画室网页端口，被占用时顺延，重启后生效 |
| `worlds.canvas.browserFile` | 空 | 画笔用的浏览器可执行文件，留空用本机安装的 Google Chrome,重启后生效 |

画作、参考图、存档和计分板存在数据目录的 `canvas/` 下。

### 限制与常见问题

- 一次工具调用超过 60 秒或被取消，画布服务会停下(防止没执行完的动作之后才写进画布),要重启这个 World 才能再用。
- 每张画布最多 5000 步;每批最多 64 个动作，路径长度和重复实例数也有上限，超出时工具回执会说明。
- 网页只在本机能打开，没有登录。
- 实现细节(渲染、工具参数、编辑语义、存储格式)见 [docs/internals.md](https://github.com/Phantivia/cortico-world-canvas/blob/main/docs/internals.md)。

## English

Coo paints on a canvas with tools, one batch of strokes at a time. The studio page plays the strokes as they land, and the finished screenshot comes back in the tool result so Coo can look and revise.
People can upload reference images on the page for Coo to copy. In draw-and-guess mode Coo picks a word and draws it, viewers guess in chat, and Coo keeps score.
The page includes an overlay view for OBS.

The studio and the game come from the Corti (CortiV) live streams. They are a reference implementation tested on CortiV streams; other Personas and non-streaming setups have not been tested.
The page title "Corti 的头像画室" and the name "可缇" next to the brush cursor belong to the stream look and cannot be changed for now.

### Features

- New canvases (1024×1024 by default, up to 2048×2048). Coo draws named path parts: solid or watercolor fills, line art with start, middle and end pressure, pencil, marker, charcoal, spray and hatching.
- Change a step's colors or shape, move, scale or rotate parts as a group, and undo any step. Starting a new canvas archives the old one.
- See the current screenshot and every step, zoom into a region or add a coordinate grid. Save a PNG with a download link.
- View the reference images people uploaded, with zoom. Coo is notified when someone uploads or renames one.
- Draw-and-guess: the page switches to a game layout, a round has a secret answer and a countdown (the page shows only its length and a public hint), Coo is notified when time runs out, the answer is revealed, and the scoreboard carries across rounds.
- People can also draw by hand on the page, start a new canvas, save and undo. The `/overlay` view shows the canvas, references and steps without buttons.

### Before you install

1. **Chrome.** When Coo draws new strokes, the brush engine starts a windowless Chrome in the background to render p5.brush. It needs no internet access and no open page. This extension does not download a browser.
   - Install [Google Chrome](https://www.google.com/chrome/) in its default location. With the setting left empty, it is found automatically.
   - To use another browser, set "画笔浏览器（Chrome）" (brush browser) to the executable of a Chromium-based browser.
   - To check: enable the World and ask Coo to draw a stroke. If no browser is found, the first drawing tool result reports an error. The page and reference images keep working.
2. **A model that can see images** (recommended). Screenshots and references are sent in tool results, and images are attached only when the provider declares multimodal support. A text-only model gets a placeholder, and Coo cannot see the drawing.

### Install

Search for `cortico-world-canvas` on the Extensions page of Cortico or Coopanion and install it. After restarting, enable "头像画室" in the World overview.

The `canvas` dependency is a native module whose build script downloads a prebuilt binary from GitHub. The Extensions page allows it automatically. From the command line, allow it with `--allow-build`:

```bash
cd extensions && corepack pnpm add --allow-build=canvas cortico-world-canvas
```

If the prebuilt binary cannot be downloaded or does not exist for your platform, `canvas` compiles from source, which needs a C++ toolchain and Cairo.

### Usage

- The World is off by default. Once enabled and restarted, the page listens on `127.0.0.1` only, port 7795 by default, moving to the next port if taken. The World tab shows "打开画室" (open studio) and "直播 Overlay" (stream overlay) links with the actual address.
- On the studio page click "添加参考图" (add reference), or drag images in or paste them with Ctrl+V (PNG/JPEG, up to 10 MiB and 4096 px on the long side, 64 in the queue). Name them and click "上传 N 张参考图" (upload). Coo is notified and can look at them.
- Tell Coo what to draw. Coo creates a canvas, draws in batches and revises from the screenshots. The page and the overlay play the strokes live.
- Draw-and-guess: ask Coo to enter the game (`canvas_game_enter`). Coo picks a word, starts the round and draws. Guesses have to come in through another World, such as live-room chat. When the countdown ends Coo is notified, scores first, then reveals the answer.
- The drawing rules and the host guide are in the World tab under "画布 · 环境提示词" (environment prompt) and "画布 · 你画我猜主持说明" (host guide), and can be edited there. Default scoring: +5 for the first correct guess, +3 for the second and third, +1 for anyone else in time.
- In OBS, add a browser source pointing at the "直播 Overlay" link.

### Configuration

| Key | Default | Description |
|---|---|---|
| `worlds.canvas.enabled` | `false` | Turns the World on |
| `worlds.canvas.port` | `7795` | Studio page port; moves to the next free port; applies after restart |
| `worlds.canvas.browserFile` | empty | Browser executable for the brush engine; empty uses the installed Google Chrome; applies after restart |

Drawings, references, archives and the scoreboard are stored under `canvas/` in the data directory.

### Limits and FAQ

- If one tool call runs longer than 60 seconds or is cancelled, the canvas service stops so unfinished actions cannot land later. Restart the World to use it again.
- A canvas holds up to 5000 steps. A batch holds up to 64 actions, and path length and repeated instances have limits too; the tool result says when one is exceeded.
- The page opens only on this machine and has no login.
- Implementation details (rendering, tool parameters, edit semantics, storage format) are in [docs/internals.md](https://github.com/Phantivia/cortico-world-canvas/blob/main/docs/internals.md) (Chinese).

## 开发 · Development

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

包里直接发 TypeScript 源码，没有构建步骤。测试用 `canvas` 包的软件渲染，不起浏览器。对着本地框架改动开发见 [docs/internals.md](https://github.com/Phantivia/cortico-world-canvas/blob/main/docs/internals.md#开发)。

The package ships TypeScript sources and has no build step. Tests use the software renderer of the `canvas` package and start no browser.

## 许可 · License

MIT

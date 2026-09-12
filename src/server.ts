import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import { object } from './drawing.ts';
import { BrushRenderer } from './brush-renderer.ts';
import { toolAction } from './paint.ts';
import { inspectImage } from './inspect.ts';
import { animateStep, type Cursor } from './motion.ts';
import { CanvasStore, type Reference } from './store.ts';
import { GameStore, type GameStatus } from './game.ts';

export interface CanvasReply { text: string; images?: { png: string; fallback: string }[] }
interface CanvasServerOptions {
  directory: string;
  port: number;
  animationMs?: number;
  browserPath?: string;
  onReferences?: (references: Reference[]) => void;
  /** 倒计时到点的通知正文,由 World 作为内部事件投递。 */
  onGameEvent?: (text: string) => void;
}

const GAME_COMMANDS = ['canvas_game_enter', 'canvas_game_round', 'canvas_game_timer', 'canvas_game_reveal', 'canvas_game_scoreboard', 'canvas_game_score', 'canvas_game_exit'];

export class CanvasServer {
  readonly store: CanvasStore;
  readonly game: GameStore;
  private server: Server | null = null;
  private subscribers = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private painting: { step: number; total: number; label: string } | null = null;
  private cursor: Cursor = { x: 0, y: 0, mode: 'idle' };
  private preview: string | null = null;
  private stopping = false;
  private readonly brush: BrushRenderer;
  url = '';

  constructor(private readonly options: CanvasServerOptions) {
    this.store = new CanvasStore(options.directory);
    this.brush = new BrushRenderer(options.browserPath);
    this.game = new GameStore({
      directory: this.store.directory,
      onChange: () => this.publish(),
      onExpire: (round) => options.onGameEvent?.(`[你画我猜] 第 ${round.id} 局倒计时结束，题目「${round.answer}」${round.hint ? `（提示：${round.hint}）` : ''}。之后的回答不计分；请先用 canvas_game_score 给倒计时内答对的观众记分，再用 canvas_game_reveal 揭示答案。`),
    });
  }

  state() {
    return { board: this.store.board, references: this.store.references, queued: this.queued,
      painting: this.painting, cursor: this.cursor, preview: this.preview, game: this.game.view() };
  }

  private gameCommand(name: string, args: Record<string, unknown>): CanvasReply {
    const reply = (message: string, status: GameStatus): CanvasReply => ({ text: JSON.stringify({ message, ...status }) });
    switch (name) {
      case 'canvas_game_enter': {
        const status = this.game.enter();
        return { text: `${this.game.guide()}\n\n${JSON.stringify({ message: '画室网页已切换到你画我猜界面', ...status })}` };
      }
      case 'canvas_game_round': {
        const status = this.game.startRound(args);
        return reply(`第 ${status.round!.id} 局已开始，倒计时 ${status.round!.remainingSeconds} 秒；题目只有你知道`, status);
      }
      case 'canvas_game_timer': {
        const status = this.game.timer(args);
        return reply(status.round ? `倒计时已重设为 ${status.round.remainingSeconds} 秒` : '本局已取消，未揭示答案', status);
      }
      case 'canvas_game_reveal': {
        const status = this.game.reveal(args);
        return reply(`第 ${status.lastReveal!.roundId} 局已揭示答案「${status.lastReveal!.answer}」`, status);
      }
      case 'canvas_game_scoreboard': return reply('当前游戏状态', this.game.status());
      case 'canvas_game_score': {
        const result = this.game.score(args);
        return { text: JSON.stringify({ message: `已更新 ${result.changes.length} 项`, ...result }) };
      }
      default: return reply('已回到自由画板', this.game.exit());
    }
  }

  private emit(type: string, data: unknown): void {
    const packet = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const response of this.subscribers) {
      if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); this.subscribers.delete(response); }
      else response.write(packet);
    }
  }

  private publish(): void { this.emit('state', this.state()); }

  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('画布服务已停止'));
    if (this.queued >= 16) return Promise.reject(new Error('画布队列已满，请稍后重试'));
    this.queued++;
    this.publish();
    const result = this.tail.then(() => { if (this.stopping) throw new Error('画布调用已取消'); return action(); });
    this.tail = result.catch(() => undefined).finally(() => { this.queued--; this.publish(); });
    return result;
  }

  command(name: string, args: Record<string, unknown>): Promise<CanvasReply> {
    // Game commands touch no pixels and answer immediately instead of waiting behind a playing batch.
    if (GAME_COMMANDS.includes(name)) {
      if (this.stopping) return Promise.reject(new Error('画布服务已停止'));
      try { return Promise.resolve(this.gameCommand(name, args)); } catch (error) { return Promise.reject(error); }
    }
    return this.enqueue(async () => {
      if (name === 'canvas_new') {
        this.store.newBoard(args);
        this.cursor = { x: 0, y: 0, mode: 'idle' };
        return this.snapshot('已新建画布');
      }
      if (name === 'canvas_snapshot') return this.snapshot('当前画布', undefined, true, args);
      if (name === 'canvas_save') {
        const saved = this.store.save(args.filename);
        return { text: JSON.stringify({ ...saved, url: `${this.url}${saved.url}` }) };
      }
      if (name === 'canvas_undo') {
        const id = this.store.undo(args.step_id);
        return this.snapshot(`已撤销步骤 ${id}`);
      }
      if (name === 'canvas_references') {
        const selected = this.store.referenceImages(args.ids);
        if (args.region !== undefined && selected.length !== 1) throw new Error('查看局部参考图时，ids 须选择一张图片');
        const views = await Promise.all(selected.map(async ({ ref, png }) => {
          const inspected = args.region !== undefined || args.grid !== undefined ? inspectImage(await loadImage(png), args) : { png, view: undefined };
          return { ref, ...inspected };
        }));
        return {
          text: JSON.stringify({ references: this.store.references, shown: selected.map(({ ref }) => ref.id),
            views: views.filter(({ view }) => view).map(({ ref, view }) => ({ id: ref.id, ...view })) }),
          images: views.map(({ ref, png, view }) => ({ png: png.toString('base64'), fallback: `[参考图：${ref.name}，ID=${ref.id}，${ref.width}×${ref.height}${view ? '，观察区域见 views' : ''}]` })),
        };
      }
      if (!['canvas_draw', 'canvas_edit', 'canvas_transform'].includes(name)) throw new Error('未知画布工具');
      const editing = name !== 'canvas_draw';
      const board = this.store.current();
      const steps = name === 'canvas_transform' ? this.store.prepareTransform(args) : editing ? this.store.prepareEdits(args.updates) : this.store.prepare(args.actions);
      const previous = board.steps.filter((old) => steps.some((step) => step.id === old.id)).map((step) => ({ step_id: step.id, action: toolAction(step.action) }));
      const planned = editing ? board.steps.map((old) => steps.find((step) => step.id === old.id) ?? old) : [...board.steps, ...steps];
      this.store.validateLayers(planned);
      let working = [...board.steps];
      let canvas = this.store.copyCanvas();
      const duration = Math.min(this.options.animationMs ?? 850, 12000 / steps.length);
      try {
        for (let index = 0; index < steps.length; index++) {
          if (this.stopping) throw new Error('画布调用已取消');
          this.painting = { step: index + 1, total: steps.length, label: steps[index].action.label };
          if (steps[index].action.kind === 'paint') this.store.cacheRaster(steps[index], await this.brush.render(board, steps[index]));
        }
        for (let index = 0; index < steps.length; index++) {
          if (this.stopping) throw new Error('画布调用已取消');
          this.painting = { step: index + 1, total: steps.length, label: steps[index].action.label };
          const position = editing ? planned.findIndex((step) => step.id === steps[index].id) : working.length;
          const later = editing ? planned.slice(position + 1) : [];
          // Edits preview the final dependency graph, including clips changed in the same batch.
          if (editing) canvas = this.store.replay(planned.slice(0, position));
          const frameBoard = { ...board, steps: editing ? planned : [...working, steps[index]] };
          const preview = editing ? createCanvas(board.width, board.height) : canvas;
          // Flood fills depend on lower pixels; other layers can be flattened once per edited step.
          const upper = editing && !later.some((step) => step.action.kind === 'fill') ? createCanvas(board.width, board.height) : null;
          if (upper) for (const step of later) this.store.draw(upper, frameBoard, step);
          this.cursor = await animateStep(canvas, board, steps[index], this.cursor, duration, (cursor) => {
            if (this.stopping) throw new Error('画布调用已取消');
            this.cursor = cursor;
            if (editing) {
              preview.getContext('2d').drawImage(canvas, 0, 0);
              if (upper) preview.getContext('2d').drawImage(upper, 0, 0);
              else for (const step of later) this.store.draw(preview, frameBoard, step);
            }
            this.preview = preview.toBuffer('image/png').toString('base64');
            this.emit('frame', { ...this.painting, cursor, png: this.preview });
          }, (target) => this.store.draw(target, frameBoard, steps[index]));
          working = editing ? planned : [...working, steps[index]];
        }
        if (this.stopping) throw new Error('画布调用已取消');
        this.store.commit(working, editing ? this.store.replay(working) : canvas);
        const reply = this.snapshot(`已${editing ? '修改' : '完成'} ${steps.length} 个步骤`, steps.map((step) => step.id));
        if (editing) reply.text = JSON.stringify({ ...JSON.parse(reply.text), previous });
        return reply;
      } finally {
        this.preview = null;
        this.painting = null;
        this.cursor = { ...this.cursor, mode: 'idle' };
        this.publish();
      }
    });
  }

  private snapshot(message: string, completed?: string[], includeSteps = false, args: Record<string, unknown> = {}): CanvasReply {
    const board = this.store.current();
    const { steps, ...description } = board;
    const inspected = args.region !== undefined || args.grid !== undefined ? inspectImage(this.store.canvas!, args) : undefined;
    return {
      text: JSON.stringify({ message, board: { ...description, stepCount: steps.length, ...(includeSteps ? { steps: steps.map((step) => ({ id: step.id, action: toolAction(step.action) })) } : {}) },
        ...(inspected ? { view: inspected.view } : {}),
        ...(completed ? { completed: steps.filter((step) => completed.includes(step.id)).map((step) => ({ id: step.id, label: step.action.label })) } : {}) }),
      images: [{ png: (inspected?.png ?? this.store.png()).toString('base64'), fallback: `[画布截图：${board.title}，${board.width}×${board.height}，${board.steps.length} 步${inspected ? '，观察区域见 view' : ''}]` }],
    };
  }

  async start(): Promise<void> {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'");
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && req.headers.origin !== this.url) {
        res.status(403).json({ error: '写入只接受本机同源请求' }); return;
      }
      next();
    });
    app.use(express.json({ limit: '14mb' }));
    app.get('/api/state', (_req, res) => res.json(this.state()));
    app.get('/api/canvas.png', (_req, res) => {
      if (!this.store.board) { res.status(404).end(); return; }
      res.type('png').send(this.store.png());
    });
    app.get('/events', (_req, res) => {
      res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: 'state', data: this.state() })}\n\n`);
      this.subscribers.add(res);
      res.on('close', () => this.subscribers.delete(res));
    });
    app.post('/api/command', (req, res) => {
      void (async () => {
        const body = object(req.body);
        const reply = await this.command(String(body.name), object(body.args ?? {}));
        // canvas_game_enter answers with the guide text ahead of its JSON line; other replies are JSON throughout.
        const json = reply.text.slice(reply.text.lastIndexOf('\n') + 1);
        res.json({ result: JSON.parse(json), state: this.state() });
      })().catch((error) => res.status(400).json({ error: String(error.message ?? error) }));
    });
    app.post('/api/references', (req, res) => {
      void this.enqueue(async () => {
        const body = object(req.body);
        const ref = await this.store.upload(body.name, body.base64);
        this.options.onReferences?.([ref]);
        return ref;
      }).then((reference) => res.json({ reference, references: this.store.references }))
        .catch((error) => res.status(400).json({ error: String(error.message ?? error) }));
    });
    app.patch('/api/references/:id', (req, res) => {
      void this.enqueue(() => {
        this.store.renameReference(String(req.params.id), object(req.body).name);
        this.options.onReferences?.(this.store.references.filter((ref) => ref.id === req.params.id));
      }).then(() => res.json({ references: this.store.references }))
        .catch((error) => res.status(400).json({ error: String(error.message ?? error) }));
    });
    app.delete('/api/references/:id', (req, res) => {
      void this.enqueue(() => this.store.removeReference(String(req.params.id)))
        .then(() => res.json({ references: this.store.references }))
        .catch((error) => res.status(400).json({ error: String(error.message ?? error) }));
    });
    app.use('/references', express.static(join(this.store.directory, 'references')));
    app.use('/exports', express.static(join(this.store.directory, 'exports'), { setHeaders: (res) => res.setHeader('Content-Disposition', 'attachment') }));
    const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
    app.get('/overlay', (_req, res) => res.sendFile(join(publicDir, 'index.html')));
    app.use(express.static(publicDir));
    app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 400).json({ error: error.message ?? '请求失败' });
    });
    for (let offset = 0; offset < (this.options.port === 0 ? 1 : 50); offset++) {
      const candidate = createServer(app);
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(this.options.port + offset, '127.0.0.1', () => { candidate.removeListener('error', reject); resolve(); });
        });
        this.server = candidate;
        this.url = `http://127.0.0.1:${(candidate.address() as AddressInfo).port}`;
        this.heartbeat = setInterval(() => { for (const response of this.subscribers) response.write(': heartbeat\n\n'); }, 15000);
        this.heartbeat.unref();
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    throw new Error('画布服务没有可用端口');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.game.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.tail;
    await this.brush.close();
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
    }
  }

  async abort(): Promise<void> {
    this.stopping = true;
    await this.brush.close();
  }
}

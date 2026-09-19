import { fork, type ChildProcess } from 'node:child_process';
import { logLines } from 'cortico/core/ipc-logger.ts';
import { nowIso } from 'cortico/core/util.ts';
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldConsoleDecl, ToolDef } from 'cortico/core/types.ts';
import { CANVAS_CONFIG_GROUP, type CanvasConfigSection } from './config.ts';
import { CANVAS_TOOLS } from './tools.ts';
import type { CanvasReply } from './server.ts';
import type { Reference } from './store.ts';

export class CanvasWorld implements World {
  readonly id = 'canvas';
  private child: ChildProcess | null = null;
  private host: WorldHost | null = null;
  private url = '';
  private nextId = 0;
  private closed: Promise<void> = Promise.resolve();
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(private readonly options: { cfg: CanvasConfigSection; directory: string; timezone?: string }) {}
  envPromptVars() { return {}; }

  console(): WorldConsoleDecl {
    return {
      lamps: [{ label: '画布', state: this.child?.connected ? 'online' : 'offline' }],
      links: this.url ? [{ label: '打开画室', href: this.url }, { label: '直播 Overlay', href: `${this.url}/overlay` }] : [],
      config: [CANVAS_CONFIG_GROUP],
      promptDocs: [
        { key: 'worlds.canvas.envPrompt', title: '画布 · 环境提示词', description: '绘图、参考图与多模态回执的使用规则。', role: 'envPrompt', path: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)) },
        { key: 'worlds.canvas.gameGuide', title: '画布 · 你画我猜主持说明', description: '进入游戏时随 canvas_game_enter 回执发出的流程与计分规则。', path: fileURLToPath(new URL('./GAME_GUIDE.md', import.meta.url)) },
      ],
    };
  }

  tools(): ToolDef[] {
    return CANVAS_TOOLS.map((tool) => ({ ...tool, handler: async (args, ctx) => {
      ctx.signal?.throwIfAborted();
      const abort = () => this.fail(new Error('画布调用已取消；服务需重新启动'));
      ctx.signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await this.rpc(tool.name, args) as CanvasReply;
        // 图随回执落库:每张的文本形态(fallback)由 core 接在正文后,这里不重复写进 text。
        const blobs = result.images?.map((image) => ({ bytes: Buffer.from(image.png, 'base64'), mime: 'image/png', fallbackText: image.fallback }));
        return { text: result.text, ...(blobs?.length ? { blobs } : {}) };
      } finally { ctx.signal?.removeEventListener('abort', abort); }
    } }));
  }

  async start(host: WorldHost): Promise<void> {
    await this.closed;
    this.host = host;
    const child = fork(fileURLToPath(new URL('./engine-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    this.closed = new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
    logLines(child.stderr, host.log.child('stdio'), 'warn', 'stderr');
    child.on('error', (error) => { if (this.child === child) { host.log.emit('error', '画布引擎子进程出错', { event: 'child-error', err: error }); this.fail(error); } });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      host.log.emit('error', '画布引擎子进程退出', { event: 'exit', data: { exitCode: code, signal } });
      this.fail(new Error('画布引擎已退出'));
    });
    child.on('message', (message: { id?: number; value?: unknown; error?: string; event?: string; references?: Reference[]; text?: string }) => {
      if (message.event === 'references') {
        void host.pushEvent({ source: this.id, type: 'canvas.references', ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'),
          text: `[画布] 人类更新了参考图：${JSON.stringify(message.references)}。可用 canvas_references 查看。`,
        }).catch((error) => host.log.error(String(error)));
        return;
      }
      if (message.event === 'game') {
        void host.pushEvent({ source: this.id, type: 'canvas.game', ts: nowIso(this.options.timezone ?? 'Asia/Shanghai'), text: message.text!, origin: 'internal' }, { trigger: 'flush' })
          .catch((error) => host.log.error(String(error)));
        return;
      }
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      this.pending.delete(message.id!);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.value);
    });
    try {
      this.url = (await this.rpc('init', {
        directory: this.options.directory, port: this.options.cfg.port, browserPath: this.options.cfg.browserFile.trim(),
      }) as { url: string }).url;
      host.log.info(`画布网页已启动 ${this.url}`);
    } catch (error) { this.fail(error as Error); throw error; }
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    this.url = '';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (child && child.exitCode === null) {
      // Disconnect lets the engine close its owned Chromium before the final process exit.
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill(), 15000);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
  }

  private rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('画布服务未启动'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('画布操作超时，服务已停止以取消待执行动作')), 60000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      child.send({ id, name, args }, (error) => { if (error) this.fail(error); });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { await this.closed; this.host = null; return; }
    try { await this.rpc('stop', {}); } finally { this.fail(new Error('画布服务已停止')); await this.closed; this.host = null; }
  }
}

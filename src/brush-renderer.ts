import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { paintContours, type Contour, type PaintSpec } from './paint.ts';
import type { Board, DrawStep } from './drawing.ts';

const require = createRequire(import.meta.url);
interface LayerInput { width: number; height: number; parts: Contour[]; paint: PaintSpec; seed: number }

/** A local WebGL renderer produces transparent layers; persisted layers make replay independent of Chromium. */
export class BrushRenderer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private dimensions = '';
  private closed = false;
  private launching: Promise<Browser> | null = null;
  private closing: Promise<void> | null = null;
  constructor(private readonly browserPath = '') {}

  async render(board: Board, step: DrawStep): Promise<Buffer> {
    if (this.closed) throw new Error('画笔引擎已关闭');
    if (!this.browser) {
      this.launching = puppeteer.launch({ ...(this.browserPath ? { executablePath: this.browserPath } : { channel: 'chrome' as const }),
        headless: true, args: ['--enable-unsafe-swiftshader'], timeout: 10000, protocolTimeout: 45000 });
      const browser = await this.launching;
      if (this.closed) { await this.close(); throw new Error('画笔调用已取消'); }
      this.browser = browser;
      this.launching = null;
    }
    const dimensions = `${board.width}:${board.height}`;
    if (!this.page || dimensions !== this.dimensions) {
      await this.page?.close();
      this.page = await this.browser.newPage();
      await this.page.setRequestInterception(true);
      this.page.on('request', (request) => { void request.abort(); });
      await this.page.addScriptTag({ path: fileURLToPath(new URL('./public/brush-alpha.js', import.meta.url)) });
      await this.page.addScriptTag({ path: require.resolve('p5.brush/standalone') });
      await this.page.addScriptTag({ path: fileURLToPath(new URL('./public/brush-engine.js', import.meta.url)) });
      this.dimensions = dimensions;
    }
    const paint = step.action.paint!;
    const parts = paintContours(paint);
    const png = await this.page.evaluate((input: LayerInput) => (globalThis as unknown as { renderBrushLayer(input: LayerInput): string }).renderBrushLayer(input),
      { width: board.width, height: board.height, parts, paint, seed: step.seed });
    return Buffer.from(png, 'base64');
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      const browser = this.browser ?? await this.launching?.catch(() => null);
      this.browser = null; this.page = null;
      await browser?.close();
    })();
  }
}

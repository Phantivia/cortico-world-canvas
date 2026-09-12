import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameStore } from '../src/game.ts';
import { CanvasWorld } from '../src/world.ts';
import type { ToolOutcome } from 'cortico/core/types.ts';
import { FakeHost } from './helpers/fake-host.ts';

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), 'corti-game-')); dirs.push(dir); return dir; }
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('scoreboard', () => {
  it('applies add, set, remove and reset in one batch, ranks ties together, and survives reopening', () => {
    const dir = directory();
    const game = new GameStore({ directory: dir });
    const first = game.score({ entries: [{ name: '阿明', add: 5 }, { name: '小红', add: 3 }, { name: ' 阿明 ', add: 3 }, { name: '路人', set: 8 }] });
    expect(first.scoreboard).toEqual([{ name: '阿明', score: 8, rank: 1 }, { name: '路人', score: 8, rank: 1 }, { name: '小红', score: 3, rank: 3 }]);
    expect(first.changes).toEqual([{ name: '阿明', before: null, after: 5 }, { name: '小红', before: null, after: 3 }, { name: '阿明', before: 5, after: 8 }, { name: '路人', before: null, after: 8 }]);
    expect(game.score({ remove: ['路人', '不存在'] }).changes).toEqual([{ name: '路人', before: 8, after: null }]);
    expect(new GameStore({ directory: dir }).ranked().map((entry) => entry.name)).toEqual(['阿明', '小红']);
    expect(game.score({ reset: true, entries: [{ name: '新人', add: 1 }] }).scoreboard).toEqual([{ name: '新人', score: 1, rank: 1 }]);
  });

  it('rejects malformed writes without touching the board', () => {
    const game = new GameStore({ directory: directory() });
    game.score({ entries: [{ name: 'A', add: 1 }] });
    expect(() => game.score({})).toThrow('至少提供一项');
    expect(() => game.score({ entries: [{ name: 'B', add: 1, set: 2 }] })).toThrow('二选一');
    expect(() => game.score({ entries: [{ name: 'B' }] })).toThrow('二选一');
    expect(() => game.score({ entries: [{ name: 'B', add: 1.5 }] })).toThrow('整数');
    expect(() => game.score({ entries: [{ name: '  ', add: 1 }] })).toThrow('name');
    expect(() => game.score({ entries: Array(65).fill({ name: 'B', add: 1 }) })).toThrow('64');
    expect(game.ranked()).toEqual([{ name: 'A', score: 1, rank: 1 }]);
  });
});

describe('rounds', () => {
  it('keeps the answer out of the page view, expires once after extensions, and reveals the stored answer', () => {
    vi.useFakeTimers();
    const expired: number[] = [];
    const game = new GameStore({ directory: directory(), onExpire: (round) => expired.push(round.id) });
    expect(game.view().mode).toBe('free');
    const status = game.startRound({ answer: '苹果派', seconds: 120, hint: '甜点' });
    expect(status).toMatchObject({ mode: 'guess', round: { id: 1, answer: '苹果派', hint: '甜点', remainingSeconds: 120, expired: false } });
    const view = game.view();
    expect(JSON.stringify(view)).not.toContain('苹果派');
    expect(view.round).toMatchObject({ id: 1, length: 3, hint: '甜点', expired: false });
    expect(() => game.startRound({ answer: '第二题' })).toThrow('尚未结束');
    vi.advanceTimersByTime(119_000);
    game.timer({ seconds: 30 });
    vi.advanceTimersByTime(29_000);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(expired).toEqual([1]);
    expect(game.view().round?.expired).toBe(true);
    expect(game.status().round?.remainingSeconds).toBe(0);
    const revealed = game.reveal({ winners: ['阿明', '小红'] });
    expect(revealed.round).toBeNull();
    expect(revealed.lastReveal).toEqual({ roundId: 1, answer: '苹果派', winners: ['阿明', '小红'] });
    expect(game.view().reveal).toMatchObject({ roundId: 1, answer: '苹果派', hint: '甜点', winners: ['阿明', '小红'] });
    expect(game.startRound({ answer: '第二题' }).round?.id).toBe(2);
    expect(game.view().reveal).toBeNull();
    game.timer({ stop: true });
    expect(game.view().round).toBeNull();
    expect(() => game.reveal({})).toThrow('开局');
    vi.advanceTimersByTime(600_000);
    expect(expired).toEqual([1]);
  });

  it('re-arms a running countdown after reopening; exit drops the round but keeps the scores', () => {
    vi.useFakeTimers();
    const dir = directory();
    const first = new GameStore({ directory: dir });
    first.score({ entries: [{ name: '阿明', add: 5 }] });
    first.startRound({ answer: '风筝', seconds: 60 });
    first.close();
    vi.advanceTimersByTime(20_000);
    const expired: number[] = [];
    const second = new GameStore({ directory: dir, onExpire: (round) => expired.push(round.id) });
    expect(second.view().round).toMatchObject({ id: 1, length: 2 });
    vi.advanceTimersByTime(40_000);
    expect(expired).toEqual([1]);
    const status = second.exit();
    expect(status).toMatchObject({ mode: 'free', round: null, lastReveal: null });
    expect(status.scoreboard).toEqual([{ name: '阿明', score: 5, rank: 1 }]);
    expect(JSON.parse(readFileSync(join(dir, 'game.json'), 'utf8'))).toMatchObject({ mode: 'free', round: null, scoreboard: [{ name: '阿明', score: 5 }] });
  });
});

describe('module', () => {
  it('serves the guide on entry, delivers the countdown as an internal flush event, and hides the answer from page state', async () => {
    const dir = directory();
    const host = new FakeHost();
    const module = new CanvasWorld({ cfg: { enabled: true, port: 0 }, directory: join(dir, 'canvas') });
    await module.start(host);
    try {
      const call = (name: string, args = {}) => module.tools().find((tool) => tool.name === name)!.handler(args, { role: 'main', log: host.log }) as Promise<ToolOutcome>;
      const enter = await call('canvas_game_enter');
      expect(enter.text).toContain('主持说明');
      expect(enter.text).toContain('canvas_game_reveal');
      expect(JSON.parse(enter.text.slice(enter.text.lastIndexOf('\n') + 1))).toMatchObject({ mode: 'guess', round: null });
      const round = await call('canvas_game_round', { answer: '小猫', seconds: 1, hint: '动物' });
      expect(JSON.parse(round.text).round).toMatchObject({ id: 1, answer: '小猫' });
      const base = module.console().links![0].href;
      const state = await (await fetch(`${base}/api/state`)).json() as { game: { mode: string; round: unknown } };
      expect(state.game.mode).toBe('guess');
      expect(state.game.round).toMatchObject({ length: 2, hint: '动物' });
      expect(JSON.stringify(state.game)).not.toContain('小猫');
      await expect.poll(() => host.events.length, { timeout: 5000 }).toBe(1);
      expect(host.events[0]).toMatchObject({ source: 'canvas', type: 'canvas.game', origin: 'internal' });
      expect(host.events[0].text).toContain('小猫');
      expect(host.pushOpts[0]).toEqual({ trigger: 'flush' });
      const scored = await call('canvas_game_score', { entries: [{ name: '阿明', add: 5 }, { name: '小红', add: 3 }] });
      expect(JSON.parse(scored.text).scoreboard[0]).toEqual({ name: '阿明', score: 5, rank: 1 });
      const reveal = await call('canvas_game_reveal', { winners: ['阿明', '小红'] });
      expect(JSON.parse(reveal.text).lastReveal).toEqual({ roundId: 1, answer: '小猫', winners: ['阿明', '小红'] });
      const board = JSON.parse((await call('canvas_game_scoreboard')).text) as { round: unknown; scoreboard: { name: string }[] };
      expect(board.scoreboard.map((entry) => entry.name)).toEqual(['阿明', '小红']);
      expect(board.round).toBeNull();
      const exit = JSON.parse((await call('canvas_game_exit')).text) as { mode: string; scoreboard: unknown[] };
      expect(exit.mode).toBe('free');
      expect(exit.scoreboard).toHaveLength(2);
      await expect(call('canvas_game_timer', { seconds: 30 })).rejects.toThrow('开局');
    } finally { await module.stop(); }
  });
});

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { number, object } from './drawing.ts';

/**
 * 你画我猜的运行态:界面模式、当前一局、上一局揭示与计分板。
 * 游戏规则不在这里执行——谁答对、记几分由主持人按说明书判断后写入;
 * 存储只保证题目在揭示前不出现在网页状态里,以及倒计时到点有一次回调。
 */
type GameMode = 'free' | 'guess';
interface ScoreEntry { name: string; score: number }
interface RankedEntry extends ScoreEntry { rank: number }
interface GameRound { id: number; answer: string; hint: string | null; startedAt: number; endsAt: number; expired: boolean }
interface GameReveal { roundId: number; answer: string; hint: string | null; winners: string[]; at: number }
/** 网页看到的投影:进行中一局只给字数与提示,题目留在文件里。 */
interface GameView {
  mode: GameMode;
  now: number;
  rounds: number;
  round: { id: number; hint: string | null; length: number; startedAt: number; endsAt: number; expired: boolean } | null;
  reveal: GameReveal | null;
  scoreboard: RankedEntry[];
}
/** 主持人看到的读数:与 GameView 的区别是带题目和剩余秒数。 */
export interface GameStatus {
  mode: GameMode;
  round: { id: number; answer: string; hint: string | null; remainingSeconds: number; expired: boolean } | null;
  lastReveal: { roundId: number; answer: string; winners: string[] } | null;
  scoreboard: RankedEntry[];
}
interface GameFile { mode: GameMode; rounds: number; round: GameRound | null; reveal: GameReveal | null; scoreboard: ScoreEntry[] }

export const GAME_GUIDE_PATH = fileURLToPath(new URL('./GAME_GUIDE.md', import.meta.url));
const SCOREBOARD_LIMIT = 500;
const BATCH_LIMIT = 64;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > max) throw new Error(`${name} 必须是 1–${max} 字的文本`);
  return value.trim();
}

function names(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > BATCH_LIMIT) throw new Error(`${name} 须为最多 ${BATCH_LIMIT} 个名字`);
  return value.map((item) => text(item, name, 40));
}

export class GameStore {
  private data: GameFile;
  private countdown: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: { directory: string; onChange?: () => void; onExpire?: (round: GameRound) => void }) {
    const path = this.path();
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as GameFile : { mode: 'free', rounds: 0, round: null, reveal: null, scoreboard: [] };
    if (this.data.round && !this.data.round.expired) this.arm();
  }

  private path(): string { return join(this.options.directory, 'game.json'); }

  private persist(): void {
    const path = this.path();
    writeFileSync(`${path}.tmp`, JSON.stringify(this.data));
    renameSync(`${path}.tmp`, path);
    this.options.onChange?.();
  }

  guide(): string { return readFileSync(GAME_GUIDE_PATH, 'utf8').trim(); }

  ranked(): RankedEntry[] {
    const sorted = [...this.data.scoreboard].sort((a, b) => b.score - a.score);
    const ranked: RankedEntry[] = [];
    sorted.forEach((entry, index) => {
      const previous = ranked[index - 1];
      ranked.push({ ...entry, rank: previous && previous.score === entry.score ? previous.rank : index + 1 });
    });
    return ranked;
  }

  view(): GameView {
    const { round } = this.data;
    return {
      mode: this.data.mode, now: Date.now(), rounds: this.data.rounds,
      round: round ? { id: round.id, hint: round.hint, length: Array.from(round.answer).length, startedAt: round.startedAt, endsAt: round.endsAt, expired: round.expired } : null,
      reveal: this.data.reveal, scoreboard: this.ranked(),
    };
  }

  status(): GameStatus {
    const { round, reveal } = this.data;
    return {
      mode: this.data.mode,
      round: round ? { id: round.id, answer: round.answer, hint: round.hint, remainingSeconds: Math.max(0, Math.ceil((round.endsAt - Date.now()) / 1000)), expired: round.expired } : null,
      lastReveal: reveal ? { roundId: reveal.roundId, answer: reveal.answer, winners: reveal.winners } : null,
      scoreboard: this.ranked(),
    };
  }

  enter(): GameStatus {
    if (this.data.mode !== 'guess') { this.data.mode = 'guess'; this.persist(); }
    return this.status();
  }

  /** 回到自由画板:未揭示的一局作废,计分板保留。 */
  exit(): GameStatus {
    this.clearTimer();
    this.data = { ...this.data, mode: 'free', round: null, reveal: null };
    this.persist();
    return this.status();
  }

  startRound(args: Record<string, unknown>): GameStatus {
    const current = this.data.round;
    if (current) throw new Error(`第 ${current.id} 局尚未结束:先用 canvas_game_reveal 揭示答案,或 canvas_game_timer 的 stop 取消这一局`);
    const answer = text(args.answer, 'answer', 40);
    const seconds = number(args.seconds ?? 300, 'seconds', 1, 3600);
    const hint = args.hint === undefined || args.hint === null ? null : text(args.hint, 'hint', 40);
    const now = Date.now();
    this.data = { ...this.data, mode: 'guess', rounds: this.data.rounds + 1, reveal: null,
      round: { id: this.data.rounds + 1, answer, hint, startedAt: now, endsAt: now + seconds * 1000, expired: false } };
    this.persist();
    this.arm();
    return this.status();
  }

  timer(args: Record<string, unknown>): GameStatus {
    const round = this.data.round;
    if (!round) throw new Error('没有进行中的一局,请先 canvas_game_round 开局');
    if (args.stop === true) {
      this.clearTimer();
      this.data = { ...this.data, round: null };
      this.persist();
      return this.status();
    }
    const seconds = number(args.seconds, 'seconds', 1, 3600);
    this.data = { ...this.data, round: { ...round, startedAt: Date.now(), endsAt: Date.now() + seconds * 1000, expired: false } };
    this.persist();
    this.arm();
    return this.status();
  }

  reveal(args: Record<string, unknown>): GameStatus {
    const round = this.data.round;
    if (!round) throw new Error('没有可揭示的一局,请先 canvas_game_round 开局');
    const winners = args.winners === undefined ? [] : names(args.winners, 'winners').slice(0, 20);
    this.clearTimer();
    this.data = { ...this.data, round: null, reveal: { roundId: round.id, answer: round.answer, hint: round.hint, winners, at: Date.now() } };
    this.persist();
    return this.status();
  }

  score(args: Record<string, unknown>): { scoreboard: RankedEntry[]; changes: { name: string; before: number | null; after: number | null }[] } {
    const entries = args.entries === undefined ? [] : args.entries;
    if (!Array.isArray(entries) || entries.length > BATCH_LIMIT) throw new Error(`entries 须为最多 ${BATCH_LIMIT} 项`);
    const remove = args.remove === undefined ? [] : names(args.remove, 'remove');
    if (!entries.length && !remove.length && args.reset !== true) throw new Error('entries、remove、reset 至少提供一项');
    const board: ScoreEntry[] = args.reset === true ? [] : [...this.data.scoreboard];
    const changes: { name: string; before: number | null; after: number | null }[] = [];
    for (const raw of entries) {
      const entry = object(raw);
      const name = text(entry.name, 'name', 40);
      const hasAdd = entry.add !== undefined, hasSet = entry.set !== undefined;
      if (hasAdd === hasSet) throw new Error(`${name}:add 与 set 二选一`);
      const value = number(hasAdd ? entry.add : entry.set, hasAdd ? 'add' : 'set', -100000, 100000, true);
      const index = board.findIndex((item) => item.name === name);
      const before = index >= 0 ? board[index].score : null;
      const after = hasAdd ? (before ?? 0) + value : value;
      if (index >= 0) board[index] = { name, score: after };
      else {
        if (board.length >= SCOREBOARD_LIMIT) throw new Error(`计分板最多 ${SCOREBOARD_LIMIT} 人,请用 remove 或 reset 清理`);
        board.push({ name, score: after });
      }
      changes.push({ name, before, after });
    }
    for (const name of remove) {
      const index = board.findIndex((item) => item.name === name);
      if (index < 0) continue;
      changes.push({ name, before: board[index].score, after: null });
      board.splice(index, 1);
    }
    this.data = { ...this.data, scoreboard: board };
    this.persist();
    return { scoreboard: this.ranked(), changes };
  }

  close(): void { this.clearTimer(); }

  private clearTimer(): void {
    if (this.countdown) clearTimeout(this.countdown);
    this.countdown = null;
  }

  private arm(): void {
    this.clearTimer();
    const round = this.data.round!;
    this.countdown = setTimeout(() => this.expire(round.id), Math.max(0, round.endsAt - Date.now()));
    this.countdown.unref();
  }

  private expire(id: number): void {
    const round = this.data.round;
    if (!round || round.id !== id || round.expired) return;
    this.countdown = null;
    this.data = { ...this.data, round: { ...round, expired: true } };
    this.persist();
    this.options.onExpire?.(this.data.round!);
  }
}

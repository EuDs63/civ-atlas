/**
 * AI 改写(阶段 5「对话式编辑」)的状态:作者在右上"改写"框里说一句话 → AI 列出修改 → 作者勾选、点"执行" → 一次合进修改。
 * 纯状态,不碰 DOM(单测里用假 AI 跑完整流程)。材料、提示词、核对在 ai/prompts/rewrite.ts,框在 Rewrite.tsx。
 *
 *   sendWish(ctx, wish)   发一句话:按现在的世界写材料、带上前几轮,调 AI;回来的修改逐条核对(不合格的写明原因,不能勾)
 *   stopWish()            停下正在想的那一轮
 *   toggleItem(turn, i)   勾 / 不勾第 i 条
 *   applyTurn(turn, now)  执行勾着的几条:一次合进修改(干预、改地形只重推 / 重新生成一回)。
 *                         只有最新的一轮能执行,而且发出去之后世界没再改过、现在也没在重推(否则提议是按旧世界写的,要重说一遍);
 *                         now = 界面上现在的这份历史(换了世界、重推完都会换成另一份)和是不是正在重推
 *   undoTurn(turn)        撤销执行过的那一轮(只拿掉这一轮加的修改,见 unmergeRewrite)
 *   redoTurn(turn)        撤销过的那一轮再做一遍(⇧⌘Z;执行和撤销都记进修改的撤销记录,见 editsStore.ts)
 *   takeRewriteNote(e)    App 用:修改变成 e 是不是一次改写 / 撤销改写(推完在提示条上说"已按你说的改写"并带撤销)
 *
 * 对话只在内存里(换了世界就清空);每次调用照常记进 AI 调用记录(功能名"改写")。
 */
import { useSyncExternalStore } from 'react';
import type { World } from '../gen/world';
import type { Civ } from '../gen/civ/types';
import type { WorldEdits } from '../gen/edits';
import { aiChat } from '../ai/client';
import { AiError, type AiErrorCode } from '../ai/types';
import { isMockReply } from '../ai/prompts/names';
import {
  mergeRewrite,
  mockRewrite,
  parseRewrite,
  rewriteMaterial,
  rewriteRequest,
  unmergeRewrite,
  cleanWish,
  type RewriteChange,
  type RewriteLock,
  type RewriteItem,
  type RewriteTurn,
} from '../ai/prompts/rewrite';
import { commitEdits, getEdits, revertEdits } from './editsStore';
import { currentWorld } from './saveStore';
import { showToast } from './toastStore';

export interface RwTurn {
  id: number;
  wish: string;
  /** 发出去时时间轴的年份 */
  year: number;
  /** 发出去时的修改(执行前核对世界没变) */
  basis: WorldEdits;
  status: 'thinking' | 'done' | 'error';
  reply?: string;
  items?: RewriteItem[];
  cannot?: string[];
  /** 没勾的几条(下标) */
  off?: number[];
  error?: { code: AiErrorCode; message: string };
  /** 测试用假 AI 的示例提议 */
  mock?: boolean;
  /** 执行过:执行前后的修改;undone = 又撤销了 */
  applied?: { before: WorldEdits; after: WorldEdits; undone?: boolean };
}

export interface RewriteState {
  /** 对话属于哪个世界(saveStore 的世界编号) */
  world: string | null;
  /** 和哪一种锁一起说的(新建中只改地形 / 建好了只改历史);锁变了,原来的提议就不能再执行 */
  lock?: RewriteLock;
  turns: RwTurn[];
}

let state: RewriteState = { world: null, turns: [] };
const subs = new Set<() => void>();
const set = (next: RewriteState) => {
  state = next;
  for (const f of subs) f();
};
const patch = (id: number, p: Partial<RwTurn>) => set({ ...state, turns: state.turns.map((t) => (t.id === id ? { ...t, ...p } : t)) });

export function getRewrite(): RewriteState {
  return state;
}

export function useRewrite(): RewriteState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getRewrite,
    getRewrite,
  );
}

/**
 * 换了世界,或者同一个世界换了锁(点了"创建世界":地形从此锁住):对话清空(打开框、换世界、发话、创建时调)。
 * 新建时提的改地形,创建以后就不能再执行或撤销
 */
export function syncRewriteWorld(lock?: RewriteLock) {
  const w = currentWorld()?.id ?? null;
  if (w === state.world && lock === state.lock) return;
  stopWish();
  turnCiv = null;
  note = null;
  set({ world: w, lock, turns: [] });
}

let seq = 0;
let ctrl: AbortController | null = null;
let running = -1;
/** 最新一轮是按哪一份历史写的(只记最新一轮:旧的几轮本来就不能执行) */
let turnCiv: { id: number; civ: Civ } | null = null;

/** 界面上现在的情形:这份历史(套上了改名的)、是不是正在重推 / 按新地形重新生成 */
export interface WorldNow {
  civ: Civ;
  busy?: boolean;
}

export interface WishContext {
  world: World;
  /** 套上了改名的这份历史 */
  civ: Civ;
  /** 时间轴现在的年份 */
  year: number;
  /** 锁住了哪一样:世界建好了不能改地形 / 还在新建只能改地形 */
  lock?: RewriteLock;
}

/** 前几轮(给 AI 看前情;执行过的那一轮,没勾的几条注明没执行) */
function history(): RewriteTurn[] {
  return state.turns
    .filter((t) => t.status === 'done')
    .map((t) => {
      const applied = !!t.applied && !t.applied.undone;
      const off = new Set(t.off ?? []);
      return {
        wish: t.wish,
        reply: t.reply,
        items: t.items?.flatMap((x, i) =>
          x.change ? [`${x.year !== undefined ? `第 ${x.year} 年起 ` : ''}${x.text}${applied && off.has(i) ? '(作者没勾,没执行)' : ''}`] : [],
        ),
        applied,
      };
    });
}

/** 发一句话;返回这一轮的编号(空话 = −1) */
export async function sendWish(ctx: WishContext, wish: string): Promise<number> {
  const w = cleanWish(wish);
  if (!w) return -1;
  syncRewriteWorld(ctx.lock);
  stopWish();
  const id = ++seq;
  const year = Math.floor(ctx.year);
  const basis = getEdits();
  const prev = history();
  turnCiv = { id, civ: ctx.civ };
  set({ ...state, turns: [...state.turns, { id, wish: w, year, basis, status: 'thinking' }] });
  const c = new AbortController();
  ctrl = c;
  running = id;
  try {
    const wishes = [...prev.map((t) => t.wish), w];
    const mat = rewriteMaterial(ctx.world, ctx.civ, year, basis, wishes, ctx.lock);
    const r = await aiChat(rewriteRequest(mat, prev, w), { signal: c.signal });
    if (c.signal.aborted) throw new AiError('aborted', '已停止');
    const pctx = { world: ctx.world, civ: ctx.civ, year, edits: basis, lock: ctx.lock };
    const mock = isMockReply(r.text);
    const p = parseRewrite(mock ? mockRewrite(pctx, w) : r.text, pctx);
    if (!p.ok) throw new AiError('bad-response', p.message);
    if (running === id) patch(id, { status: 'done', reply: p.reply, items: p.items, cannot: p.cannot, mock });
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError('other', `出错了:${e instanceof Error ? e.message : String(e)}`);
    if (state.turns.some((t) => t.id === id)) patch(id, { status: 'error', error: { code: err.code, message: err.code === 'aborted' ? '已停止' : err.message } });
  } finally {
    if (running === id) {
      running = -1;
      ctrl = null;
    }
  }
  return id;
}

/** 停下正在想的那一轮 */
export function stopWish() {
  ctrl?.abort();
}

/** 勾 / 不勾第 i 条 */
export function toggleItem(id: number, i: number) {
  const t = state.turns.find((x) => x.id === id);
  if (!t || t.applied || !t.items?.[i]?.change) return;
  const off = new Set(t.off ?? []);
  if (off.has(i)) off.delete(i);
  else off.add(i);
  patch(id, { off: [...off] });
}

/** 这一轮勾着的修改 */
export function pickedChanges(t: RwTurn): RewriteChange[] {
  const off = new Set(t.off ?? []);
  return (t.items ?? []).flatMap((x, i) => (x.change && !off.has(i) ? [x.change] : []));
}

/** 这一轮现在能不能执行;不能 = 原因(不用说原因 = 空串) */
export function applyBlock(t: RwTurn, now: WorldNow): string | null {
  if (t.status !== 'done' || t.applied) return '';
  if (state.turns[state.turns.length - 1]?.id !== t.id) return '后面又说过话了,执行最新的那一轮';
  if (now.busy) return '世界正在重推,推完再执行';
  if (getEdits() !== t.basis || turnCiv?.id !== t.id || turnCiv.civ !== now.civ) return '世界在这之后改过,这份提议是按改之前写的;再说一遍,按现在的世界重想';
  if (!pickedChanges(t).length) return '没有勾选能执行的修改';
  return null;
}

// ---------------------------------------------------------------------------
// 执行 / 撤销(App 推完在提示条上说结果)

export interface RewriteNote {
  kind: 'apply' | 'undo';
  /** 哪一轮 */
  turn: number;
  before: WorldEdits;
  after: WorldEdits;
}

let note: (RewriteNote & { edits: WorldEdits }) | null = null;

/** App 用:修改刚变成 e,是不是一次改写 / 撤销改写(取走;不是 = null) */
export function takeRewriteNote(e: WorldEdits): RewriteNote | null {
  if (!note || note.edits !== e) return null;
  const n = note;
  note = null;
  return { kind: n.kind, turn: n.turn, before: n.before, after: n.after };
}

/** 执行这一轮勾着的修改;返回原因(执行了 = null) */
export function applyTurn(id: number, now: WorldNow): string | null {
  const t = state.turns.find((x) => x.id === id);
  if (!t) return '找不到这一轮了';
  const why = applyBlock(t, now);
  if (why !== null) return why || '这一轮执行过了';
  const before = getEdits();
  const after = mergeRewrite(before, pickedChanges(t));
  if (after === before) return '这些修改都已经有了';
  patch(id, { applied: { before, after } });
  // 只改名:不用重推,当场说;有干预 / 改地形:App 推完再说(带撤销)
  if (after.interventions === before.interventions && after.terrain === before.terrain) {
    commitEdits(after, { id, kind: 'apply' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已按你说的改名', action: { label: '撤销', act: 'rw-undo', onClick: () => undoTurn(id) } });
  } else {
    note = { kind: 'apply', turn: id, before, after, edits: after };
    commitEdits(after, { id, kind: 'apply' });
  }
  return null;
}

/** 撤销执行过的这一轮 */
export function undoTurn(id: number) {
  const t = state.turns.find((x) => x.id === id);
  const a = t?.applied;
  if (!t || !a || a.undone) return;
  const now = getEdits();
  const next = unmergeRewrite(now, a.before, a.after);
  patch(id, { applied: { ...a, undone: true } });
  if (next === now) return;
  if (next.interventions === now.interventions && next.terrain === now.terrain) {
    commitEdits(next, { id, kind: 'undo' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已撤销这次改写', ttl: 4000 });
  } else {
    note = { kind: 'undo', turn: id, before: a.before, after: a.after, edits: next };
    commitEdits(next, { id, kind: 'undo' });
  }
}

/** 撤销过的这一轮再做一遍(之后没再改过 = 正好回到执行后的样子;改过别的 = 只把这一轮的修改放回去) */
export function redoTurn(id: number) {
  const t = state.turns.find((x) => x.id === id);
  const a = t?.applied;
  if (!t || !a || !a.undone) return;
  const now = getEdits();
  const next = revertEdits(now, a.before, a.after);
  patch(id, { applied: { ...a, undone: false } });
  if (next === now) return;
  if (next.interventions === now.interventions && next.terrain === now.terrain) {
    commitEdits(next, { id, kind: 'apply' });
    showToast({ id: 'resim-done', kind: 'ok', text: '已按你说的改名', action: { label: '撤销', act: 'rw-undo', onClick: () => undoTurn(id) } });
  } else {
    note = { kind: 'apply', turn: id, before: a.before, after: a.after, edits: next };
    commitEdits(next, { id, kind: 'apply' });
  }
}

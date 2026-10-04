/**
 * 成书:生成史书的状态 —— 选项窗口、后台写作、阅读。纯状态,不碰 DOM(单测里用假 AI 跑完整流程)。
 *
 *   openHistoryBook({ polity? })  打开"生成史书"窗口(给了国家就默认写那一国;国家面板的"写国史"用)
 *   startBook(opts)               开始写:窗口关上,写作在后台进行(可以接着看地图、拖时间轴);同一时间只写一部
 *                                 没设置 AI → 提示条"还没有设置 AI · 去设置";失败 → 提示条报错 + 重试
 *   stopBook()                    停下正在写的(写到一半的不存)
 *   openBookReader(key | null)    阅读:已写好的那部(笔记的键)/ null = 正在写(或刚写完)的那部
 *   useBook()                     React:整个状态(窗口、阅读、正在写的那部、上次选的文体篇幅)
 *
 * 写、存、比对历史指纹都在 ai/history.ts;这里只管"哪一部在写、写到哪、写完了没"。
 * 界面:BookDialog.tsx(选项窗口)、BookReader.tsx(阅读)、Corners.tsx 的 BookChip(右上的进度)。
 */
import { useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import { getAiStatus, openAiSettings } from '../ai/client';
import { AiError } from '../ai/types';
import { writeHistory } from '../ai/history';
import {
  BOOK_LENGTHS,
  BOOK_STYLES,
  buildHistoryPrompts,
  historyNoteKey,
  storeScope,
  textLength,
  type HistoryLength,
  type HistoryOptions,
  type HistoryStyle,
} from '../ai/prompts/history';
import { clearToast, showToast } from './toastStore';
import { currentWorld } from './saveStore';

export interface BookJob {
  /** 每开始写一部加一 */
  id: number;
  status: 'writing' | 'done' | 'stopped' | 'error';
  /** 写进哪个世界(saveStore 的世界编号) */
  world: string;
  opts: HistoryOptions;
  /** 笔记的键(写完存在这里;同一个"写什么 + 文体 + 篇幅"是同一部) */
  key: string;
  /** 书名(不带书名号):"世界通史" / "大昌史" */
  title: string;
  /** "第 0—3000 年" */
  range: string;
  /** 这一部要写多少字(史料不够时比所选篇幅少) */
  chars: number;
  /** 到目前为止写出来的全文(Markdown) */
  text: string;
  /** 正在写第几次调用(0 起)/ 一共几次(长篇一章一次) */
  call: number;
  calls: number;
  error?: AiError;
  /** 写完之后点开读过了:右上的"已完成 · 打开"收起 */
  seen?: boolean;
}

export interface BookState {
  dialog: {
    open: boolean;
    /** 打开时默认写的国家(国家面板的"写国史");null = 默认整个世界 */
    polity: number | null;
    /** 每次打开加一(默认值只在打开那一刻套用) */
    stamp: number;
  };
  reader: {
    open: boolean;
    /** 读哪一部:笔记的键;null = 正在写(或刚写完)的那部 */
    key: string | null;
    stamp: number;
  };
  job: BookJob | null;
  /** 上次选的文体、篇幅(下次打开窗口还是它) */
  prefs: { style: HistoryStyle; length: HistoryLength };
  /** 上次点"开始生成"时还没设置 AI:设置好再打开窗口,照原来选的 */
  pending: HistoryOptions | null;
}

let state: BookState = {
  dialog: { open: false, polity: null, stamp: 0 },
  reader: { open: false, key: null, stamp: 0 },
  job: null,
  prefs: { style: BOOK_STYLES[0], length: BOOK_LENGTHS[1] },
  pending: null,
};
const subs = new Set<() => void>();
function set(patch: Partial<BookState>) {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function getBook(): BookState {
  return state;
}

export function useBook(): BookState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getBook,
    getBook,
  );
}

// ---------------------------------------------------------------------------
// 窗口

/** 打开"生成史书"窗口;给了国家就默认写"这一国"(签名不变:国家面板、编年史都在用) */
export function openHistoryBook(opt: { polity?: number | null } = {}) {
  set({ dialog: { open: true, polity: opt.polity ?? null, stamp: state.dialog.stamp + 1 }, reader: { ...state.reader, open: false } });
}

export function closeHistoryBook() {
  if (state.dialog.open) set({ dialog: { ...state.dialog, open: false } });
}

export function setBookPrefs(p: Partial<BookState['prefs']>) {
  set({ prefs: { ...state.prefs, ...p } });
}

/** 阅读:key = 笔记的键;null = 正在写(或刚写完)的那部。读的是刚写完的那部 = 右上的"已完成 · 打开"收起 */
export function openBookReader(key: string | null) {
  const j = state.job;
  const job = j && j.status === 'done' && (key === null || key === j.key) ? { ...j, seen: true } : j;
  set({ reader: { open: true, key: key ?? (j && j.status === 'done' ? j.key : null), stamp: state.reader.stamp + 1 }, dialog: { ...state.dialog, open: false }, job });
}

export function closeBookReader() {
  if (state.reader.open) set({ reader: { ...state.reader, open: false } });
}

// ---------------------------------------------------------------------------
// 写

/** 写的时候用哪个世界的历史(界面挂载时交进来:改名之后是改过名的那份) */
let ctx: { civ: Civ; world: string } | null = null;
export function setBookContext(civ: Civ | null, world: string | null) {
  ctx = civ && world ? { civ, world } : null;
}

let seq = 0;
let abort: AbortController | null = null;
const TOAST = 'book';

/** 书名加书名号;世界起了名字时,通史写成"某某通史" */
export function bookTitleText(title: string, scope: { kind: string }, worldTitle?: string | null): string {
  const t = scope.kind === 'world' && worldTitle && title === '世界通史' ? `${worldTitle}通史` : title;
  return `《${t}》`;
}

/**
 * 写到哪了(0–1):按字数和第几章估,写完 = 1。
 * AI 还没回第一个字(开头几秒在读材料)= 0:右上的进度条画成来回滑动的一小段(states.css),不停在最左
 */
export function bookProgress(j: BookJob): number {
  if (j.status === 'done') return 1;
  if (j.status === 'writing' && !j.text && j.call === 0) return 0;
  const byText = j.chars > 0 ? textLength(j.text) / j.chars : 0;
  const byCall = j.calls > 0 ? j.call / j.calls : 0;
  return Math.max(0.02, Math.min(0.97, Math.max(byText, byCall)));
}

function notConfigured(text = '还没有设置 AI') {
  showToast({
    id: TOAST,
    kind: 'warn',
    text,
    action: {
      label: '去设置',
      onClick: () => {
        clearToast(TOAST);
        openAiSettings();
      },
    },
  });
}

/**
 * 开始写一部(窗口关上,后台写)。返回是否开始了:
 * 没设置 AI(提示条 + "去设置")、已经在写别的、这个范围里没有史事 = false
 */
export function startBook(opts: HistoryOptions): boolean {
  const c = ctx;
  if (!c || state.job?.status === 'writing') return false;
  if (!getAiStatus().ready) {
    // 窗口关上(提示条在窗口下面会被挡住);设置好 AI 再点"成书",还是这次选的
    set({ pending: opts, dialog: { ...state.dialog, open: false }, reader: { ...state.reader, open: false } });
    notConfigured();
    return false;
  }
  const pr = buildHistoryPrompts(c.civ, opts);
  if (pr.empty || !pr.calls.length) {
    showToast({ id: TOAST, kind: 'warn', text: '这段历史里没有史事可写' });
    return false;
  }
  clearToast(TOAST);
  const id = ++seq;
  const job: BookJob = {
    id,
    status: 'writing',
    world: c.world,
    opts,
    key: historyNoteKey(storeScope(c.civ, opts.scope), opts.style, opts.length),
    title: pr.title,
    range: pr.range,
    chars: pr.chars,
    text: '',
    call: 0,
    calls: pr.calls.length,
  };
  const ac = new AbortController();
  abort = ac;
  set({ job, dialog: { ...state.dialog, open: false }, prefs: { style: opts.style, length: opts.length }, pending: null });

  // 进度:AI 一个字一个字地回,攒一下再刷新显示
  let pending: { text: string; call: number; calls: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const p = pending;
    const j = state.job;
    if (p && j && j.id === id && j.status === 'writing') set({ job: { ...j, text: p.text, call: p.call, calls: p.calls } });
  };
  const finish = (patch: Partial<BookJob>) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (abort === ac) abort = null;
    const j = state.job;
    if (!j || j.id !== id) return null;
    const next = { ...j, ...patch };
    set({ job: next });
    return next;
  };

  writeHistory(c.civ, opts, {
    world: c.world,
    signal: ac.signal,
    onProgress: (p) => {
      pending = p;
      if (!timer) timer = setTimeout(flush, 120);
    },
  }).then(
    (note) => {
      // 正在读这一部(边写边看):写完接着看存好的那部
      const reading = state.reader.open && state.reader.key === null;
      finish({ status: 'done', text: note.text, key: note.key, call: job.calls - 1, seen: reading });
      if (reading) set({ reader: { ...state.reader, key: note.key } });
    },
    (e) => {
      const err = e instanceof AiError ? e : new AiError('other', `写史书失败:${e instanceof Error ? e.message : String(e)}`);
      const done = finish({ status: err.code === 'aborted' ? 'stopped' : 'error', error: err, text: pending?.text ?? state.job?.text ?? '' });
      if (!done || err.code === 'aborted') return;
      reportError(done, err);
    },
  );
  return true;
}

/** 写失败:顶部提示条报错,带"重试"(没设置 AI 的带"去设置") */
function reportError(j: BookJob, err: AiError) {
  if (err.code === 'not-configured') return notConfigured(err.message.length <= 24 ? err.message : '还没有设置 AI');
  const retry = {
    label: '重试',
    onClick: () => {
      clearToast(TOAST);
      startBook(j.opts);
    },
  };
  const name = bookTitleText(j.title, j.opts.scope, currentWorld()?.title);
  if (err.code === 'content-filter') {
    showToast({
      id: TOAST,
      kind: 'warn',
      text: `${name}没写完`,
      more: ['内容被 AI 服务商的审核拦下了,可以重试或换个文体'],
      action: retry,
    });
    return;
  }
  showToast({ id: TOAST, kind: 'error', text: `${name}没写完`, more: [err.message], action: retry });
}

/** 停下正在写的(写到一半的不存;旧的那部不动) */
export function stopBook() {
  abort?.abort();
}

/** 换了世界:停下正在写的(写到的存不进别的世界),右上的进度收起 */
export function resetBookForWorld() {
  abort?.abort();
  abort = null;
  set({ job: null, reader: { ...state.reader, open: false }, dialog: { ...state.dialog, open: false } });
}

/** 单测用 */
export function _resetBook() {
  abort?.abort();
  abort = null;
  ctx = null;
  state = {
    dialog: { open: false, polity: null, stamp: 0 },
    reader: { open: false, key: null, stamp: 0 },
    job: null,
    prefs: { style: BOOK_STYLES[0], length: BOOK_LENGTHS[1] },
    pending: null,
  };
  subs.forEach((f) => f());
}

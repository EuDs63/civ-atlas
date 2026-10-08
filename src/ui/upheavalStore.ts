/**
 * 地形大事(gen/edits.ts 文件头"地形大事")的卡片和地图上的笔:卡片开没开、选的哪一种、各种的大小、这一件放好 / 涂好的几笔、
 * 正在涂的那一笔和光标;"会怎么样"的预览(后台线程照"那一年的地形 + 这几笔"生成一遍,App 收发)。
 * 和 civView.ts 一样的小 store(get / set / use)。
 *
 * 地图上怎么放:火山喷发点一下放一座;地震抬升、海水漫进来按住拖动涂一笔(和编辑地形的画笔一样,点和点隔开小半个半径;
 * 跨 180° 经线接着涂)。几笔合成一件大事,「让它发生」时整件加进修改(editsStore 的 addUpheaval)。
 */
import { useSyncExternalStore } from 'react';
import type { TerrainOp, Upheaval } from '../gen/edits';
import { TERRAIN_MAX_PTS, UPHEAVAL_OPS_MAX, UPHEAVAL_YEARS, nearLon } from '../gen/terrainEdits';
import type { UpheavalPreview } from '../gen/civ/upheaval';
import type { IconName } from './icons';

/** 三种大事 = 三种地形修改(火山、抬起陆地、沉成海),挪到半路发生 */
export type UpKind = 'volcano' | 'raise' | 'sink';

export const UP_KINDS: readonly { id: UpKind; name: string; icon: IconName; hint: string; map: string }[] = [
  {
    id: 'volcano',
    name: '火山喷发',
    icon: 'volcano',
    hint: '点一下地图放一座火山。在陆上会毁掉山脚下的城；在海里会冒出一座火山岛。',
    map: '点一下地图，放一座火山',
  },
  {
    id: 'raise',
    name: '地震抬升',
    icon: 'raise',
    hint: '按住拖动来涂。涂到的海底抬出水面成为陆地，能把隔海的两块陆地连起来。',
    map: '按住拖动来涂，涂到的海底会抬出水面',
  },
  {
    id: 'sink',
    name: '海水漫进来',
    icon: 'flood',
    hint: '按住拖动来涂。涂到的陆地沉进海里，城跟着沉没；一州的地全沉了，国家就退出那里。',
    map: '按住拖动来涂，涂到的陆地会沉进海里',
  },
];
export const upKind = (k: UpKind) => UP_KINDS.find((x) => x.id === k)!;

/** 各种的大小(世界坐标的半径):最小、最大、默认 */
export const UP_SIZE: Record<UpKind, readonly [number, number, number]> = {
  volcano: [12, 64, 36],
  raise: [8, 44, 18],
  sink: [12, 68, 40],
};
/** 强度(三种一样) */
export const UP_STRENGTH = 1.1;

/** 一件大事的名字:只有一种 = 那一种的名字;几种都有 = "地形大事" */
export function upheavalName(u: Pick<Upheaval, 'ops'>): string {
  const kinds = new Set(u.ops.map((o) => o.kind));
  if (kinds.size !== 1) return '地形大事';
  const k = [...kinds][0];
  return UP_KINDS.find((x) => x.id === k)?.name ?? '地形大事';
}

// ---------------------------------------------------------------------------
// 卡片

export interface UpUi {
  on: boolean;
  kind: UpKind;
  size: Record<UpKind, number>;
  /** 这一件放好 / 涂好的几笔(按先后) */
  ops: TerrainOp[];
}

const sizes = () => ({ volcano: UP_SIZE.volcano[2], raise: UP_SIZE.raise[2], sink: UP_SIZE.sink[2] });
let ui: UpUi = { on: false, kind: 'volcano', size: sizes(), ops: [] };
const subs = new Set<() => void>();
function put(next: UpUi) {
  ui = next;
  subs.forEach((f) => f());
}

export function getUpUi(): UpUi {
  return ui;
}
export function useUpUi(): UpUi {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ui,
    () => ui,
  );
}

/** 打开卡片(从火山喷发开始,什么也没放) */
export function openUpheaval() {
  put({ on: true, kind: 'volcano', size: sizes(), ops: [] });
  setDraft({ pts: null, cursor: null });
}
/** 关上(放好的几笔不要了) */
export function closeUpheaval() {
  if (!ui.on) return;
  put({ ...ui, on: false, ops: [] });
  setDraft({ pts: null, cursor: null });
  resetPreview();
}
export function setUpKind(kind: UpKind) {
  if (kind !== ui.kind) put({ ...ui, kind });
}
export function setUpSize(kind: UpKind, r: number) {
  const [lo, hi] = UP_SIZE[kind];
  put({ ...ui, size: { ...ui.size, [kind]: Math.min(hi, Math.max(lo, Math.round(r))) } });
}
/** 撤销最后一笔 */
export function undoUpOp() {
  if (ui.ops.length) put({ ...ui, ops: ui.ops.slice(0, -1) });
}
/** 全部清除 */
export function clearUpOps() {
  if (ui.ops.length) put({ ...ui, ops: [] });
}
function addOp(op: TerrainOp) {
  if (ui.ops.length >= UPHEAVAL_OPS_MAX) return;
  put({ ...ui, ops: [...ui.ops, op] });
}

/** 卡片上的年份:时间轴那一年(取整),夹在 UPHEAVAL_YEARS 和结束年份之前 */
export function upYear(year: number | null, endYear: number): number {
  const y = Math.floor(year ?? endYear);
  return Math.min(Math.min(UPHEAVAL_YEARS[1], endYear - 1), Math.max(UPHEAVAL_YEARS[0], y));
}

// ---------------------------------------------------------------------------
// 地图上的笔:正在涂的那一笔、光标(世界坐标)

export interface UpDraft {
  pts: number[] | null;
  cursor: [number, number] | null;
}
let draft: UpDraft = { pts: null, cursor: null };
/** 这一笔是什么时候按下的(第二根手指紧跟着按下 = 想捏合,不是在涂) */
let draftT0 = 0;
const draftSubs = new Set<() => void>();
function setDraft(d: UpDraft) {
  draft = d;
  draftSubs.forEach((f) => f());
}
export function useUpDraft(): UpDraft {
  return useSyncExternalStore(
    (f) => (draftSubs.add(f), () => draftSubs.delete(f)),
    () => draft,
    () => draft,
  );
}

/** 地图上按下:涂的两种开始涂(返回 true = 这一下归地形大事管,不平移) */
export function upDown(w: [number, number] | null, button: number): boolean {
  if (!ui.on || !w || button !== 0 || ui.kind === 'volcano' || ui.ops.length >= UPHEAVAL_OPS_MAX) return false;
  draftT0 = performance.now();
  setDraft({ pts: [Math.round(w[0]), Math.round(w[1])], cursor: w });
  return true;
}

/** 地图上移动:更新光标;正在涂就把这一笔接长(返回 true = 正在涂) */
export function upMove(w: [number, number] | null): boolean {
  if (!ui.on) return false;
  const d = draft.pts;
  if (!d) {
    if (w !== draft.cursor) setDraft({ pts: null, cursor: w });
    return false;
  }
  if (!w) return true;
  const lx = d[d.length - 2];
  const ly = d[d.length - 1];
  const step = Math.max(2, ui.size[ui.kind] * 0.4);
  const wx = nearLon(w[0], lx);
  const far = (wx - lx) ** 2 + (w[1] - ly) ** 2 >= step * step;
  setDraft({ pts: far && d.length < TERRAIN_MAX_PTS * 2 ? [...d, Math.round(wx), Math.round(w[1])] : d, cursor: [wx, w[1]] });
  return true;
}

/** 松开:涂完的一笔加进这件大事 */
export function upUp() {
  const d = draft.pts;
  if (!d) return;
  const c0 = draft.cursor;
  setDraft({ pts: null, cursor: c0 });
  const c: [number, number] | null = c0 && [nearLon(c0[0], d[d.length - 2]), c0[1]];
  const pts = c && d.length < TERRAIN_MAX_PTS * 2 && (c[0] - d[d.length - 2]) ** 2 + (c[1] - d[d.length - 1]) ** 2 >= 4 ? [...d, Math.round(c[0]), Math.round(c[1])] : d;
  if (ui.kind === 'volcano') return;
  addOp({ kind: ui.kind, pts, r: ui.size[ui.kind], s: UP_STRENGTH });
}

/** 单击地图:火山喷发在这里放一座(返回 true = 这一下归地形大事管,不看详情) */
export function upClick(w: [number, number] | null): boolean {
  if (!ui.on) return false;
  if (w && ui.kind === 'volcano') addOp({ kind: 'volcano', pts: [Math.round(w[0]), Math.round(w[1])], r: ui.size.volcano, s: UP_STRENGTH });
  return true;
}

/** 第二根手指按下:刚按下不久的这一笔不算(想捏合),返回 true = 收掉了;已经涂了一阵的照旧涂完 */
export function upCancel(): boolean {
  if (!draft.pts) return true;
  if (performance.now() - draftT0 > 400) return false;
  setDraft({ pts: null, cursor: null });
  return true;
}

// ---------------------------------------------------------------------------
// "会怎么样":后台线程照"那一年的地形 + 这几笔"生成一遍(App 发请求、收结果)

export interface UpPreviewState {
  /** 这次结果对应的几笔、那一年在第几段(键一样 = 不用再算) */
  sig: string;
  /** 正在算 */
  busy: boolean;
  /** 算好的(还在算下一次时留着上一次的) */
  result: { sig: string; preview: UpheavalPreview; water: Uint8Array; ms: number } | null;
}
let pv: UpPreviewState = { sig: '', busy: false, result: null };
let pid = 0;
const pvSubs = new Set<() => void>();
function setPv(next: UpPreviewState) {
  pv = next;
  pvSubs.forEach((f) => f());
}
export function useUpPreview(): UpPreviewState {
  return useSyncExternalStore(
    (f) => (pvSubs.add(f), () => pvSubs.delete(f)),
    () => pv,
    () => pv,
  );
}

/** App 登记的:把一次预览发给后台线程(pid = 第几次;year = 哪一年;ops = 这几笔) */
type Runner = (pid: number, year: number, ops: TerrainOp[]) => void;
let runner: Runner | null = null;
export function setUpRunner(f: Runner | null) {
  runner = f;
}

/** 要看 sig(几笔 + 那一年在第几段)这一次的结果:已经有了 / 正在算就不再发 */
export function requestUpPreview(sig: string, year: number, ops: TerrainOp[]) {
  if (!ops.length) {
    if (pv.sig || pv.result) setPv({ sig: '', busy: false, result: null });
    return;
  }
  if (sig === pv.sig) return;
  if (pv.result?.sig === sig) return setPv({ ...pv, sig, busy: false });
  setPv({ ...pv, sig, busy: true });
  runner?.(++pid, year, ops);
}

/** 后台线程算好了:是最新的一次才收 */
export function takeUpPreview(id: number, preview: UpheavalPreview, water: Uint8Array, ms: number) {
  if (id !== pid) return;
  setPv({ sig: pv.sig, busy: false, result: { sig: pv.sig, preview, water, ms } });
}

function resetPreview() {
  pid++;
  setPv({ sig: '', busy: false, result: null });
}

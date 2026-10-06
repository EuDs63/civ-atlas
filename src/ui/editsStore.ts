/**
 * 当前世界的用户修改(阶段 4,格式见 gen/edits.ts 的 WorldEdits):改名、干预、地形修改、作者标记、改旗。
 * 和 civView.ts 一样的小 store(get / set / use)。换世界(种子 / 参数变了)时 App 调 clearEdits 清空。
 *
 * 这里只管内存里的这一份;存进浏览器 / 存成文件在 saveStore.ts(经 subscribeEdits 订阅,修改一变就自动存),
 * 读档时 App 先按存档的参数生成,再 setEdits(存档里的修改)。
 *
 * 撤销 / 重做(⌘Z / ⇧⌘Z,见 undo.ts):改名、改旗、干预、作者标记、AI 改写每次都记一步(改之前、改之后两份),只记这次打开网页以后、这个世界上的;
 * 读档、换世界(setEdits / clearEdits)、创建世界(clearEditHistory)清空。地形修改不记:只在新建世界时能改,改地形工具有自己的"撤销一笔"。
 */
import { useSyncExternalStore } from 'react';
import { EMPTY_EDITS, MARKS_MAX, MARK_REGIONS_TOTAL, cleanIntervention, cleanMark, markRegionTotal, sameMark, markAiName, nextMarkId, type AuthorMark, type Intervention, type TerrainOp, type WorldEdits } from '../gen/edits';
import { TERRAIN_MAX_OPS, cleanTerrainOp } from '../gen/terrainEdits';
import { showToast } from './toastStore';

let state: WorldEdits = EMPTY_EDITS;
const subs = new Set<() => void>();
const emit = () => {
  for (const f of subs) f();
};

export function getEdits(): WorldEdits {
  return state;
}

/** 整个换掉(读档用;撤销记录清空)。传进来的对象之后别再改它 */
export function setEdits(next: WorldEdits) {
  past = [];
  future = [];
  put(next);
}

function put(next: WorldEdits) {
  if (next === state) return;
  state = next;
  emit();
}

// ---------------------------------------------------------------------------
// 撤销 / 重做

/** 记下的一步:改之前、改之后;助手执行的一轮带上轮次(撤销 / 重做要经过助手那边,对话里的"已执行 / 已撤销"跟着变) */
export interface EditStep {
  before: WorldEdits;
  after: WorldEdits;
  turn?: { id: number; kind: 'apply' | 'undo' };
}

/** 最多记多少步(再早的丢掉) */
export const HISTORY_MAX = 100;
let past: EditStep[] = [];
let future: EditStep[] = [];
/** 正在撤销 / 重做:这时的修改不另记一步 */
let replaying = false;

/** 改一处,记一步(用户自己的修改都走这里;读档用 setEdits) */
export function commitEdits(next: WorldEdits, turn?: EditStep['turn']) {
  if (next === state) return;
  if (!replaying) {
    past.push({ before: state, after: next, turn });
    if (past.length > HISTORY_MAX) past.shift();
    future = [];
  }
  put(next);
}

export function canUndoEdit(): boolean {
  return past.length > 0;
}
export function canRedoEdit(): boolean {
  return future.length > 0;
}

/**
 * 撤销 / 重做一步:取出最近的一步交给 run 去做(run 里改修改照常走 commitEdits / put,不会另记一步),做完放进另一边。
 * 没有可做的 = false
 */
export function stepEdits(dir: 'undo' | 'redo', run: (s: EditStep) => void): boolean {
  const s = (dir === 'undo' ? past : future).pop();
  if (!s) return false;
  replaying = true;
  try {
    run(s);
  } finally {
    replaying = false;
  }
  (dir === 'undo' ? future : past).push(s);
  return true;
}

/** 把修改换成 next,不记一步(撤销 / 重做时用) */
export function replaceEdits(next: WorldEdits) {
  put(next);
}

/**
 * 把 now 里"从 from 变成 to"那一步的改动做一遍(撤销 = from 是改之后、to 是改之前;重做反过来)。
 * 之后没再改过(now 就是 from)= 正好变成 to;改过别的 = 只动这一步碰过的:
 * 改过的名字还是 from 里那样的才换回去,from 里多出来的干预 / 地形去掉,to 里有、现在没有的放回原来的位置。
 * 列表变了一律换成新数组(App 按数组是不是读档套上的那一份来认"自动恢复",撤销回去不能被当成恢复)
 */
export function revertEdits(now: WorldEdits, from: WorldEdits, to: WorldEdits): WorldEdits {
  const names = moveMap(now.names, from.names, to.names) ?? {};
  const aiNames = moveMap(now.aiNames, from.aiNames, to.aiNames);
  const interventions = moveList(now.interventions, from.interventions, to.interventions);
  const terrain = moveList(now.terrain, from.terrain, to.terrain);
  const marks = moveMarks(now.marks, from.marks, to.marks);
  const flags = moveMap(now.flags, from.flags, to.flags);
  if (names === now.names && aiNames === now.aiNames && interventions === now.interventions && terrain === now.terrain && marks === now.marks && flags === now.flags) return now;
  const out: WorldEdits = { names, interventions, terrain };
  if (aiNames && Object.keys(aiNames).length) out.aiNames = aiNames;
  if (marks?.length) out.marks = marks;
  if (flags && Object.keys(flags).length) out.flags = flags;
  return out;
}

/**
 * 标记那一半:按编号认同一个标记 —— 从 from 到 to 这一步新建的(to 有、from 没有)去掉,删掉的放回原来的位置,
 * 改过的换回 to 那样(现在还是 from 那样的才换;之后又改过的不动)。都没动 = 原数组
 */
function moveMarks(now: readonly AuthorMark[] | undefined, from: readonly AuthorMark[] | undefined, to: readonly AuthorMark[] | undefined): AuthorMark[] | undefined {
  const N = now ?? [];
  const F = new Map((from ?? []).map((m) => [m.id, m]));
  const T = new Map((to ?? []).map((m) => [m.id, m]));
  const same = (a: AuthorMark | undefined, b: AuthorMark | undefined) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
  let out: AuthorMark[] | null = null;
  const list = () => (out ??= N.slice());
  for (const id of new Set([...F.keys(), ...T.keys()])) {
    const f = F.get(id);
    const t = T.get(id);
    if (same(f, t)) continue;
    const i = (out ?? N).findIndex((m) => m.id === id);
    const cur = i >= 0 ? (out ?? N)[i] : undefined;
    if (!same(cur, f)) continue;
    if (t && i >= 0) list()[i] = t;
    else if (t) list().splice(Math.min(list().length, (to ?? []).indexOf(t)), 0, t);
    else list().splice(i, 1);
  }
  return out ?? (now as AuthorMark[] | undefined);
}

/** 键值表那一半(改名、AI 起名的记号、改过的旗):from 到 to 变了的键,现在还是 from 那样的才换成 to 那样;都没动 = 原对象 */
function moveMap<T>(now: Record<string, T> | undefined, from: Record<string, T> | undefined, to: Record<string, T> | undefined): Record<string, T> | undefined {
  const N = now ?? {};
  const F = from ?? {};
  const T = to ?? {};
  const same = (a: T | undefined, b: T | undefined) => a === b || JSON.stringify(a) === JSON.stringify(b);
  let out = now;
  for (const k of new Set([...Object.keys(F), ...Object.keys(T)])) {
    if (same(F[k], T[k]) || !same(N[k], F[k])) continue;
    if (out === now) out = { ...N };
    if (k in T) out![k] = T[k];
    else delete out![k];
  }
  return out;
}

/** 列表那一半:from 有 to 没有的从 now 去掉(各去一次);to 有 from 没有、now 里也没有的放回它在 to 里的位置 */
function moveList<T>(now: readonly T[], from: readonly T[], to: readonly T[]): T[] {
  const key = (x: T) => JSON.stringify(x);
  const drop = without(from, to);
  const add = without(to, from);
  if (!drop.length && !add.length) return now as T[];
  const out = without(now, drop);
  const have = new Set(out.map(key));
  for (const x of add) {
    if (have.has(key(x))) continue;
    out.splice(Math.min(out.length, to.indexOf(x)), 0, x);
    have.add(key(x));
  }
  return out.length === now.length && out.every((x, i) => x === now[i]) ? (now as T[]) : out;
}

/** 去掉 list 里和 drop 一样的那几条(各去一次) */
function without<T>(list: readonly T[], drop: readonly T[]): T[] {
  const left = drop.map((x) => JSON.stringify(x));
  return list.filter((x) => {
    const i = left.indexOf(JSON.stringify(x));
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/** 清空撤销记录(点了"创建世界":新建时的修改从此不能撤销) */
export function clearEditHistory() {
  past = [];
  future = [];
}

export function useEdits(): WorldEdits {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getEdits,
    getEdits,
  );
}

/** 不经过 React 订阅 */
export function subscribeEdits(f: (e: WorldEdits) => void): () => void {
  const g = () => f(state);
  subs.add(g);
  return () => subs.delete(g);
}

// ---- 能不能改(助手"先在地图上看看"时) ----

/**
 * 改名、下令之前问一声(App 在助手"先在地图上看看"时挂上):面板里这时是试推演的历史,那里的国家、城
 * 不一定是现在这份历史里的同一个,用它的键改会落到别的东西上或者落空。gate 返回不能改的原因(能改 = null)
 */
let gate: ((keys: string[]) => string | null) | null = null;
export function setEditGate(f: ((keys: string[]) => string | null) | null) {
  gate = f;
}
/** 这几个键现在能不能改:不能 = 原因 */
export function editBlock(keys: readonly string[]): string | null {
  return gate ? gate(keys.filter(Boolean)) : null;
}
/** 一条干预点到的键(国家、对方、城、州) */
export function interventionKeys(v: Intervention): string[] {
  const o = v as Partial<Record<'a' | 'b' | 'city' | 'region', string>>;
  return [o.a, o.b, o.city, o.region].filter((k): k is string => typeof k === 'string');
}

/**
 * 改名:name 为空(或 null)= 恢复默认(从 names 里去掉这个键)。现在不能改(editBlock)= 提示条说原因,不改。
 * from = 'ai':从 AI 起名里挑的,记一笔(名字旁标"AI 写",见 gen/edits.ts 的 aiNames);别的改名把这一笔去掉。
 * fallback = 生成时的名字:之前自己改过名、又从 AI 候选里挑回了生成时的名字,照样算 AI 起的(改名表里写明这个名字),
 * 导出"换回原名"时回到自己改的那个
 */
export function setName(key: string, name: string | null, from?: 'ai', fallback?: string) {
  const why = editBlock([key]);
  if (why) {
    showToast({ id: 'edit-block', kind: 'warn', text: why });
    return;
  }
  if (from === 'ai' && !name && fallback && key in state.names) name = fallback;
  const names = { ...state.names };
  if (name) names[key] = name;
  else if (key in names) delete names[key];
  else return;
  const aiNames = markAiName(state, key, name, from === 'ai');
  if (aiNames === state.aiNames && names[key] === state.names[key] && Object.keys(names).length === Object.keys(state.names).length) return;
  const { aiNames: _, ...rest } = state;
  commitEdits(aiNames ? { ...rest, names, aiNames } : { ...rest, names });
}

/**
 * 改旗:keys 里的几面换成 code(旗的写法,见 gen/civ/flags.ts 的 encodeFlag);code 为 null = 去掉这几面(恢复自动配的)。
 * 每次记一步(⌘Z 撤销)。现在不能改(editBlock)= 提示条说原因,不改
 */
export function setFlags(keys: readonly string[], code: string | null) {
  const why = editBlock([...keys]);
  if (why) {
    showToast({ id: 'edit-block', kind: 'warn', text: why });
    return;
  }
  const flags = { ...(state.flags ?? {}) };
  let changed = false;
  for (const k of keys) {
    if (code ? flags[k] === code : !(k in flags)) continue;
    if (code) flags[k] = code;
    else delete flags[k];
    changed = true;
  }
  if (!changed) return;
  const { flags: _, ...rest } = state;
  commitEdits(Object.keys(flags).length ? { ...rest, flags } : rest);
}

/**
 * 干预(阶段 4):加一条(清理过的;不合格的、和已有的一模一样的、现在不能改的不加)。返回是否加上了(下令的面板先问 editBlock 说原因)。
 * App 看到干预列表变了就在后台从第 0 年重推文明
 */
export function addIntervention(v: Intervention): boolean {
  const c = cleanIntervention(v);
  if (!c || editBlock(interventionKeys(c))) return false;
  const key = JSON.stringify(c);
  if (state.interventions.some((x) => JSON.stringify(x) === key)) return false;
  commitEdits({ ...state, interventions: [...state.interventions, c] });
  return true;
}

/** 干预:去掉第 i 条(下标越界 = 不动) */
export function removeIntervention(i: number) {
  if (!(i >= 0 && i < state.interventions.length)) return;
  commitEdits({ ...state, interventions: state.interventions.filter((_, j) => j !== i) });
}

/**
 * 地形修改(阶段 4):加一处(清理过的;不合格的、已满 TERRAIN_MAX_OPS 处的不加)。返回是否加上了。
 * App 看到地形修改变了就在后台带着新的地形重新生成世界、重推文明
 */
export function addTerrainOp(op: TerrainOp): boolean {
  const c = cleanTerrainOp(op);
  if (!c || state.terrain.length >= TERRAIN_MAX_OPS) return false;
  put({ ...state, terrain: [...state.terrain, c] });
  return true;
}

/** 地形修改:撤销最后一处 */
export function undoTerrainOp() {
  if (!state.terrain.length) return;
  put({ ...state, terrain: state.terrain.slice(0, -1) });
}

/** 地形修改:全部清除(地形回到种子原本的样子) */
export function clearTerrain() {
  if (!state.terrain.length) return;
  put({ ...state, terrain: EMPTY_EDITS.terrain });
}

// ---- 作者标记 ----

/** 把标记换成 list(空 = 去掉这个字段),记一步 */
function commitMarks(list: AuthorMark[]) {
  const { marks: _, ...rest } = state;
  commitEdits(list.length ? { ...rest, marks: list } : rest);
}

/** 加上(换上)这个标记后,所有标记圈的州加起来超过 MARK_REGIONS_TOTAL */
function regionsOver(m: AuthorMark): boolean {
  return !!m.regions && markRegionTotal(state.marks, m.id) + m.regions.length > MARK_REGIONS_TOTAL;
}

/** 加一个标记(清理过的;编号按现有最大的 + 1 重新给)。返回新标记的编号;不合格、已经有 MARKS_MAX 个、圈的州一共超过 MARK_REGIONS_TOTAL = −1 */
export function addMark(m: Omit<AuthorMark, 'id'>): number {
  if ((state.marks?.length ?? 0) >= MARKS_MAX) return -1;
  const id = nextMarkId(state.marks);
  const c = cleanMark({ ...m, id });
  if (!c || regionsOver(c)) return -1;
  commitMarks([...(state.marks ?? []), c]);
  return id;
}

/** 改一个标记(整个换成 m,编号不变;找不到、不合格、没变、圈的州一共超过 MARK_REGIONS_TOTAL = 不动)。返回改没改 */
export function updateMark(m: AuthorMark): boolean {
  const list = state.marks ?? [];
  const i = list.findIndex((x) => x.id === m.id);
  const c = cleanMark(m);
  if (i < 0 || !c || sameMark(c, list[i]) || regionsOver(c)) return false;
  commitMarks(list.map((x, j) => (j === i ? c : x)));
  return true;
}

/** 删一个标记(找不到 = 不动)。返回删掉的那个 */
export function removeMark(id: number): AuthorMark | null {
  const list = state.marks ?? [];
  const m = list.find((x) => x.id === id);
  if (!m) return null;
  commitMarks(list.filter((x) => x !== m));
  return m;
}

/** 把删掉的标记放回去(删除提示条上的"撤销"):编号已经被占了 = 换一个新编号;at = 放回列表里的位置。返回编号,放不回去 = −1 */
export function restoreMark(m: AuthorMark, at: number): number {
  const list = state.marks ?? [];
  // 已经放回来了(比如先按了 Ctrl+Z):不再放一份
  const same = list.find((x) => x.id === m.id);
  if (same && sameMark(same, m)) return m.id;
  if (list.length >= MARKS_MAX) return -1;
  const id = same ? nextMarkId(list) : m.id;
  const c = cleanMark({ ...m, id });
  if (!c || regionsOver(c)) return -1;
  const next = list.slice();
  next.splice(Math.min(Math.max(0, at), next.length), 0, c);
  commitMarks(next);
  return id;
}

/** 换了新世界:修改一律作废 */
export function clearEdits() {
  setEdits(EMPTY_EDITS);
}

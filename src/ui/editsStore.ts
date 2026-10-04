/**
 * 当前世界的用户修改(阶段 4,格式见 gen/edits.ts 的 WorldEdits):改名、干预、地形修改。
 * 和 civView.ts 一样的小 store(get / set / use)。换世界(种子 / 参数变了)时 App 调 clearEdits 清空。
 *
 * 这里只管内存里的这一份;存进浏览器 / 存成文件在 saveStore.ts(经 subscribeEdits 订阅,修改一变就自动存),
 * 读档时 App 先按存档的参数生成,再 setEdits(存档里的修改)。
 */
import { useSyncExternalStore } from 'react';
import { EMPTY_EDITS, cleanIntervention, type Intervention, type TerrainOp, type WorldEdits } from '../gen/edits';
import { TERRAIN_MAX_OPS, cleanTerrainOp } from '../gen/terrainEdits';

let state: WorldEdits = EMPTY_EDITS;
const subs = new Set<() => void>();
const emit = () => {
  for (const f of subs) f();
};

export function getEdits(): WorldEdits {
  return state;
}

/** 整个换掉(读档用)。传进来的对象之后别再改它 */
export function setEdits(next: WorldEdits) {
  if (next === state) return;
  state = next;
  emit();
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

/** 改名:name 为空(或 null)= 恢复默认(从 names 里去掉这个键) */
export function setName(key: string, name: string | null) {
  const names = { ...state.names };
  if (name) names[key] = name;
  else if (key in names) delete names[key];
  else return;
  if (names[key] === state.names[key] && Object.keys(names).length === Object.keys(state.names).length) return;
  setEdits({ ...state, names });
}

/**
 * 干预(阶段 4):加一条(清理过的;不合格的、和已有的一模一样的不加)。返回是否加上了。
 * App 看到干预列表变了就在后台从第 0 年重推文明
 */
export function addIntervention(v: Intervention): boolean {
  const c = cleanIntervention(v);
  if (!c) return false;
  const key = JSON.stringify(c);
  if (state.interventions.some((x) => JSON.stringify(x) === key)) return false;
  setEdits({ ...state, interventions: [...state.interventions, c] });
  return true;
}

/** 干预:去掉第 i 条(下标越界 = 不动) */
export function removeIntervention(i: number) {
  if (!(i >= 0 && i < state.interventions.length)) return;
  setEdits({ ...state, interventions: state.interventions.filter((_, j) => j !== i) });
}

/**
 * 地形修改(阶段 4):加一处(清理过的;不合格的、已满 TERRAIN_MAX_OPS 处的不加)。返回是否加上了。
 * App 看到地形修改变了就在后台带着新的地形重新生成世界、重推文明
 */
export function addTerrainOp(op: TerrainOp): boolean {
  const c = cleanTerrainOp(op);
  if (!c || state.terrain.length >= TERRAIN_MAX_OPS) return false;
  setEdits({ ...state, terrain: [...state.terrain, c] });
  return true;
}

/** 地形修改:撤销最后一处 */
export function undoTerrainOp() {
  if (!state.terrain.length) return;
  setEdits({ ...state, terrain: state.terrain.slice(0, -1) });
}

/** 地形修改:全部清除(地形回到种子原本的样子) */
export function clearTerrain() {
  if (!state.terrain.length) return;
  setEdits({ ...state, terrain: EMPTY_EDITS.terrain });
}

/** 换了新世界:修改一律作废 */
export function clearEdits() {
  setEdits(EMPTY_EDITS);
}

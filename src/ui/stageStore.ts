/**
 * 页面在哪一步(和 civView.ts 一样的小 store):
 *
 *   home    我的世界:存过的世界一张张卡片,新建世界、打开存档文件(MyWorlds.tsx)
 *   draft   新建世界:和平常页面分开的一套界面,中间是这颗星球,左边定种子、参数、地形、名字,右边换样式和投影,点"创建世界"(studio/Studio.tsx)
 *   world   建好的世界:历史、国家、改名、干预;种子、参数、地形锁住(世界概览的"世界设定"页只能看)
 *
 * base = 新建这一步是"以某个世界为底稿新建"(种子锁住,参数、地形照它填好,改名和干预跟过去)。
 * 纯状态,不碰 DOM。哪一步由 App 决定(网址、存档、按钮),别的组件只读。
 */
import { useSyncExternalStore } from 'react';

export type Stage = 'home' | 'draft' | 'world';

/** 以它为底稿新建:原来那个世界 */
export interface DraftBase {
  id: string;
  title: string;
  /** 跟过去的改名几处、干预几条 */
  names: number;
  interventions: number;
}

export interface StageState {
  stage: Stage;
  base: DraftBase | null;
}

let state: StageState = { stage: 'world', base: null };
const subs = new Set<() => void>();

export function getStage(): StageState {
  return state;
}

export function setStage(stage: Stage, base: DraftBase | null = null) {
  if (state.stage === stage && state.base === base) return;
  state = { stage, base: stage === 'draft' ? base : null };
  for (const f of subs) f();
}

/** 换了阶段时调 f(返回取消函数) */
export function subscribeStage(f: () => void): () => void {
  subs.add(f);
  return () => void subs.delete(f);
}

export function useStage(): StageState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
    () => state,
  );
}

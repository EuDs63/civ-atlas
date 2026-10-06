/**
 * 新建界面和 App 之间传的两样东西(和 stageStore 一样的小 store,纯状态):
 *
 *   flat   摊平改地形(或者没有 WebGL)时,平常的地图该铺在视口的哪一块;lon = 刚摊平时正中的经线(度)。
 *          App 按它摆地图的舞台、把视图放回 1 倍并转到这条经线;null = 地图照常铺满(新建界面里藏起来)
 *   geom   App 告诉新建界面平常的地图现在的样子(收起平面地图时星球从这里接着变形)
 */
import { useSyncExternalStore } from 'react';
import type { Box } from './layout';
import type { FlatGeom } from './scene';

export interface StudioFlat {
  rect: Box;
  lon?: number;
  /** 第几次摊平(lon 只在刚摊平那一次用) */
  seq: number;
}

let flat: StudioFlat | null = null;
let seq = 0;
const subs = new Set<() => void>();

export function setStudioFlat(rect: Box | null, lon?: number): void {
  if (!rect) {
    if (!flat) return;
    flat = null;
  } else {
    const same = flat && lon === undefined && flat.rect.x === rect.x && flat.rect.y === rect.y && flat.rect.w === rect.w && flat.rect.h === rect.h;
    if (same) return;
    flat = { rect, lon: lon ?? flat?.lon, seq: lon !== undefined || !flat ? ++seq : flat.seq };
  }
  for (const f of subs) f();
}

export function getStudioFlat(): StudioFlat | null {
  return flat;
}

export function useStudioFlat(): StudioFlat | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => flat,
    () => flat,
  );
}

let geomSource: (() => FlatGeom | null) | null = null;

/** App 挂上:平常的地图现在的样子 */
export function setFlatGeomSource(fn: (() => FlatGeom | null) | null): void {
  geomSource = fn;
}

export function flatGeom(): FlatGeom | null {
  return geomSource?.() ?? null;
}

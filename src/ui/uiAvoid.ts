/**
 * 地图上的字要让开的界面:平面主图(CivLayer.tsx)和地球仪(Globe.tsx)共用。
 *
 * 宽屏:左边浮着的侧栏卡片、右上图层分段按钮、导出、编年史(MapBar,含写作进度、打开的图层弹层);窄屏:底部的世界卡片 / 详情卡片、
 * 右上竖排的图层和地球按钮(含写作进度、打开的图层抽屉)。两边都有的还有助手面板和在地图上看试推演时的提示条。
 * 两边都有:顶部提示条、右下地球仪切换和缩放、底部时间轴、第一次打开的操作提示(新建时是"拖动地图看看这颗星球")、回放时的顶部说明。
 * 这些东西下面不放地名和城镇符号(压在按钮、面板底下的字读不清,还会被误点)。
 *
 * 量出来的是屏幕坐标(clientX / clientY)的矩形;界面很少动,不必每帧读布局 —— 调用方按 AVOID_MS 节流。
 */

import { useEffect, useState, type RefObject } from 'react';

/** 要让开的界面元素 */
export const AVOID_UI =
  '.sidebar, .psheet, .phone-btns, .ast-panel, .ast-banner, .corner-tl, .map-bar, .book-chip, .toast, .map-controls, .bottom-row, .lp-pop, .inspector:not(.hidden), .first-hint, .draft-tip, .civ-top';

/** 让开的范围多久重新量一次(毫秒) */
export const AVOID_MS = 200;

/** [左, 上, 右, 下] */
export type Box = [number, number, number, number];

/**
 * 量一遍要让开的界面(屏幕坐标,四周各放宽 pad 像素);看不见的(宽或高为 0、display: none)不算。
 * scope = 在哪里找(界面根元素 .app;找不到就整页)
 */
export function measureAvoid(scope: ParentNode | null, pad = 4): Box[] {
  const root: ParentNode | null = scope ?? (typeof document !== 'undefined' ? document : null);
  if (!root) return [];
  const out: Box[] = [];
  for (const el of root.querySelectorAll(AVOID_UI)) {
    const b = el.getBoundingClientRect();
    if (b.width && b.height) out.push([b.left - pad, b.top - pad, b.right + pad, b.bottom + pad]);
  }
  return out;
}

/** 两组矩形差不多一样(每条边相差不到 tol 像素):界面没动,不用重排地名 */
export function sameBoxes(a: readonly Box[], b: readonly Box[], tol = 2): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < 4; j++) if (Math.abs(a[i][j] - b[i][j]) > tol) return false;
  return true;
}

/**
 * 要让开的界面(屏幕坐标),每 AVOID_MS 量一次,变了才换新的一份(用它的地方据此重排地名)。
 * ref = 界面里的任一元素(按它找 .app)
 */
export function useAvoidBoxes(ref: RefObject<Element>): Box[] {
  const [boxes, setBoxes] = useState<Box[]>([]);
  useEffect(() => {
    let last: Box[] = [];
    const tick = () => {
      const el = ref.current;
      if (!el) return;
      const b = measureAvoid(el.closest('.app'));
      if (sameBoxes(b, last)) return;
      last = b;
      setBoxes(b);
    };
    tick();
    const t = window.setInterval(tick, AVOID_MS);
    return () => window.clearInterval(t);
  }, [ref]);
  return boxes;
}

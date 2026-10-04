/**
 * 屏幕宽窄、是不是手指操作(手机布局用):两样分别判断 ——
 *
 *   窄屏 narrow  视口宽 ≤ 760px:面板改成底部抽屉、时间轴两行固定在底部、弹层改成底部抽屉(样式在各 css 的 @media (max-width: 760px))
 *   触屏 coarse  (pointer: coarse):右下的 + − 藏起来(用双指捏合)、不出悬停卡片、操作提示改成"双指缩放"
 *
 * 平板横屏 = 宽屏 + 触屏:桌面布局,但支持手指。和 CSS 用同一个断点(NARROW_MAX)。
 */
import { useSyncExternalStore } from 'react';

/** 窄屏布局的断点(和各 css 里的 @media (max-width: 760px) 一致) */
export const NARROW_MAX = 760;

const NARROW_Q = `(max-width: ${NARROW_MAX}px)`;
const COARSE_Q = '(pointer: coarse)';

function media(q: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null;
}

function subscribe(q: string) {
  return (f: () => void) => {
    const m = media(q);
    if (!m) return () => {};
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  };
}

const subNarrow = subscribe(NARROW_Q);
const subCoarse = subscribe(COARSE_Q);

/** 现在是不是窄屏布局 */
export function isNarrow(): boolean {
  return media(NARROW_Q)?.matches ?? false;
}

/** 主要的指点设备是不是手指 */
export function isCoarse(): boolean {
  return media(COARSE_Q)?.matches ?? false;
}

export function useNarrow(): boolean {
  return useSyncExternalStore(subNarrow, isNarrow, () => false);
}

export function useCoarse(): boolean {
  return useSyncExternalStore(subCoarse, isCoarse, () => false);
}

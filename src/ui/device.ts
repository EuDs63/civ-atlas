/**
 * 屏幕宽窄、是不是手指操作(手机布局用):两样分别判断 ——
 *
 *   窄屏 narrow  视口宽 ≤ 760px:手机布局 —— 底部的世界 / 详情卡片、浮在卡片上面的时间轴胶囊、弹层改成底部抽屉
 *                (界面根元素带 .phone,布局在 phone.css;各 css 里还有些 @media (max-width: 760px) 的小调整)
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

let insetProbe: HTMLDivElement | null = null;

/**
 * 刘海、底部横条占掉的安全区(CSS 像素;没有就是 0):量一个用 env(safe-area-inset-*) 当内边距的隐藏元素,
 * 和 phone.css 里 --safe-t / --safe-b 是同一个值。转屏后会变,用的时候现量。
 */
export function safeInsets(): { t: number; b: number } {
  if (typeof document === 'undefined' || !document.body) return { t: 0, b: 0 };
  if (!insetProbe) {
    insetProbe = document.createElement('div');
    insetProbe.setAttribute('aria-hidden', 'true');
    insetProbe.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.appendChild(insetProbe);
  }
  const cs = getComputedStyle(insetProbe);
  return { t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
}

/**
 * 按钮的鼠标提示:鼠标停 0.4 秒(或用 Tab 选中)出一个小框,写这个按钮做什么,有快捷键的右边灰字写出键(「播放  空格」「民族  2」)。
 * 按钮上只写属性,整个页面共用这一个提示框(挂在 body 下,不会被卡片、按钮组的圆角裁掉):
 *
 *   data-tip="播放"         提示的字
 *   data-tip-key="play"     快捷键(shortcuts.ts 的动作名;苹果电脑写 ⌘、别的写 Ctrl)
 *   data-tip-side="above"   出在按钮的哪一边:above / below(默认)/ left / right
 *
 * 触屏(手指点)不出;按下鼠标、滚动、按键时收起;深浅色跟着按钮所在的地方。样子见 tips.css。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { keyLabel, type ShortcutKey } from './shortcuts';
import './tips.css';

type Side = 'above' | 'below' | 'left' | 'right';
interface Shown {
  text: string;
  /** 快捷键怎么写(没有 = null) */
  kbd: string | null;
  side: Side;
  rect: DOMRect;
  /** 按钮所在处的深浅色(实景、高程等图层是深色;提示框挂在 body 下,自己带上) */
  theme: string | undefined;
}

/** 鼠标停多久才出 */
const DELAY = 400;
/** 离按钮多远:上下 8,左右 6 */
const GAP_Y = 8;
const GAP_X = 6;

function tipOf(el: Element): Shown {
  const k = el.getAttribute('data-tip-key') as ShortcutKey | null;
  const side = el.getAttribute('data-tip-side');
  return {
    text: el.getAttribute('data-tip') ?? '',
    kbd: k ? keyLabel(k) : null,
    side: side === 'above' || side === 'left' || side === 'right' ? side : 'below',
    rect: el.getBoundingClientRect(),
    theme: el.closest('[data-theme]')?.getAttribute('data-theme') ?? undefined,
  };
}

export function TipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    let timer = 0;
    let at: Element | null = null;
    const hide = () => {
      clearTimeout(timer);
      at = null;
      setShown(null);
    };
    const later = (el: Element) => {
      clearTimeout(timer);
      at = el;
      timer = window.setTimeout(() => at === el && el.isConnected && setShown(tipOf(el)), DELAY);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el === at) return;
      if (!el) return hide();
      setShown(null);
      later(el);
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as Element | null;
      if (!el?.matches?.('[data-tip]:focus-visible')) return;
      setShown(null);
      later(el);
    };
    const blur = (e: FocusEvent) => e.target === at && hide();
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('wheel', hide, { capture: true });
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!shown) return null;
  // 换了一个按钮 = 换一个框(重新量大小)
  return createPortal(<Tip key={`${shown.text}|${shown.rect.left}|${shown.rect.top}`} {...shown} />, document.body);
}

function Tip({ text, kbd, side, rect, theme }: Shown) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = 0;
  let y = 0;
  if (box) {
    if (side === 'left' || side === 'right') {
      x = side === 'left' ? rect.left - GAP_X - box.w : rect.right + GAP_X;
      y = rect.top + rect.height / 2 - box.h / 2;
    } else {
      x = rect.left + rect.width / 2 - box.w / 2;
      y = side === 'above' ? rect.top - GAP_Y - box.h : rect.bottom + GAP_Y;
    }
    x = Math.max(8, Math.min(vw - 8 - box.w, x));
    y = Math.max(8, Math.min(vh - 8 - box.h, y));
  }
  return (
    <div
      className="ui-tip"
      role="tooltip"
      data-theme={theme}
      ref={(el) => {
        if (el && !box) setBox({ w: el.offsetWidth, h: el.offsetHeight });
      }}
      style={box ? { left: x, top: y } : { left: -9999, top: 0 }}
    >
      {text}
      {kbd && <kbd>{kbd}</kbd>}
    </div>
  );
}

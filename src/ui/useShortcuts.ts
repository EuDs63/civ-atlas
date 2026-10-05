/**
 * 键盘快捷键的总开关(按键对照见 shortcuts.ts;每个动作做什么由 App 给)。
 *
 * 这些时候不管,让按键照常:
 * - 光标在输入框、文本框、下拉框、可编辑的地方(搜索、改名、AI 对话……;中文输入法正在拼字时也不管)
 * - 弹窗开着(世界概览、AI 设置、史书、快捷键一览……):那里只认 Esc,各自处理
 * - 别处已经处理了这一下(比如时间轴拿到焦点时的方向键)
 * - 空格:焦点停在用 Tab 选中的按钮上(看得见焦点框)时,空格照旧是按那个按钮
 * 动作返回 false = 这一下不归快捷键管(比如还没有历史时按空格),按键照常;⌘S 在哪都拦下,不弹浏览器的"存储网页"。
 */
import { useEffect, useRef } from 'react';
import { matchShortcut, type ShortcutAction } from './shortcuts';

/** 按住不放会连着来的几个(方向键走年份、+ − 缩放);其余按住只算一下 */
const REPEATS = new Set<ShortcutAction>(['back', 'forward', 'back100', 'forward100', 'zoomIn', 'zoomOut']);

/** 光标在能打字的地方 */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/** 有弹窗(aria-modal)开着(世界概览一直挂着、关着时藏起来,只算看得见的) */
function modalOpen(): boolean {
  for (const el of document.querySelectorAll('[aria-modal="true"]')) if (el.getClientRects().length) return true;
  return false;
}

/** 焦点停在用键盘选中的按钮 / 链接上(:focus-visible) */
function keyboardFocus(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || el === document.body || !el.matches) return false;
  try {
    return el.matches(':focus-visible') && el.matches('button, a, summary, [role=button], [role=radio], [role=checkbox], [role=menuitem], [role=tab]');
  } catch {
    return false;
  }
}

export function useShortcuts(run: (a: ShortcutAction) => boolean) {
  const ref = useRef(run);
  ref.current = run;
  useEffect(() => {
    /** 空格按下时归了快捷键:松开时也拦下(不然焦点停在刚点过的按钮上时,松开空格会再按一次那个按钮) */
    let space = false;
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const a = matchShortcut(e);
      if (!a) return;
      // ⌘S 在哪都不弹浏览器的"存储网页"(存下来的是一张没用的网页;世界本来就自动存着)
      if (a === 'save') e.preventDefault();
      if (isTyping(e.target) || modalOpen()) return;
      if (a === 'play' && keyboardFocus(e.target)) return;
      if (e.repeat && !REPEATS.has(a)) {
        if (a === 'play' && space) e.preventDefault();
        return;
      }
      const done = ref.current(a);
      if (done) e.preventDefault();
      if (done && a === 'play') space = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !space) return;
      space = false;
      e.preventDefault();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}

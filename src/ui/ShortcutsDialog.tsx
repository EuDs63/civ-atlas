/**
 * 快捷键一览(电脑上按 ?,或左边卡片「···」菜单里的「键盘快捷键」):分时间、地图、世界三组,每行一件事、右边是它的键。
 * 样子照左边卡片的分组列表(白色圆角分组、灰色组名)。Esc、?、✕ 或点外面关掉。
 *
 *   openShortcuts() / closeShortcuts() / toggleShortcuts()
 *   ShortcutsHost   窗口本身,App 里一直挂着
 */
import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { SHORTCUT_GROUPS, keyLabel, matchShortcut } from './shortcuts';
import './shortcuts.css';

let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  if (v === open) return;
  open = v;
  subs.forEach((f) => f());
};
export const openShortcuts = () => set(true);
export const closeShortcuts = () => set(false);
export const toggleShortcuts = () => set(!open);

export function ShortcutsHost() {
  const on = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
    () => false,
  );
  return on ? <ShortcutsDialog /> : null;
}

function ShortcutsDialog() {
  // Esc、? 关掉(先于页面上别的按键)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && matchShortcut(e) !== 'help') return;
      e.preventDefault();
      e.stopPropagation();
      closeShortcuts();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // 挂在 body 下:深浅色跟着页面(实景、高程等图层是深色)
  const theme = document.querySelector('.app')?.getAttribute('data-theme') ?? undefined;
  return createPortal(
    <div className="kb-bg" data-theme={theme} onPointerDown={(e) => e.target === e.currentTarget && closeShortcuts()}>
      <section className="kb-panel" role="dialog" aria-modal="true" aria-label="键盘快捷键" data-testid="shortcuts" onWheel={(e) => e.stopPropagation()}>
        <header className="kb-head">
          <h2>键盘快捷键</h2>
          <button className="kb-x" data-act="shortcuts-close" onClick={closeShortcuts} aria-label="关闭">
            ✕
          </button>
        </header>
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title}>
            <h3 className="kb-sec">{g.title}</h3>
            <div className="kb-group">
              {g.rows.map((r) => (
                <div className="kb-row" key={r.text}>
                  <span>{r.text}</span>
                  <span className="kb-keys">
                    {r.keys.map((k) => (
                      <kbd key={k}>{keyLabel(k)}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>,
    document.body,
  );
}

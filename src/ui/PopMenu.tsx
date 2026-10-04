/**
 * 点按钮弹出的小菜单(侧栏顶上的"更多"、面板里的"更多"):按钮 + 一列菜单项。
 * 点菜单项、点外面、按 Esc 收起。样式在 sidebar.css(.pm-*)。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAiStatus } from '../ai/client';

export function PopMenu({
  label,
  icon,
  className,
  title,
  act,
  align = 'left',
  side,
  disabled,
  children,
}: {
  label?: ReactNode;
  icon?: ReactNode;
  /** 加在外层上(决定按钮长什么样:sb-pill / cp-tile……) */
  className?: string;
  title?: string;
  /** 按钮的 data-act */
  act?: string;
  /** 菜单和按钮左对齐还是右对齐 */
  align?: 'left' | 'right';
  /**
   * 按钮在宽屏的侧栏卡片里时,菜单弹到卡片右边、和按钮顶对齐(不盖住面板里的内容);
   * 不在侧栏里(手机的底部抽屉)照常挂在按钮下面
   */
  side?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    const card = side && open ? root.current?.closest('.sidebar') : null;
    if (!card || !root.current) return setAt(undefined);
    setAt({ position: 'fixed', left: card.getBoundingClientRect().right + 8, top: root.current.getBoundingClientRect().top, right: 'auto' });
  }, [open, side]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    // 弹到侧栏右边的菜单不跟着侧栏滚动:侧栏一滚就收起
    const onScroll = (e: Event) => {
      if (at && !(e.target instanceof Node && root.current?.contains(e.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, at]);
  return (
    <div className={`pm${className ? ` ${className}` : ''}${open ? ' open' : ''}`} ref={root}>
      <button
        className={`pm-btn${open ? ' on' : ''}`}
        data-act={act}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {label}
      </button>
      {open && (
        <div
          className={`pm-menu pm-${align}${at ? ' pm-side' : ''}`}
          style={at}
          role="menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.pm-item:not(:disabled)')) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** 菜单里的一项:按钮,或者给了 href 就是新标签页打开的链接 */
export function MenuItem({
  icon,
  note,
  href,
  act,
  ain,
  disabled,
  onClick,
  children,
}: {
  icon?: ReactNode;
  /** 右边的灰色小字("需设置") */
  note?: ReactNode;
  href?: string;
  act?: string;
  /** 名字由来 / AI 起名(data-ain) */
  ain?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      {icon}
      <span className="pm-text">{children}</span>
      {note && <small className="pm-note">{note}</small>}
    </>
  );
  if (href)
    return (
      <a className="pm-item" role="menuitem" href={href} target="_blank" rel="noreferrer" data-link={act}>
        {body}
      </a>
    );
  return (
    <button className="pm-item" role="menuitem" data-act={act} data-ain={ain} disabled={disabled} onClick={onClick}>
      {body}
    </button>
  );
}

/** 要用 AI 的一项:还没设置 AI 时右边的小字是"需设置" */
export function AiMenuItem(props: Parameters<typeof MenuItem>[0]) {
  const ai = useAiStatus();
  return <MenuItem {...props} note={ai.ready ? props.note : '需设置'} />;
}

export function MenuSep() {
  return <hr className="pm-sep" />;
}

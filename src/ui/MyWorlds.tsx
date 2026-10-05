/**
 * 「我的世界」:浏览器里存着的世界,一个一张卡片(缩略图、名字、种子和现存几国、最近打开的时间),最近的在前。
 * 有存档的人进站先到这一页;世界卡片顶上"‹ 我的世界"回到这里。样子照常见的文稿列表(浅灰底、缩略图网格、名字和日期在图下面)。
 *
 *   右上     打开存档文件(也可以把 .json 拖进页面)、新建世界
 *   卡片     点一下打开;"没建完"的(还在新建)点开接着建
 *            右上"···"(电脑悬停时出现;手机长按卡片)= 改名、复制一份、存成文件、删除(点两下确认)。没建完的只有改名、删除
 *   底部     源代码、隐私政策、用户协议、版本号(手机上不放,在世界卡片的"更多"里)
 * 手机:两列卡片,新建世界在右上,打开存档文件在列表下面。
 *
 * 存、读、列都在 saveStore.ts;打开一个世界(生成 + 套上修改)由 App 做。一个世界都不剩时 App 直接进新建。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { deleteWorld, duplicateWorld, listWorlds, loadWorld, notify, persistent, renameWorld, restoreWorld, useSavesVersion, type StoredWorld } from './saveStore';
import { downloadSave } from './SaveMenu';
import { copyNotes } from '../ai/library';
import { Icon } from './icons';
import { TitleInput, when } from './worldParts';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import './worlds.css';

export interface MyWorldsProps {
  phone: boolean;
  /** 打开一个存着的世界 */
  onOpen: (id: string) => void;
  /** 新建世界 */
  onNew: () => void;
  /** 从文件打开:文件内容(App 解析、存进我的世界、打开) */
  onOpenText: (text: string, fileName?: string) => void;
}

/** 卡片第二行:"种子 7，现存 13 国" / "种子 1009，还在新建" */
function worldLine(w: StoredWorld): string {
  const seed = `种子 ${w.save.seed}`;
  if (w.draft) return `${seed}，还在新建`;
  if (w.alive === undefined) return seed;
  return w.alive ? `${seed}，现存 ${w.alive} 国` : `${seed}，没有文明`;
}

export function MyWorlds({ phone, onOpen, onNew, onOpenText }: MyWorldsProps) {
  const v = useSavesVersion();
  const list = useMemo(() => listWorlds(), [v]);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 菜单开在哪张卡片上 */
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const keep = persistent();

  const pickFile = () => fileRef.current?.click();
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      onOpenText(await f.text(), f.name);
    } catch {
      notify({ kind: 'error', text: `打不开 ${f.name}`, more: ['读不了这个文件'] });
    }
  };
  const sub = keep
    ? phone
      ? `${list.length} 个世界，自动存在这个浏览器里`
      : `${list.length} 个世界，改动自动存在这个浏览器里；换电脑请用存档文件。`
    : '浏览器不让网页存数据，关掉页面前请把世界存成文件。';
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <div className={`mw${phone ? ' mw-phone' : ''}`} role="main" aria-label="我的世界" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} data-testid="save-file-input" />
      <header className="mw-top">
        {phone && (
          <div className="mw-bar">
            <button className="mw-btn blue round" data-act="new-world" onClick={onNew}>
              <Icon name="plus" size={16} />
              新建世界
            </button>
          </div>
        )}
        <div className="mw-heading">
          <h1>我的世界</h1>
          <p>{sub}</p>
        </div>
        {!phone && (
          <div className="mw-acts">
            <button className="mw-btn" data-act="open-file" onClick={pickFile}>
              <Icon name="file" size={16} />
              打开存档文件
            </button>
            <button className="mw-btn blue" data-act="new-world" onClick={onNew}>
              <Icon name="plus" size={16} />
              新建世界
            </button>
          </div>
        )}
      </header>
      <div className="mw-grid" role="list">
        {list.map((w) => (
          <WorldCard
            key={w.id}
            w={w}
            phone={phone}
            menuOpen={menu === w.id}
            onMenu={(o) => setMenu(o ? w.id : null)}
            renaming={renaming === w.id}
            onRename={(o) => setRenaming(o ? w.id : null)}
            onOpen={() => onOpen(w.id)}
          />
        ))}
      </div>
      {phone && (
        <div className="mw-open-file sb-group">
          <button className="sb-row" data-act="open-file" onClick={pickFile}>
            <Icon name="file" size={18} className="sb-ico" />
            <span className="sb-row-main">
              <b>打开存档文件</b>
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
        </div>
      )}
      {!phone && (
        <footer className="mw-foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer" data-link="source">
            源代码
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-link="privacy">
            隐私政策
          </a>
          <a href={TERMS_URL} target="_blank" rel="noreferrer" data-link="terms">
            用户协议
          </a>
          <span className="mw-ver" data-version>
            版本 {APP_VERSION}
          </span>
        </footer>
      )}
    </div>
  );
}

/** 长按多久算长按(毫秒;手机上开卡片的菜单) */
const LONG_PRESS = 480;

function WorldCard({
  w,
  phone,
  menuOpen,
  onMenu,
  renaming,
  onRename,
  onOpen,
}: {
  w: StoredWorld;
  phone: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  renaming: boolean;
  onRename: (on: boolean) => void;
  onOpen: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  /** 长按:按下的计时器;长按开了菜单以后,松手那一下的点击不算打开 */
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longFired = useRef(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onMenu(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen, onMenu]);
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.t);
    },
    [],
  );

  const name = w.save.title || '未命名世界';
  const act = (f: () => void) => () => {
    onMenu(false);
    f();
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  return (
    <div ref={root} className={`mw-card${w.draft ? ' draft' : ''}${menuOpen ? ' menu-on' : ''}`} role="listitem" data-id={w.id}>
      <button
        className="mw-open"
        data-act="open-world"
        onClick={() => {
          if (longFired.current) {
            longFired.current = false;
            return;
          }
          if (!renaming) onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(true);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          longFired.current = false;
          cancelPress();
          press.current = {
            x: e.clientX,
            y: e.clientY,
            t: setTimeout(() => {
              press.current = null;
              longFired.current = true;
              onMenu(true);
            }, LONG_PRESS),
          };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        title={w.draft ? '接着建这个世界' : '打开这个世界'}
      >
        <span className="mw-thumb" style={w.thumb ? { backgroundImage: `url(${w.thumb})` } : undefined}>
          {w.draft && <span className="mw-tag">没建完</span>}
        </span>
        {phone ? (
          <span className="mw-meta">
            {!renaming && <b className="mw-name">{name}</b>}
            <span className="mw-line">{worldLine(w)}</span>
            <span className="mw-time">{when(w.at)}</span>
          </span>
        ) : (
          <span className="mw-meta">
            <span className="mw-row1">
              {!renaming && <b className="mw-name">{name}</b>}
              <span className="mw-time">{when(w.at)}</span>
            </span>
            <span className="mw-line">{worldLine(w)}</span>
          </span>
        )}
      </button>
      {renaming && (
        <div className="mw-rename">
          <TitleInput
            className="mw-title-input"
            initial={w.save.title ?? ''}
            onDone={(v) => {
              onRename(false);
              if (v !== null) renameWorld(w.id, v);
            }}
          />
        </div>
      )}
      {!phone && (
        <button className={`mw-dots${menuOpen ? ' on' : ''}`} data-act="world-menu" aria-label="更多" title="更多" onClick={() => onMenu(!menuOpen)}>
          <Icon name="more" size={18} />
        </button>
      )}
      {menuOpen && (
        <div className="pm-menu mw-menu" role="menu">
          <button className="pm-item" data-act="world-rename" onClick={act(() => onRename(true))}>
            <Icon name="rename" size={16} />
            <span className="pm-text">改名</span>
          </button>
          {!w.draft && (
            <>
              <button
                className="pm-item"
                data-act="world-copy"
                onClick={act(() => {
                  const id = duplicateWorld(w.id);
                  if (!id) return notify({ kind: 'error', text: '没能复制', more: ['浏览器存储已满'] });
                  const more = [`新的叫「${loadWorld(id)?.save.title ?? ''}」`];
                  // AI 写的史书、名字由来跟着复制;存不下就说一声(这一页里还看得到,刷新以后没有)
                  if (!copyNotes(w.id, id)) more.push('AI 写的史书、名字由来没能一起存下（浏览器存储已满）');
                  notify({ kind: more.length > 1 ? 'warn' : 'ok', text: `已复制一份「${name}」`, more });
                })}
              >
                <Icon name="copy" size={16} />
                <span className="pm-text">复制一份</span>
              </button>
              <button
                className="pm-item"
                data-act="world-file"
                onClick={act(() => {
                  // 按点的这一刻存着的存(别的页面里可能又改过、删了)
                  const cur = loadWorld(w.id);
                  if (!cur) return notify({ kind: 'error', text: '打不开这个存档', more: ['可能已在别的页面里删掉了'] });
                  downloadSave(cur.save);
                })}
              >
                <Icon name="save" size={16} />
                <span className="pm-text">存成文件</span>
              </button>
            </>
          )}
          <hr className="pm-sep" />
          <button
            className="pm-item red"
            data-act="world-delete"
            onClick={act(() => {
              // 点一下就删,不再问;提示条上的"撤销"兜底(提示条还在的时候点,放回原处)
              const gone = deleteWorld(w.id);
              // 别的页面里已经删掉了(这一页的列表还没跟上):没有可撤销的
              if (!gone) return notify({ kind: 'ok', text: `「${name}」已在别的页面里删掉了` });
              notify({
                kind: 'ok',
                text: `已删除「${name}」`,
                action: {
                  label: '撤销',
                  act: 'world-undelete',
                  onClick: () => {
                    if (restoreWorld(gone)) notify(null);
                    else notify({ kind: 'error', text: '没能放回去', more: ['浏览器存储已满'] });
                  },
                },
              });
            })}
          >
            <Icon name="trash" size={16} />
            <span className="pm-text">删除</span>
          </button>
        </div>
      )}
    </div>
  );
}

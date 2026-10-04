/**
 * 世界概览头部的"存档"菜单(阶段 4):
 *
 *   当前世界:名字(可起名 / 改名)、种子、改了几处、"已自动存在这个浏览器里"
 *   存成文件:下载 .json(文明与地图-九州大陆.json;格式见 gen/savefile.ts)
 *   从文件打开:选文件(也可以把 .json 直接拖进页面,App 接住)
 *   复制分享链接:整份存档压缩进网址的 # 后面(gen/savefile.ts 的 encodeShare),复制到剪贴板;
 *     没有修改 = 普通网址(只带种子、参数);剪贴板用不了:菜单留着,里面多一行选中了链接的输入框,让用户自己复制
 *   我的世界:浏览器里存过的世界(缩略图、名字、种子、改了几处、最后修改时间),点一个就打开;可改名、删除
 *
 * 存、读、列都在 saveStore.ts;打开一个世界(重新生成 + 套上修改)由 App 做(onOpenText / onOpenStored)。
 * 读档结果、自动恢复、版本不同、存储满了之类的提示(saveStore 的 notify)显示在顶部的提示条上;
 * 打开分享链接时本地存过不同修改的"用链接里的 / 保留本地"也是提示条上的两个按钮(App 显示)。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_PARAMS, type WorldParams } from '../gen/world';
import { SHARE_WARN_LENGTH, TITLE_MAX, editCount, encodeShare, hasShareData, saveFileName, saveText, type SaveFile } from '../gen/savefile';
import { GENERATOR_VERSION } from '../gen/edits';
import { useEdits } from './editsStore';
import {
  currentSave,
  currentWorld,
  deleteWorld,
  listWorlds,
  loadWorld,
  notify,
  persistent,
  renameWorld,
  setFileSaver,
  storageIsFull,
  useSavesVersion,
  type StoredWorld,
} from './saveStore';

export interface SaveMenuProps {
  /** 世界生成完了(能存) */
  ready: boolean;
  /** 读档:文件内容(App 解析、按存档的参数生成、套上修改) */
  onOpenText: (text: string, fileName?: string) => void;
  /** 打开"我的世界"里的一个 */
  onOpenStored: (id: string) => void;
  /** 按钮上文字前面的小图标 */
  icon?: ReactNode;
}

/** 调试 / 冒烟测试用:最近一次"存成文件" */
interface SaveDebug {
  name: string;
  bytes: number;
  count: number;
}

/** 调试 / 冒烟测试用:最近一次"复制分享链接" */
interface ShareDebug {
  url: string;
  length: number;
  /** 带不带修改(没有修改 = 普通网址) */
  withData: boolean;
  count: number;
  copied: boolean;
}

/** 复制到剪贴板:先用剪贴板接口,不行(没权限、不是 https)再用老办法;都不行 = false */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 换老办法 */
  }
  const focused = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', left: '-9999px', top: '0', opacity: '0' });
    document.body.appendChild(ta);
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    focused?.focus?.();
  }
}

const LONG_HINT = '链接较长,可能打不开,建议存成文件';

/** 当前世界存成文件(菜单里的"存成文件"、存储满了时提示条上的"存成文件") */
function saveCurrentFile() {
  const save = currentSave();
  if (!save) return;
  const name = saveFileName(save);
  const text = saveText(save);
  download(text, name);
  (window as unknown as { __wfSave?: SaveDebug }).__wfSave = { name, bytes: new Blob([text]).size, count: editCount(save.edits) };
  notify({ kind: 'ok', text: '已存成文件', more: [name] });
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 和默认值不同的参数,简写:"陆地 45% · 板块 20" */
function paramsBrief(p: WorldParams): string {
  const d = DEFAULT_PARAMS;
  const out: string[] = [];
  if (p.landFraction !== d.landFraction) out.push(`陆地 ${Math.round(p.landFraction * 100)}%`);
  if (p.plates !== d.plates) out.push(`板块 ${p.plates}`);
  if (p.mountains !== d.mountains) out.push(`造山 ${p.mountains.toFixed(2)}×`);
  if (p.temperature !== d.temperature) out.push(`气温 ${p.temperature > 0 ? '+' : ''}${p.temperature}°C`);
  if (p.rainfall !== d.rainfall) out.push(`降水 ${p.rainfall.toFixed(2)}×`);
  if (p.cells !== d.cells) out.push(`${Math.round(p.cells / 1000)}k 地块`);
  return out.join(' · ');
}

/** 剪贴板用不了:菜单里一行"没能自动复制",下面是选中了链接的输入框(不另开窗口) */
function ManualCopy({ url }: { url: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [url]);
  return (
    <div className="save-manual" data-testid="share-manual">
      <span>{url.length > SHARE_WARN_LENGTH ? `没能自动复制,请手动复制 · ${LONG_HINT}` : '没能自动复制,请手动复制'}</span>
      <input ref={ref} readOnly value={url} spellCheck={false} aria-label="分享链接" onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

/** 最后修改时间:刚刚 / 5 分钟前 / 3 小时前 / 昨天 14:05 / 9月27日 */
function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const now = Date.now();
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(t);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (t >= today.getTime()) return s < 6 * 3600 ? `${Math.floor(s / 3600)} 小时前` : `今天 ${hm}`;
  if (t >= today.getTime() - 86400e3) return `昨天 ${hm}`;
  const y = d.getFullYear() === today.getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}

const worldName = (save: Pick<SaveFile, 'title' | 'seed'>) => save.title || `种子 ${save.seed}`;

/** 名字输入框:回车 / 点别处确定,Esc 取消 */
function TitleInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="save-title-input"
      value={text}
      maxLength={TITLE_MAX}
      placeholder="给这个世界起个名字,如「九州大陆」"
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(text);
        else if (e.key === 'Escape') {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={() => finish(text)}
    />
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? <img className="save-thumb" src={src} alt="" draggable={false} /> : <div className="save-thumb empty" />;
}

function WorldRow({ w, isCurrent, onOpen }: { w: StoredWorld; isCurrent: boolean; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return;
    const t = setTimeout(() => setArm(false), 3000);
    return () => clearTimeout(t);
  }, [arm]);
  const brief = paramsBrief(w.save.params);
  return (
    <div className={`save-row${isCurrent ? ' current' : ''}`} data-id={w.id}>
      <button className="save-open" onClick={onOpen} disabled={isCurrent} title={isCurrent ? '正在看的就是这个世界' : '打开这个世界'}>
        <Thumb src={w.thumb} />
        <span className="save-info">
          {editing ? null : (
            <b>
              {worldName(w.save)}
              {isCurrent && <em className="save-badge">当前</em>}
            </b>
          )}
          <span>
            种子 {w.save.seed}
            {brief && ` · ${brief}`}
          </span>
          <span>
            {w.count ? `改了 ${w.count} 处` : '没有修改'}
            {w.save.savedAt && ` · ${when(w.save.savedAt)}`}
            {w.save.generator !== GENERATOR_VERSION && (
              <em className="save-old" title="存的时候是另一个版本:打开后地形可能不同">
                {w.save.generator < GENERATOR_VERSION ? ' · 旧版本' : ' · 新版本'}
              </em>
            )}
          </span>
        </span>
      </button>
      {editing && (
        <div className="save-row-edit">
          <TitleInput
            initial={w.save.title ?? ''}
            onDone={(v) => {
              setEditing(false);
              if (v !== null) renameWorld(w.id, v);
            }}
          />
        </div>
      )}
      <div className="save-acts">
        <button className="save-act" onClick={() => setEditing(true)} title="给这个存档改名">
          ✎
        </button>
        <button
          className={`save-act del${arm ? ' arm' : ''}`}
          onClick={() => {
            if (!arm) return setArm(true);
            setArm(false);
            deleteWorld(w.id);
          }}
          title={arm ? '再点一次就删掉' : '从"我的世界"里删掉'}
        >
          {arm ? '确定删除' : '删除'}
        </button>
      </div>
    </div>
  );
}

export function SaveMenu({ ready, onOpenText, onOpenStored, icon }: SaveMenuProps) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const v = useSavesVersion();
  const edits = useEdits();
  const cur = ready ? currentWorld() : null;
  const list = useMemo(() => (open ? listWorlds() : []), [open, v]);
  const curStored = useMemo(() => (open && cur ? loadWorld(cur.id) : null), [open, cur, v]);
  const count = editCount(edits);
  const keep = persistent();
  const full = storageIsFull();

  // 点菜单外面就收起(在捕获阶段听:地图上的按钮条拦了冒泡,点旁边的按钮照样收起)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setNaming(false);
  }, [open]);

  const saveFile = () => {
    setOpen(false);
    saveCurrentFile();
  };

  // 复制分享链接:网址(种子 + 参数 + 画风……)+ #share=整份存档;没有修改就是普通网址。
  // 剪贴板用不了:菜单留着,里面多一行选中了链接的输入框(不另开窗口)
  const [manual, setManual] = useState<string | null>(null);
  const shareLink = async () => {
    const save = currentSave();
    if (!save) return;
    const base = location.origin + location.pathname + location.search;
    const withData = hasShareData(save);
    let url = base;
    if (withData) {
      try {
        url = base + (await encodeShare(save));
      } catch {
        setOpen(false);
        notify({ kind: 'error', text: '做不了分享链接', more: ['浏览器版本太旧,请改用存成文件'] });
        return;
      }
    }
    const n = url.length;
    const count = editCount(save.edits);
    const copied = await copyText(url);
    (window as unknown as { __wfShare?: ShareDebug }).__wfShare = { url, length: n, withData, count, copied };
    const long = n > SHARE_WARN_LENGTH;
    if (!copied) {
      setManual(url);
      return;
    }
    setOpen(false);
    const more = long ? [`${LONG_HINT}(${n} 字)`] : withData ? [] : ['还没有修改,只带种子和参数'];
    notify({ kind: long ? 'warn' : 'ok', text: `已复制${withData ? '分享' : ''}链接`, more });
  };
  useEffect(() => {
    if (!open) setManual(null);
  }, [open]);
  // 存储满了 / 浏览器不让存时,提示条上的"存成文件"
  useEffect(() => {
    setFileSaver(saveCurrentFile);
    return () => setFileSaver(null);
  }, []);

  const pickFile = () => fileRef.current?.click();
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setOpen(false);
    try {
      onOpenText(await f.text(), f.name);
    } catch {
      notify({ kind: 'error', text: `打不开 ${f.name}`, more: ['读不了这个文件'] });
    }
  };

  const title = cur?.title;
  return (
    <div className="save" ref={rootRef}>
      <button className={`save-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} title="我的世界:自动存在浏览器里;也能存成文件、从文件打开">
        {icon}
        存档
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} data-testid="save-file-input" />
      {open && (
        <div className="save-menu" role="menu">
          <div className="save-sec">当前世界</div>
          {cur ? (
            <div className="save-cur">
              <Thumb src={curStored?.thumb ?? null} />
              <div className="save-info">
                {naming ? (
                  <TitleInput
                    initial={title ?? ''}
                    onDone={(t) => {
                      setNaming(false);
                      if (t !== null) renameWorld(cur.id, t);
                    }}
                  />
                ) : (
                  <button className="save-name" onClick={() => setNaming(true)} title="给这个世界起个名字(起了名字的世界没有修改也会留在「我的世界」里)">
                    {title || <span className="ph">起个名字…</span>}
                    <span className="ins-pen" aria-hidden="true">
                      ✎
                    </span>
                  </button>
                )}
                <span>
                  种子 {cur.params.seed}
                  {paramsBrief(cur.params) && ` · ${paramsBrief(cur.params)}`}
                </span>
                <span className={full ? 'save-full' : undefined}>
                  {count ? `改了 ${count} 处 · ` : ''}
                  {full ? '浏览器存储已满,没能自动存' : curStored ? (keep ? '已自动存在这个浏览器里' : '只存在这个页面里') : count ? '' : '还没有修改'}
                </span>
              </div>
            </div>
          ) : (
            <div className="save-empty">{ready ? '' : '正在生成世界'}</div>
          )}
          <div className="save-btns">
            <button className="save-item" data-act="save-file" disabled={!cur} onClick={saveFile}>
              <b>存成文件(.json)</b>
              <span>换台电脑也能打开</span>
            </button>
            <button className="save-item" data-act="open-file" onClick={pickFile}>
              <b>从文件打开…</b>
              <span>也可以把 .json 拖进页面</span>
            </button>
            <button className="save-item wide" data-act="share-link" disabled={!cur} onClick={shareLink}>
              <b>复制分享链接</b>
              <span>{count || title ? '对方打开看到同一个世界、同样的修改' : '还没有修改,只带种子和参数'}</span>
            </button>
          </div>
          {manual !== null && <ManualCopy url={manual} />}
          <div className="save-sec">
            我的世界{list.length ? `(${list.length})` : ''}
          </div>
          <div className="save-list">
            {list.length ? (
              list.map((w) => (
                <WorldRow
                  key={w.id}
                  w={w}
                  isCurrent={w.id === cur?.id}
                  onOpen={() => {
                    setOpen(false);
                    onOpenStored(w.id);
                  }}
                />
              ))
            ) : (
              <div className="save-empty">还没有存过的世界。改过或起了名字的世界会出现在这里</div>
            )}
          </div>
          <div className="save-foot">{keep ? '改过的世界自动存在这个浏览器里' : '浏览器不让网页存数据,关掉页面前请存成文件'}</div>
        </div>
      )}
    </div>
  );
}

/**
 * 读史书(右上"已完成 · 打开"、已写的史书列表打开):小字元信息、宋体大标题、目录、分章正文。
 * 写的时候也能打开:边写边显示,可以停止。工具:复制、导出 Markdown、重写、删除。
 * 像一本书,纸色底 —— 不跟着图层换深色。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import { deleteNote, getNote, useNotesVersion } from '../ai/library';
import { HISTORY_LENGTHS, textLength, type HistoryLength, type HistoryStyle } from '../ai/prompts/history';
import { asHistoryNote, historyFileName, historyMarkdown, historyNoteStatus, historyStyleLabel, historyWriter, shortDate, type HistoryNote } from '../ai/history';
import { currentWorld, useSavesVersion } from './saveStore';
import { bookTitleText, bookUnit, closeBookReader, openBookReader, startBook, stopBook, useBook } from './bookStore';
import { useDialogEscape } from './BookDialog';
import { AiTag } from './aiTag';
import './book.css';

const fmt = (n: number) => n.toLocaleString('en-US');

/** 复制文字(没有剪贴板权限时退回老办法) */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// 正文排版:AI 写的 Markdown(只认标题、引用、列表、分隔线、粗体;其余当段落)

interface Chapter {
  id: string;
  /** "卷一" / "第一章" / "本纪" */
  n: string;
  /** 章名 */
  t: string;
  /** "1045–1536" */
  y: string;
  /** 列传这一篇写了谁(从"### 某某传"取):目录里写"列传 | 司空弈、顾珏" */
  who?: string[];
}

/** "## 卷一 诸部初立(第 0—1045 年)" / "## 本纪·大澜王朝" / "## 列传" → 卷次、章名、年份 */
export function parseChapter(line: string): Omit<Chapter, 'id'> {
  let rest = line.trim();
  let y = '';
  const ym = /\s*[(（]\s*(?:第\s*)?(\d+)\s*(?:年)?\s*[—–\-~至到]+\s*(?:第\s*)?(\d+)\s*年?\s*[)）]\s*$/.exec(rest);
  if (ym) {
    y = `${ym[1]}–${ym[2]}`;
    rest = rest.slice(0, ym.index).trim();
  }
  const cm = /^(第[一二三四五六七八九十百零〇两\d]+[章卷篇回]|卷[一二三四五六七八九十百零〇\d]+)\s*[·・:：、.\s]?\s*(.*)$/.exec(rest);
  if (cm && cm[2]) return { n: cm[1], t: cm[2].trim(), y };
  const pm = /^(本纪|世家|列传)\s*[·・:：]\s*(.+)$/.exec(rest);
  if (pm) return { n: pm[1], t: pm[2].trim(), y };
  return { n: '', t: rest, y };
}

/** "司空弈传" / "一、顾珏传" / "司空弈、顾珏合传(第 1200—1260 年)" → 传主的名字;不像传名的 → 空 */
export function lifeName(line: string): string {
  const t = line
    .trim()
    .replace(/\s*[(（][^()（）]*[)）]\s*$/, '')
    .replace(/^[一二三四五六七八九十百\d]+\s*[、.．]\s*/, '');
  if (t.startsWith('列传')) return '';
  const m = /^(.+?)\s*合?传$/.exec(t);
  return m && m[1].length <= 16 ? m[1].trim() : '';
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <b key={i}>{p.slice(2, -2)}</b> : p));
}

export function layout(text: string, bookTitle: string): { blocks: ReactNode[]; chapters: Chapter[] } {
  const blocks: ReactNode[] = [];
  const chapters: Chapter[] = [];
  const lives = (c: Chapter | undefined) => !!c && (c.n === '列传' || (!c.n && c.t === '列传'));
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const h = /^(#{1,6})\s*(.*)$/.exec(line);
    if (h) {
      const body = h[2].replace(/\*\*/g, '').trim();
      // 模型偶尔先写一行"# 书名":和大标题重复,不要
      const norm = (x: string) => x.replace(/[《》\s]/g, '');
      if (h[1].length === 1 && (!blocks.length || norm(body) === norm(bookTitle))) return;
      if (h[1].length <= 2) {
        const c = { id: `bk-ch-${chapters.length}`, ...parseChapter(body) };
        chapters.push(c);
        blocks.push(
          <h3 key={i} id={c.id} className="bk-ch">
            {c.n && <span className="bk-ch-n">{c.n}</span>}
            <span className="bk-ch-t">{c.t}</span>
            {c.y && <span className="bk-ch-y">{c.y}</span>}
          </h3>,
        );
      } else {
        const c = chapters[chapters.length - 1];
        const who = lives(c) ? lifeName(body) : '';
        if (who && !c.who?.includes(who)) c.who = [...(c.who ?? []), who];
        blocks.push(<h4 key={i}>{inline(body)}</h4>);
      }
      return;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return void blocks.push(<hr key={i} />);
    const q = /^>\s?(.*)$/.exec(line);
    if (q) return void blocks.push(<p key={i} className="bk-quote">{inline(q[1])}</p>);
    const li = /^[-*·]\s+(.*)$/.exec(line);
    if (li) return void blocks.push(<p key={i} className="bk-li">{inline(li[1])}</p>);
    blocks.push(<p key={i}>{inline(line)}</p>);
  });
  return { blocks, chapters };
}

// ---------------------------------------------------------------------------

/** 元信息:"纪传体，中篇，截至 3000 年"(一国的写起止年份) */
function metaLine(style: HistoryStyle, length: HistoryLength, range: string, scopeKind: string): string {
  const m = /(\d+)\D+(\d+)/.exec(range);
  const when = m ? (scopeKind === 'world' ? `截至 ${m[2]} 年` : `${m[1]}–${m[2]} 年`) : range;
  return [historyStyleLabel(style), `${HISTORY_LENGTHS[length].label}篇`, when].filter(Boolean).join('，');
}

export function BookReader({ civ }: { civ: Civ }) {
  const st = useBook();
  useDialogEscape(st.reader.open, closeBookReader);
  if (!st.reader.open) return null;
  return <Reader key={`${st.reader.stamp}`} civ={civ} />;
}

function Reader({ civ }: { civ: Civ }) {
  const st = useBook();
  useSavesVersion();
  useNotesVersion();
  const world = currentWorld();
  const job = st.job;
  const key = st.reader.key;
  const note: HistoryNote | null = key && world ? asHistoryNote(getNote(world.id, key)) : null;
  const live = !note && key === null && job ? job : null;
  const status = useMemo(() => (note ? historyNoteStatus(civ, note) : null), [note, civ]);
  const [copied, setCopied] = useState(false);
  const [armDel, setArmDel] = useState(false);

  // 看着的那部被删了 / 找不到了:关上
  useEffect(() => {
    if (!note && !live) closeBookReader();
  }, [note, live]);

  const text = note ? note.text : (live?.text ?? '');
  const title = note ? note.book.title : (live?.title ?? '');
  const scope = note ? note.book.scope : (live?.opts.scope ?? { kind: 'world' });
  const name = bookTitleText(title, scope, world?.title);
  const { blocks, chapters } = useMemo(() => layout(text, name), [text, name]);
  const writing = !!live && live.status === 'writing';

  // 写的时候跟着往下滚(读者往上翻了就不跟)
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && writing && follow.current) el.scrollTop = el.scrollHeight;
  }, [text, writing]);

  if (!note && !live) return null;
  const style = note ? note.book.style : live!.opts.style;
  const length = note ? note.book.length : live!.opts.length;
  const range = note ? note.book.range : live!.range;
  const busy = job?.status === 'writing';
  const redo = note ? (status?.scope ? { scope: status.scope, style, length } : null) : live && !writing ? live.opts : null;
  // 重写 / 重试:阅读页接着看正在写的这一部
  const rewrite = () => {
    if (redo && startBook(redo)) openBookReader(null);
  };

  const info = note
    ? [`${fmt(textLength(note.text))} 字`, historyWriter(note, '，'), shortDate(note.createdAt)].filter(Boolean).join('，')
    : writing
      ? `正在写${live!.calls > 1 ? `第 ${live!.call + 1} ${bookUnit(style)}(共 ${live!.calls} ${bookUnit(style)})` : ''}…… ${text ? `${fmt(textLength(text))} 字` : ''}`
      : live!.status === 'stopped'
        ? '已停止,写到一半的没有保存。'
        : (live!.error?.message ?? '没写完');

  const stopBubble = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className="bk-bg" onPointerDown={(e) => e.target === e.currentTarget && closeBookReader()}>
      <article className="bk-reader" data-theme="light" role="dialog" aria-modal="true" aria-label={name} onPointerDown={stopBubble} onWheel={stopBubble}>
        <header className="bk-r-head">
          <div className="bk-r-top">
            <span className="bk-meta">
              <AiTag />
              {metaLine(style, length, range, scope.kind)}
            </span>
            <button className="bk-x" onClick={closeBookReader} title="关闭" aria-label="关闭">
              ✕
            </button>
          </div>
          <h1 className="bk-book">{name}</h1>
          <div className="bk-tools">
            <span className={`bk-info${live && !writing ? ' err' : ''}`} data-testid="book-info">
              {writing && <i className="bk-spin" />}
              {info}
            </span>
            {writing ? (
              <button className="bk-tool" data-act="book-stop" onClick={stopBook}>
                停止
              </button>
            ) : (
              <>
                {note && (
                  <>
                    <button
                      className="bk-tool"
                      onClick={async () => {
                        await copyText(`${name}\n\n${note.text.trim()}\n`);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1600);
                      }}
                    >
                      {copied ? '已复制' : '复制'}
                    </button>
                    <button className="bk-tool" onClick={() => download(historyMarkdown(note, name.slice(1, -1)), historyFileName(note, name.slice(1, -1)))}>
                      导出
                    </button>
                  </>
                )}
                <button
                  className="bk-tool"
                  data-act="book-redo"
                  disabled={!redo || busy}
                  onClick={rewrite}
                  title={busy ? '正在写别的,写完才能重写' : redo ? '按现在的历史重新写一遍(写完替换这一部)' : status?.why}
                >
                  {live ? '重试' : '重写'}
                </button>
                {note && (
                  <button
                    className={`bk-tool${armDel ? ' danger' : ''}`}
                    data-act="book-delete"
                    onBlur={() => setArmDel(false)}
                    onClick={() => {
                      if (!armDel) return setArmDel(true);
                      if (world) deleteNote(world.id, note.key);
                    }}
                  >
                    {armDel ? '再点一次删除' : '删除'}
                  </button>
                )}
              </>
            )}
          </div>
        </header>
        <div
          className="bk-r-body"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {note && status?.stale && (
            <p className="bk-stale">
              这部史书写于历史改变之前(改过名、干预过历史或改过地形),可能对不上{status.why ? `:${status.why}` : ''}。
            </p>
          )}
          {chapters.length >= 2 && !writing && (
            <nav className="bk-toc" aria-label="目录">
              {chapters.map((c) => (
                <button key={c.id} className="bk-toc-row" onClick={() => document.getElementById(c.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                  <span className="bk-toc-n">{c.who ? '列传' : c.n}</span>
                  <span className="bk-toc-t">{c.who ? c.who.join('、') : c.t}</span>
                  <span className="bk-toc-y">{c.y}</span>
                </button>
              ))}
            </nav>
          )}
          <div className="bk-text">
            {blocks}
            {writing && <span className="bk-caret" />}
            {writing && !text && <p className="bk-wait">AI 正在读材料,马上开始写……</p>}
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * 右上"改写"弹出的框(阶段 5「对话式编辑」,宽 400):作者说一句想怎么改,AI 列出修改,勾选后点"执行"。
 *
 *   空的时候     一行说明 + 三句按这个世界写的例子(点一下填进输入框)
 *   一轮对话     作者的话 → "AI 正在想"(可停止)→ AI 的一两句话 + 修改清单(年份 + 一句话 + 理由;
 *               不能执行的变淡、写原因、不能勾)+ 做不到的几句 + "执行 N 条";执行过的写"已执行 · 撤销"
 *   底部         输入框(回车发送,Shift + 回车换行)+ "发送";没设置 AI 时上面一行提示 + "设置 AI";
 *               正在重推 / 按新地形重新生成时一行"世界正在重推,好了再说"(这时发不了,提议也不能执行)
 * 执行:框收起,修改一次合进去(App 在后台重推 / 按新地形重新生成),推完提示条"已按你说的改写"带撤销(App.tsx)。
 * Esc、点框外面关上(对话留着,再打开接着说)。状态在 rewriteStore.ts,材料和核对在 ai/prompts/rewrite.ts。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { World } from '../gen/world';
import type { Civ } from '../gen/civ/types';
import { polityAlive, polityName } from '../gen/civ/growth';
import { ownersAt } from '../gen/civ/timeline';
import { useAiStatus } from '../ai/client';
import { WISH_MAX } from '../ai/prompts/rewrite';
import { openAiSettings } from './AiSettings';
import { getCivTime } from './civView';
import { useEdits } from './editsStore';
import {
  applyBlock,
  applyTurn,
  pickedChanges,
  sendWish,
  stopWish,
  syncRewriteWorld,
  toggleItem,
  undoTurn,
  useRewrite,
  type RwTurn,
  type WorldNow,
} from './rewriteStore';
import './rewrite.css';

const TERRAIN_OPS = ['volcano', 'lake', 'range', 'raise', 'sink'];

/** 没发出去的话(框关了再打开还在) */
let draft = '';

export function RewriteBox({
  world,
  civ,
  busy = false,
  onClose,
  anchor,
}: {
  world: World;
  civ: Civ;
  /** 正在重推 / 按新地形重新生成(界面上的 civ 还是旧的) */
  busy?: boolean;
  onClose: () => void;
  anchor?: React.RefObject<HTMLElement>;
}) {
  const st = useRewrite();
  const ai = useAiStatus();
  useEdits();
  const [text, setText] = useState(draft);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  // 换了世界(比如框开着时粘贴了别的世界的分享链接):对话清空
  useEffect(() => syncRewriteWorld(), [world, civ]);
  useEffect(() => {
    draft = text;
  }, [text]);

  useEffect(() => {
    input.current?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      // 弹出的 AI 设置窗口挂在 body 下,点它不关
      if (!t || box.current?.contains(t) || anchor?.current?.contains(t) || (t instanceof Element && t.closest('.ai-dialog'))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.ai-dialog')) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, anchor]);

  // 新的一轮 / 结果回来:滚到底
  const last = st.turns[st.turns.length - 1];
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [st.turns.length, last?.status]);

  const thinking = last?.status === 'thinking';
  const send = () => {
    const w = text.trim();
    if (!w || thinking || !ai.ready || busy) return;
    setText('');
    void sendWish({ world, civ, year: getCivTime().year ?? civ.endYear }, w);
  };
  const examples = useMemo(() => exampleWishes(civ, Math.floor(getCivTime().year ?? civ.endYear)), [civ]);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <div ref={box} className="rw-box" role="dialog" aria-label="改写" onPointerDown={stop} onWheel={stop} onDoubleClick={stop}>
      <div className="rw-log" ref={log}>
        {!st.turns.length && (
          <div className="rw-empty">
            <div className="rw-hint">用一句话说想怎么改这个世界:AI 把它翻成命令、改名或改地形,列出来给你勾选,点了执行才改。</div>
            <div className="rw-examples">
              {examples.map((x) => (
                <button key={x} className="rw-example" onClick={() => (setText(x), input.current?.focus())}>
                  {x}
                </button>
              ))}
            </div>
          </div>
        )}
        {st.turns.map((t) => (
          <Turn key={t.id} t={t} latest={t === last} now={{ civ, busy }} onApplied={onClose} onRetry={() => setText(t.wish)} />
        ))}
      </div>
      {ai.ready && busy && <div className="rw-unset">世界正在重推,好了再说</div>}
      {!ai.ready && (
        <div className="rw-unset">
          <span>{ai.reason ?? '还没有设置 AI'}</span>
          <button className="rw-link" onClick={() => openAiSettings()}>
            设置 AI
          </button>
        </div>
      )}
      <div className="rw-input">
        <textarea
          ref={input}
          value={text}
          rows={2}
          maxLength={WISH_MAX}
          placeholder={examples[0] ? `比如:${examples[0]}` : '想怎么改这个世界'}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="rw-send" data-act="rw-send" disabled={!text.trim() || thinking || !ai.ready || busy} onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
}

function Turn({ t, latest, now, onApplied, onRetry }: { t: RwTurn; latest: boolean; now: WorldNow; onApplied: () => void; onRetry: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const off = new Set(t.off ?? []);
  const n = pickedChanges(t).length;
  const block = t.status === 'done' && !t.applied ? applyBlock(t, now) : '';
  const terrain = (t.items ?? []).some((x, i) => x.change?.kind === 'terrain' && !off.has(i));
  const mixed = terrain && (t.items ?? []).some((x, i) => x.change?.kind === 'intervention' && !off.has(i));
  return (
    <div className="rw-turn" data-turn={t.id}>
      <div className="rw-wish">{t.wish}</div>
      {t.status === 'thinking' && (
        <div className="rw-wait">
          <span className="rw-dots">AI 正在想</span>
          <button className="rw-link" onClick={stopWish}>
            停止
          </button>
        </div>
      )}
      {t.status === 'error' && (
        <div className="rw-err">
          <span>{t.error?.message}</span>
          {t.error?.code === 'not-configured' ? (
            <button className="rw-link" onClick={() => openAiSettings()}>
              设置 AI
            </button>
          ) : (
            latest && (
              <button className="rw-link" onClick={onRetry}>
                重新说
              </button>
            )
          )}
        </div>
      )}
      {t.status === 'done' && (
        <div className="rw-ans">
          {t.reply && <p className="rw-reply">{t.reply}</p>}
          {!!t.items?.length && (
            <ul className="rw-items">
              {t.items.map((x, i) => {
                const ok = !!x.change;
                const on = ok && !off.has(i);
                return (
                  <li key={i} className={`rw-item${ok ? '' : ' bad'}${on ? '' : ' off'}`}>
                    <button
                      className="rw-check"
                      role="checkbox"
                      aria-checked={on}
                      disabled={!ok || !!t.applied}
                      onClick={() => toggleItem(t.id, i)}
                      title={ok ? (on ? '不要这一条' : '要这一条') : '这一条不能执行'}
                    >
                      <i aria-hidden="true" />
                    </button>
                    <span className="rw-year">{x.year !== undefined ? x.year : TERRAIN_OPS.includes(x.op) ? '地形' : x.op === 'rename' ? '改名' : '—'}</span>
                    <span className="rw-what">
                      <span className="rw-text">{x.text}</span>
                      {(x.problem || x.why) && <span className="rw-why">{x.problem ? `不能执行:${x.problem}` : x.why}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {t.cannot?.map((c, i) => (
            <div key={i} className="rw-cannot">
              {c}
            </div>
          ))}
          {terrain && !t.applied && (
            <div className="rw-note">
              {mixed
                ? '同时有改地形和历史命令:地形一改,三千年历史整个重来,这些命令多半对不上。建议先只执行改地形,再接着说历史那部分'
                : '含改地形:整个世界会按新地形重新生成,三千年历史整个重来(命令和改名尽量保留)'}
            </div>
          )}
          {t.applied ? (
            <div className="rw-acts">
              <span className="rw-done">{t.applied.undone ? '已撤销' : '已执行'}</span>
              {!t.applied.undone && (
                <button className="rw-link" data-act="rw-undo-turn" onClick={() => undoTurn(t.id)}>
                  撤销
                </button>
              )}
            </div>
          ) : (
            !!t.items?.some((x) => x.change) && (
              <div className="rw-acts">
                <button
                  className="rw-go"
                  data-act="rw-apply"
                  disabled={block !== null}
                  onClick={() => {
                    const why = applyTurn(t.id, now);
                    setMsg(why);
                    if (!why) onApplied();
                  }}
                >
                  执行{n ? ` ${n} 条` : ''}
                </button>
                {(msg || (block && latest)) && <span className="rw-block">{msg || block}</span>}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** 空的时候给的三句例子(用这个世界里的名字;时间轴在最后一百年时,结盟、不再扩张按历史的三分之二处举例) */
function exampleWishes(civ: Civ, year: number): string[] {
  if (!civ.viable || !civ.polities.length) return ['在赤道的海上放一座火山岛'];
  const y = Math.min(civ.endYear, Math.max(0, year));
  const at = y <= civ.endYear - 100 ? Math.floor(y) : Math.floor((civ.endYear * 2) / 300) * 100;
  const P = civ.polities;
  const own = ownersAt(civ, at).polity;
  const size = new Map<number, number>();
  for (const o of own) if (o >= 0) size.set(o, (size.get(o) ?? 0) + 1);
  const alive = P.filter((p) => polityAlive(p, at) && (size.get(p.id) ?? 0) > 0).sort((a, b) => (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0));
  const short = (p: (typeof P)[number]) => polityName(p, at) || p.name;
  const out: string[] = [];
  // 亡了的国家里国祚最长的:多撑三百年(用国名本身,不带亡国时的国号)
  const fallen = P.filter((p) => p.ended !== undefined && p.name).sort((a, b) => b.ended! - b.founded - (a.ended! - a.founded) || a.id - b.id)[0];
  if (fallen) out.push(`让${fallen.name}多撑三百年`);
  if (alive.length >= 2) out.push(`让${short(alive[0])}和${short(alive[1])}结盟`);
  if (alive[0]) out.push(`${short(alive[0])}从第 ${at} 年起不再扩张`);
  const range = civ.places.find((p) => p.kind === 'mountains');
  if (out.length < 3 && range) out.push(`把${range.name}再拉长一些`);
  return out.slice(0, 3);
}

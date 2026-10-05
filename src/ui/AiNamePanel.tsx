/**
 * 详情面板里的"AI 释名 / AI 起名"(阶段 5「AI 叙事」)。国家、城、山河湖海岛漠、民族、州的名字下面两个入口:
 *
 * - **释名**:让 AI 结合名字本身、语感、地理、历史写一段 100–250 字的"名字由来",边写边显示(可停止);
 *   写完存在本地(src/ai/library.ts,按世界、kind = "释名"、键 = "释名:" + 稳定键),再选中这个东西直接显示(可"重写""复制");
 *   名字被改过 / 历史被改写过(干预、改地形)之后标"写于改名前""写于历史改写前"
 * - **起名**:按当地民族的语感、这个东西的种类和特点起 5 个候选名(每个附一句含义;可以加一句要求);
 *   点一个预览(国家看国号怎么变),"就用这个"才改名 —— 走和手动改名一样的 setName(稳定键, 新名字)
 * - 只经过 aiChat() 调 AI;没设置 AI / 失败 / 取消都给中文提示,没设置的带"去设置 AI"按钮
 * - 测试用假 AI(网址 ai=mock)起名时给 5 个占位候选,好检查界面和流程
 *
 * 用法:`const ai = useAiName({ civ, raw, raster, target })`,ai.panel(释名 / 起名的内容)放在面板下面。
 * 四种面板(国家、城、地理实体、州)都不用 ai.bar(两个 ✦ 小按钮):底部的"名字由来"调 ai.ask(),改名时的"AI 起名"调 ai.suggest(),
 * 地理实体面板底部的"起名"调 ai.suggestNow()(打开并马上起一批);州面板里民族那一行的"族名由来""起族名"同理(what = "族名")。
 * 给了 lazy,写好的释名要点过"名字由来"才显示(先"生成中…"再出结果)。材料、提示词、解析都在 src/ai/prompts/names.ts。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import { aiChat, getProvider, useAiOn } from '../ai/client';
import { openAiSettings } from './AiSettings';
import { AiError, type AiErrorCode, type AiProviderKind } from '../ai/types';
import { getNote, putNote, useNotesVersion, type AiNote } from '../ai/library';
import {
  cleanExplanation,
  defaultName,
  explainNoteKey,
  explainRequest,
  isMockReply,
  mockSuggestions,
  nameInfo,
  nameMaterial,
  nameStamp,
  parseSuggestions,
  suggestRequest,
  suggestionEdit,
  suggestionPreview,
  takenNames,
  type NameTarget,
  type Suggestion,
} from '../ai/prompts/names';
import { setName } from './editsStore';
import { currentWorld } from './saveStore';
import { AiTag } from './aiTag';

/** 存下的释名:AiNote 再记上写的时候的名字、叫法和历史指纹(过时检查用) */
interface NameNote extends AiNote {
  name?: string;
  shown?: string;
  stamp?: string;
}

interface Err {
  code: AiErrorCode;
  message: string;
}

function toErr(e: unknown): Err {
  if (e instanceof AiError) return { code: e.code, message: e.message };
  return { code: 'other', message: `出错了:${e instanceof Error ? e.message : String(e)}` };
}

interface State {
  key: string;
  /** 点过"名字由来"(lazy 时释名框只在这之后显示) */
  asked: boolean;
  // 释名
  writing: boolean;
  live: string;
  explainErr: Err | null;
  expanded: boolean;
  copied: boolean;
  // 起名
  suggestOpen: boolean;
  wish: string;
  asking: boolean;
  list: Suggestion[];
  suggestErr: Err | null;
  /** 点开预览的是第几个(−1 = 没有) */
  picked: number;
  /** 刚改成的名字 */
  applied: string;
  /** 这一批是测试用假 AI 的占位候选 */
  mock: boolean;
}

const fresh = (key: string): State => ({
  key,
  asked: false,
  writing: false,
  live: '',
  explainErr: null,
  expanded: false,
  copied: false,
  suggestOpen: false,
  wish: '',
  asking: false,
  list: [],
  suggestErr: null,
  picked: -1,
  applied: '',
  mock: false,
});

/** 存释名用的世界编号(saveStore 的;还没挂上世界时按种子) */
function worldId(civ: Civ): string {
  return currentWorld()?.id ?? `seed-${civ.seed}`;
}

function providerLabel(kind: string, model: string): string {
  const p = getProvider(kind as AiProviderKind);
  const label = p?.label ?? kind;
  return model && model !== kind && !label.includes(model) ? `${label} ${model}` : label;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 错误 / 取消的一行提示(没设置 AI:"还没有设置 AI · 设置 AI";被审核拦下:一句平常话,原文放在悬停提示里) */
function ErrLine({ err, retry }: { err: Err; retry: () => void }) {
  const aborted = err.code === 'aborted';
  const unset = err.code === 'not-configured';
  const filtered = err.code === 'content-filter';
  const text = aborted ? '已取消' : unset ? '还没有设置 AI' : filtered ? '内容被 AI 服务商的审核拦下了,可以再试一次' : err.message;
  return (
    <div className={`ain-err${aborted ? ' soft' : ''}${unset || filtered ? ' unset' : ''}`} title={unset || filtered ? err.message : undefined}>
      <span>{text}</span>
      {unset ? (
        <button className="ain-link" onClick={() => openAiSettings()}>
          设置 AI
        </button>
      ) : (
        <button onClick={retry}>{aborted ? '重新开始' : '重试'}</button>
      )}
    </div>
  );
}

export interface AiNameProps {
  /** 套上改名的 Civ(界面上显示的那一份) */
  civ: Civ;
  /** 没套改名的 Civ(判断"和生成时的名字一样 = 恢复默认"用) */
  raw: Civ;
  raster: Raster | null;
  /** 释 / 起哪个名字;null = 不显示 */
  target: NameTarget | null;
  /** 小号按钮(民族那一行里用) */
  compact?: boolean;
  /** 写好的释名要点过"名字由来"(ask)才显示(国家面板) */
  lazy?: boolean;
  /** 框上的叫法:"族名" → "族名由来""AI 起族名"(不给 = "名字由来""AI 起名");由来那一段标"AI 写" */
  what?: string;
}

export interface AiName {
  /** ✦ 释名 / ✦ 起名 两个按钮 */
  bar: ReactNode;
  /** 释名 / 起名的内容 */
  panel: ReactNode;
  /** "名字由来":没写过 = 让 AI 写;写过 = 显示 / 收起 */
  ask: () => void;
  /** 打开 / 收起"AI 起名" */
  suggest: () => void;
  /** 打开"AI 起名"并马上起一批(地理实体面板底部的"起名") */
  suggestNow: () => void;
  /** 正在写释名 / 正在起名 */
  busy: boolean;
}

export function useAiName({ civ, raw, raster, target, compact, lazy, what }: AiNameProps): AiName {
  useNotesVersion();
  const on = useAiOn();
  const info = target ? nameInfo(civ, target) : null;
  const key = info?.key ?? '';
  const [st, setSt] = useState<State>(() => fresh(key));
  const ctl = useRef<AbortController | null>(null);
  // 选中别的东西(或卸载):停掉进行中的调用
  useEffect(() => () => ctl.current?.abort(), [key]);
  // 「使用 AI 功能」关了:停掉进行中的调用(写过的名字由来留着,只是不显示)
  useEffect(() => {
    if (!on) ctl.current?.abort();
  }, [on]);
  // 换了对象:状态从头来
  const s = st.key === key ? st : fresh(key);
  if (st.key !== key) setSt(s);
  const patch = (k: string, p: Partial<State>) => setSt((prev) => (prev.key === k ? { ...prev, ...p } : prev));

  if (!on || !info || !target) return { bar: null, panel: null, ask: () => {}, suggest: () => {}, suggestNow: () => {}, busy: false };
  const world = worldId(civ);
  const note = getNote(world, explainNoteKey(key)) as NameNote | undefined;
  const renamed = !!note && typeof note.name === 'string' && note.name !== info.name;
  const rewritten = !!note && typeof note.stamp === 'string' && note.stamp !== nameStamp(civ, target);

  const start = () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    return c;
  };
  const stop = () => ctl.current?.abort();

  const explain = async () => {
    const k = key;
    const c = start();
    patch(k, { writing: true, live: '', explainErr: null, expanded: true, copied: false, asked: true });
    try {
      const m = nameMaterial(civ, target, raster);
      if (!m) throw new AiError('other', '找不到这个名字了');
      const r = await aiChat(explainRequest(m), { signal: c.signal, onDelta: (_, full) => patch(k, { live: full }) });
      const text = cleanExplanation(r.text);
      if (!text) throw new AiError('bad-response', 'AI 没有写出内容,再试一次');
      const saved: NameNote = {
        key: explainNoteKey(k),
        kind: '释名',
        title: `${m.info.shown} · ${m.info.kindLabel}`,
        text,
        createdAt: new Date().toISOString(),
        provider: r.provider,
        model: r.model,
        name: m.info.name,
        shown: m.info.shown,
        stamp: m.stamp,
      };
      putNote(world, saved);
      patch(k, { writing: false, live: '' });
    } catch (e) {
      patch(k, { writing: false, live: '', explainErr: toErr(e) });
    } finally {
      if (ctl.current === c) ctl.current = null;
    }
  };

  const suggest = async () => {
    const k = key;
    const c = start();
    patch(k, { asking: true, suggestErr: null, picked: -1, applied: '', mock: false });
    try {
      const m = nameMaterial(civ, target, raster);
      if (!m) throw new AiError('other', '找不到这个名字了');
      const r = await aiChat(suggestRequest(m, s.wish), { signal: c.signal });
      let list: Suggestion[];
      const mock = r.provider === 'mock' && isMockReply(r.text);
      if (mock) list = mockSuggestions(civ, target, m.info);
      else {
        const p = parseSuggestions(r.text, m.info, takenNames(civ, target));
        if (!p.ok) throw new AiError('bad-response', p.message);
        list = p.list;
      }
      patch(k, { asking: false, list, mock });
    } catch (e) {
      patch(k, { asking: false, suggestErr: toErr(e) });
    } finally {
      if (ctl.current === c) ctl.current = null;
    }
  };

  const apply = (c: Suggestion) => {
    const fallback = defaultName(raw, target, info);
    const e = suggestionEdit(info, c.name, fallback);
    setName(e.key, e.value, 'ai', fallback);
    patch(key, { picked: -1, applied: c.name });
  };

  const copy = () => {
    if (!note) return;
    navigator.clipboard?.writeText(note.text).then(
      () => {
        patch(key, { copied: true });
        setTimeout(() => patch(key, { copied: false }), 1500);
      },
      () => {},
    );
  };

  const busy = s.writing || s.asking;
  const bar = (
    <div className={`ain-bar${compact ? ' compact' : ''}`}>
      {info.name && (
        <button
          className={`ain-btn${s.writing ? ' on' : ''}`}
          data-ain="explain"
          disabled={busy}
          onClick={() => (note ? patch(key, { expanded: !s.expanded }) : explain())}
          title={note ? '看 AI 写的名字由来' : '让 AI 讲讲这个名字的含义和由来'}
        >
          ✦ 释名
        </button>
      )}
      <button
        className={`ain-btn${s.suggestOpen ? ' on' : ''}`}
        data-ain="suggest"
        onClick={() => patch(key, { suggestOpen: !s.suggestOpen, picked: -1 })}
        title={`让 AI 按${info.style ? info.style.label : '当地'}的语感起几个新名字`}
      >
        ✦ 起名
      </button>
    </div>
  );

  const explainBox =
    s.writing || s.explainErr || (note && (!lazy || s.asked)) ? (
      <div className={`ain-box ain-note${s.writing ? ' writing' : ''}`}>
        <div className="ain-head">
          <span className="ain-title">
            {what ? `${what}由来` : '名字由来'}
            <AiTag />
          </span>
          {s.writing ? (
            <span className="ain-status">AI 正在写…</span>
          ) : (
            note && (
              <>
                {renamed && (
                  <span className="ain-stale" title="名字改过以后还没重写">
                    写于改名前{note.shown ? `(当时叫「${note.shown}」)` : ''}
                  </span>
                )}
                {rewritten && (
                  <span className="ain-stale" title="之后历史被改写过(干预 / 改地形),里面的年份、事件可能对不上了">
                    写于历史改写前
                  </span>
                )}
              </>
            )
          )}
        </div>
        {s.writing ? (
          <p className="ain-text">
            {s.live || <span className="ain-wait-text">生成中…</span>}
            {s.live && <span className="ain-caret" />}
          </p>
        ) : note ? (
          <p
            className={`ain-text${s.expanded ? '' : ' clamp'}`}
            onClick={() => !s.expanded && patch(key, { expanded: true })}
            title={s.expanded ? undefined : '点一下看全文'}
          >
            {cleanExplanation(note.text)}
          </p>
        ) : null}
        {s.explainErr && <ErrLine err={s.explainErr} retry={explain} />}
        {(s.writing || note) && (
          <div className="ain-actions">
            {s.writing ? (
              <button onClick={stop}>停止</button>
            ) : (
              note && (
                <>
                  <button onClick={explain} disabled={busy}>
                    重写
                  </button>
                  <button onClick={copy}>{s.copied ? '已复制' : '复制'}</button>
                  <button onClick={() => patch(key, { expanded: !s.expanded })}>{s.expanded ? '收起' : '展开'}</button>
                  <span className="ain-by">
                    {providerLabel(note.provider, note.model)}
                    {dateLabel(note.createdAt) && `，${dateLabel(note.createdAt)}`}
                  </span>
                </>
              )
            )}
          </div>
        )}
      </div>
    ) : null;

  const closeSuggest = () => {
    if (s.asking) stop();
    patch(key, { suggestOpen: false, picked: -1 });
  };
  const suggestBox = s.suggestOpen ? (
    <div className="ain-box ain-suggest">
      <div className="ain-head">
        <span className="ain-title">✦ AI 起{what ?? '名'}</span>
        {info.style && <span className="ain-status">按{info.style.label}的语感</span>}
        <button className="ain-x" onClick={closeSuggest} title="收起">
          ✕
        </button>
      </div>
      {s.applied && <div className="ain-done">已改名为「{s.applied}」;想改回去,点名字旁的"恢复默认"</div>}
      {!s.list.length && !s.asking && !s.suggestErr && (
        <div className="ain-hint">按当地民族的语感、这个{info.kindLabel}的地理和历史起 5 个名字;点一个先预览,确定了才改名。</div>
      )}
      <div className="ain-wish">
        <input
          value={s.wish}
          maxLength={60}
          spellCheck={false}
          placeholder='加一句要求(可不填),如"要带水字旁"'
          disabled={s.asking}
          onChange={(e) => patch(key, { wish: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') suggest();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              closeSuggest();
            }
          }}
        />
        <button className="ain-go" onClick={suggest} disabled={busy}>
          {s.list.length ? '换一批' : '起 5 个'}
        </button>
      </div>
      {s.asking && (
        <div className="ain-wait">
          <span className="ain-dots">AI 正在起名</span>
          <button onClick={stop}>取消</button>
        </div>
      )}
      {s.suggestErr && <ErrLine err={s.suggestErr} retry={suggest} />}
      {s.list.length > 0 && !s.asking && (
        <div className="ain-cands">
          {s.list.map((c, i) => {
            const now = c.name === info.name;
            const on = s.picked === i;
            return (
              <div key={c.name} className={`ain-cand${on ? ' on' : ''}${now ? ' now' : ''}`}>
                <button className="ain-cand-btn" disabled={now} onClick={() => patch(key, { picked: on ? -1 : i, applied: '' })}>
                  <span className="ain-cand-name">{c.name}</span>
                  {c.latin && <span className="ain-latin">{c.latin}</span>}
                  {now && <span className="ain-cand-now">现在的名字</span>}
                  {c.meaning && <span className="ain-cand-mean">{c.meaning}</span>}
                </button>
                {on && (
                  <div className="ain-confirm">
                    <div className="ain-preview">
                      {target.kind === 'polity' ? `国号:${suggestionPreview(civ, target, info, c.name)}` : `${info.shown} → ${suggestionPreview(civ, target, info, c.name)}`}
                    </div>
                    <button className="ain-ok" onClick={() => apply(c)}>
                      就用这个
                    </button>
                    <button onClick={() => patch(key, { picked: -1 })}>再看看</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {s.mock && s.list.length > 0 && <div className="ain-hint">测试用假 AI:这几个是占位候选,不代表真实效果</div>}
    </div>
  ) : null;

  return {
    bar,
    panel:
      explainBox || suggestBox ? (
        <>
          {explainBox}
          {suggestBox}
        </>
      ) : null,
    ask: () => {
      if (s.writing) return;
      if (note && !s.explainErr) patch(key, { asked: !s.asked, expanded: true });
      else explain();
    },
    suggest: () => patch(key, { suggestOpen: !s.suggestOpen, picked: -1 }),
    suggestNow: () => {
      patch(key, { suggestOpen: true, picked: -1 });
      if (!busy) suggest();
    },
    busy,
  };
}

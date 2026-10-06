/**
 * 作者的人物的卡片(和推演人物、作者标记的卡片同一套样子,零件见 panelParts.tsx;数据格式见 gen/characters.ts 文件头):
 * 世界概览「人物」页的「我的」、搜索、地图上的头像、别的卡片里「作者的人物」打开;新建、编辑也在这张卡片里填(characterStore.ts 的 draft)。
 *
 * 看的时候
 *   顶部  圆形头像(名字的第一个字)、名字、"作者的人物，2490–2561 年"
 *   按钮  出生那年(主操作:时间轴跳到生年)/ 编辑 / 复制生平 / 更多(设为中心、删除人物;删了提示条上能撤销)
 *   简介  作者写的那几句
 *   概况  年龄(跟时间轴:"22 岁"、"还没出生"、"已故，享年 71 岁")、身份、国家(那年在位的君主)、出生地、亲友
 *   一生  经历按先后,每条下面写那年几岁、在哪、勾上的推演里的事;时间轴那一年画一条"现在"线,以后的变淡;点一条跳到那一年
 *   这些年身边的事  他在世那些年他的国家的事、换君主、他去过的州的事(当前那年前后最多 8 条),后面「在编年史中查看」
 *
 * 填的时候(新建、编辑)
 *   名字输入框、生卒(各带"用第 N 年")、出生地(点地图挑,「换一处」「去掉」)、国家(默认跟着出生地)、身份、颜色、简介、
 *   一生(一行一段,点了改;「加一段经历」)、亲友(点了改;「加亲友」)、底部 取消 / 完成
 *   加一段经历:年份(算好几岁)、经历、在哪(点地图;「去掉」清掉)、勾推演里那几年那一处的事和人;底部 取消 / 加上
 *   加亲友:关系(随便写)、是谁(自己的人物或推演里的人,能搜);底部 取消 / 加上
 */
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { polityName } from '../gen/civ/growth';
import { regionLabel } from '../gen/civ/display';
import { personName } from '../gen/civ/peopleText';
import { rulerAt } from '../gen/civ/peopleInfo';
import { MARK_COLORS, polityKey, type MarkColor } from '../gen/edits';
import {
  CHARACTERS_MAX,
  CHAR_NAME_DEFAULT,
  CHAR_NAME_MAX,
  CHAR_NOTE_MAX,
  CHAR_ROLE_MAX,
  KIN_REL_MAX,
  LIFE_TEXT_MAX,
  characterAge,
  lifeInOrder,
  lifeStops,
  personKey,
  resolvePersonKey,
  type AuthorCharacter,
} from '../gen/characters';
import { MARK_HEX } from '../render/marks';
import { getEdits, removeCharacter, restoreCharacter, useEdits } from './editsStore';
import { clearSelection, pickChronicleEntry, setSelection, type MapSelection } from './civView';
import {
  cancelDraft,
  cancelSub,
  draftAsCharacter,
  draftProblem,
  editCharacterDraft,
  escapeCharacter,
  finishDraft,
  finishKin,
  finishLife,
  kinProblem,
  lifeProblem,
  parseYear,
  patchDraft,
  patchKin,
  patchLife,
  pickKin,
  removeKin,
  removeLife,
  startKin,
  startLife,
  startPicking,
  stopPicking,
  toggleLifeLink,
  useCharUi,
  type CharDraft,
  type KinDraft,
  type LifeDraft,
} from './characterStore';
import {
  aroundEvents,
  birthPolity,
  characterCopyText,
  characterPolity,
  eventOfKey,
  eventShort,
  kinList,
  lifeEventChoices,
  lifePeopleChoices,
  lifeYears,
  personChip,
  placeOf,
  regionOwner,
  windowAround,
  type CharPlace,
  type CharRef,
} from './characterInfo';
import { pointsFocus } from './flyTo';
import { requestMapCenter } from './mapWrap';
import { openOverview } from './overviewStore';
import { clearToast, showToast } from './toastStore';
import { evLabel, evText, evType } from './timelineLayout';
import { Act, Acts, EntryText, Link, MoreAct, PanelHead, Row, Stats, SubLine, copyText, jumpTo } from './panelParts';
import { MenuItem } from './PopMenu';
import { Icon } from './icons';
import './characters.css';

const F = Math.floor;

/** 颜色的名字(颜色圆点的读屏文字) */
const COLOR_NAME: Record<MarkColor, string> = { red: '红', orange: '橙', green: '绿', blue: '蓝', purple: '紫', teal: '青' };
/** 「这些年身边的事」最多几条 */
const AROUND_MAX = 8;
/** 加亲友时最多列几个人 */
const KIN_LIST_MAX = 12;

/** 圆形头像:名字的第一个字 + 人物的颜色(不传图片) */
export function CharAvatar({ c, size }: { c: Pick<AuthorCharacter, 'name' | 'color'>; size: number }) {
  return (
    <span className="oc-av" style={{ '--s': `${size}px`, background: MARK_HEX[c.color] } as CSSProperties} aria-hidden="true">
      {[...(c.name.trim() || CHAR_NAME_DEFAULT)][0]}
    </span>
  );
}

export interface CharacterPanelProps {
  civ: Civ;
  raster: Raster | null;
  world: World;
  /** 人物编号(新建还没存 = 0) */
  id: number;
  year: number;
}

export function CharacterPanel(props: CharacterPanelProps) {
  const ui = useCharUi();
  const edits = useEdits();
  const draft = ui.draft && ui.draft.id === props.id ? ui.draft : null;
  if (draft) {
    if (draft.sub?.kind === 'life') return <LifeCard {...props} draft={draft} l={draft.sub.d} picking={ui.picking === 'life'} />;
    if (draft.sub?.kind === 'kin') return <KinCard {...props} draft={draft} k={draft.sub.d} />;
    return <CharEdit {...props} draft={draft} picking={ui.picking === 'birth'} />;
  }
  const c = edits.characters?.find((x) => x.id === props.id);
  return c ? <CharView {...props} c={c} chars={edits.characters ?? []} /> : null;
}

/** 卡片上 Esc:先停下挑地方,再关小表,再取消正在填的 */
const onEsc = (e: React.KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  escapeCharacter();
};

/** 一个地方(能点的):城 → 城卡片,州 → 州卡片;一个点、找不到的 = 字 */
function PlaceLink({ pl, span }: { pl: CharPlace; span?: boolean }) {
  const to: MapSelection | null = pl.missing ? null : pl.kind === 'city' && pl.city !== undefined ? { kind: 'settlement', id: pl.city } : pl.kind === 'region' && pl.region !== undefined ? { kind: 'region', id: pl.region } : null;
  if (!to) return <>{pl.name}</>;
  if (!span) return <Link to={to}>{pl.name}</Link>;
  // 整行是按钮时,里面的链接用 span(按钮里不能再放按钮)
  return (
    <span
      className="ins-link"
      onClick={(ev) => {
        ev.stopPropagation();
        setSelection(to);
      }}
    >
      {pl.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 看的时候

function CharView({ civ, raster, world, year, c, chars }: CharacterPanelProps & { c: AuthorCharacter; chars: readonly AuthorCharacter[] }) {
  const [copied, setCopied] = useState(false);
  const polity = useMemo(() => characterPolity(civ, world, raster, c), [civ, world, raster, c]);
  const around = useMemo(() => aroundEvents(civ, world, raster, c), [civ, world, raster, c]);
  const kin = useMemo(() => kinList(civ, c, chars), [civ, c, chars]);
  const focus = useMemo(() => {
    const pts = lifeStops(c)
      .map((s) => placeOf(civ, world, raster, s.where, s.year).at)
      .filter((p): p is [number, number] => !!p);
    return pointsFocus(world, pts);
  }, [civ, world, raster, c]);
  const age = characterAge(c, year);

  const copy = async () => {
    const text = characterCopyText(civ, world, raster, c, chars);
    (window as unknown as { __wfCharText: string }).__wfCharText = text;
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const del = () => {
    const at = (getEdits().characters ?? []).findIndex((x) => x.id === c.id);
    const gone = removeCharacter(c.id);
    if (!gone) return;
    clearSelection();
    showToast({
      id: 'oc',
      kind: 'ok',
      text: `已删除人物「${gone.name}」`,
      action: {
        label: '撤销',
        act: 'character-restore',
        onClick: () => {
          clearToast('oc');
          const id = restoreCharacter(gone, at);
          if (id > 0) setSelection({ kind: 'character', id });
          else showToast({ id: 'oc-restore', kind: 'warn', text: `作者的人物已经有 ${CHARACTERS_MAX} 个了，放不回去`, ttl: 4000 });
        },
      },
    });
  };

  // 概况
  const rows: { k: string; node: ReactNode }[] = [];
  rows.push({
    k: '年龄',
    node:
      age.state === 'unborn' ? (
        <>
          还没出生<em className="cp-num-note">{c.born} 年生</em>
        </>
      ) : age.state === 'dead' ? (
        <>
          已故<em className="cp-num-note">享年 {age.age} 岁</em>
        </>
      ) : (
        <>
          {age.age} 岁<em className="cp-num-note">第 {year} 年</em>
        </>
      ),
  });
  if (c.role) rows.push({ k: '身份', node: c.role });
  if (polity >= 0) {
    const p = civ.polities[polity];
    const y = Math.min(civ.endYear, Math.max(0, Math.max(c.born, Math.min(year, c.died ?? year))));
    const ruler = rulerAt(civ, polity, y);
    rows.push({
      k: '国家',
      node: (
        <>
          <Link to={{ kind: 'polity', id: polity }}>{polityName(p, y)}</Link>
          {ruler && <em className="cp-num-note">{personName(civ, ruler)}在位</em>}
        </>
      ),
    });
  }
  if (c.birthplace) {
    const pl = placeOf(civ, world, raster, c.birthplace, c.born);
    rows.push({
      k: '出生地',
      node: (
        <>
          <PlaceLink pl={pl} />
          {pl.kind === 'city' && pl.region !== undefined && <em className="cp-num-note">{regionLabel(civ, pl.region)}</em>}
        </>
      ),
    });
  }
  if (kin.length)
    rows.push({
      k: '亲友',
      node: kin.map((k, i) => (
        <Fragment key={i}>
          {i > 0 && '、'}
          {k.char !== undefined ? (
            <Link to={{ kind: 'character', id: k.char }}>{k.name}</Link>
          ) : k.person !== undefined ? (
            <Link to={{ kind: 'person', id: k.person }}>{k.name}</Link>
          ) : (
            k.name
          )}
          {(k.rel || k.missing) && <em className="cp-num-note">{k.missing ? `${k.rel ? `${k.rel}，` : ''}重推以后找不到了` : k.rel}</em>}
        </Fragment>
      )),
    });

  // 一生:按先后;"现在"线放在第一件还没发生的事上面
  const life = lifeInOrder(c);
  const nowLine = (key: string) => (
    <div className="oc-now" key={key} data-oc="now">
      <span>第 {year} 年</span>
    </div>
  );
  const lifeRows: ReactNode[] = [];
  let lined = false;
  for (const { e, i } of life) {
    const fut = e.year > year;
    if (fut && !lined) {
      lifeRows.push(nowLine('now'));
      lined = true;
    }
    const a = e.year - c.born;
    const pl = e.where ? placeOf(civ, world, raster, e.where, e.year) : null;
    const evs = (e.events ?? []).map((k) => ({ k, entry: eventOfKey(civ, k) }));
    lifeRows.push(
      <button key={i} className="cp-ev" style={{ '--c': MARK_HEX[c.color] } as CSSProperties} data-st={fut ? 'future' : 'past'} data-life={i} onClick={() => jumpTo(e.year)}>
        <span className="cp-ev-year">{e.year}</span>
        <span className="cp-ev-text">
          {e.text || '（没写经历）'}
          {(pl || a !== 0) && (
            <span className="oc-sub">
              {a !== 0 && `${a} 岁`}
              {a !== 0 && pl && '，'}
              {pl && <PlaceLink pl={pl} span />}
            </span>
          )}
          {evs.length > 0 && (
            <span className="oc-sub">
              推演里：
              {evs.map((v, j) => (
                <Fragment key={v.k}>
                  {j > 0 && '、'}
                  {v.entry ? (
                    <span
                      className="ins-link"
                      title={evText(v.entry)}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        pickChronicleEntry(v.entry!);
                      }}
                    >
                      {eventShort(v.entry)}
                    </span>
                  ) : (
                    '重推以后这件事没有了'
                  )}
                </Fragment>
              ))}
            </span>
          )}
        </span>
      </button>,
    );
  }

  // 这些年身边的事:当前那年前后最多 8 条
  const shown = windowAround(around, (e) => F(e.year), year, AROUND_MAX);
  const aroundRows: ReactNode[] = [];
  let lined2 = false;
  for (const e of shown) {
    const fut = F(e.year) > year;
    if (fut && !lined2) {
      aroundRows.push(nowLine('now2'));
      lined2 = true;
    }
    aroundRows.push(
      <button key={`${e.kind}:${e.id}`} className="cp-ev" data-ev={evType(e)} data-st={fut ? 'future' : 'past'} title={evLabel(e)} onClick={() => pickChronicleEntry(e)}>
        <span className="cp-ev-year">{F(e.year)}</span>
        <span className="cp-ev-text">
          <EntryText civ={civ} e={e} />
        </span>
      </button>,
    );
  }

  return (
    <div className="cp pp oc-card" data-character={c.id}>
      <PanelHead icon={<CharAvatar c={c} size={38} />}>
        <div className="ins-name-row big">
          <span className="ins-name pp-title oc-name">{c.name}</span>
        </div>
        <SubLine parts={[`作者的人物，${lifeYears(c)}`]} />
      </PanelHead>
      <Acts>
        <Act icon="history" primary act="character-year" onClick={() => jumpTo(c.born)} title={`时间轴跳到 ${c.born} 年`}>
          出生那年
        </Act>
        <Act icon="rename" act="character-edit" onClick={() => editCharacterDraft(c)}>
          编辑
        </Act>
        <Act icon="copy" act="character-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制生平'}
        </Act>
        <MoreAct>
          <MenuItem icon={<Icon name="center" size={16} />} act="set-center" disabled={!focus} onClick={() => focus && requestMapCenter(focus.lon)}>
            设为中心
          </MenuItem>
          <MenuItem icon={<Icon name="trash" size={16} />} act="character-delete" onClick={del}>
            删除人物
          </MenuItem>
        </MoreAct>
      </Acts>
      <div className="cp-body">
        {c.note && (
          <section className="cp-sec">
            <div className="cp-sec-head">简介</div>
            <div className="oc-note">{c.note}</div>
          </section>
        )}
        <Stats items={[]}>
          {rows.map((r) => (
            <Row key={r.k} k={r.k}>
              {r.node}
            </Row>
          ))}
        </Stats>
        {life.length > 0 && (
          <section className="cp-sec cp-events" data-oc="life">
            <div className="cp-sec-head cp-events-head">
              <span>一生</span>
            </div>
            <div className="cp-group">{lifeRows}</div>
          </section>
        )}
        {shown.length > 0 && (
          <section className="cp-sec cp-events" data-oc="around">
            <div className="cp-sec-head cp-events-head">
              <span>这些年身边的事</span>
              {polity >= 0 && (
                <button className="ins-link cp-more" data-act="character-chronicle" onClick={() => openOverview('chronicle', { polity, major: false, at: year })}>
                  在编年史中查看
                </button>
              )}
            </div>
            <div className="cp-group">{aroundRows}</div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 别的卡片里的「作者的人物」

/** 推演人物、城、州的卡片里:和它有关的作者人物(头像、名字、一句);点了打开那个人物 */
export function CharacterRefs({ refs }: { refs: readonly CharRef[] }) {
  if (!refs.length) return null;
  return (
    <section className="cp-sec" data-oc="refs">
      <div className="cp-sec-head">作者的人物</div>
      <div className="oc-rows oc-people">
        {refs.map((r) => (
          <button key={r.c.id} className="oc-person" data-character={r.c.id} onClick={() => setSelection({ kind: 'character', id: r.c.id })}>
            <CharAvatar c={r.c} size={26} />
            <span className="oc-txt">
              <b>{r.c.name}</b>
              <span>{r.text}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 填的时候

const digits = (s: string) => s.replace(/[^\d]/g, '').slice(0, 5);

/** 挑地方的那一格:已经有 = 名字 + 小字 +「去掉」「换一处」;正在挑 =「取消」;没有 = 一句提示 */
function PickRow({ name, note, picking, onPick, onClear, act }: { name: string | null; note?: string; picking: boolean; onPick: () => void; onClear: () => void; act: string }) {
  return (
    <div className={`oc-pick${picking ? ' picking' : ''}`} data-oc={act}>
      {name ? (
        <span className="oc-pick-name">
          {name}
          {note && <em>{note}</em>}
        </span>
      ) : (
        <span className="oc-pick-empty">{picking ? '在地图上点一处' : '还没选'}</span>
      )}
      <span className="oc-pick-acts">
        {name && !picking && (
          <button className="cp-step" data-act={`${act}-clear`} onClick={onClear}>
            去掉
          </button>
        )}
        <button className="cp-step" data-act={`${act}-pick`} onClick={picking ? stopPicking : onPick}>
          {picking ? '取消' : name ? '换一处' : '选一处'}
        </button>
      </span>
    </div>
  );
}

/** 一处地方的小字:"紫月洲，当年归大景王朝"(城)/ "当年归萨尔斯坦帝国"(州、一个点) */
function placeNote(civ: Civ, pl: CharPlace, year: number): string {
  const parts: string[] = [];
  if (pl.kind === 'city' && pl.region !== undefined) parts.push(regionLabel(civ, pl.region));
  if (pl.region !== undefined) {
    const o = regionOwner(civ, pl.region, year);
    parts.push(o >= 0 ? `当年归${polityName(civ.polities[o], Math.min(civ.endYear, Math.max(0, year)))}` : '当年无主');
  }
  return parts.join('，');
}

function CharEdit({ civ, raster, world, year, draft: d, picking }: CharacterPanelProps & { draft: CharDraft; picking: boolean }) {
  const problem = draftProblem(d);
  const nameRef = useRef<HTMLInputElement>(null);
  const chars = useEdits().characters ?? [];
  // 新建的:光标放在名字框里
  useEffect(() => {
    if (d.id === 0) nameRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const born = parseYear(d.bornText);
  const bornYear = born === null || Number.isNaN(born) ? year : born;
  const done = () => {
    if (!problem) finishDraft();
  };
  const yearRow = (k: string, key: 'bornText' | 'diedText', placeholder?: string) => (
    <div className="cp-from-row">
      <span className="mk-k">{k}</span>
      <label className="cp-year">
        <input
          value={d[key]}
          inputMode="numeric"
          aria-label={k === '生' ? '生年' : '卒年'}
          placeholder={placeholder}
          className={d[key] ? undefined : 'empty'}
          data-oc={key === 'bornText' ? 'born' : 'died'}
          onChange={(e) => patchDraft({ [key]: digits(e.target.value) })}
          onKeyDown={(e) => e.key === 'Enter' && done()}
        />
        年
      </label>
      <button className="cp-step" data-act={key === 'bornText' ? 'character-born-now' : 'character-died-now'} onClick={() => patchDraft({ [key]: String(year) })}>
        用第 {year} 年
      </button>
    </div>
  );
  const yearProblem = problem && !problem.includes('个了') ? problem : null;
  const birth = d.birthplace ? placeOf(civ, world, raster, d.birthplace, bornYear) : null;
  // 国家:默认跟着出生地(那一年归属的国家);也能挑一国
  const follow = birthPolity(civ, world, raster, { birthplace: d.birthplace ?? undefined, born: bornYear });
  const followName = follow >= 0 ? polityName(civ.polities[follow], Math.min(civ.endYear, Math.max(0, bornYear))) : d.birthplace ? '出生地那年无主' : '跟着出生地';
  const options = useMemo(() => {
    const y = Math.min(civ.endYear, Math.max(0, bornYear));
    const out = civ.polities.filter((p) => p.founded <= y && (p.ended === undefined || p.ended > y)).map((p) => ({ key: polityKey(civ, p.id), name: polityName(p, y) }));
    if (d.polity && !out.some((o) => o.key === d.polity)) {
      const self = characterPolity(civ, world, raster, { polity: d.polity, born: bornYear });
      out.unshift({ key: d.polity, name: self >= 0 ? polityName(civ.polities[self], Math.max(civ.polities[self].founded, Math.min(y, (civ.polities[self].ended ?? Infinity) - 1 / 512))) : '找不到了' });
    }
    return out;
  }, [civ, world, raster, bornYear, d.polity]);
  const life = lifeInOrder({ life: d.life });

  return (
    <div className="cp pp mk-card mk-editing oc-card oc-editing" data-character={d.id} onKeyDown={onEsc}>
      <PanelHead icon={<CharAvatar c={d} size={38} />}>
        <div className="ins-edit big">
          <input
            ref={nameRef}
            value={d.name}
            maxLength={CHAR_NAME_MAX}
            placeholder={CHAR_NAME_DEFAULT}
            aria-label="人物的名字"
            data-oc="name"
            onChange={(e) => patchDraft({ name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && done()}
          />
        </div>
        <SubLine parts={['作者的人物']} />
      </PanelHead>
      <div className="cp-body">
        <section className="cp-sec">
          <div className="cp-sec-head">生卒</div>
          <div className="cp-from mk-yrs">
            {yearRow('生', 'bornText')}
            {yearRow('卒', 'diedText', '还活着')}
            <div className={`cp-note${yearProblem ? ' mk-warn' : ''}`}>{yearProblem ?? '年龄跟着时间轴算。卒年不填就是一直活着。'}</div>
          </div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">出生地</div>
          <PickRow name={birth?.name ?? null} note={birth && !birth.missing ? placeNote(civ, birth, bornYear) : undefined} picking={picking} onPick={() => startPicking('birth')} onClear={() => patchDraft({ birthplace: null })} act="character-birth" />
          <div className="cp-note">点地图上的城，或者任意一处。不填也行。</div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">国家</div>
          <label className="oc-pick oc-select-wrap">
            <select className="oc-select" value={d.polity ?? ''} aria-label="国家" data-oc="polity" onChange={(e) => patchDraft({ polity: e.target.value || null })}>
              <option value="">{followName}</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                </option>
              ))}
            </select>
            <Icon name="down" size={14} />
          </label>
          <div className="cp-note">默认是出生地那一年归属的国家。</div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">身份</div>
          <input className="oc-field" value={d.role} maxLength={CHAR_ROLE_MAX} placeholder="比如：剑客、商人、书记官" aria-label="身份" data-oc="role" onChange={(e) => patchDraft({ role: e.target.value })} />
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">颜色</div>
          <div className="mk-colors" role="radiogroup" aria-label="颜色">
            {MARK_COLORS.map((col) => (
              <button
                key={col}
                className={col === d.color ? 'on' : undefined}
                style={{ background: MARK_HEX[col] }}
                role="radio"
                aria-checked={col === d.color}
                aria-label={COLOR_NAME[col]}
                data-color={col}
                onClick={() => patchDraft({ color: col })}
              />
            ))}
          </div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">简介</div>
          <textarea className="mk-text" rows={4} value={d.note} maxLength={CHAR_NOTE_MAX} aria-label="简介" data-oc="note" onChange={(e) => patchDraft({ note: e.target.value })} />
        </section>
        <section className="cp-sec" data-oc="life-list">
          <div className="cp-sec-head">一生</div>
          {life.length > 0 && (
            <div className="oc-rows">
              {life.map(({ e, i }) => (
                <button key={i} className="oc-row" data-life={i} onClick={() => startLife(i, year)}>
                  <span className="y">{e.year}</span>
                  <span className="t">{e.text}</span>
                  <span className="w">{e.where ? placeOf(civ, world, raster, e.where, e.year).name : ''}</span>
                </button>
              ))}
            </div>
          )}
          <button className="oc-add" data-act="character-add-life" onClick={() => startLife(-1, year)}>
            <Icon name="plus" size={15} />
            加一段经历
          </button>
        </section>
        <section className="cp-sec" data-oc="kin-list">
          <div className="cp-sec-head">亲友</div>
          {d.kin.length > 0 && (
            <div className="oc-rows">
              {d.kin.map((k, i) => {
                const name = k.char !== undefined ? (chars.find((x) => x.id === k.char)?.name ?? '已删除的人物') : kinPersonName(civ, k.person!);
                return (
                  <button key={i} className="oc-row" data-kin={i} onClick={() => startKin(i)}>
                    <span className="y">{k.rel}</span>
                    <span className="t">{name}</span>
                    <span className="w">{k.char !== undefined ? '我的人物' : '推演里的人'}</span>
                  </button>
                );
              })}
            </div>
          )}
          <button className="oc-add" data-act="character-add-kin" onClick={() => startKin(-1)}>
            <Icon name="plus" size={15} />
            加亲友
          </button>
          <div className="cp-note">可以选自己的人物，也可以选推演里的君主、将领。关系随便写。</div>
        </section>
      </div>
      <div className="cp-foot mk-foot">
        <button className="cp-btn" data-act="character-cancel" onClick={cancelDraft}>
          取消
        </button>
        <button className="cp-btn primary" data-act="character-done" disabled={!!problem} title={problem ?? undefined} onClick={done}>
          完成
        </button>
      </div>
    </div>
  );
}

/** 推演里的人(稳定键)的名字;重推以后找不到了 = 键里的名字 */
function kinPersonName(civ: Civ, key: string): string {
  const id = resolvePersonKey(civ, key);
  return id >= 0 ? personName(civ, civ.people![id]) : (key.split('|')[2] ?? '');
}

/** 小表的头:人物的头像、名字,小字写在填什么 */
function SubHead({ d, sub }: { d: CharDraft; sub: string }) {
  return (
    <PanelHead icon={<CharAvatar c={d} size={38} />}>
      <div className="ins-name-row big">
        <span className="ins-name pp-title oc-name">{d.name.trim() || CHAR_NAME_DEFAULT}</span>
      </div>
      <SubLine parts={[sub]} />
    </PanelHead>
  );
}

function LifeCard({ civ, raster, world, year, draft: d, l, picking }: CharacterPanelProps & { draft: CharDraft; l: LifeDraft; picking: boolean }) {
  const problem = lifeProblem(d, l);
  const textRef = useRef<HTMLInputElement>(null);
  const c = useMemo(() => draftAsCharacter(d, year), [d, year]);
  const y = parseYear(l.yearText);
  const yOk = y !== null && !Number.isNaN(y);
  const ly = yOk ? y : year;
  const pl = l.where ? placeOf(civ, world, raster, l.where, ly) : null;
  const events = useMemo(() => lifeEventChoices(civ, world, raster, c, { year: ly, where: l.where, events: l.events }), [civ, world, raster, c, ly, l.where, l.events]);
  const people = useMemo(() => lifePeopleChoices(civ, world, raster, c, { year: ly, where: l.where, people: l.people }, events.list), [civ, world, raster, c, ly, l.where, l.people, events]);
  const ageNote = !yOk ? '' : y! < c.born ? '出生前' : c.died !== undefined && y! > c.died ? '去世后' : `${y! - c.born} 岁`;
  const done = () => {
    if (!problem) finishLife();
  };
  const name = d.name.trim() || CHAR_NAME_DEFAULT;
  const yearProblem = problem && problem.includes('年') ? problem : null;
  return (
    <div className="cp pp mk-card mk-editing oc-card oc-editing" data-character={d.id} data-oc-sub="life" onKeyDown={onEsc}>
      <SubHead d={d} sub={l.index >= 0 ? '改一段经历' : '加一段经历'} />
      <div className="cp-body">
        <section className="cp-sec">
          <div className="cp-sec-head">年份</div>
          <div className="cp-from mk-yrs">
            <div className="cp-from-row">
              <label className="cp-year">
                <input
                  value={l.yearText}
                  inputMode="numeric"
                  aria-label="哪一年"
                  data-oc="life-year"
                  onChange={(e) => patchLife({ yearText: digits(e.target.value) })}
                  onKeyDown={(e) => e.key === 'Enter' && textRef.current?.focus()}
                />
                年
              </label>
              {ageNote && <span className="oc-age">{ageNote}</span>}
              <button className="cp-step" data-act="character-life-now" onClick={() => patchLife({ yearText: String(year) })}>
                用第 {year} 年
              </button>
            </div>
            {yearProblem && <div className="cp-note mk-warn">{yearProblem}</div>}
          </div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">经历</div>
          <input
            ref={textRef}
            className="oc-field"
            value={l.text}
            maxLength={LIFE_TEXT_MAX}
            placeholder="比如：随军西征"
            aria-label="经历"
            data-oc="life-text"
            onChange={(e) => patchLife({ text: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && done()}
          />
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">在哪</div>
          <PickRow name={pl?.name ?? null} note={pl && !pl.missing ? placeNote(civ, pl, ly) : undefined} picking={picking} onPick={() => startPicking('life')} onClear={() => patchLife({ where: null })} act="character-life-where" />
          <div className="cp-note">点地图上的城、州，或者任意一处。不填也行。</div>
        </section>
        <section className="cp-sec" data-oc="life-events">
          <div className="cp-sec-head">推演里的事</div>
          {events.list.length > 0 ? (
            <div className="oc-checks">
              {events.list.map((v) => {
                const on = l.events.includes(v.key);
                return (
                  <button key={v.key} className="oc-check" role="checkbox" aria-checked={on} data-event={v.key} onClick={() => toggleLifeLink('events', v.key)}>
                    <span className={`oc-box${on ? ' on' : ''}`}>{on && <Icon name="check" size={13} />}</span>
                    <span className="y">{v.entry ? F(v.entry.year) : ''}</span>
                    <span className={v.entry ? undefined : 'oc-gone'}>{v.entry ? evText(v.entry) : '重推以后这件事没有了'}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="oc-checks">
              <span className="cp-none oc-none">{events.scope === 'place' ? '那几年这一处没有记下的事' : '那几年没有记下的事'}</span>
            </div>
          )}
          <div className="cp-note">
            {events.scope === 'place' ? '那几年这一处的事。' : '那几年他的国家的事。'}勾上的写进他的一生，事的那一方也会在卡片上看到他。
          </div>
        </section>
        {people.length > 0 && (
          <section className="cp-sec" data-oc="life-people">
            <div className="cp-sec-head">推演里的人</div>
            <div className="oc-chips">
              {people.map((v) => {
                const on = l.people.includes(v.key);
                const chip = v.person ? personChip(civ, v.person) : { name: v.key.split('|')[2] ?? '', role: '找不到了' };
                return (
                  <button key={v.key} className={`oc-chip${on ? ' on' : ''}`} role="checkbox" aria-checked={on} data-person-key={v.key} onClick={() => toggleLifeLink('people', v.key)}>
                    {on && <Icon name="check" size={12} />}
                    {chip.name}
                    <em>{chip.role}</em>
                  </button>
                );
              })}
            </div>
            <div className="cp-note">勾上的人，他的卡片上会出现{name}。</div>
          </section>
        )}
        {l.index >= 0 && (
          <section className="cp-sec">
            <button className="oc-del" data-act="character-life-delete" onClick={removeLife}>
              删掉这段经历
            </button>
          </section>
        )}
      </div>
      <div className="cp-foot mk-foot">
        <button className="cp-btn" data-act="character-life-cancel" onClick={cancelSub}>
          取消
        </button>
        <button className="cp-btn primary" data-act="character-life-done" disabled={!!problem} title={problem ?? undefined} onClick={done}>
          {l.index >= 0 ? '完成' : '加上'}
        </button>
      </div>
    </div>
  );
}

function KinCard({ civ, draft: d, k }: CharacterPanelProps & { draft: CharDraft; k: KinDraft }) {
  const problem = kinProblem(d, k);
  const chars = useEdits().characters ?? [];
  const relRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (k.index < 0) relRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 能选的人:自己的人物(不含他自己)、推演里的人;没搜的时候列他经历里勾过的人
  const list = useMemo(() => {
    const q = k.query.trim().toLowerCase();
    const out: { who: { char: number } | { person: string }; name: string; kind: string; color?: string; c?: AuthorCharacter }[] = [];
    for (const c of chars) {
      if (c.id === d.id || (q && !c.name.toLowerCase().includes(q))) continue;
      out.push({ who: { char: c.id }, name: c.name, kind: '我的人物', c });
    }
    const keys: string[] = [];
    if (q) {
      for (const x of civ.people ?? []) {
        if (keys.length >= KIN_LIST_MAX) break;
        if (!personName(civ, x).toLowerCase().includes(q) && !x.name.toLowerCase().includes(q)) continue;
        const key = personKey(civ, x.id);
        if (key && !keys.includes(key)) keys.push(key);
      }
    } else {
      for (const e of d.life) for (const key of e.people ?? []) if (!keys.includes(key)) keys.push(key);
    }
    if (k.person && !keys.includes(k.person)) keys.unshift(k.person);
    for (const key of keys) {
      const id = resolvePersonKey(civ, key);
      const x = id >= 0 ? civ.people![id] : null;
      const chip = x ? personChip(civ, x) : { name: key.split('|')[2] ?? '', role: '找不到了' };
      out.push({ who: { person: key }, name: chip.name, kind: `推演里的人，${chip.role}`, color: x ? `rgb(${civ.polities[x.polity].color.join(',')})` : undefined });
    }
    return out.slice(0, KIN_LIST_MAX * 2);
  }, [civ, chars, d.id, d.life, k.query, k.person]);
  const done = () => {
    if (!problem) finishKin();
  };
  const isOn = (w: { char: number } | { person: string }) => ('char' in w ? k.char === w.char : k.person === w.person);
  return (
    <div className="cp pp mk-card mk-editing oc-card oc-editing" data-character={d.id} data-oc-sub="kin" onKeyDown={onEsc}>
      <SubHead d={d} sub={k.index >= 0 ? '改亲友' : '加亲友'} />
      <div className="cp-body">
        <section className="cp-sec">
          <div className="cp-sec-head">关系</div>
          <input
            ref={relRef}
            className="oc-field"
            value={k.rel}
            maxLength={KIN_REL_MAX}
            placeholder="比如：父亲、好友、上司"
            aria-label="关系"
            data-oc="kin-rel"
            onChange={(e) => patchKin({ rel: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && done()}
          />
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">是谁</div>
          <input className="oc-field" value={k.query} placeholder="搜名字：自己的人物、推演里的君主和将领" aria-label="搜名字" data-oc="kin-query" onChange={(e) => patchKin({ query: e.target.value })} />
          {list.length > 0 ? (
            <div className="oc-checks">
              {list.map((v) => {
                const on = isOn(v.who);
                return (
                  <button key={'char' in v.who ? `c${v.who.char}` : v.who.person} className="oc-check who" role="radio" aria-checked={on} data-kin-pick={'char' in v.who ? v.who.char : v.who.person} onClick={() => pickKin(v.who)}>
                    <span className={`oc-box round${on ? ' on' : ''}`}>{on && <Icon name="check" size={13} />}</span>
                    <span className="t">
                      {v.c ? <CharAvatar c={v.c} size={20} /> : <i className="oc-sw" style={{ background: v.color ?? 'var(--ink-3)' }} />}
                      {v.name}
                    </span>
                    <span className="w">{v.kind}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="oc-checks">
              <span className="cp-none oc-none">{k.query.trim() ? '没找到这个名字' : '搜一下名字'}</span>
            </div>
          )}
          <div className="cp-note">可以选自己的人物，也可以选推演里的君主、将领。关系随便写。</div>
        </section>
        {k.index >= 0 && (
          <section className="cp-sec">
            <button className="oc-del" data-act="character-kin-delete" onClick={removeKin}>
              从亲友里去掉
            </button>
          </section>
        )}
      </div>
      <div className="cp-foot mk-foot">
        <button className="cp-btn" data-act="character-kin-cancel" onClick={cancelSub}>
          取消
        </button>
        <button className="cp-btn primary" data-act="character-kin-done" disabled={!!problem} title={problem ?? undefined} onClick={done}>
          {k.index >= 0 ? '完成' : '加上'}
        </button>
      </div>
    </div>
  );
}


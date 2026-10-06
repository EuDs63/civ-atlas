/**
 * 作者标记的卡片(和别的卡片同一套样子,零件见 panelParts.tsx;数据格式见 gen/edits.ts 文件头"作者标记"):
 * 地图上点标记、世界概览的「标记」页、搜索打开;新建、编辑也在这张卡片里填(markStore.ts 的 draft)。
 *
 * 看的时候
 *   顶部  标记颜色的小图钉、名字、"作者标记，2506–2515 年"
 *   按钮  开始那年(主操作:时间轴跳到「从」那年)/ 编辑 / 设为中心 / 更多(复制文字、删除标记;删了提示条上能撤销)
 *   说明  作者写的那几句
 *   概况  年份(几年;当前年份不在里面时写"第 N 年时还没有 / 已经没了")、地方(一个点:城、州、海)或范围(几个州)、
 *         当年归属(时间轴当前那一年归谁,国名能点)
 *   这些年这里的事  标记那几年、那几州(一个点 = 它落在的州)发生的事,新的在上;点一条跳到那一年
 *
 * 填的时候(新建、编辑)
 *   顶部  名字输入框(空着 = "新标记")、"作者标记，在大景王朝的紫月洲"(几个州:年份)
 *   年份  从 / 到(各带"用第 N 年"= 时间轴当前那年;"到"空着 = 一直都在)
 *   范围  一个点 | 几个州;一个点:拖地图上的图钉挪位置(点地图也行),几个州:点地图上的州加进来 / 去掉
 *   颜色  六种;说明  随便写
 *   底部  取消 / 完成(填得不对时点不了,提示一句)
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { regionLabel } from '../gen/civ/display';
import { MARKS_MAX, MARK_COLORS, MARK_NOTE_MAX, MARK_REGIONS_TOTAL, MARK_TITLE_DEFAULT, MARK_TITLE_MAX, markShownAt, regionKey, type AuthorMark, type MarkColor } from '../gen/edits';
import { MARK_HEX } from '../render/marks';
import { getEdits, removeMark, restoreMark, useEdits } from './editsStore';
import { clearSelection, setSelection } from './civView';
import { cancelDraft, draftProblem, editMarkDraft, finishDraft, patchDraft, useMarkUi, type MarkDraft } from './markStore';
import {
  cellAtWorld,
  markAllRegions,
  markCopyText,
  markEvents,
  markOwners,
  markRegionIds,
  markSpot,
  markYears,
  ownerName,
  regionsText,
} from './markInfo';
import { markFocus } from './flyTo';
import { requestMapCenter } from './mapWrap';
import { clearToast, showToast } from './toastStore';
import { Act, Acts, EventList, Link, MoreAct, PanelHead, Row, Stats, SubLine, copyText, jumpTo } from './panelParts';
import { MenuItem } from './PopMenu';
import { Icon } from './icons';

const F = Math.floor;

/** 颜色的名字(颜色圆点的读屏文字) */
const COLOR_NAME: Record<MarkColor, string> = { red: '红', orange: '橙', green: '绿', blue: '蓝', purple: '紫', teal: '青' };
/** 填的时候最多列出多少个州的名字(再多写"等 N 州") */
const CHIPS_MAX = 24;

/** 卡片标题前的小图钉(代替国家卡片的颜色块) */
export function MarkPin({ color, size = 14 }: { color: MarkColor; size?: number }) {
  return (
    <svg className="mk-head-pin" width={size} height={(size * 4) / 3} viewBox="0 0 24 32" aria-hidden="true">
      <path d="M12 31.2C10.6 27 3 20.4 3 12.6a9 9 0 0 1 18 0c0 7.8-7.6 14.4-9 18.6z" fill={MARK_HEX[color]} />
      <circle cx="12" cy="12.4" r="3.8" fill="#fff" />
    </svg>
  );
}

export interface MarkPanelProps {
  civ: Civ;
  raster: Raster | null;
  world: World;
  /** 标记编号(新建还没存 = 0) */
  id: number;
  year: number;
}

export function MarkPanel(props: MarkPanelProps) {
  const ui = useMarkUi();
  const edits = useEdits();
  const draft = ui.draft && ui.draft.id === props.id ? ui.draft : null;
  if (draft) return <MarkEdit {...props} draft={draft} />;
  const m = edits.marks?.find((x) => x.id === props.id);
  return m ? <MarkView {...props} m={m} /> : null;
}

// ---------------------------------------------------------------------------
// 看的时候

function MarkView({ civ, raster, world, year, m }: MarkPanelProps & { m: AuthorMark }) {
  const [copied, setCopied] = useState(false);
  const regs = useMemo(() => markAllRegions(civ, world, raster, m), [civ, world, raster, m]);
  const events = useMemo(() => markEvents(civ, regs, m), [civ, regs, m]);
  const focus = useMemo(() => markFocus(world, civ, m), [world, civ, m]);
  const live = markShownAt(m, year);

  const copy = async () => {
    const text = markCopyText(civ, world, raster, m, year);
    (window as unknown as { __wfMarkText: string }).__wfMarkText = text;
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const del = () => {
    const at = (getEdits().marks ?? []).findIndex((x) => x.id === m.id);
    const gone = removeMark(m.id);
    if (!gone) return;
    clearSelection();
    showToast({
      id: 'mk',
      kind: 'ok',
      text: `已删除标记「${gone.title}」`,
      action: {
        label: '撤销',
        act: 'mark-restore',
        onClick: () => {
          clearToast('mk');
          const id = restoreMark(gone, at);
          if (id > 0) setSelection({ kind: 'mark', id });
          else {
            const full = (getEdits().marks?.length ?? 0) >= MARKS_MAX;
            const why = full ? `标记已经有 ${MARKS_MAX} 个了` : `所有标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州`;
            showToast({ id: 'mk-restore', kind: 'warn', text: `${why},放不回去`, ttl: 4000 });
          }
        },
      },
    });
  };

  // 年份:几年(两头相减,同一年 = 不足一年,和人物页的在位年数一样);当前那年不在里面时说一声
  const span = m.to === undefined ? null : m.to > m.from ? `${m.to - m.from} 年` : '不足一年';
  const yearNote = live ? span : year < m.from ? `第 ${year} 年时还没有` : `第 ${year} 年时已经没了`;
  const rows: { k: string; node: ReactNode }[] = [
    {
      k: '年份',
      node: (
        <>
          {markYears(m)}
          {yearNote && <em className="cp-num-note">{yearNote}</em>}
        </>
      ),
    },
  ];
  if (m.regions) {
    const ids = markRegionIds(civ, m);
    rows.push({ k: '范围', node: regionsText(civ, ids) });
    const own = markOwners(civ, ids, year);
    if (own.length) rows.push({ k: '当年归属', node: ownersNode(civ, own, year, ids.length) });
  } else if (m.at) {
    const spot = markSpot(civ, world, raster, m.at, year);
    const city = spot.city !== undefined ? civ.settlements[spot.city] : undefined;
    const place = spot.place !== undefined ? civ.places[spot.place] : undefined;
    const reg = spot.region;
    rows.push({
      k: '地方',
      node: city ? (
        <>
          <Link to={{ kind: 'settlement', id: city.id }}>{city.name}</Link>
          {reg !== undefined && <em className="cp-num-note">{regionLabel(civ, reg)}</em>}
        </>
      ) : place ? (
        <>
          <Link to={{ kind: 'place', id: spot.place! }}>{place.name}</Link>
          {reg !== undefined && <em className="cp-num-note">{regionLabel(civ, reg)}</em>}
        </>
      ) : reg !== undefined ? (
        <Link to={{ kind: 'region', id: reg }}>{regionLabel(civ, reg)}</Link>
      ) : (
        (spot.sea ?? '海上')
      ),
    });
    const own = reg !== undefined ? markOwners(civ, [reg], year) : [];
    if (own.length) rows.push({ k: '当年归属', node: ownersNode(civ, own, year, 1) });
  }

  return (
    <div className="cp mk-card" data-mark={m.id}>
      <PanelHead icon={<MarkPin color={m.color} />}>
        <div className="ins-name-row big">
          <span className="ins-name mk-title">{m.title}</span>
        </div>
        <SubLine parts={[`作者标记，${markYears(m)}`]} />
      </PanelHead>
      <Acts>
        <Act icon="history" primary act="mark-year" onClick={() => jumpTo(m.from)} title={`时间轴跳到 ${m.from} 年`}>
          开始那年
        </Act>
        <Act icon="rename" act="mark-edit" onClick={() => editMarkDraft(m)}>
          编辑
        </Act>
        <Act icon="center" act="set-center" disabled={!focus} title="把地图转到以它为中心" onClick={() => focus && requestMapCenter(focus.lon)}>
          设为中心
        </Act>
        <MoreAct>
          <MenuItem icon={<Icon name="copy" size={16} />} act="mark-copy" onClick={() => void copy()}>
            {copied ? '已复制' : '复制文字'}
          </MenuItem>
          <MenuItem icon={<Icon name="trash" size={16} />} act="mark-delete" onClick={del}>
            删除标记
          </MenuItem>
        </MoreAct>
      </Acts>
      <div className="cp-body">
        {m.note && (
          <section className="cp-sec">
            <div className="cp-sec-head">说明</div>
            <div className="mk-note">{m.note}</div>
          </section>
        )}
        <Stats items={[]}>
          {rows.map((r) => (
            <Row key={r.k} k={r.k}>
              {r.node}
            </Row>
          ))}
        </Stats>
        {events.length > 0 && <EventList civ={civ} title="这些年这里的事" upTo={events} limit={8} />}
      </div>
    </div>
  );
}

/** 当年归属:全归一国 = 国名;几国、或有的州无主 = 国名 + "N 州"(total = 一共几州) */
function ownersNode(civ: Civ, own: { polity: number; n: number }[], year: number, total: number): ReactNode {
  const counts = own.length > 1 || own.reduce((s, o) => s + o.n, 0) < total;
  // 国名、州数都直接放进那一格(格子是 flex,间距照别的卡片)
  return own.map((o) => (
    <Fragment key={o.polity}>
      <Link to={{ kind: 'polity', id: o.polity }}>{ownerName(civ, o.polity, year)}</Link>
      {counts && <em className="cp-num-note">{o.n} 州</em>}
    </Fragment>
  ));
}

// ---------------------------------------------------------------------------
// 填的时候

function MarkEdit({ civ, raster, world, year, draft: d }: MarkPanelProps & { draft: MarkDraft }) {
  const problem = draftProblem(d);
  const titleRef = useRef<HTMLInputElement>(null);
  // 新建的:光标放在名字框里
  useEffect(() => {
    if (d.id === 0) titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const yearsShown = (() => {
    const from = Number(d.fromText);
    const to = d.toText.trim() ? Number(d.toText) : undefined;
    return Number.isFinite(from) && d.fromText.trim() ? markYears({ from, to: Number.isFinite(to) ? to : undefined }) : '';
  })();
  // 小字:一个点 = 在哪国的哪州(海上 = 哪片海);几个州 = 年份
  let sub = '作者标记';
  if (d.scope === 'point' && d.at) {
    const c = cellAtWorld(world, raster, d.at[0], d.at[1]);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r >= 0) {
      const own = markOwners(civ, [r], year)[0];
      sub = own ? `作者标记，在${ownerName(civ, own.polity, year)}的${regionLabel(civ, r)}` : `作者标记，在${regionLabel(civ, r)}`;
    } else sub = `作者标记，在${markSpot(civ, world, raster, d.at, year).sea ?? '海上'}`;
  } else if (yearsShown) sub = `作者标记，${yearsShown}`;

  const setScope = (scope: MarkDraft['scope']) => {
    if (scope === d.scope) return;
    if (scope === 'regions' && !d.regions.length && d.at) {
      // 换成几个州:先圈上图钉所在的那一州
      const c = cellAtWorld(world, raster, d.at[0], d.at[1]);
      const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
      return patchDraft({ scope, regions: r >= 0 ? [regionKey(civ, r)] : [] });
    }
    if (scope === 'point' && !d.at && d.regions.length) {
      // 换成一个点:图钉放在第一个州的州府
      const r = markRegionIds(civ, { regions: d.regions })[0];
      if (r !== undefined) {
        const seat = civ.regions.seat[r];
        return patchDraft({ scope, at: [world.mesh.x[seat], world.mesh.y[seat]] });
      }
    }
    patchDraft({ scope });
  };
  const done = () => {
    if (!problem) finishDraft();
  };
  const ids = d.scope === 'regions' ? markRegionIds(civ, { regions: d.regions }) : [];
  const digits = (s: string) => s.replace(/[^\d]/g, '').slice(0, 5);
  const yearRow = (k: string, key: 'fromText' | 'toText', placeholder?: string) => (
    <div className="cp-from-row">
      <span className="mk-k">{k}</span>
      <label className="cp-year">
        <input
          value={d[key]}
          inputMode="numeric"
          aria-label={k === '从' ? '从哪年' : '到哪年'}
          placeholder={placeholder}
          className={d[key] ? undefined : 'empty'}
          data-mk={key === 'fromText' ? 'from' : 'to'}
          onChange={(e) => patchDraft({ [key]: digits(e.target.value) })}
          onKeyDown={(e) => e.key === 'Enter' && done()}
        />
        年
      </label>
      <button className="cp-step" data-act={key === 'fromText' ? 'mark-from-now' : 'mark-to-now'} onClick={() => patchDraft({ [key]: String(year) })}>
        用第 {year} 年
      </button>
    </div>
  );
  const yearProblem = problem && !problem.includes('地图') ? problem : null;

  return (
    <div
      className="cp mk-card mk-editing"
      data-mark={d.id}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        cancelDraft();
      }}
    >
      <PanelHead icon={<MarkPin color={d.color} />}>
        <div className="ins-edit big">
          <input
            ref={titleRef}
            value={d.title}
            maxLength={MARK_TITLE_MAX}
            placeholder={MARK_TITLE_DEFAULT}
            aria-label="标记的名字"
            data-mk="title"
            onChange={(e) => patchDraft({ title: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && done()}
          />
        </div>
        <SubLine parts={[sub]} />
      </PanelHead>
      <div className="cp-body">
        <section className="cp-sec">
          <div className="cp-sec-head">年份</div>
          <div className="cp-from mk-yrs">
            {yearRow('从', 'fromText')}
            {yearRow('到', 'toText', '一直都在')}
            <div className={`cp-note${yearProblem ? ' mk-warn' : ''}`}>{yearProblem ?? '时间轴走到这些年里，地图上才有这个标记。"到"不填就是一直都在。'}</div>
          </div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">范围</div>
          <div className="seg mk-seg" role="tablist">
            <button className={d.scope === 'point' ? 'on' : undefined} role="tab" aria-selected={d.scope === 'point'} data-act="mark-point" onClick={() => setScope('point')}>
              一个点
            </button>
            <button className={d.scope === 'regions' ? 'on' : undefined} role="tab" aria-selected={d.scope === 'regions'} data-act="mark-regions" onClick={() => setScope('regions')}>
              几个州
            </button>
          </div>
          {d.scope === 'regions' ? (
            <>
              {ids.length > 0 && (
                <div className="mk-chips">
                  {ids.slice(0, CHIPS_MAX).map((r) => (
                    <span key={r}>{regionLabel(civ, r)}</span>
                  ))}
                  {ids.length > CHIPS_MAX && <span>等 {ids.length} 州</span>}
                </div>
              )}
              <div className="cp-note">点地图上的州加进来，再点一下去掉。已选 {ids.length} 个州。</div>
            </>
          ) : (
            <div className="cp-note">{d.at ? '拖动地图上的图钉可以挪位置。' : '在地图上点一下放图钉。'}</div>
          )}
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">颜色</div>
          <div className="mk-colors" role="radiogroup" aria-label="颜色">
            {MARK_COLORS.map((c) => (
              <button
                key={c}
                className={c === d.color ? 'on' : undefined}
                style={{ background: MARK_HEX[c] }}
                role="radio"
                aria-checked={c === d.color}
                aria-label={COLOR_NAME[c]}
                data-color={c}
                onClick={() => patchDraft({ color: c })}
              />
            ))}
          </div>
        </section>
        <section className="cp-sec">
          <div className="cp-sec-head">说明</div>
          <textarea className="mk-text" rows={4} value={d.note} maxLength={MARK_NOTE_MAX} aria-label="说明" data-mk="note" onChange={(e) => patchDraft({ note: e.target.value })} />
        </section>
      </div>
      <div className="cp-foot mk-foot">
        <button className="cp-btn" data-act="mark-cancel" onClick={cancelDraft}>
          取消
        </button>
        <button className="cp-btn primary" data-act="mark-done" disabled={!!problem} title={problem ?? undefined} onClick={done}>
          完成
        </button>
      </div>
    </div>
  );
}

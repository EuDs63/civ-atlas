/**
 * 城的面板(和国家面板同一套样子,零件见 panelParts.tsx),按时间轴当前那一年:
 *
 *   顶部  颜色块(当年所属国)、城名(可改)、"城，1045 年建城，属 大昌"(毁了 = "故城"、写毁于哪年)、关闭
 *   按钮  迁都到这里(主操作:替所属国下"迁都"令,生效年份 = 当前年份,和国家干预页同一套流程)/ 设为中心 / 改名 /
 *         更多(在这里加标记 / 在这里加人物、看所属国家、让 AI 讲名字由来)
 *   概况  级别(都城 / 大城 / 城 / 镇 / 村;故城)、人口、做过国都(次数或"未曾")、所在州(可点)、建城时的民族、
 *         做国都的年份段、故址(重建)
 *   作者的人物  生在这里、经历写在这里的作者人物(characterInfo.ts 的 charactersAt),没有就不显示
 *   兴衰  历年人口的小柱图(柱子按当时的主人上色,无主时灰),洗劫 / 毁城 / 重建 / 旧都衰落的年份在上面标一个字;点一处跳到那年
 *   历任归属 按时长分段的色条(每段一个国家的颜色),点一段跳到它开始的那年
 *   大事  最近 5 条(可点)
 */
import { useMemo, useState } from 'react';
import type { Civ, Settlement } from '../gen/civ/types';
import { cultureLabel, regionLabel } from '../gen/civ/display';
import { SETTLEMENT_RANKS, capitalAt, polityAlive, populationAt, populationLabel, settlementRank } from '../gen/civ/growth';
import { ownersAt } from '../gen/civ/timeline';
import { polityKey, settlementKey, type Intervention } from '../gen/edits';
import { setSelection } from './civView';
import { newMarkDraft } from './markStore';
import { newCharacterDraft } from './characterStore';
import { charactersAt, whereOfCity } from './characterInfo';
import { CharacterRefs } from './CharacterPanel';
import { addIntervention, editBlock, interventionKeys, useEdits } from './editsStore';
import { NameEdit } from './NameEdit';
import { nameAt } from './Interventions';
import { endRun, startRun } from './panelStore';
import { cityEntries, entriesUpTo, ownerSpans, ownersOf, popPeak, popSeries, type OwnerSpan } from './panelData';
import {
  Act,
  Acts,
  AiBox,
  AiSuggestLink,
  CenterAct,
  EventList,
  Link,
  MoreAct,
  OwnerBar,
  PanelHead,
  Row,
  Spark,
  Stats,
  SubLine,
  jumpTo,
  rgb,
  type DetailProps,
  useRevealAi,
} from './panelParts';
import { AiMenuItem, MenuItem } from './PopMenu';
import { Icon } from './icons';

/** 兴衰小柱图的柱数 */
const BARS = 24;
/** 柱子最高多少像素 */
const BAR_H = 30;

const popShort = (pop: number) => (pop > 0 ? populationLabel(pop) : '—');

export function CityPanel({ civ, raw, raster, world, id, year, names }: DetailProps) {
  const s = civ.settlements[id];
  const [renaming, setRenaming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const { ai, aiRef } = useRevealAi({ civ, raw, raster, target: { kind: 'settlement', id }, lazy: true });
  const chars = useEdits().characters;
  const refs = useMemo(() => charactersAt(civ, world, raster, chars, { city: id }), [civ, world, raster, chars, id]);
  const built = year >= s.founded;
  const ruined = s.ended !== undefined && year >= s.ended;
  const stands = built && !ruined;
  const pop = populationAt(s, year);
  // 当年的主人:做谁的国都就算谁的;否则看所在州
  const own = ownersOf(civ, year);
  const capitalOf = stands ? civ.polities.find((p) => polityAlive(p, year) && capitalAt(p, year) === id) : undefined;
  const owner = capitalOf ?? (stands ? civ.polities[own.polity[s.region]] : undefined);
  const last = s.ended ?? civ.endYear;
  const spans = useMemo(() => ownerSpans(civ, s.region, s.founded, last), [civ, s.region, s.founded, last]);
  const capSpans: { from: number; until?: number; polity: number }[] = s.capitalSpans ?? (s.capitalFrom !== undefined ? [{ from: s.capitalFrom, polity: -1 }] : []);
  const capTimes = capSpans.filter((c) => c.from <= year).length;
  const old = s.rebuilds !== undefined ? civ.settlements[s.rebuilds] : undefined;
  const rebuiltAs = useMemo(() => civ.settlements.find((x) => x.rebuilds === id), [civ, id]);
  const cu = civ.cultures[s.culture];
  const upTo = entriesUpTo(cityEntries(civ, id), year);
  const level = !built ? '未建' : ruined ? '故城' : capitalOf ? '都城' : SETTLEMENT_RANKS[settlementRank(pop)].name;
  const polityLink = (q: number, y: number) => {
    const P = civ.polities[q];
    return P ? <Link to={{ kind: 'polity', id: q }}>{nameAt(P, y)}</Link> : null;
  };

  // 迁都到这里:替当年的主人下"迁都"令(生效年份 = 当前年份;到了结束年份就往前一年)
  const y = Math.max(0, Math.min(civ.endYear - 1, year));
  const moveOwner = (() => {
    if (!(y >= s.founded) || (s.ended !== undefined && y >= s.ended)) return undefined;
    const q = y === year ? own.polity[s.region] : ownersAt(civ, y).polity[s.region];
    const P = civ.polities[q];
    return P && polityAlive(P, y) ? P : undefined;
  })();
  const moveWhy = !built
    ? '还没建城'
    : ruined
      ? '城已毁'
      : !moveOwner
        ? '不属于任何国家'
        : capitalAt(moveOwner, y) === id
          ? '已是国都'
          : populationAt(s, y) <= 0
            ? '城已不在'
            : null;
  const move = () => {
    if (!moveOwner || moveWhy) return;
    const v: Intervention = { kind: 'move', a: polityKey(civ, moveOwner.id), city: settlementKey(civ, id), from: y };
    const blocked = editBlock(interventionKeys(v));
    setMsg(blocked);
    if (blocked) return;
    jumpTo(y);
    startRun({ self: moveOwner.id, target: { kind: 'settlement', id }, from: y });
    if (!addIntervention(v)) {
      endRun();
      setMsg('这条命令已经下过了');
    }
  };

  return (
    <div className="cp" data-settlement={id}>
      <PanelHead color={stands && owner ? rgb(owner.color) : undefined}>
        <NameEdit
          k={settlementKey(civ, id)}
          kind="settlement"
          shown={s.name}
          current={s.name}
          fallback={raw.settlements[id].name}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
          extra={<AiSuggestLink ai={ai} />}
        />
        <SubLine
          className="ins-status"
          parts={[
            ruined ? '故城' : '城',
            `${Math.floor(s.founded)} 年${built ? '' : '才'}建城`,
            ruined ? `毁于 ${Math.floor(s.ended!)} 年` : owner ? <>属 {polityLink(owner.id, year)}</> : stands ? '部落地带' : null,
          ]}
        />
      </PanelHead>
      <Acts>
        <Act icon="flag" primary act="move-here" disabled={!!moveWhy} title={moveWhy ?? `${nameAt(moveOwner!, y)}迁都到这里,${y} 年起生效`} onClick={move}>
          迁都到这里
        </Act>
        <CenterAct world={world} civ={civ} sel={{ kind: 'settlement', id }} year={year} />
        <Act icon="rename" act="rename" onClick={() => setRenaming(true)}>
          改名
        </Act>
        <MoreAct>
          <MenuItem icon={<Icon name="pin" size={16} />} act="add-mark" onClick={() => newMarkDraft({ at: [world.mesh.x[s.cell], world.mesh.y[s.cell]], year })}>
            在这里加标记
          </MenuItem>
          <MenuItem icon={<Icon name="person" size={16} />} act="add-character" onClick={() => newCharacterDraft({ birthplace: whereOfCity(civ, id), year })}>
            在这里加人物
          </MenuItem>
          <MenuItem icon={<Icon name="flag" size={16} />} act="owner" disabled={!owner} onClick={() => owner && setSelection({ kind: 'polity', id: owner.id })}>
            看所属国家
          </MenuItem>
          <AiMenuItem icon={<Icon name="sparkle" size={16} />} ain="explain" disabled={ai.busy} onClick={ai.ask}>
            让 AI 讲名字由来
          </AiMenuItem>
        </MoreAct>
      </Acts>
      {msg && <div className="cp-msg">{msg}</div>}
      <div className="cp-body">
        <Stats
          items={[
            { k: '级别', v: level },
            { k: '人口', v: stands ? popShort(pop) : '—' },
            { k: '做过国都', v: capTimes ? `${capTimes} 次` : '未曾' },
          ]}
        >
          <Row k="所在">
            <span>
              <Link to={{ kind: 'region', id: s.region }}>{regionLabel(civ, s.region)}</Link>
              {s.port && '，港口'}
            </span>
          </Row>
          {cu && (
            <Row k="民族">
              {cultureLabel(cu)}
              <em className="cp-em">建城时</em>
            </Row>
          )}
          {capSpans.length > 0 && (
            <Row k="国都" className="cp-links">
              {capSpans.map((c, i) => {
                const end = c.until ?? s.ended;
                const now = c.from <= year && (end === undefined || year < end);
                const P = civ.polities[c.polity];
                return (
                  <span key={i} className={`${now ? 'cp-now' : ''}${c.from > year ? ' cp-later' : ''}`}>
                    {P ? polityLink(P.id, Math.max(c.from, Math.min(year, Math.min(end ?? Infinity, P.ended ?? Infinity, civ.endYear + 1) - 1 / 512))) : '国都'}
                    <em>
                      {Math.floor(c.from)}–{end === undefined ? '今' : Math.floor(end)}
                    </em>
                  </span>
                );
              })}
            </Row>
          )}
          {(old || rebuiltAs) && (
            <Row k="故址" className="cp-links">
              {old && (
                <span>
                  在 <Link to={{ kind: 'settlement', id: old.id }}>{old.name}</Link> 故址上重建
                </span>
              )}
              {rebuiltAs && (
                <span className={rebuiltAs.founded > year ? 'cp-later' : ''}>
                  {Math.floor(rebuiltAs.founded)} 年重建为 <Link to={{ kind: 'settlement', id: rebuiltAs.id }}>{rebuiltAs.name}</Link>
                </span>
              )}
            </Row>
          )}
        </Stats>
        <CharacterRefs refs={refs} />
        <Trend civ={civ} s={s} year={year} from={s.founded} to={last} spans={spans} />
        <OwnerBar civ={civ} spans={spans} year={year} />
        <EventList upTo={upTo} civ={civ} />
        <AiBox ai={ai} aiRef={aiRef} />
      </div>
    </div>
  );
}

/** 兴衰上面的一个记号 */
interface Mark {
  year: number;
  glyph: string;
  ev: string;
  title: string;
}

/** 兴衰:历年人口的小柱图 + 洗劫 / 毁城 / 重建 / 旧都衰落的记号;点一根柱子或一个记号跳到那年 */
function Trend({ civ, s, year, from, to, spans }: { civ: Civ; s: Settlement; year: number; from: number; to: number; spans: readonly OwnerSpan[] }) {
  const series = useMemo(() => popSeries(s, from, to, BARS), [s, from, to]);
  const marks = useMemo(() => {
    const out: Mark[] = [];
    const by = (q: number, y: number) => (civ.polities[q] ? nameAt(civ.polities[q], y) : '');
    if (s.rebuilds !== undefined && civ.settlements[s.rebuilds]) out.push({ year: s.founded, glyph: '建', ev: 'found', title: `${Math.floor(s.founded)} 年在${civ.settlements[s.rebuilds].name}故址上重建` });
    let ruinBy = -1;
    for (const a of civ.annals) {
      if (a.settlement !== s.id) continue;
      if (a.kind === 'sack') {
        const loss = s.sacks?.find((k) => k.year === a.year)?.loss;
        out.push({ year: a.year, glyph: '掠', ev: 'war', title: `${Math.floor(a.year)} 年遭${by(a.a, a.year)}洗劫${loss !== undefined ? `,人口折损约 ${Math.round(loss * 100)}%` : ''}` });
      } else if (a.kind === 'ruin') ruinBy = a.a;
      else if (a.kind === 'decline') out.push({ year: a.year, glyph: '衰', ev: 'dynasty', title: `${Math.floor(a.year)} 年${by(a.a, a.year)}迁都,旧都渐衰` });
    }
    if (s.ended !== undefined) out.push({ year: s.ended, glyph: '毁', ev: 'war', title: `${Math.floor(s.ended)} 年${ruinBy >= 0 ? `被${by(ruinBy, s.ended)}攻破,毁于兵火` : '毁弃'}` });
    out.sort((a, b) => a.year - b.year);
    // 挨得太近的只留先来的(毁城一定留)
    const kept: Mark[] = [];
    const span = Math.max(1e-6, to - from);
    for (const m of out) {
      const prev = kept[kept.length - 1];
      if (prev && (m.year - prev.year) / span < 0.06) {
        if (m.glyph === '毁') kept[kept.length - 1] = m;
        continue;
      }
      kept.push(m);
    }
    return kept;
  }, [civ, s, from, to]);
  // 最盛:按年份逐处算准(小柱图只在柱子中间取样,会比现在的人口还少);正看着的这一年也算进去
  const top = useMemo(() => popPeak(s, from, to), [s, from, to]);
  const now = year >= from && year <= to ? populationAt(s, year) : 0;
  const peak = Math.max(top.pop, now);
  const peakYear = now > top.pop ? year : top.year;
  if (!(to > from) || peak <= 0) return null;
  const span = to - from;
  const ownerAt = (y: number) => spans.find((sp) => y >= sp.from && y < sp.to)?.polity ?? -1;
  return (
    <div className="cp-dyn cp-trend">
      <div className="cp-sec-head cp-trend-head">
        <span>兴衰</span>
        <span className="cp-count">
          最盛 {popShort(peak)}，{Math.round(peakYear)} 年
        </span>
      </div>
      {marks.length > 0 && (
        <div className="cp-marks">
          {marks.map((m, i) => (
            <button
              key={i}
              className="cp-mark"
              data-ev={m.ev}
              style={{ left: `${Math.min(1, Math.max(0, (m.year - from) / span)) * 100}%` }}
              title={m.title}
              onClick={() => jumpTo(Math.ceil(m.year))}
            >
              {m.glyph}
            </button>
          ))}
        </div>
      )}
      <Spark
        fill
        bars={series.map((x) => {
          const P = civ.polities[ownerAt(x.year)];
          return {
            h: Math.max(1, Math.round((x.pop / peak) * BAR_H)),
            background: P ? rgb(P.color) : 'var(--line-strong)',
            opacity: x.pop > 0 ? (x.year <= year ? 1 : 0.35) : 0.2,
            title: `${Math.round(x.year)} 年 · ${x.pop > 0 ? populationLabel(x.pop) : '无人'}`,
            onClick: () => jumpTo(Math.round(x.year)),
          };
        })}
      />
      <div className="cp-dyn-years">
        <span>{Math.floor(from)}</span>
        <span>{Math.floor(to)}</span>
      </div>
    </div>
  );
}

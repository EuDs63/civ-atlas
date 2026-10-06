/**
 * 州的面板(和国家面板同一套样子,零件见 panelParts.tsx),按时间轴当前那一年:
 *
 *   顶部  颜色块(当年所属国)、州名(可改)、"州，属 大昌，第 12 州"(没有国家 = "无主之地")、关闭
 *   按钮  在这里立国(主操作)/ 划给… / 改名 / 更多(在这里加标记 / 在这里加人物、设为中心、让 AI 讲名字由来)(每个面板只有一个主操作,和国家面板一样)
 *   概况  主体民族(族名可改)、宜居度、人口(州里的城;一州同一时刻最多一座城)、信仰(可点)、州里的城(可点;故城标出来)、地貌、
 *         民族(族名由来 / 起族名)
 *   作者的人物  生在这里、经历写在这里的作者人物(没有就不显示)
 *   历任归属 按时长分段的色条,点一段跳到它开始的那年
 *   大事  最近 5 条(可点)、这一州的干预(可撤销)
 *
 * "在这里立国""划给…"换到干预页:生效年份(−100 −10 [年份] +10)+ 国名(可不填)/ 永久;
 * "划给…"在地图上选国家(地图压暗、可选的国家浮出名牌,见 TargetPlates.tsx)。下了干预回到信息页,App 在后台重推,
 * 顶部提示"…划给…,已从 X 年起重新推演"带撤销。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import { BIOMES } from '../gen/biomes';
import { KIND_INFO, cultureLabel, regionLabel, regionNamed } from '../gen/civ/display';
import { SETTLEMENT_RANKS, capitalAt, polityAlive, polityName, populationAt, populationLabel, settlementRank } from '../gen/civ/growth';
import { ownersAt } from '../gen/civ/timeline';
import { faithAt } from '../gen/civ/religion';
import { cleanName, cultureKey, polityKey, regionKey, type Intervention } from '../gen/edits';
import { addIntervention, editBlock, interventionKeys, useEdits } from './editsStore';
import { habitatScore, habitatWord } from './civDescribe';
import { MineList, getPolityPick, nameAt, regionOrders, setPolityPick } from './Interventions';
import { NameEdit } from './NameEdit';
import { AiMenuItem, MenuItem } from './PopMenu';
import { Icon } from './icons';
import { useAiOn } from '../ai/client';
import { setSheet } from './panelStore';
import { newMarkDraft } from './markStore';
import { newCharacterDraft } from './characterStore';
import { charactersAt, whereOfRegion } from './characterInfo';
import { CharacterRefs } from './CharacterPanel';
import { entriesUpTo, firstOwned, ownerSpans, ownersOf, regionEntries } from './panelData';
import {
  Act,
  Acts,
  AiBox,
  AiSuggestLink,
  CenterAct,
  CenterItem,
  EventList,
  Foot,
  Link,
  MoreAct,
  OwnerBar,
  PanelHead,
  Row,
  Stats,
  SubLine,
  YearStepper,
  jumpTo,
  rgb,
  type DetailProps,
  useRevealAi,
  useYearInput,
} from './panelParts';

type Page = 'found' | 'cede';

export function RegionPanel(props: DetailProps) {
  const { civ, raw, raster, world, id, year, names } = props;
  const [page, setPage] = useState<Page | null>(null);
  const [renaming, setRenaming] = useState(false);
  const { ai, aiRef } = useRevealAi({ civ, raw, raster, target: { kind: 'region', id }, lazy: true });
  const own = ownersOf(civ, year);
  const po = civ.polities[own.polity[id]];
  const named = regionNamed(civ, id);
  const canAct = civ.viable && civ.polities.length > 0;
  return (
    <div className="cp" data-region={id} data-page={page ?? 'info'}>
      <PanelHead color={po ? rgb(po.color) : undefined}>
        <NameEdit
          k={regionKey(civ, id)}
          kind="region"
          shown={regionLabel(civ, id)}
          current={named ? regionLabel(civ, id) : ''}
          fallback={regionLabel(raw, id)}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
          extra={<AiSuggestLink ai={ai} />}
          hint={named ? '州名不随历史改变' : '给这个州起个名字,如"九嶷州"'}
        />
        <SubLine
          className="ins-status"
          parts={[
            '州',
            po ? (
              <>
                属 <Link to={{ kind: 'polity', id: po.id }}>{polityName(po, year)}</Link>
              </>
            ) : (
              '无主之地'
            ),
            named && `第 ${id + 1} 州`,
          ]}
        />
      </PanelHead>
      {page && canAct ? (
        <RegionOrder civ={civ} id={id} year={year} page={page} back={() => setPage(null)} />
      ) : (
        <>
          <Acts>
            {canAct ? (
              <>
                <Act icon="flag" primary act="found" onClick={() => (setPage('found'), setSheet('full'))}>
                  在这里立国
                </Act>
                <Act icon="map" act="cede" onClick={() => (setPage('cede'), setSheet('full'))}>
                  划给…
                </Act>
              </>
            ) : (
              <CenterAct world={world} civ={civ} sel={{ kind: 'region', id }} year={year} />
            )}
            <Act icon="rename" act="rename" onClick={() => setRenaming(true)}>
              改名
            </Act>
            <MoreAct>
              <MenuItem icon={<Icon name="pin" size={16} />} act="add-mark" onClick={() => newMarkDraft({ regions: [regionKey(civ, id)], year })}>
                在这里加标记
              </MenuItem>
              <MenuItem icon={<Icon name="person" size={16} />} act="add-character" onClick={() => newCharacterDraft({ birthplace: whereOfRegion(civ, id), year })}>
                在这里加人物
              </MenuItem>
              {canAct && <CenterItem world={world} civ={civ} sel={{ kind: 'region', id }} year={year} />}
              <AiMenuItem icon={<Icon name="sparkle" size={16} />} ain="explain" disabled={ai.busy} onClick={ai.ask}>
                让 AI 讲名字由来
              </AiMenuItem>
            </MoreAct>
          </Acts>
          <RegionInfo {...props} ai={ai} aiRef={aiRef} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 信息页

function RegionInfo({ civ, raw, raster, world, id, year, names, ai, aiRef }: DetailProps & Pick<ReturnType<typeof useRevealAi>, 'ai' | 'aiRef'>) {
  const edits = useEdits();
  const chars = edits.characters;
  const refs = useMemo(() => charactersAt(civ, world, raster, chars, { region: id }), [civ, world, raster, chars, id]);
  const own = ownersOf(civ, year);
  const cid = own.culture[id];
  const cu = civ.cultures[cid];
  const culture = useRevealAi({ civ, raw, raster, target: cu ? { kind: 'culture', id: cid } : null, lazy: true, what: '族名' });
  const aiOn = useAiOn();
  const score = habitatScore(civ.habitat.suitability[civ.regions.seat[id]]);
  const cities = civ.settlements.filter((s) => s.region === id && s.founded <= year);
  const city = cities.find((s) => s.ended === undefined || s.ended > year);
  const pop = city ? populationAt(city, year) : 0;
  const first = firstOwned(civ, id);
  const spans = useMemo(() => (first === null ? [] : ownerSpans(civ, id, first, civ.endYear)), [civ, id, first]);
  const upTo = entriesUpTo(regionEntries(civ, id), year);
  const mine = regionOrders(civ, id, edits.interventions);
  const elev = civ.regions.elevation[id];
  const faith = civ.religion?.faiths[faithAt(civ, year)[id]];
  return (
    <div className="cp-body">
      <Stats
        items={[
          {
            k: '主体民族',
            v: cu ? (
              <NameEdit
                k={cultureKey(civ, cid)}
                kind="culture"
                shown={cultureLabel(cu)}
                current={cu.name}
                fallback={raw.cultures[cid].name}
                names={names}
                preview={(v) => `${v}族`}
                hint="族名(不带“族”字)"
              />
            ) : (
              '—'
            ),
          },
          { k: '宜居度', v: score, note: habitatWord(score) },
          { k: '人口', v: pop > 0 ? populationLabel(pop) : '—' },
        ]}
      >
        {civ.religion && (
          <Row k="信仰">
            {faith ? <Link to={{ kind: 'faith', id: faith.id }}>{faith.name}</Link> : '—'}
          </Row>
        )}
        {cities.length > 0 && (
          <Row k="城" className="cp-links">
            {cities.map((s) => {
              const gone = s.ended !== undefined && s.ended <= year;
              const cap = !gone && civ.polities.some((p) => polityAlive(p, year) && capitalAt(p, year) === s.id);
              return (
                <span key={s.id} className={gone ? 'cp-gone' : ''}>
                  <Link to={{ kind: 'settlement', id: s.id }}>{s.name}</Link>
                  <em>{gone ? '故城' : cap ? '都城' : SETTLEMENT_RANKS[settlementRank(populationAt(s, year))].name}</em>
                </span>
              );
            })}
          </Row>
        )}
        <Row k="地貌">
          {BIOMES[civ.regions.biome[id]]?.name ?? '—'}
          {Number.isFinite(elev) && `，平均海拔 ${Math.round(elev).toLocaleString()} 米`}
        </Row>
        {cu && (
          <Row k="民族" className="cp-links">
            <span>{KIND_INFO[cu.kind].name}民族</span>
            {aiOn && (
              <>
                <button className="ins-link" data-act="culture-explain" disabled={culture.ai.busy} onClick={culture.ai.ask}>
                  族名由来
                </button>
                <button className="ins-link" data-act="culture-suggest" onClick={culture.ai.suggest}>
                  起族名
                </button>
              </>
            )}
          </Row>
        )}
      </Stats>
      <CharacterRefs refs={refs} />
      <OwnerBar civ={civ} spans={spans} year={year} />
      <EventList upTo={upTo} civ={civ} />
      {mine.length > 0 && (
        <section className="cp-sec cp-mine">
          <div className="cp-sec-head">这一州的干预</div>
          <MineList civ={civ} mine={mine} />
        </section>
      )}
      <AiBox ai={culture.ai} aiRef={culture.aiRef} />
      <AiBox ai={ai} aiRef={aiRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 干预页:在这里立国 / 划给…

function RegionOrder({ civ, id, year, page, back }: { civ: Civ; id: number; year: number; page: Page; back: () => void }) {
  const edits = useEdits();
  const key = regionKey(civ, id);
  const source = `region:${id}`;
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [forever, setForever] = useState(false);
  const yi = useYearInput(year, 0, Math.max(0, civ.endYear - 1), () => setMsg(null));
  const { y, valid } = yi;
  // 离开这一页(返回、选了别的东西):在地图上选到一半的收起
  useEffect(
    () => () => {
      if (getPolityPick()?.source === source) setPolityPick(null);
    },
    [source],
  );
  // 那一年这州的主人、有没有人住;各国州数、挨着这州的国家
  const at = useMemo(() => {
    const size = new Map<number, number>();
    const near = new Set<number>();
    const o = ownersAt(civ, y);
    const reg = civ.regions;
    for (let r = 0; r < reg.count; r++) if (o.polity[r] >= 0) size.set(o.polity[r], (size.get(o.polity[r]) ?? 0) + 1);
    for (let k = reg.adjStart[id]; k < reg.adjStart[id + 1]; k++) if (o.polity[reg.adj[k]] >= 0) near.add(o.polity[reg.adj[k]]);
    return { owner: o.polity[id], peopled: o.culture[id] >= 0, size, near };
  }, [civ, id, y]);
  const others = useMemo(() => civ.polities.filter((q) => q.id !== at.owner && polityAlive(q, y) && (at.size.get(q.id) ?? 0) > 0).map((q) => q.id), [civ, y, at]);
  const R = regionLabel(civ, id);
  const O = at.owner >= 0 ? civ.polities[at.owner] : undefined;
  /** 原主会怎样:这州是它的国都 → 迁都;它只有这一州 → 亡国 */
  const fate = !O
    ? ''
    : (at.size.get(O.id) ?? 0) <= 1
      ? `,${nameAt(O, y)}只有这一州,会就此亡国`
      : civ.settlements[capitalAt(O, y)]?.region === id
        ? `,这里是${nameAt(O, y)}的国都,它会迁都`
        : '';
  const why = !valid
    ? `生效年份要在 0–${Math.max(0, civ.endYear - 1)} 年之间`
    : !at.peopled
      ? `${y} 年这州无人居住`
      : page === 'cede' && !others.length && !(forever && O)
        ? '该年没有别的国家'
        : null;
  const add = (v: Intervention): string | null => {
    const blocked = editBlock(interventionKeys(v));
    if (blocked) return blocked;
    if (!addIntervention(v)) return '这条干预已经下过了';
    back();
    return null;
  };
  /** 划给国家 q:合格就下干预,不合格返回原因 */
  const cedeTo = (q: number): string | null => {
    const Q = civ.polities[q];
    if (!Q || !polityAlive(Q, y) || !(at.size.get(q)! > 0)) return `${y} 年${Q ? nameAt(Q, y) : '这个国家'}不在`;
    if (q === at.owner && !forever) return `${y} 年${R}本来就属${nameAt(Q, y)}`;
    return add(forever ? { kind: 'cede', a: polityKey(civ, q), region: key, from: y, permanent: true } : { kind: 'cede', a: polityKey(civ, q), region: key, from: y });
  };
  const found = () => {
    const n = cleanName('polity', name);
    setMsg(add(n ? { kind: 'found', region: key, from: y, name: n } : { kind: 'found', region: key, from: y }));
  };
  const pick = () => {
    setMsg(null);
    // 地图停在生效那一年:看到的国界、可选的国家和干预用的是同一年
    jumpTo(y);
    setPolityPick({
      prompt: `选择${R}要划给的国家`,
      sub: `${y} 年起生效`,
      source,
      accept: cedeTo,
      eligible: new Set(others.concat(forever && at.owner >= 0 ? [at.owner] : [])),
      near: at.near,
      year: y,
    });
  };
  const mine = regionOrders(civ, id, edits.interventions);
  const holder = O ? `这州 ${y} 年属${nameAt(O, y)}` : `这州 ${y} 年无主`;
  return (
    <>
      <div className="cp-body">
        <YearStepper yi={yi} />
        <div className="cp-form">
          <span className="cp-form-title">{page === 'found' ? '在这里立国' : '划给…'}</span>
          {page === 'found' ? (
            <label className="cp-field">
              <span className="cp-k">国名</span>
              <input
                value={name}
                placeholder="不填自动起"
                maxLength={16}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !why && found()}
              />
            </label>
          ) : (
            <label className="cp-check">
              <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} />
              <span>永久</span>
              <span className="cp-note">之后战争、分裂都拿不走</span>
            </label>
          )}
          <span className="cp-note">{page === 'found' ? `${holder}${O ? ',立国后从它分出来' : ''}${fate}。` : `${holder}${fate}。`}</span>
        </div>
        {(msg || why) && <div className="cp-msg">{msg ?? why}</div>}
        {mine.length > 0 && (
          <div className="cp-events cp-mine">
            <span className="cp-k">这一州的干预</span>
            <MineList civ={civ} mine={mine} />
          </div>
        )}
      </div>
      <Foot>
        <button className="cp-btn" data-act="back" onClick={back}>
          返回
        </button>
        {page === 'found' ? (
          <button className="cp-btn primary" data-act="found-go" disabled={!!why} onClick={found}>
            立国
          </button>
        ) : (
          <button className="cp-btn primary" data-act="cede-pick" disabled={!!why} onClick={pick}>
            选择国家 ›
          </button>
        )}
      </Foot>
    </>
  );
}

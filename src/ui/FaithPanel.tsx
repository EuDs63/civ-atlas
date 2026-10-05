/**
 * 信仰的面板(和国家、城的面板同一套样子,零件见 panelParts.tsx),按时间轴当前那一年:
 *
 *   顶部  颜色块(这个教的颜色)、教名(可改)、"宗教，1140 年创立"(教派:"教派，2250 年分出";民间信仰:"民间信仰")、关闭
 *   按钮  创立那年(主操作:时间轴跳到创立那年;民间信仰 = 这个民族出现那年)/ 设为中心(转到圣城)/ 改名 /
 *         更多(看圣城;教派:看本教、看分出的国家;民间信仰:看发源的州)
 *   概况  大教:类型(带一句说明)、创立(年份、创教者、圣城)、圣城(今属哪国)、信众(小柱图 + 州数)、国教(这一年奉它为国教的国家)、教派
 *         教派:类型、来历(从哪个教分出、哪年、哪国)、信众、国教;没有圣城、教派两行
 *         民间信仰:类型、民族、信众
 *   大事  大教连同它的教派、教派自己的:最近 5 条(可点),"全部 N 件"展开全部;民间信仰没有
 * 卡片开着时,信仰图层上别的信仰变淡、地图上圈出圣城(见 faithSelection.ts)。
 */
import { useMemo, useState } from 'react';
import type { Civ, Faith } from '../gen/civ/types';
import { capitalAt, polityAlive, polityName } from '../gen/civ/growth';
import { cultureLabel } from '../gen/civ/display';
import { faithKey } from '../gen/edits';
import { faithCounts, statesOfFaith } from '../gen/civ/religion';
import { FORM_NOTE, eventRoot, faithHistory, fullChronicle } from '../gen/civ/religionText';
import { setSelection } from './civView';
import { NameEdit } from './NameEdit';
import { entriesUpTo, ownersOf } from './panelData';
import { Act, Acts, CenterAct, EventList, Link, MoreAct, PanelHead, Row, Spark, Stats, SubLine, jumpTo, rgb, type DetailProps } from './panelParts';
import { MenuItem } from './PopMenu';
import { Icon } from './icons';

/** 圣城这一年归谁:"今属大景王朝" / "今为部落地带" / "已成故城" */
function holyNote(civ: Civ, city: number, year: number): string {
  const s = civ.settlements[city];
  if (!s || year < s.founded) return '';
  if (s.ended !== undefined && year >= s.ended) return '已成故城';
  const cap = civ.polities.find((p) => polityAlive(p, year) && capitalAt(p, year) === city);
  const owner = cap ?? civ.polities[ownersOf(civ, year).polity[s.region]];
  return owner ? `今属${polityName(owner, year)}` : '今为部落地带';
}

export function FaithPanel({ civ, raw, world, id, year, names }: DetailProps) {
  const rel = civ.religion!;
  const f = rel.faiths[id];
  const [renaming, setRenaming] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const folk = f.kind === 'folk';
  const cu = folk ? civ.cultures[f.culture ?? f.id] : undefined;
  const born = folk ? (cu?.born ?? 0) <= year : (f.founded ?? 0) <= year;
  const counts = useMemo(() => faithCounts(civ, year), [civ, year]);
  const n = counts.n[id] ?? 0;
  const hist = faithHistory(civ);
  const maxN = Math.max(1, ...hist.n.map((x) => x[id] ?? 0));
  const states = statesOfFaith(rel, id, year).filter((s) => civ.polities[s.polity] && polityAlive(civ.polities[s.polity], year));
  const sects = rel.faiths.filter((x) => x.kind === 'sect' && x.parent === id && (x.founded ?? 0) <= year);
  const parent = f.kind === 'sect' && f.parent !== undefined ? rel.faiths[f.parent] : undefined;
  const holy = f.kind === 'great' && f.holy !== undefined ? civ.settlements[f.holy] : undefined;
  const events = useMemo(
    () => (folk ? [] : fullChronicle(civ).filter((e) => e.kind === 'faith' && (f.kind === 'great' ? eventRoot(civ, e) === id : e.faith === id))),
    [civ, id, folk, f.kind],
  );
  const upTo = entriesUpTo(events, year);
  const founded = Math.floor(f.founded ?? 0);
  const firstYear = folk ? Math.ceil(cu?.born ?? 0) : Math.ceil(f.founded ?? 0);
  const pol = (p: number | undefined, y: number) => (p !== undefined && civ.polities[p] ? <Link to={{ kind: 'polity', id: p }}>{polityName(civ.polities[p], y)}</Link> : null);
  const faithLink = (x: Faith) => <Link to={{ kind: 'faith', id: x.id }}>{x.name}</Link>;

  return (
    <div className="cp" data-faith={id}>
      <PanelHead color={rgb(f.color)}>
        <NameEdit
          k={faithKey(civ, id)}
          kind="faith"
          shown={f.name}
          current={f.name}
          fallback={raw.religion?.faiths[id]?.name ?? f.name}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
        />
        <SubLine
          className="ins-status"
          parts={folk ? ['民间信仰'] : f.kind === 'sect' ? ['教派', `${founded} 年${born ? '' : '才'}分出`] : ['宗教', `${founded} 年${born ? '' : '才'}创立`]}
        />
      </PanelHead>
      <Acts>
        <Act icon="history" primary act="founded-year" title={folk ? '跳到这个民族出现的那年' : `跳到 ${firstYear} 年`} onClick={() => jumpTo(firstYear)}>
          创立那年
        </Act>
        <CenterAct world={world} civ={civ} sel={{ kind: 'faith', id }} year={year} />
        <Act icon="rename" act="rename" onClick={() => setRenaming(true)}>
          改名
        </Act>
        <MoreAct>
          {holy && (
            <MenuItem icon={<Icon name="city" size={16} />} act="holy" onClick={() => setSelection({ kind: 'settlement', id: holy.id })}>
              看圣城
            </MenuItem>
          )}
          {parent && (
            <MenuItem icon={<Icon name="scroll" size={16} />} act="parent" onClick={() => setSelection({ kind: 'faith', id: parent.id })}>
              看本教
            </MenuItem>
          )}
          {f.kind === 'sect' && (
            <MenuItem
              icon={<Icon name="flag" size={16} />}
              act="polity"
              disabled={f.polity === undefined || !civ.polities[f.polity]}
              onClick={() => f.polity !== undefined && setSelection({ kind: 'polity', id: f.polity })}
            >
              看分出的国家
            </MenuItem>
          )}
          {folk && (
            <MenuItem icon={<Icon name="map" size={16} />} act="hearth" disabled={!cu || cu.hearth < 0} onClick={() => cu && setSelection({ kind: 'region', id: cu.hearth })}>
              看发源的州
            </MenuItem>
          )}
        </MoreAct>
      </Acts>
      <div className="cp-body">
        <Stats items={[]}>
          <Row k="类型">
            {folk ? '民间信仰' : (f.form ?? '—')}
            {!folk && f.form && <em className="cp-num-note">{FORM_NOTE[f.form]}</em>}
          </Row>
          {folk && <Row k="民族">{cu ? cultureLabel(cu) : '—'}</Row>}
          {f.kind === 'great' && (
            <Row k="创立">
              {founded} 年，{f.founder?.name ?? ''}
              {holy ? (
                <>
                  创于<Link to={{ kind: 'settlement', id: holy.id }}>{holy.name}</Link>
                </>
              ) : (
                '创立'
              )}
            </Row>
          )}
          {holy && (
            <Row k="圣城">
              <Link to={{ kind: 'settlement', id: holy.id }}>{holy.name}</Link>
              <em className="cp-num-note">{holyNote(civ, holy.id, year)}</em>
            </Row>
          )}
          {parent && (
            <Row k="来历">
              从{faithLink(parent)}分出，{founded} 年{f.polity !== undefined && civ.polities[f.polity] ? <>，{pol(f.polity, f.founded ?? 0)}</> : null}
            </Row>
          )}
          <Row k="信众" className="cp-terr">
            <Spark
              title={`历年州数(最多时 ${maxN} 州)`}
              bars={hist.years.map((y, i) => {
                const v = hist.n[i][id] ?? 0;
                return { h: Math.max(1, Math.round((v / maxN) * 16)), background: rgb(f.color), opacity: v ? (y <= year ? 1 : 0.35) : 0.2 };
              })}
            />
            <span data-stat="州">{born ? `${n} 个州` : '—'}</span>
          </Row>
          {!folk && (
            <Row k="国教" className="cp-links">
              {states.length ? (
                states.map((s) => (
                  <Link key={s.polity} to={{ kind: 'polity', id: s.polity }}>
                    {polityName(civ.polities[s.polity], year)}
                  </Link>
                ))
              ) : (
                <span className="cp-none">没有</span>
              )}
            </Row>
          )}
          {sects.length > 0 && (
            <Row k="教派" className="cp-links">
              {sects.map((x) => (
                <span key={x.id} className="cp-now">
                  {faithLink(x)}
                  <em>{Math.floor(x.founded ?? 0)} 年</em>
                </span>
              ))}
            </Row>
          )}
        </Stats>
        {!folk && (
          <EventList
            upTo={upTo}
            limit={allEvents ? upTo.length : 5}
            empty={born ? '还没有' : f.kind === 'sect' ? '尚未分出' : '尚未创立'}
            more={
              upTo.length > 5 && (
                <button className="ins-link cp-more" data-act="all-events" onClick={() => setAllEvents((v) => !v)}>
                  {allEvents ? '收起' : `全部 ${upTo.length} 件`}
                </button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

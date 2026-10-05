/**
 * 世界概览的"人物"页(在"编年史"后面):推演里的人物列成表,点一行打开人物卡片(收起概览,地图上亮出他的国家)。
 *
 *   名人   全世界的名将、名君、开国之君(gen/civ/peopleInfo.ts 按事迹打分挑的),按上台的年份排,新的在上;
 *          每人一行:年份、名字、一句为什么出名("大景王朝君主，在位时得五州，亲征萨尔斯坦帝国")
 *   君主   选了国家:按朝代分组(组名停在顶上),新的在上;一句"继父睿宗即位，时年 14 岁，在位 28 年，驾崩"。
 *          全部国家:先按国家(鼎盛时大的在前)、再按朝代分组;这时不是一条时间线,不画"现在"线
 *   将领   按第一次领兵的年份排,新的在上;一句"伐萨尔斯坦帝国，攻取三州"(全部国家时前面加"大景将领")
 * 国家下拉框只看这一国(国家卡片的"全部 N 位"进来 = 这国的君主);"复制全文"复制成纯文字。
 * 和编年史一样跟着时间轴:还没上台的淡显,"现在"线在第一位已经上台的上方(Chronicle.tsx 的 useNowLine)。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Civ, Person } from '../gen/civ/types';
import { polityName } from '../gen/civ/growth';
import { cnNumber } from '../gen/civ/chronicle';
import {
  campaignText,
  commandFoes,
  famousPeople,
  fameLine,
  foesText,
  generalTally,
  peopleIndex,
  personSpan,
  riseText,
} from '../gen/civ/peopleInfo';
import { generalRole, isConsul, personName, rulerFateWord } from '../gen/civ/peopleText';
import { setPeople, usePeople, type PeopleList } from './overviewStore';
import { useNowLine } from './Chronicle';
import { polityHistory } from './WorldOverviewCountries';
import { copyText, selectPerson } from './panelParts';
import './timeline.css';

const F = Math.floor;

interface PRow {
  x: Person;
  from: number;
  until: number | null;
  name: string;
  line: string;
}

interface Group {
  /** 组名(朝代 / 国家);没有 = 不分组 */
  head?: { name: string; note: string };
  rows: PRow[];
}

/** 君主一行:怎么上台、即位时多大、在位多久、怎么结局、亲征 */
function rulerLine(civ: Civ, x: Person): string {
  const consul = isConsul(civ, x);
  const from = x.from ?? x.born;
  const age = F(from - x.born);
  const parts = [riseText(civ, x) + (age < 15 ? `，时年 ${age} 岁` : '')];
  if (x.until === undefined) parts.push(consul ? '在任至今' : '在位至今');
  else {
    const n = F(x.until) - F(from);
    parts.push(n >= 1 ? `${consul ? '在任' : '在位'} ${n} 年` : `${consul ? '在任' : '在位'}不足一年`);
    const fate = rulerFateWord(civ, x);
    if (fate) parts.push(fate);
  }
  const foes = commandFoes(civ, x);
  return parts.join('，') + (foes.length ? `；${campaignText(civ, foes)}` : '');
}

/** 将领一行:伐谁抗谁、攻下几州、守住几次、战死 */
function generalLine(civ: Civ, x: Person, withPolity: boolean): string {
  const { took, held } = generalTally(civ, x);
  const parts = [withPolity ? generalRole(civ, x) : '', foesText(civ, commandFoes(civ, x))];
  if (took) parts.push(`攻取${cnNumber(took)}州`);
  if (held) parts.push(`击退来攻${cnNumber(held)}次`);
  if (x.fate === 'battle') parts.push('战死');
  return parts.filter(Boolean).join('，');
}

function rowOf(civ: Civ, x: Person, line: string): PRow {
  const s = personSpan(x);
  return { x, from: s.from, until: s.until, name: personName(civ, x), line };
}

/** 一国的君主按朝代分组(新的朝代在上,组里新的在上);label = 组名前面加国名(全部国家时) */
function rulerGroups(civ: Civ, polity: number, label: boolean): Group[] {
  const p = civ.polities[polity];
  const rs = peopleIndex(civ).rulers[polity] ?? [];
  const byDyn = new Map<number, Person[]>();
  for (const r of rs) {
    const d = r.dynasty ?? 0;
    if (!byDyn.has(d)) byDyn.set(d, []);
    byDyn.get(d)!.push(r);
  }
  const ds = p.dynasties ?? [];
  const multi = byDyn.size > 1;
  const out: Group[] = [];
  for (const [d, list] of [...byDyn].sort((a, b) => b[0] - a[0])) {
    const from = d === 0 ? p.founded : (ds[d]?.year ?? list[0].from ?? p.founded);
    const to = ds[d + 1]?.year ?? p.ended;
    const dyn = multi ? ds[d]?.name || polityName(p, from) : '';
    const pname = polityName(p, Math.min(civ.endYear, p.ended ?? civ.endYear) - 1 / 512);
    const name = label ? pname : dyn || pname;
    const note = `${label && dyn ? `${dyn}，` : ''}${F(from)}${to !== undefined ? `–${F(to)} 年` : ' 年起'}，${list.length} 位`;
    out.push({ head: { name, note }, rows: [...list].reverse().map((x) => rowOf(civ, x, rulerLine(civ, x))) });
  }
  return out;
}

export function PeoplePage({ civ }: { civ: Civ | null }) {
  const view = usePeople();
  const listRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const ok = !!civ && !!civ.people?.length;
  const polity = view.polity !== null && civ?.polities[view.polity] ? view.polity : null;
  const famous = useMemo(() => (ok ? famousPeople(civ!) : []), [ok, civ]);
  // 国家下拉框:有君主的国家,鼎盛时大的在前
  const choices = useMemo(() => {
    if (!ok) return [];
    const ix = peopleIndex(civ!);
    const peak = polityHistory(civ!).peak;
    return civ!.polities
      .filter((p) => ix.rulers[p.id]?.length)
      .sort((a, b) => peak[b.id] - peak[a.id] || a.id - b.id)
      .map((p) => ({ id: p.id, name: polityName(p, Math.min(civ!.endYear, p.ended ?? civ!.endYear) - 1 / 512) }));
  }, [ok, civ]);
  const counts = useMemo(() => {
    if (!ok) return { famous: 0, rulers: 0, generals: 0 };
    const ix = peopleIndex(civ!);
    const sum = (ls: Person[][]) => (polity !== null ? (ls[polity]?.length ?? 0) : ls.reduce((n, l) => n + l.length, 0));
    return {
      famous: polity !== null ? famous.filter((f) => civ!.people![f.id].polity === polity).length : famous.length,
      rulers: sum(ix.rulers),
      generals: sum(ix.generals),
    };
  }, [ok, civ, famous, polity]);
  const groups = useMemo((): Group[] => {
    if (!ok) return [];
    const c = civ!;
    const ps = c.people!;
    if (view.list === 'famous') {
      const rows = famous.filter((f) => polity === null || ps[f.id].polity === polity).map((f) => rowOf(c, ps[f.id], fameLine(c, ps[f.id], f)));
      return [{ rows }];
    }
    if (view.list === 'generals') {
      const ix = peopleIndex(c);
      const list = polity !== null ? ix.generals[polity] : ix.generals.flat();
      const rows = list.map((x) => rowOf(c, x, generalLine(c, x, polity === null)));
      rows.sort((a, b) => b.from - a.from || b.x.id - a.x.id);
      return [{ rows }];
    }
    if (polity !== null) return rulerGroups(c, polity, false);
    return choices.flatMap((ch) => rulerGroups(c, ch.id, true));
  }, [ok, civ, view.list, polity, famous, choices]);
  // 全部国家的君主不是一条时间线(一国一国列):只淡显,不画"现在"线
  const timeline = !(view.list === 'rulers' && polity === null);
  useNowLine({ listRef, nowRef, civ, jumpKey: groups, line: timeline });

  if (!civ) return <section className="chronicle people" />;
  if (!ok) return <div className="ov-empty">这个世界还没有人物</div>;

  const focus = polity !== null ? civ.polities[polity] : undefined;
  const focusName = focus ? (choices.find((c) => c.id === polity)?.name ?? polityName(focus, civ.endYear)) : '';
  const LISTS: { id: PeopleList; name: string; n: number; title: string }[] = [
    { id: 'famous', name: '名人', n: counts.famous, title: '按推演里的事迹挑出来的名将、名君、开国之君' },
    { id: 'rulers', name: focus?.lineage === 'republic' ? '执政' : '君主', n: counts.rulers, title: '历代君主,按朝代分组' },
    { id: 'generals', name: '将领', n: counts.generals, title: '领过兵的将领,按第一次领兵的年份排' },
  ];
  const listName = LISTS.find((l) => l.id === view.list)!.name;
  const end = civ.endYear;

  const copy = async () => {
    const lines = [`人物 · ${listName} · 种子 ${civ.seed}${focus ? ` · 只看${focusName}` : ''}`, ''];
    for (const g of groups) {
      if (g.head) lines.push(`${g.head.name}(${g.head.note})`);
      for (const r of g.rows) lines.push(`${F(r.from)}–${r.until !== null ? F(r.until) : ''} ${r.name} ${r.line}`);
      if (g.head) lines.push('');
    }
    const text = lines.join('\n').trim();
    (window as unknown as { __wfPeopleText: string }).__wfPeopleText = text;
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  let empty: ReactNode = null;
  if (!total) empty = view.list === 'famous' && focus ? `${focusName}没有名人,切到"君主"看看` : '没有符合的人物';

  return (
    <section className="chronicle people">
      <div className="chron-filters">
        <div className="seg">
          {LISTS.map((l) => (
            <button key={l.id} className={view.list === l.id ? 'on' : ''} data-list={l.id} title={l.title} onClick={() => setPeople({ list: l.id })}>
              {l.name} <span className="chron-n">{l.n}</span>
            </button>
          ))}
        </div>
        <label className={`chron-pick${focus ? ' on' : ''}`}>
          {focus && <i style={{ background: `rgb(${focus.color.join(',')})` }} aria-hidden="true" />}
          <select aria-label="只看某一国" data-act="people-polity" value={polity ?? ''} onChange={(ev) => setPeople({ polity: ev.target.value === '' ? null : Number(ev.target.value) })}>
            <option value="">全部国家</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <span className="chron-acts">
          <button className="ov-btn chron-copy" data-act="people-copy" onClick={() => void copy()} disabled={!total} title="把列出的人物复制成纯文本">
            {copied ? '已复制' : '复制全文'}
          </button>
        </span>
      </div>
      <div className="chron-list" ref={listRef}>
        {groups.map((g, gi) => (
          <div key={gi} className="pp-sect">
            {g.head && (
              <div className="pp-group">
                <b>{g.head.name}</b>
                <span>{g.head.note}</span>
              </div>
            )}
            {g.rows.map((r) => (
              <div key={r.x.id} className="chron-item">
                <div
                  className="chron-row pp-row"
                  data-y={r.from}
                  data-e={r.until ?? end + 1}
                  data-top="1"
                  data-person={r.x.id}
                  data-ev={r.x.role === 'ruler' ? 'dynasty' : 'war'}
                  title="看这个人"
                  onClick={() => selectPerson(r.x.id)}
                >
                  <span className="chron-year">
                    {F(r.from)}
                    <em>–{r.until !== null ? F(r.until) : ''}</em>
                  </span>
                  <b className="pp-who">{r.name}</b>
                  <span className="chron-text">{r.line}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
        <div className="chron-now" ref={nowRef}>
          <span />
        </div>
        {empty && <div className="ov-empty">{empty}</div>}
      </div>
    </section>
  );
}

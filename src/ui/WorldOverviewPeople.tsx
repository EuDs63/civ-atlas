/**
 * 世界概览的"人物"页(在"编年史"后面):推演里的人物列成表,点一行打开人物卡片(收起概览,地图上亮出他的国家)。
 *
 *   我的   作者自己的人物(gen/characters.ts),按生年排,新的在上;每人一行:生卒、头像和名字、"大景王朝书记官，22 岁"
 *          (年龄跟着时间轴);右上「新建人物」。有自己的人物时先看这一档,一个都没有时先看「名人」
 *   名人   全世界的名将、名君、开国之君(gen/civ/peopleInfo.ts 按事迹打分挑的),按上台的年份排,新的在上;
 *          每人一行:年份、名字、一句为什么出名("大景王朝君主，在位时得五州，亲征萨尔斯坦帝国")
 *   君主   选了国家:按朝代分组(组名停在顶上),新的在上;一句"继父睿宗即位，时年 14 岁，在位 28 年，驾崩"。
 *          全部国家:先按国家(鼎盛时大的在前)、再按朝代分组;这时不是一条时间线,不画"现在"线。
 *          只看一国、不是共和国时右上多「列表 | 世系图」:世系图一朝一棵家谱树(PeopleLineage.tsx)
 *   将领   按第一次领兵的年份排,新的在上;一句"伐萨尔斯坦帝国，攻取三州"(全部国家时前面加"大景将领")
 * 国家下拉框只看这一国(国家卡片的"全部 N 位"进来 = 这国的君主);"复制全文"复制成纯文字(世系图 = 缩进的家谱)。
 * 和编年史一样跟着时间轴:还没上台的淡显,"现在"线在第一位已经上台的上方(Chronicle.tsx 的 useNowLine)。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Civ, Person } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import type { AuthorCharacter } from '../gen/characters';
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
import { hasLineage, lineageText } from '../gen/civ/lineageInfo';
import { closeOverview, setPeople, usePeople, type PeopleList } from './overviewStore';
import { useEdits } from './editsStore';
import { setSelection } from './civView';
import { newCharacterDraft } from './characterStore';
import { characterLine, characterPolity } from './characterInfo';
import { CharAvatar } from './CharacterPanel';
import { useYear } from './WorldOverviewMarks';
import { useNowLine } from './Chronicle';
import { polityHistory } from './WorldOverviewCountries';
import { copyText, selectPerson } from './panelParts';
import { PolityFlag } from './Flag';
import { PeopleLineage } from './PeopleLineage';
import './timeline.css';

const F = Math.floor;

interface PRow {
  /** 推演里的人(「我的」那一档没有) */
  x?: Person;
  /** 作者的人物(「我的」那一档;x 不用) */
  c?: AuthorCharacter;
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

function rowOf(civ: Civ, x: Person, line: string): PRow & { x: Person } {
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

export function PeoplePage({ civ, data }: { civ: Civ | null; data: { world: World; raster: Raster } | null }) {
  const view0 = usePeople();
  const chars = useEdits().characters;
  const year = useYear(civ);
  const ok = !!civ && !!civ.people?.length;
  // 还没挑过哪一档:有自己的人物先看「我的」;推演里没有人(比如太冷没人住的星球)只有「我的」
  const view = { ...view0, list: !ok ? 'mine' : (view0.list ?? (chars?.length ? 'mine' : 'famous')) };
  const listRef = useRef<HTMLDivElement>(null);
  const nowRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
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
  // 我的:按国家筛(他的国家),按生年排,新的在上;不靠推演里的人
  const mine = useMemo((): AuthorCharacter[] => {
    if (!civ || !data || !chars?.length) return [];
    return chars.filter((c) => polity === null || characterPolity(civ!, data.world, data.raster, c) === polity).sort((a, b) => b.born - a.born || b.id - a.id);
  }, [civ, data, chars, polity]);
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
    if (!civ) return [];
    if (view.list === 'mine') {
      const rows = data ? mine.map((ch): PRow => ({ c: ch, from: ch.born, until: ch.died ?? null, name: ch.name, line: characterLine(civ, data.world, data.raster, ch, year, chars ?? []) })) : [];
      return [{ rows }];
    }
    if (!ok) return [];
    const c = civ;
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
  }, [ok, civ, view.list, polity, famous, choices, mine, data, year, chars]);
  // 世系图:「君主」、只看一国、不是共和国
  const canTree = ok && view.list === 'rulers' && polity !== null && hasLineage(civ!, polity);
  const tree = canTree && view.tree;
  // 全部国家的君主不是一条时间线(一国一国列):只淡显,不画"现在"线
  const timeline = !(view.list === 'rulers' && polity === null);
  useNowLine({ listRef, nowRef, civ, jumpKey: groups, line: timeline, deps: [tree] });

  if (!civ) return <section className="chronicle people" />;

  const focus = polity !== null ? civ.polities[polity] : undefined;
  const focusName = focus ? (choices.find((c) => c.id === polity)?.name ?? polityName(focus, civ.endYear)) : '';
  const LISTS: { id: PeopleList; name: string; n: number; title: string }[] = [
    { id: 'mine', name: '我的', n: mine.length, title: '自己放进这个世界的人物' },
    ...(ok
      ? [
          { id: 'famous' as const, name: '名人', n: counts.famous, title: '按推演里的事迹挑出来的名将、名君、开国之君' },
          { id: 'rulers' as const, name: focus?.lineage === 'republic' ? '执政' : '君主', n: counts.rulers, title: '历代君主,按朝代分组' },
          { id: 'generals' as const, name: '将领', n: counts.generals, title: '领过兵的将领,按第一次领兵的年份排' },
        ]
      : []),
  ];
  const listName = LISTS.find((l) => l.id === view.list)!.name;
  const end = civ.endYear;

  const copy = async () => {
    const lines = [`人物 · ${listName}${tree ? ' · 世系图' : ''} · 种子 ${civ.seed}${focus ? ` · 只看${focusName}` : ''}`, ''];
    if (tree) lines.push(lineageText(civ, polity!));
    for (const g of tree ? [] : groups) {
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
  const newChar = () => {
    closeOverview();
    newCharacterDraft({ year });
  };
  if (!total)
    empty =
      view.list === 'mine' && !chars?.length ? (
        <div className="oc-empty-mine">
          <span>还没有自己的人物。写上名字、生卒和出生地，再加几段经历，地图上就能看到他一生走过的地方，年龄跟着时间轴算。</span>
          <button className="ov-btn ov-primary" data-act="character-new-empty" onClick={newChar}>
            新建人物
          </button>
        </div>
      ) : view.list === 'famous' && focus ? (
        `${focusName}没有名人,切到"君主"看看`
      ) : (
        '没有符合的人物'
      );

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
        {ok && (
        <label className={`chron-pick${focus ? ' on' : ''}`}>
          {focus && <PolityFlag id={focus.id} year={civ.endYear} w={21} className="chron-flag" fallback={<i style={{ background: `rgb(${focus.color.join(',')})` }} aria-hidden="true" />} />}
          <select aria-label="只看某一国" data-act="people-polity" value={polity ?? ''} onChange={(ev) => setPeople({ polity: ev.target.value === '' ? null : Number(ev.target.value) })}>
            <option value="">全部国家</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        )}
        <span className="chron-acts">
          {view.list === 'mine' && !!chars?.length && (
            <button className="ov-btn ov-primary oc-new" data-act="character-new" onClick={newChar}>
              新建人物
            </button>
          )}
          {canTree && (
            <span className="seg lg-seg" role="group" aria-label="怎么看">
              <button className={tree ? '' : 'on'} data-act="people-as-list" aria-pressed={!tree} onClick={() => setPeople({ tree: false })}>
                列表
              </button>
              <button className={tree ? 'on' : ''} data-act="people-as-tree" aria-pressed={tree} title="一朝一棵家谱树" onClick={() => setPeople({ tree: true, dynasty: null, focus: null })}>
                世系图
              </button>
            </span>
          )}
          <button className="ov-btn chron-copy" data-act="people-copy" onClick={() => void copy()} disabled={!total} title={tree ? '把这国的家谱复制成纯文本' : '把列出的人物复制成纯文本'}>
            {copied ? '已复制' : '复制全文'}
          </button>
        </span>
      </div>
      {tree ? (
        <div className="chron-list lg-box">
          <PeopleLineage civ={civ} polity={polity!} dynasty={view.dynasty} focus={view.focus} year={year} />
        </div>
      ) : (
      <div className="chron-list" ref={listRef}>
        {groups.map((g, gi) => (
          <div key={gi} className="pp-sect">
            {g.head && (
              <div className="pp-group">
                <b>{g.head.name}</b>
                <span>{g.head.note}</span>
              </div>
            )}
            {g.rows.map((r) =>
              r.c ? (
                <div key={`c${r.c.id}`} className="chron-item">
                  <div
                    className="chron-row pp-row oc-row-mine"
                    data-y={r.from}
                    data-e={r.until !== null ? r.until + 1 : end + 1}
                    data-top="1"
                    data-character={r.c.id}
                    data-ev="found"
                    title="看这个人物"
                    onClick={() => {
                      closeOverview();
                      setSelection({ kind: 'character', id: r.c!.id });
                    }}
                  >
                    <span className="chron-year">
                      {F(r.from)}
                      <em>–{r.until !== null ? F(r.until) : ''}</em>
                    </span>
                    <b className="pp-who">
                      <CharAvatar c={r.c} size={24} />
                      {r.name}
                    </b>
                    <span className="chron-text">{r.line}</span>
                  </div>
                </div>
              ) : (
              <div key={r.x!.id} className="chron-item">
                <div
                  className="chron-row pp-row"
                  data-y={r.from}
                  data-e={r.until ?? end + 1}
                  data-top="1"
                  data-person={r.x!.id}
                  data-ev={r.x!.role === 'ruler' ? 'dynasty' : 'war'}
                  title="看这个人"
                  onClick={() => selectPerson(r.x!.id)}
                >
                  <span className="chron-year">
                    {F(r.from)}
                    <em>–{r.until !== null ? F(r.until) : ''}</em>
                  </span>
                  <b className="pp-who">{r.name}</b>
                  <span className="chron-text">{r.line}</span>
                </div>
              </div>
              ),
            )}
          </div>
        ))}
        <div className="chron-now" ref={nowRef}>
          <span />
        </div>
        {empty && <div className="ov-empty">{empty}</div>}
      </div>
      )}
    </section>
  );
}

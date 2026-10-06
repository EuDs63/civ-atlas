/**
 * 人物卡片(和国家卡片同一套样子,零件见 panelParts.tsx):点编年史、卡片、人物页、搜索里的人名打开。
 * 地图上亮出他的国家(civView.ts 的 MapSelection、flyTo.ts 的 mapTarget);点人名不挪时间轴,按"即位那年 / 出征那年"才跳。
 *
 *   顶部  国家颜色块、称呼("圣宗柳玄""阿尔德里克三世""楚尧")、"大景皇帝，2485–2519 年在位" / "大景将领，2478–2509 年领兵"
 *   按钮  即位那年 / 出征那年(主操作:时间轴跳过去)、编年史(这国的编年史,滚到他在台上那段)、复制生平(纯文字,写设定用)、
 *         更多(加一个和他有关的作者人物:亲友里先填上他)
 *   概况  君主:事迹(名人才有)、国家、生卒、在位、前任、继任(后面的小字是亲属,和编年史的"其子 / 其弟"同一个算法)、
 *         结局、亲征、将领(在位时本国领兵的);共和国写"在任""执政"
 *         将领:事迹、国家、生卒、领兵(伐谁 / 抗谁)、效力(那几年在位的君主)、对手(同一场仗对面的统帅)、结局
 *   作者的人物  亲友里有他、经历里勾了他的作者人物(characterInfo.ts 的 charactersOfPerson),没有就不显示
 *   在位时 / 领兵时  他在台上那几年本国的事(将领 = 他经手的那几仗),新的在上;点一条跳到那一年
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { Civ, Person } from '../gen/civ/types';
import { polityName } from '../gen/civ/growth';
import { buildChronicle, filterChronicle, reignEntries, type ChronicleEntry } from '../gen/civ/chronicle';
import { commandFoes, peopleIndex, personFame, personSpan, rulerNeighbors, type Foe } from '../gen/civ/peopleInfo';
import { KIN_BACK, ageAt, generalRole, isConsul, kinOf, personName, rulerFateWord, rulerRole } from '../gen/civ/peopleText';
import { personKey } from '../gen/characters';
import { openOverview } from './overviewStore';
import { useEdits } from './editsStore';
import { newCharacterDraft } from './characterStore';
import { charactersOfPerson } from './characterInfo';
import { CharacterRefs } from './CharacterPanel';
import { MenuItem } from './PopMenu';
import { Icon } from './icons';
import { Act, Acts, EventList, Link, MoreAct, PanelHead, Row, Stats, SubLine, copyText, jumpTo, rgb, type DetailProps } from './panelParts';

const F = Math.floor;

/** 一行概况:k 名目、node 显示的、text 复制生平时的纯文字 */
interface Line {
  k: string;
  node: ReactNode;
  text: string;
}

/** 一串人名(都能点);多于 max 个只列前面的,后面写"等 N 位" */
function peopleLine(civ: Civ, list: readonly Person[], max = 6): { node: ReactNode; text: string } {
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  return {
    node: (
      <>
        {shown.map((g, i) => (
          <Fragment key={g.id}>
            {i > 0 && '、'}
            <Link to={{ kind: 'person', id: g.id }}>{personName(civ, g)}</Link>
          </Fragment>
        ))}
        {more > 0 && <em className="cp-num-note">等 {list.length} 位</em>}
      </>
    ),
    text: shown.map((g) => personName(civ, g)).join('、') + (more > 0 ? ` 等 ${list.length} 位` : ''),
  };
}

/** 伐 / 抗哪国(国名能点)+ 年份 */
function foesLine(civ: Civ, foes: readonly Foe[]): { node: ReactNode; text: string } {
  return {
    node: foes.map((f, i) => (
      <Fragment key={i}>
        {i > 0 && '、'}
        {f.verb}
        <Link to={{ kind: 'polity', id: f.polity }}>{polityName(civ.polities[f.polity], f.from)}</Link>
        <em className="cp-num-note">
          {F(f.from)}–{F(f.until)}
        </em>
      </Fragment>
    )),
    text: foes.map((f) => `${f.verb}${polityName(civ.polities[f.polity], f.from)}(${F(f.from)}–${F(f.until)})`).join('、'),
  };
}

/** 本国的纪事(战争拆成一件一件)+ 历代继位,按先后 */
function polityEntries(civ: Civ, polity: number): ChronicleEntry[] {
  const out: ChronicleEntry[] = [];
  for (const e of filterChronicle(buildChronicle(civ), { polity })) {
    if (e.children?.length) out.push(...e.children);
    else out.push(e);
  }
  out.push(...filterChronicle(reignEntries(civ), { polity }));
  return out.sort((a, b) => a.year - b.year || a.id - b.id);
}

export function PersonPanel({ civ, id, year }: DetailProps) {
  const x = civ.people?.[id];
  const p = x ? civ.polities[x.polity] : undefined;
  const [copied, setCopied] = useState(false);
  const chars = useEdits().characters;
  const lines = useMemo(() => (x && p ? personLines(civ, x) : []), [civ, x, p]);
  const events = useMemo(() => (x && p ? personEvents(civ, x) : []), [civ, x, p]);
  const refs = useMemo(() => charactersOfPerson(civ, chars, id), [civ, chars, id]);
  if (!x || !p) return null;
  const ruler = x.role === 'ruler';
  const consul = isConsul(civ, x);
  const span = personSpan(x);
  const end = span.until ?? civ.endYear;
  const sub = ruler
    ? span.until === null
      ? `${rulerRole(civ, x)}，${F(span.from)} 年${consul ? '就任' : '即位'}`
      : `${rulerRole(civ, x)}，${F(span.from)}–${F(span.until)} 年${consul ? '在任' : '在位'}`
    : `${generalRole(civ, x)}，${F(span.from)}–${F(end)} 年领兵`;
  const name = personName(civ, x);
  const head = ruler ? (consul ? '在任时' : '在位时') : '领兵时';

  const copy = async () => {
    const out = [name, sub, ...lines.map((l) => `${l.k}：${l.text}`)];
    if (events.length) out.push('', `${head}：`, ...events.map((e) => `${F(e.year)} ${e.text.replace(/^【干预】/, '')}`));
    const text = out.join('\n');
    (window as unknown as { __wfPersonText: string }).__wfPersonText = text;
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="cp pp" data-person={id}>
      <PanelHead color={rgb(p.color)}>
        <div className="ins-name-row big">
          <span className="ins-name pp-title">{name}</span>
        </div>
        <SubLine parts={[sub]} />
      </PanelHead>
      <Acts>
        <Act icon="history" primary act="person-year" onClick={() => jumpTo(span.from)} title={`时间轴跳到 ${F(span.from)} 年`}>
          {ruler ? (consul ? '就任那年' : '即位那年') : '出征那年'}
        </Act>
        <Act icon="scroll" act="person-chronicle" onClick={() => openOverview('chronicle', { polity: x.polity, major: false, at: end })}>
          编年史
        </Act>
        <Act icon="copy" act="person-copy" onClick={() => void copy()}>
          {copied ? '已复制' : '复制生平'}
        </Act>
        <MoreAct>
          <MenuItem icon={<Icon name="person" size={16} />} act="person-add-character" onClick={() => newCharacterDraft({ kin: [{ rel: '', person: personKey(civ, id) }], year })}>
            加一个和他有关的人物
          </MenuItem>
        </MoreAct>
      </Acts>
      <div className="cp-body">
        <Stats items={[]}>
          {lines.map((l) => (
            <Row key={l.k} k={l.k}>
              {l.node}
            </Row>
          ))}
        </Stats>
        <CharacterRefs refs={refs} />
        <EventList
          civ={civ}
          self={id}
          title={head}
          upTo={events}
          limit={12}
          empty="这几年本国无事可记"
          more={
            <button className="ins-link cp-more" data-act="person-chronicle-more" onClick={() => openOverview('chronicle', { polity: x.polity, major: false, at: end })}>
              在编年史中查看
            </button>
          }
        />
      </div>
    </div>
  );
}

/** 概况的每一行 */
function personLines(civ: Civ, x: Person): Line[] {
  const p = civ.polities[x.polity];
  const out: Line[] = [];
  const fame = personFame(civ, x);
  if (fame?.deeds) out.push({ k: '事迹', node: fame.deeds, text: fame.deeds });
  const span = personSpan(x);
  const pn = polityName(p, span.from);
  out.push({ k: '国家', node: <Link to={{ kind: 'polity', id: p.id }}>{pn}</Link>, text: pn });
  if (x.died !== undefined) {
    // 享年按实际活了多久算(和编年史的"时年"一样),不是两个年份相减
    const age = ageAt(x, x.died);
    out.push({
      k: '生卒',
      node: (
        <>
          {F(x.born)}–{F(x.died)} 年<em className="cp-num-note">享年 {age} 岁</em>
        </>
      ),
      text: `${F(x.born)}–${F(x.died)} 年，享年 ${age} 岁`,
    });
  } else out.push({ k: '生卒', node: `${F(x.born)} 年生`, text: `${F(x.born)} 年生` });
  const foes = commandFoes(civ, x);
  if (x.role === 'ruler') rulerLines(civ, x, out, foes);
  else generalLines(civ, x, out, foes);
  return out;
}

function rulerLines(civ: Civ, x: Person, out: Line[], foes: Foe[]) {
  const consul = isConsul(civ, x);
  const from = x.from ?? x.born;
  if (x.until !== undefined) {
    const n = F(x.until) - F(from);
    const len = n >= 1 ? `${n} 年` : '不足一年';
    out.push({
      k: consul ? '在任' : '在位',
      node: (
        <>
          {F(from)}–{F(x.until)} 年<em className="cp-num-note">{len}</em>
        </>
      ),
      text: `${F(from)}–${F(x.until)} 年，${len}`,
    });
  } else {
    const t = consul ? `${F(from)} 年就任，在任至今` : `${F(from)} 年即位，在位至今`;
    out.push({ k: consul ? '在任' : '在位', node: t, text: t });
  }
  const { prev, next } = rulerNeighbors(civ, x);
  // 亲属:同一朝、继位的才写(和编年史的"其子 / 其弟"一致);换了朝代写"前朝 / 新朝"
  const sameDyn = (a: Person, b: Person) => (a.dynasty ?? 0) === (b.dynasty ?? 0);
  if (prev) {
    const note = consul ? '' : !sameDyn(prev, x) ? '前朝' : x.rise === 'heir' ? KIN_BACK[kinOf(prev, x)] : '';
    out.push(personRow('前任', civ, prev, note));
  }
  if (next) {
    const note = consul ? '' : !sameDyn(x, next) ? '新朝' : next.rise === 'heir' ? kinOf(x, next) : '';
    out.push(personRow('继任', civ, next, note));
  }
  const fate = rulerFateWord(civ, x);
  if (fate) {
    // 失位以后又活了些年(被废、出奔……)的,写上卒年
    const later = x.died !== undefined && x.until !== undefined && x.died - x.until >= 1 ? `，${F(x.died)} 年卒` : '';
    out.push({ k: '结局', node: fate + later, text: fate + later });
  }
  if (foes.length) out.push({ k: consul ? '领兵' : '亲征', ...foesLine(civ, foes) });
  // 在位时本国领兵的将领
  const until = x.until ?? civ.endYear;
  const gens = peopleIndex(civ).generals[x.polity].filter((g) => (g.commands ?? []).some((c) => c.until > from && c.from < until));
  if (gens.length) out.push({ k: '将领', ...peopleLine(civ, gens) });
}

function generalLines(civ: Civ, x: Person, out: Line[], foes: Foe[]) {
  const cs = x.commands ?? [];
  if (foes.length) out.push({ k: '领兵', ...foesLine(civ, foes) });
  // 效力:他领兵那几年在位的本国君主
  const ix = peopleIndex(civ);
  const served = ix.rulers[x.polity].filter((r) => cs.some((c) => (r.from ?? Infinity) < c.until && (r.until ?? Infinity) > c.from));
  if (served.length) out.push({ k: '效力', ...peopleLine(civ, served) });
  // 对手:同一场仗、同一段时间对面的统帅(君主亲征的也算)
  const foesP: Person[] = [];
  for (const o of civ.people ?? []) {
    if (o.id === x.id || o.polity === x.polity || !o.commands) continue;
    if (o.commands.some((oc) => cs.some((c) => c.war === oc.war && oc.side !== c.side && oc.until > c.from && oc.from < c.until))) foesP.push(o);
  }
  if (foesP.length) out.push({ k: '对手', ...peopleLine(civ, foesP) });
  const last = cs.length ? cs[cs.length - 1].until : x.born;
  let fate = '';
  if (x.fate === 'battle') fate = x.died !== undefined ? `战死，${F(x.died)} 年` : '战死';
  else if (x.died !== undefined) fate = x.died - last >= 1 ? `卸甲，${F(x.died)} 年卒` : `${F(x.died)} 年卒于军中`;
  if (fate) out.push({ k: '结局', node: fate, text: fate });
}

/** 前任 / 继任:人名能点,后面小字写亲属 */
function personRow(k: string, civ: Civ, y: Person, note: string): Line {
  const n = personName(civ, y);
  return {
    k,
    node: (
      <>
        <Link to={{ kind: 'person', id: y.id }}>{n}</Link>
        {note && <em className="cp-num-note">{note}</em>}
      </>
    ),
    text: note ? `${n}(${note})` : n,
  };
}

/** 在位时 / 领兵时的事(按先后) */
function personEvents(civ: Civ, x: Person): ChronicleEntry[] {
  const all = polityEntries(civ, x.polity);
  const eps = 1e-6;
  if (x.role === 'ruler') {
    const from = x.from ?? x.born;
    const until = x.until ?? civ.endYear;
    return all.filter((e) => e.year >= from - eps && e.year <= until + eps);
  }
  // 将领:他经手的那几件(宣战、战役、攻占:史事下标在他任期的第一件到最后一件之间)
  const cs = x.commands ?? [];
  const mine = all.filter((e) => e.kind !== 'reign' && cs.some((c) => e.id >= c.first && e.id <= c.last && civ.annals[e.id]?.war === c.war));
  if (mine.length) return mine;
  return all.filter((e) => e.kind !== 'reign' && cs.some((c) => e.year >= c.from - eps && e.year <= c.until + eps));
}

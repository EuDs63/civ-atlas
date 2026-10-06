/**
 * 世系图要用的:谁是谁的父亲、子嗣,一国有几朝,一朝的家谱树怎么排、标题和结尾怎么写、复制成文字。
 * 只读推演记下的 Person.parent(lineage.ts),纯计算;人物页的世系图(PeopleLineage.tsx)、人物卡片的「父亲」「子嗣」用它。
 *
 * 一朝一棵树:这一朝即位的君主 + 推演补上的没即位的宗室(role = 'prince',dynasty 同一朝)。
 * 树的排法:一代一行;兄弟按长幼从左往右;父亲在传下去的那一支(子孙里有最后即位的君主)正上方,所以主干是一条直线往下;
 * 子树之间按每一代的左右边缘挤紧(位置以"一格"为单位,一格 = 一个方框宽加间距)。
 * 找不到合年纪的父亲、兜底成"宗室"的君主连不上这一朝开国的那一支:另起一小棵(远支)。
 */
import type { Civ, Person, Year } from './types';
import { polityName } from './growth';
import { peopleIndex, riseText } from './peopleInfo';
import { personName, rulerShort } from './peopleText';

interface LineageIndex {
  /** 人物编号 → 子嗣(按出生先后) */
  kids: Map<number, Person[]>;
  /** 国家 → 没即位的宗室 */
  princes: Person[][];
}

const cache = new WeakMap<object, LineageIndex>();

function lineageIndex(civ: Civ): LineageIndex {
  const key = civ.people ?? civ.annals;
  const hit = cache.get(key);
  if (hit && hit.princes.length === civ.polities.length) return hit;
  const ix: LineageIndex = { kids: new Map(), princes: civ.polities.map(() => []) };
  for (const x of civ.people ?? []) {
    if (x.role === 'prince' && ix.princes[x.polity]) ix.princes[x.polity].push(x);
    if (x.parent === undefined) continue;
    if (!ix.kids.has(x.parent)) ix.kids.set(x.parent, []);
    ix.kids.get(x.parent)!.push(x);
  }
  for (const ks of ix.kids.values()) ks.sort((a, b) => a.born - b.born || a.id - b.id);
  cache.set(key, ix);
  return ix;
}

/** 父亲(没记 = undefined:一朝的第一位、共和国执政官、将领、兜底成宗室的君主) */
export function fatherOf(civ: Civ, x: Person): Person | undefined {
  return x.parent !== undefined ? civ.people?.[x.parent] : undefined;
}

/** 子嗣(按出生先后;只有世系图里有的人:即位的君主和他们没即位的父辈) */
export function kidsOf(civ: Civ, x: Person): Person[] {
  return lineageIndex(civ).kids.get(x.id) ?? [];
}

/** 这国有没有世系图:不是共和国、有君主 */
export function hasLineage(civ: Civ, polity: number): boolean {
  const p = civ.polities[polity];
  return !!p && p.lineage !== 'republic' && (peopleIndex(civ).rulers[polity]?.length ?? 0) > 0;
}

/** 一国的一朝(只列有君主的) */
export interface DynastyRow {
  /** Polity.dynasties 的下标(= Person.dynasty) */
  index: number;
  /** 朝名("景";没改朝换代过的国家 = 国名) */
  name: string;
  from: Year;
  /** 到哪年(下一朝开始、亡国);还在 = undefined */
  to?: Year;
  /** 这一朝的君主(即位先后) */
  rulers: Person[];
}

/** 一国的各朝,先后排 */
export function dynastyRows(civ: Civ, polity: number): DynastyRow[] {
  const p = civ.polities[polity];
  if (!p) return [];
  const ds = p.dynasties ?? [];
  const by = new Map<number, Person[]>();
  for (const r of peopleIndex(civ).rulers[polity] ?? []) {
    const d = r.dynasty ?? 0;
    if (!by.has(d)) by.set(d, []);
    by.get(d)!.push(r);
  }
  const pname = polityName(p, Math.min(civ.endYear, p.ended ?? civ.endYear) - 1 / 512);
  return [...by]
    .sort((a, b) => a[0] - b[0])
    .map(([d, rulers]) => {
      const from = d === 0 ? p.founded : (ds[d]?.year ?? rulers[0].from ?? p.founded);
      return { index: d, name: (by.size > 1 && ds[d]?.name) || pname, from, to: ds[d + 1]?.year ?? p.ended, rulers };
    });
}

/** year 那一年的那一朝(rows 的下标):还没立国 = 第一朝;已经亡了 = 最后一朝 */
export function dynastyRowAt(rows: readonly DynastyRow[], year: Year): number {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].from <= year) return i;
  return 0;
}

/** 这一朝第几位君主(1 起;不是这一朝的君主 = 0) */
export function reignOrder(row: DynastyRow, x: Person): number {
  return row.rulers.indexOf(x) + 1;
}

/**
 * 树的标题后半句:"2377–2794 年，27 位君主；太祖柳渺玄起兵代衍朝开国"(开国那句:起兵代某朝开国 / 立国 / 篡位 /
 * 叛某国自立 / 复某国之国 / 起兵建立新朝;继位来的不写)
 */
export function dynastyNote(civ: Civ, rows: readonly DynastyRow[], i: number): string {
  const row = rows[i];
  const span = `${Math.floor(row.from)}${row.to !== undefined ? `–${Math.floor(row.to)} 年` : ' 年起'}`;
  const first = row.rulers[0];
  const p = civ.polities[first.polity];
  let rise = '';
  if (first.rise === 'rise' && p?.eastern && rows[i - 1]) rise = `起兵代${rows[i - 1].name}朝开国`;
  else if (first.rise && first.rise !== 'heir') rise = riseText(civ, first).replace('，', '');
  return `${span}，${row.rulers.length} 位君主${rise ? `；${personName(civ, first)}${rise}` : ''}`;
}

/** 最后一位下面那句这一朝怎么结束:"2794 年，渊朝起兵代之""2884 年，提贝亚国亡";还在 = 空串 */
export function dynastyEnd(civ: Civ, rows: readonly DynastyRow[], i: number): string {
  const row = rows[i];
  if (!row || row.to === undefined) return '';
  const p = civ.polities[row.rulers[0].polity];
  const y = `${Math.floor(row.to)} 年`;
  const next = rows[i + 1];
  if (!next) return `${y}，${polityName(p, row.to - 1 / 512)}亡`;
  const nu = next.rulers[0];
  if (nu.rise === 'usurp') return `${y}，${rulerShort(civ, nu)}篡位`;
  if (p.eastern) return `${y}，${next.name}朝起兵代之`;
  return `${y}，${p.lineage === 'khanate' ? '汗位易主' : '王室更迭'}，${next.name}兴`;
}

/** 一朝树里的人:这一朝的君主 + 同一朝补上的宗室 */
export function dynastyMembers(civ: Civ, row: DynastyRow): Person[] {
  const polity = row.rulers[0]?.polity ?? -1;
  const princes = lineageIndex(civ).princes[polity] ?? [];
  return [...row.rulers, ...princes.filter((x) => (x.dynasty ?? 0) === row.index)];
}

/** 排好的一个人:x = 第几格(可以是负的、整数),depth = 第几代(0 = 树根) */
export interface PlacedPerson {
  p: Person;
  x: number;
  depth: number;
}

/** 一朝的一棵树;distant = 连不上开国那一支的远支 */
export interface LineageTree {
  nodes: PlacedPerson[];
  distant: boolean;
}

/** 一朝排成几棵树:第一棵是开国那一支,远支按即位先后跟在后面 */
export function layoutDynasty(civ: Civ, row: DynastyRow): LineageTree[] {
  const members = dynastyMembers(civ, row);
  const inTree = new Set(members);
  const kids = (n: Person) => kidsOf(civ, n).filter((k) => inTree.has(k));
  // 这一支里最后即位的那年:父亲放在这个值最大的儿子正上方
  const last = new Map<Person, number>();
  const lastReign = (n: Person): number => {
    let v = last.get(n);
    if (v === undefined) {
      v = Math.max(n.role === 'ruler' ? (n.from ?? n.born) : -Infinity, ...kids(n).map(lastReign));
      last.set(n, v);
    }
    return v;
  };
  // 每棵子树:每一代最左、最右占到第几格(相对子树的根),各人的位置
  const lay = (n: Person): { lc: number[]; rc: number[]; pos: [Person, number, number][] } => {
    const ks = kids(n);
    if (!ks.length) return { lc: [0], rc: [0], pos: [[n, 0, 0]] };
    const subs = ks.map(lay);
    const offs = [0];
    const L = subs[0].lc.slice();
    const R = subs[0].rc.slice();
    for (let i = 1; i < subs.length; i++) {
      const s = subs[i];
      let shift = -Infinity;
      for (let d = 0; d < Math.min(R.length, s.lc.length); d++) shift = Math.max(shift, R[d] - s.lc[d] + 1);
      offs[i] = shift;
      for (let d = 0; d < s.rc.length; d++) {
        R[d] = s.rc[d] + shift;
        if (d >= L.length) L[d] = s.lc[d] + shift;
      }
    }
    let main = 0;
    ks.forEach((k, i) => lastReign(k) > lastReign(ks[main]) && (main = i));
    const mid = offs[main];
    const pos: [Person, number, number][] = [[n, 0, 0]];
    subs.forEach((s, i) => s.pos.forEach(([k, x, d]) => pos.push([k, x + offs[i] - mid, d + 1])));
    return { lc: [0, ...L.map((x) => x - mid)], rc: [0, ...R.map((x) => x - mid)], pos };
  };
  const roots = members.filter((x) => x.parent === undefined || !inTree.has(civ.people![x.parent]));
  const first = row.rulers[0];
  const rootOf = (x: Person): Person => {
    let r = x;
    for (let f = fatherOf(civ, r); f && inTree.has(f); f = fatherOf(civ, r)) r = f;
    return r;
  };
  const top = first ? rootOf(first) : roots[0];
  // 远支:按这一支第一位即位的先后
  const firstReign = (n: Person): number => Math.min(n.role === 'ruler' ? (n.from ?? n.born) : Infinity, ...kids(n).map(firstReign));
  const rest = roots.filter((r) => r !== top).sort((a, b) => firstReign(a) - firstReign(b));
  return [top, ...rest]
    .filter((r): r is Person => !!r)
    .map((r) => ({ nodes: lay(r).pos.map(([p, x, depth]) => ({ p, x, depth })), distant: r !== top }));
}

/**
 * 一国的家谱写成缩进的文字(人物页世系图的"复制全文"):一朝一段,标题行、一人一行(下一代多缩两格)、结尾那句。
 * "  3 懿宗柳离琅 2394–2421 年在位" / "  柳曜玄 未即位 2428–2467"
 */
export function lineageText(civ: Civ, polity: number): string {
  const rows = dynastyRows(civ, polity);
  const out: string[] = [];
  rows.forEach((row, i) => {
    out.push(`${row.name}(${dynastyNote(civ, rows, i)})`);
    for (const t of layoutDynasty(civ, row)) {
      if (t.distant) out.push('宗室远支');
      const inTree = new Set(t.nodes.map((n) => n.p));
      const walk = (x: Person, depth: number) => {
        const pad = '  '.repeat(depth);
        const k = reignOrder(row, x);
        if (k) out.push(`${pad}${k} ${personName(civ, x)} ${Math.floor(x.from ?? x.born)}–${x.until !== undefined ? Math.floor(x.until) : ''} 年在位`);
        else out.push(`${pad}${personName(civ, x)} 未即位 ${Math.floor(x.born)}–${x.died !== undefined ? Math.floor(x.died) : ''}`);
        for (const c of kidsOf(civ, x)) if (inTree.has(c)) walk(c, depth + 1);
      };
      const root = t.nodes.find((n) => n.depth === 0);
      if (root) walk(root.p, 0);
    }
    const end = dynastyEnd(civ, rows, i);
    if (end) out.push(end);
    out.push('');
  });
  return out.join('\n').trim();
}

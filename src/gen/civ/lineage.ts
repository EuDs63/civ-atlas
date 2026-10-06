/**
 * 君主的世系:谁是谁的父亲。people.ts 排完君主、将领以后调用,只往人物上添 Person.parent 和没即位的宗室,
 * 君主、将领的名字、生卒、在位年份一样都不改。
 *
 * 每个国家(共和国除外)每一朝,从第二位起按即位先后给继位的君主找父亲。年纪要对得上:父亲生他时 GEN_AGE 岁之间,
 * 他出生时父亲还在世(或刚去世不久,遗腹子)。先照两人的年纪差试最顺的说法:
 *   - 差 14 岁以上 → 前一位的儿子;差 40 岁以上 → 孙子(中间补一位没即位、在他即位前去世的父亲,早卒的太子)
 *   - 差得少 → 和前一位同一个父亲的兄弟(前一位没有父亲 —— 一朝的第一位 —— 就补一位没即位的父亲)
 * 对不上再依次试:前一位兄弟的儿子(侄)、前一位祖父的儿子(叔伯)、前一位叔伯的儿子(从兄弟);都不行就不连(宗室远支)。
 * 补出来的人是 role = 'prince' 的人物(只有国家、朝代、名字、生卒、父亲),排在 civ.people 的最后。
 * 只往前看:每一位的父亲只取决于他和他之前的君主,干预某年之前的世系不变。不用随机数,名字按位置锚取(和君主、将领同一个起名器)。
 * 纯计算,不碰 DOM。
 */
import type { Person, Polity, Year } from './types';

/** 生儿子的年纪 */
const GEN_AGE: [number, number] = [14, 55];
/** 父亲去世后最多这么久出生(遗腹子) */
const POSTHUMOUS = 0.75;
/** 一生最多这么多岁(同 people.ts) */
const MAX_AGE = 88;
/** 补出来的开国之君的父亲:比两个儿子里年长的那个大多少岁(年纪差太大时少一些) */
const FOUNDER_FATHER_AGE = 30;

const TICK = 256;
const q = (x: number) => Math.round(x * TICK) / TICK;

interface Node {
  p: Person;
  born: Year;
  /** 卒年;还在世 = Infinity */
  died: Year;
  parent?: Node;
  kids: Node[];
  /** 补出来的开国之君的父亲:卒年跟着最小的儿子往后挪 */
  flex?: boolean;
}

export interface LineageNamer {
  /** 东方中式:名字前面要加姓 */
  surnamed: boolean;
  given(...key: number[]): string;
}

/**
 * 给每国的君主连上父亲,返回补出来的宗室(按国家、补出来的先后)。rulers[国家] = 这国的君主(即位先后);
 * Person.parent 先记成 Person(parentOf),等 people.ts 排好编号再换成编号
 */
export function buildLineage(
  polities: readonly Polity[],
  rulers: readonly Person[][],
  generals: readonly Person[],
  opts: { tag: readonly number[]; namerOf: (p: Polity) => LineageNamer; surnameOf: (ruler: Person) => string },
): { princes: Person[]; parentOf: Map<Person, Person> } {
  const princes: Person[] = [];
  const parentOf = new Map<Person, Person>();
  const generalNames: Set<string>[] = polities.map(() => new Set());
  for (const g of generals) generalNames[g.polity]?.add(g.name);
  for (const p of polities) {
    if (p.lineage === 'republic') continue;
    const list = rulers[p.id];
    const mine: Node[] = [];
    const nodes = new Map<Person, Node>();
    const prince = (born: Year, died: Year, dynasty: number, flex = false): Node => {
      const x: Person = { id: -1, role: 'prince', polity: p.id, name: '', born: q(born), died: q(died), fate: 'died', dynasty };
      const n: Node = { p: x, born: x.born, died: x.died!, kids: [], flex };
      mine.push(n);
      return n;
    };
    const fits = (f: Node, x: Node) => {
      const age = x.born - f.born;
      if (age < GEN_AGE[0] || age > GEN_AGE[1]) return false;
      return x.born <= f.died + POSTHUMOUS || (f.flex === true && x.born - f.born <= MAX_AGE);
    };
    const adopt = (f: Node, x: Node) => {
      if (f.flex && x.born > f.died) f.died = x.born;
      x.parent = f;
      f.kids.push(x);
    };
    const child = (f: Node | undefined, x: Node) => !!f && fits(f, x) && (adopt(f, x), true);
    /** 补一位没即位的宗室:f 的儿子、x 的父亲,在 x 即位前去世 */
    const bridge = (f: Node | undefined, x: Node, from: Year): boolean => {
      if (!f) return false;
      const lo = Math.max(f.born + GEN_AGE[0], x.born - GEN_AGE[1]);
      const hi = Math.min(f.died + POSTHUMOUS, x.born - GEN_AGE[0]);
      if (lo > hi) return false;
      const b = (lo + hi) / 2;
      const m = prince(b, Math.max(x.born, Math.min(from - 1, b + MAX_AGE)), x.p.dynasty ?? 0);
      adopt(f, m);
      adopt(m, x);
      return true;
    };
    for (let k = 0; k < list.length; k++) {
      const r = list[k];
      const X: Node = { p: r, born: r.born, died: r.died ?? Infinity, kids: [] };
      nodes.set(r, X);
      const prev = list[k - 1];
      if (!prev || r.rise !== 'heir' || (prev.dynasty ?? 0) !== (r.dynasty ?? 0)) continue;
      const PV = nodes.get(prev)!;
      const gap = r.born - prev.born;
      const from = r.from ?? r.born;
      // 1) 照年纪差最顺的说法
      let ok = false;
      if (gap >= 40) ok = bridge(PV, X, from);
      else if (gap >= GEN_AGE[0]) ok = child(PV, X);
      else if (PV.parent) ok = child(PV.parent, X);
      else {
        const a = Math.min(PV.born, X.born);
        const b = Math.max(PV.born, X.born);
        if (b - a <= GEN_AGE[1] - GEN_AGE[0]) {
          const f = prince(a - Math.max(GEN_AGE[0], Math.min(FOUNDER_FATHER_AGE, GEN_AGE[1] - (b - a))), b, r.dynasty ?? 0, true);
          adopt(f, PV);
          adopt(f, X);
          ok = true;
        }
      }
      if (ok) continue;
      // 2) 对不上:按辈分由近到远
      const G = PV.parent;
      const GG = G?.parent;
      if (gap >= GEN_AGE[0] && child(PV, X)) continue;
      if (G && G.kids.some((s) => s !== PV && child(s, X))) continue;
      if (bridge(G, X, from)) continue;
      if (child(GG, X)) continue;
      if (gap >= 2 * GEN_AGE[0] && bridge(PV, X, from)) continue;
      if (GG && GG.kids.some((s) => s !== G && child(s, X))) continue;
      bridge(GG, X, from);
    }
    // 宗室的名字:东方中式 = 本朝的姓 + 名;不和这国的君主、将领、别的宗室同名
    const namer = opts.namerOf(p);
    const used = new Set([...list.map((x) => x.name), ...generalNames[p.id]]);
    mine.forEach((n, i) => {
      let r: Person | undefined;
      for (let d: Node | undefined = n; d && !r; d = d.kids.find((c) => c.p.role === 'ruler') ?? d.kids[0]) if (d.p.role === 'ruler') r = d.p;
      const sur = namer.surnamed && r ? opts.surnameOf(r) : '';
      let name = '';
      for (let a = 0; !name || (used.has(name) && a < 24); a++) name = sur + namer.given(opts.tag[p.id], 2, i, a);
      used.add(name);
      n.p.name = name;
      n.p.died = q(n.died);
    });
    for (const n of [...nodes.values(), ...mine]) if (n.parent) parentOf.set(n.p, n.parent.p);
    princes.push(...mine.map((n) => n.p));
  }
  return { princes, parentOf };
}

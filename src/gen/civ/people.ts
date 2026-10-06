/**
 * 人物:各国的历代君主、战争里的统帅。推演结束、起好国名和城名以后调用(index.ts),
 * 按已经推出来的历史"贴"上去 —— 立国、灭亡、并入、王朝更替、每场战争、每一仗的胜负都照史事,一样都不改。
 *
 * **君主**(每个国家从立国到灭亡,一朝接一朝,中间不断档):
 *   - 每一朝的第一位:立国之君 / 叛离自立的守将(分裂)/ 故国王室之后(复国;东方沿用故国末代的姓)/
 *     篡位的权臣(新朝的根据地就是国都)/ 起兵代之的新朝开国之君
 *   - 之后同一家里继位:即位的年纪、在位多少年按"国家的位置锚 + 第几位"随机取,一生不超过 MAX_AGE 岁;
 *     共和国的执政官任期短、任满卸任
 *   - 一朝结束(改朝换代、亡国、并入他国)时在位的那一位是末代:被废、死于兵乱、殉国、出降、出奔、归附
 *   - 称号(Person.title)去世以后才定,还在位的没有:东方按去世那年的国号档位 —— 帝国(王朝)用庙号(开国之君太祖,
 *     这一朝中途才称帝的第一位世祖;太宗、世宗……,末代"哀帝""末帝""废帝""少帝"),王国、国用谥号 + 王 / 公(按在位时开疆还是失地挑字),部落首领、可汗没有称号;
 *     西幻:同一国里同名的国王按先后编序数("阿尔德里克三世"),帝国里开疆最多的一位称"大帝";共和国执政官、汗不编序数
 * **统帅**(按战争先后):开战时两边各有一位 —— 好战的君主有时亲征,否则派一位将领(本国在世、正闲着的将领先用,没有就新起一位);
 *   每一仗输的一方统帅有机会战死,下一仗换人;将领到年纪卸甲、去世也换人。君主亲征不会战死。
 * **世系**(lineage.ts):按年纪给继位的君主连上父亲(子、孙、兄弟、侄、叔伯……),对不上的地方补一位没即位的宗室。
 *
 * 随机数一律 keyed4(subSeed(seed, 'civ-people'), 国家的位置锚, 第几位, 用途, 种类):国家的位置锚 = 立国时国都的地块
 * (+ 这块地上第几个立国,同 naming.ts);一场战争里按"攻守两国的位置锚 + 宣战的年份"取(同 wars.ts)。
 * 干预某一年之前的历史不变,那之前已经下台的君主(名字、生卒、在位年份)、打完的仗的统帅也不变
 * (称号、编号可能变:日后多了一位同名的国王,前面那位就要编"一世")。名字按民族的语感取(naming.ts 的 personNamers)。纯计算,不碰 DOM。
 */
import type { Annal, Civ, Person, PersonCommand, PersonFate, Polity, RulerRise, Year } from './types';
import { anchorTag, keyed4, subSeed } from './rand';
import { anchorsOf, personNamers } from './naming';
import { capitalAt, polityTierAt } from './growth';
import { buildLineage } from './lineage';

// ---- 调参 ----
/** 开国之君、新朝之君即位的年纪(随机) */
const FOUNDER_AGE: [number, number] = [28, 50];
/** 继位的年纪:HEIR_AGE[0] + 跨度 × u^HEIR_EXP(偏年轻,偶有幼主) */
const HEIR_AGE: [number, number] = [10, 40];
const HEIR_EXP = 1.3;
/** 在位年数:1 + REIGN_MAX × u^REIGN_EXP(中位数十几年,偶有四五十年) */
const REIGN_MAX = 50;
const REIGN_EXP = 1.3;
/** 共和国执政官:就任的年纪、任期 */
const CONSUL_AGE: [number, number] = [40, 62];
const TERM: [number, number] = [4, 20];
/** 一生最多这么多岁 */
const MAX_AGE = 88;
/** 在位时遇弑的机会 */
const MURDER = 0.07;
/** 被废、出降、出奔、归附、卸任以后最多再活这么多年 */
const AFTERLIFE = 15;
/** 亡国之君:殉国、出降的机会(其余出奔) */
const FELL = 0.35;
const SURRENDER = 0.4;
/** 好战的君主(有时亲征)的比例;好战的君主每场仗亲征的机会;亲征的年纪 */
const MARTIAL = 0.35;
const LEAD = 0.5;
const LEAD_AGE: [number, number] = [18, 58];
/** 将领:领兵的年纪、寿命、卸甲的年纪 */
const GENERAL_AGE: [number, number] = [24, 42];
const GENERAL_LIFE: [number, number] = [45, 82];
const RETIRE: [number, number] = [58, 70];
/** 输了的一仗统帅战死的机会:攻方没打下来 / 守方丢了州 */
const FALL_ATTACK = 0.06;
const FALL_DEFEND = 0.08;
/** 西幻:继位的君主沿用本朝用过的名字的机会(同名多了才有"三世""四世") */
const REUSE = 0.55;
/** 帝国里开疆这么多州以上的君主,开疆最多的一位称"大帝" */
const GREAT_GAINS = 12;

// 随机数用途
const U_AGE = 1;
const U_REIGN = 2;
const U_MURDER = 3;
const U_FATE = 4;
const U_AFTER = 5;
const U_MARTIAL = 6;
const U_REUSE = 7;
const U_PICK = 8;
const U_TITLE = 9;
const U_LIFE = 10;
const U_RETIRE = 11;
const U_LEAD = 12;
const U_FALL = 13;
/** keyed4 最后一位:君主 / 将领 / 战争 */
const K_RULER = 0;
const K_GENERAL = 1;

const TICK = 256;
const q = (x: number) => Math.round(x * TICK) / TICK;
const lerp = (r: [number, number], u: number) => r[0] + (r[1] - r[0]) * u;

/** 要用到的 Civ 字段(index.ts 在拼 Civ 之前调用) */
export type PeopleInput = Pick<Civ, 'seed' | 'endYear' | 'polities' | 'settlements' | 'cultures' | 'annals'>;

/** 一国的史事索引:怎么结束的、每一次改朝换代、战争里的得失 */
interface PolityFacts {
  /** 灭亡(fall,a = 本国)/ 并入(merge,b = 本国) */
  fall?: Annal;
  merge?: Annal;
  /** 改朝换代的史事(按先后,对应 dynasties[1..]) */
  dynasty: Annal[];
  /** 战争里得失的州(年份、+1 得 / −1 失)、国都失守的年份 */
  swings: { year: Year; d: number }[];
  capitalLost: Year[];
}

function factsOf(civ: PeopleInput): PolityFacts[] {
  const out: PolityFacts[] = civ.polities.map(() => ({ dynasty: [], swings: [], capitalLost: [] }));
  const at = (p: number) => (p >= 0 && p < out.length ? out[p] : undefined);
  for (const e of civ.annals) {
    if (e.kind === 'fall') {
      const f = at(e.a);
      if (f && !f.fall) f.fall = e;
    } else if (e.kind === 'merge') {
      const f = at(e.b);
      if (f && !f.merge) f.merge = e;
    } else if (e.kind === 'dynasty') at(e.a)?.dynasty.push(e);
    else if (e.kind === 'conquer' && e.war >= 0) {
      at(e.a)?.swings.push({ year: e.year, d: 1 });
      at(e.b)?.swings.push({ year: e.year, d: -1 });
    } else if (e.kind === 'capital' && e.war >= 0) at(e.a)?.capitalLost.push(e.year);
  }
  return out;
}

/** 在位期间战争里得、失了几州,丢没丢过国都 */
function deedsOf(f: PolityFacts, from: Year, until: Year): { gains: number; losses: number; capital: boolean } {
  let gains = 0;
  let losses = 0;
  for (const s of f.swings) {
    if (s.year < from || s.year >= until) continue;
    if (s.d > 0) gains++;
    else losses++;
  }
  return { gains, losses, capital: f.capitalLost.some((y) => y >= from && y < until) };
}

// ---------------------------------------------------------------------------
// 称号

/** 庙号(东方帝国级):按在位时的作为挑,同一朝不重复 */
const TEMPLE = {
  great: ['世宗', '圣宗', '武宗', '神宗', '宪宗', '成宗'],
  bad: ['哀宗', '顺宗', '恭宗', '怀宗', '钦宗'],
  young: ['敬宗', '顺宗', '昭宗', '恭宗'],
  long: ['高宗', '仁宗', '宣宗'],
  restore: ['中宗', '宪宗', '肃宗'],
  plain: ['仁宗', '英宗', '宣宗', '德宗', '穆宗', '文宗', '孝宗', '睿宗', '兴宗', '道宗', '光宗', '宁宗', '理宗', '哲宗', '章宗', '肃宗', '代宗', '懿宗', '僖宗', '明宗', '景宗', '惠宗'],
};
/** 谥号(东方王国、国级,后面加"王""公") */
const POSTHUMOUS = {
  great: ['武', '威', '桓', '庄', '襄', '烈'],
  bad: ['哀', '愍', '灵', '怀', '厉', '幽'],
  young: ['殇', '悼', '冲'],
  long: ['文', '成', '康', '穆', '宣'],
  restore: ['宣', '献', '孝', '襄'],
  plain: ['文', '景', '宣', '成', '康', '昭', '献', '平', '定', '惠', '孝', '穆', '简', '靖', '顷', '懿', '德', '安', '僖', '恭'],
};
/** 末代帝王(亡国、被废、并入) */
const LAST_EMPEROR = ['哀帝', '末帝', '愍帝'];

type Deed = keyof typeof TEMPLE;

/** 从 pool 里随机的一处起,挑第一个这一朝还没用过的 */
function pickUnused(pool: readonly string[], used: ReadonlySet<string>, u: number): string {
  const k0 = Math.floor(u * pool.length);
  for (let j = 0; j < pool.length; j++) {
    const x = pool[(k0 + j) % pool.length];
    if (!used.has(x)) return x;
  }
  return '';
}

const CN = '零一二三四五六七八九';
/** 序数:1 → 一,12 → 十二,23 → 二十三(君主的"几世",不会超过两位数) */
function ordinal(n: number): string {
  if (n < 10) return CN[n];
  const t = Math.floor(n / 10);
  return `${t === 1 ? '' : CN[t]}十${n % 10 ? CN[n % 10] : ''}`;
}

const ENDED: ReadonlySet<PersonFate> = new Set(['deposed', 'overthrown', 'fell', 'surrendered', 'fled', 'merged']);

// ---------------------------------------------------------------------------

/**
 * 排出所有人物(Civ.people)。没有文明 / 没有国家 = 空数组。
 * 先排君主(按国家编号、即位先后),再按战争先后排统帅,最后是世系里补出来的没即位的宗室(lineage.ts);下标 = Person.id
 */
export function buildPeople(civ: PeopleInput): Person[] {
  const { polities, settlements, cultures, endYear } = civ;
  if (!polities.length) return [];
  const base = subSeed(civ.seed, 'civ-people');
  const at = anchorsOf(polities, (p) => settlements[p.capital]?.cell ?? -1);
  const tag = polities.map((_, i) => anchorTag(Math.max(0, at[i].cell), at[i].n));
  const facts = factsOf(civ);
  const namerOf = personNamers(civ.seed);
  const styleOf = (p: Polity) => cultures[p.culture]?.style || 'kingdom';
  const rulers: Person[][] = polities.map(() => []);
  /** 每国每一朝君主用过的名字(西幻:继位的君主沿用) */
  const pools: string[][][] = polities.map(() => []);

  for (const p of polities) {
    const f = facts[p.id];
    const R = (k: number, use: number) => keyed4(base, tag[p.id], k, use, K_RULER);
    const namer = namerOf(styleOf(p));
    const republic = p.lineage === 'republic';
    const segs = p.dynasties?.length ? p.dynasties : [{ year: p.founded, name: p.name, seat: p.capital }];
    const end = p.ended ?? endYear;
    const list = rulers[p.id];
    let surname = '';
    for (let i = 0; i < segs.length; i++) {
      const segStart = i === 0 ? p.founded : segs[i].year;
      const last = i + 1 >= segs.length;
      const segEnd = last ? end : segs[i + 1].year;
      // 这一朝的第一位怎么上台的;东方中式的姓(新朝换姓,复国沿用故国末代的姓)
      let rise: RulerRise = 'found';
      if (i > 0) {
        const d = f.dynasty[i - 1];
        const old = settlements[capitalAt(p, segStart - 1 / (2 * TICK))];
        rise = d && old && d.region === old.region ? 'usurp' : 'rise';
      } else if (p.restores !== undefined) rise = 'restore';
      else if (p.parent !== undefined) rise = 'rebel';
      const pool: string[] = [];
      pools[p.id][i] = pool;
      const fallen = rise === 'restore' ? polities[p.restores!] : undefined;
      const heirOf = fallen ? rulers[fallen.id][rulers[fallen.id].length - 1] : undefined;
      if (namer.surnamed) {
        const prev = surname;
        surname = '';
        if (heirOf && namerOf(styleOf(fallen!)).surnamed) surname = splitSurname(heirOf.name);
        for (let t = 0; !surname || (surname === prev && t < 20); t++) surname = namer.surname(tag[p.id], 0, i, t);
      }
      const usedGiven = new Set<string>();
      // 这一朝的君主,一位接一位
      let t = segStart;
      for (let j = 0; ; j++) {
        const k = list.length;
        let A: number;
        let L: number;
        if (republic) {
          A = lerp(CONSUL_AGE, R(k, U_AGE));
          L = lerp(TERM, R(k, U_REIGN));
        } else {
          A = j === 0 ? lerp(FOUNDER_AGE, R(k, U_AGE)) : HEIR_AGE[0] + (HEIR_AGE[1] - HEIR_AGE[0]) * Math.pow(R(k, U_AGE), HEIR_EXP);
          L = 1 + REIGN_MAX * Math.pow(R(k, U_REIGN), REIGN_EXP);
        }
        if (A + L > MAX_AGE) L = Math.max(1, MAX_AGE - A);
        const from = t;
        const born = q(from - A);
        const natural = q(from + L);
        const person: Person = { id: -1, role: 'ruler', polity: p.id, name: '', born, from, dynasty: i, rise: j === 0 ? rise : 'heir' };
        // 名字
        person.name = rulerName(namer, tag[p.id], k, j, surname, usedGiven, pool, R, republic, heirOf && pools[fallen!.id], list[list.length - 1]?.name);
        list.push(person);
        if (natural < segEnd) {
          // 这一朝里正常交接:驾崩(偶尔遇弑);执政官任满卸任
          person.until = natural;
          if (republic) {
            person.fate = 'retired';
            const died = q(Math.min(born + MAX_AGE, natural + AFTERLIFE * R(k, U_AFTER)));
            if (died <= endYear) person.died = died;
          } else {
            person.fate = R(k, U_MURDER) < MURDER ? 'murdered' : 'died';
            person.died = natural;
          }
          t = natural;
          continue;
        }
        // 在位到这一朝结束;最后一朝、国家还在 = 到结束年份还在位
        if (last && p.ended === undefined) break;
        person.until = segEnd;
        let fate: PersonFate;
        if (!last) {
          // 下一朝是篡位(根据地就是此刻的国都)还是起兵代之(和下一朝第一位的 rise 同一个判据)
          const d = f.dynasty[i];
          const old = settlements[capitalAt(p, segEnd - 1 / (2 * TICK))];
          fate = d && old && d.region === old.region ? 'deposed' : 'overthrown';
        } else if (f.merge && (!f.fall || f.merge.year <= f.fall.year)) fate = 'merged';
        else if (f.fall && f.fall.b >= 0) {
          const u = R(k, U_FATE);
          fate = u < FELL ? 'fell' : u < FELL + SURRENDER ? 'surrendered' : 'fled';
        } else fate = 'fled';
        person.fate = fate;
        if (fate === 'overthrown' || fate === 'fell') person.died = segEnd;
        else {
          const died = q(Math.min(natural, segEnd + AFTERLIFE * R(k, U_AFTER)));
          if (died <= endYear) person.died = Math.max(segEnd, died);
        }
        break;
      }
    }
    titleRulers(p, list, f, base, tag[p.id]);
  }

  // ---- 统帅 ----
  const generals: Person[] = [];
  const genOf: { p: Person; careerEnd: number; busy: number }[][] = polities.map(() => []);
  const busyRuler = new Map<Person, number>();
  const wars = warsOf(civ);
  const warBase = subSeed(civ.seed, 'civ-people-war');
  for (const w of wars) {
    const sides = [w.a, w.b];
    const wr = (x: number, use: number) => keyed4((warBase ^ Math.imul(Math.round(w.start * TICK), 0x27d4eb2d)) >>> 0, tag[w.a] ?? 0, tag[w.b] ?? 0, x, use);
    const cur: ({ p: Person; careerEnd: number; cmd: PersonCommand; general: boolean } | null)[] = [null, null];
    const close = (s: number, until: Year) => {
      const c = cur[s];
      if (!c) return;
      c.cmd.until = Math.max(c.cmd.from, until);
      if (c.general) {
        const g = genOf[sides[s]].find((x) => x.p === c.p);
        if (g) g.busy = c.cmd.until;
      } else busyRuler.set(c.p, c.cmd.until);
      cur[s] = null;
    };
    const appoint = (s: number, t: Year, x: number, idx: number) => {
      const pid = sides[s];
      const P = polities[pid];
      if (!P || !(t >= P.founded) || (P.ended !== undefined && t > P.ended)) return;
      const command = (p: Person) => {
        const cmd: PersonCommand = { war: w.id, side: s as 0 | 1, from: t, until: t, first: idx, last: idx };
        (p.commands ??= []).push(cmd);
        return cmd;
      };
      // 好战的君主亲征
      const ruler = rulerAt(rulers[pid], t);
      if (ruler) {
        const k = rulers[pid].indexOf(ruler);
        const age = t - ruler.born;
        const free = (busyRuler.get(ruler) ?? -Infinity) <= t;
        if (free && P.lineage !== 'republic' && keyed4(base, tag[pid], k, U_MARTIAL, K_RULER) < MARTIAL && age >= LEAD_AGE[0] && age <= LEAD_AGE[1] && wr(x * 2 + s, U_LEAD) < LEAD) {
          cur[s] = { p: ruler, careerEnd: ruler.until ?? Infinity, cmd: command(ruler), general: false };
          busyRuler.set(ruler, Infinity);
          return;
        }
      }
      // 本国在世、正闲着的将领
      const list = genOf[pid];
      let g = list.find((c) => c.busy <= t && c.careerEnd > t && c.p.born + GENERAL_AGE[0] <= t);
      if (!g) {
        const gi = list.length;
        const G = (use: number) => keyed4(base, tag[pid], gi, use, K_GENERAL);
        const born = q(t - lerp(GENERAL_AGE, G(U_AGE)));
        const life = q(born + lerp(GENERAL_LIFE, Math.pow(G(U_LIFE), 0.8)));
        const careerEnd = Math.min(life, q(born + lerp(RETIRE, G(U_RETIRE))));
        const namer = namerOf(styleOf(P));
        let name = '';
        const royal = new Set(rulers[pid].map((r) => r.name));
        for (let a = 0; a < 12 && (!name || royal.has(name)); a++) name = namer.surname(tag[pid], 1, gi, a) + namer.given(tag[pid], 1, gi, a);
        const person: Person = { id: -1, role: 'general', polity: pid, name, born };
        if (life <= endYear) {
          person.died = life;
          person.fate = 'died';
        }
        generals.push(person);
        g = { p: person, careerEnd, busy: -Infinity };
        list.push(g);
      }
      g.busy = Infinity;
      cur[s] = { p: g.p, careerEnd: g.careerEnd, cmd: command(g.p), general: true };
    };
    appoint(0, w.start, 0, w.decl);
    appoint(1, w.start, 0, w.decl);
    for (let n = 0; n < w.events.length; n++) {
      const idx = w.events[n];
      const e = civ.annals[idx];
      const t = e.year;
      for (let s = 0; s < 2; s++) {
        const c = cur[s];
        // 任期到头就换人:将领到了卒年、退下的那一刻,君主下台的那一刻(亡国那一刻君主还在:殉国、出降、出奔)
        if (c && (c.careerEnd < t || (c.careerEnd === t && (c.general || t !== polities[c.p.polity].ended)))) close(s, c.careerEnd);
        if (!cur[s]) appoint(s, t, n + 1, idx);
        const cs = cur[s];
        if (cs) cs.cmd.last = idx;
      }
      // 输的一方:攻方没打下来(battle 的 a)/ 丢了州(conquer 的 b)
      const loser = e.kind === 'battle' ? e.a : e.b;
      const s = loser === w.a ? 0 : loser === w.b ? 1 : -1;
      const c = s >= 0 ? cur[s] : null;
      if (c && c.general && wr(n + 1, U_FALL) < (e.kind === 'battle' ? FALL_ATTACK : FALL_DEFEND)) {
        c.p.died = t;
        c.p.fate = 'battle';
        const g = genOf[sides[s]].find((x) => x.p === c.p);
        if (g) g.careerEnd = t;
        close(s, t);
      }
    }
    for (let s = 0; s < 2; s++) {
      const c = cur[s];
      if (c) close(s, Math.min(w.end, c.careerEnd));
    }
  }

  // ---- 世系:谁是谁的父亲,补上没即位的宗室(排在最后,君主、将领的编号不变)----
  const { princes, parentOf } = buildLineage(polities, rulers, generals, { tag, namerOf: (p) => namerOf(styleOf(p)), surnameOf: (r) => splitSurname(r.name) });
  const out = [...rulers.flat(), ...generals, ...princes];
  out.forEach((p, i) => (p.id = i));
  for (const [x, f] of parentOf) x.parent = f.id;
  return out;
}

/** 某一刻在位的君主(即位那一刻起算;到结束年份还在位的 until 不给) */
export function rulerAt(list: readonly Person[], t: Year): Person | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (r.from! <= t) return r.until === undefined || t < r.until ? r : undefined;
  }
  return undefined;
}

/** 东方中式的全名拆出姓(复姓两个字) */
function splitSurname(full: string): string {
  const two = full.slice(0, 2);
  return COMPOUND.has(two) && full.length > 2 ? two : full.slice(0, 1);
}
const COMPOUND = new Set(['司马', '欧阳', '上官', '慕容', '宇文', '长孙', '独孤', '皇甫', '令狐', '尉迟', '南宫', '司空', '东方', '端木', '百里']);

/**
 * 第 k 位君主(这一朝第 j 位)的名字:
 * - 东方中式:本朝的姓 + 名(同一朝里不重名);边塞、山海:名(同一国里不重名)
 * - 西幻:继位的君主有 REUSE 的机会沿用本朝用过的名字(上一位的除外;复国的第一位沿用故国末代王朝的名字);共和国执政官一律另起
 */
function rulerName(
  namer: ReturnType<ReturnType<typeof personNamers>>,
  tag: number,
  k: number,
  j: number,
  surname: string,
  used: Set<string>,
  pool: string[],
  R: (k: number, use: number) => number,
  republic: boolean,
  fallenPools: string[][] | undefined,
  prev: string | undefined,
): string {
  if (namer.family === 'western') {
    let name = '';
    const old = fallenPools?.[fallenPools.length - 1];
    if (j === 0 && old?.length) name = old[Math.floor(R(k, U_PICK) * old.length)];
    else if (!republic && j > 0 && R(k, U_REUSE) < REUSE) {
      // 不沿用上一位的名字(兄弟同名、父子接连同名读起来都别扭)
      const names = pool.filter((x) => x !== prev);
      if (names.length) name = names[Math.floor(R(k, U_PICK) * names.length)];
    }
    for (let a = 0; !name || (republic && used.has(name) && a < 12); a++) name = namer.given(tag, 0, k, a);
    if (!pool.includes(name)) pool.push(name);
    used.add(name);
    return name;
  }
  let given = '';
  for (let a = 0; !given || (used.has(given) && a < 24); a++) given = namer.given(tag, 0, k, a);
  used.add(given);
  return surname + given;
}

/** 定称号(去世以后才有;见文件头) */
function titleRulers(p: Polity, list: Person[], f: PolityFacts, base: number, tag: number): void {
  const T = (k: number, use: number) => keyed4(base, tag, k, use, K_RULER);
  if (!p.eastern) {
    // 西幻:同名的国王编序数(在位的也编);帝国里开疆最多的一位称大帝
    if (p.lineage === 'realm' || p.lineage === undefined) {
      const count = new Map<string, number>();
      for (const r of list) count.set(r.name, (count.get(r.name) ?? 0) + 1);
      const seen = new Map<string, number>();
      for (const r of list) {
        const n = (seen.get(r.name) ?? 0) + 1;
        seen.set(r.name, n);
        r.title = count.get(r.name)! > 1 ? `${ordinal(n)}世` : '';
      }
      let best: Person | undefined;
      let most = GREAT_GAINS - 1;
      for (const r of list) {
        if (r.until === undefined || polityTierAt(p, r.until - 1 / TICK) < 3) continue;
        const g = deedsOf(f, r.from!, r.until).gains;
        if (g > most) {
          most = g;
          best = r;
        }
      }
      if (best) best.title = '大帝';
    } else for (const r of list) r.title = '';
    return;
  }
  // 东方:汗国没有庙号谥号
  if (p.lineage === 'khanate') {
    for (const r of list) r.title = '';
    return;
  }
  const used = new Map<number, Set<string>>();
  let prev: Person | undefined;
  let prevDeed: Deed | 'last' | '' = '';
  list.forEach((r, k) => {
    const dyn = r.dynasty ?? 0;
    let u = used.get(dyn);
    if (!u) used.set(dyn, (u = new Set()));
    if (prev && (prev.dynasty ?? 0) !== dyn) prevDeed = '';
    const until = r.until;
    if (until === undefined) {
      r.title = '';
      prev = r;
      return;
    }
    const tier = polityTierAt(p, until - 1 / TICK);
    const d = deedsOf(f, r.from!, until);
    const ageAtEnd = (r.died ?? until) - r.born;
    let deed: Deed = 'plain';
    if (d.gains >= 5 && d.gains >= 2 * d.losses) deed = 'great';
    else if ((d.losses >= 4 && d.losses > d.gains) || d.capital) deed = 'bad';
    else if (ageAtEnd < 25) deed = 'young';
    else if (prevDeed === 'bad' && d.gains >= 2) deed = 'restore';
    else if (until - r.from! >= 35) deed = 'long';
    const lastOne = !!r.fate && ENDED.has(r.fate);
    // 这一朝的第一位(开国之君;这一朝中途才称帝的,第一位称帝驾崩的叫"世祖")
    const founder = !prev || (prev.dynasty ?? 0) !== dyn;
    let title = '';
    if (tier <= 0) title = '';
    else if (tier >= 3) {
      if (lastOne) {
        const pool = r.fate === 'deposed' ? ['废帝', ...LAST_EMPEROR] : ageAtEnd < 20 ? ['少帝', ...LAST_EMPEROR] : LAST_EMPEROR;
        title = pickUnused(pool, u, r.fate === 'deposed' || ageAtEnd < 20 ? 0 : T(k, U_TITLE));
      } else if (!u.has('太祖') && !u.has('世祖')) title = founder ? '太祖' : '世祖';
      else if (prev?.title === '太祖' && (prev.dynasty ?? 0) === dyn && !u.has('太宗') && deed !== 'young' && deed !== 'bad') title = '太宗';
      else title = pickUnused(TEMPLE[deed], u, T(k, U_TITLE)) || pickUnused(TEMPLE.plain, u, T(k, U_TITLE));
      if (!title) title = `${pickUnused(POSTHUMOUS.plain, u, T(k, U_TITLE)) || '后'}帝`;
    } else {
      const rank = tier >= 2 ? '王' : '公';
      const pool = lastOne ? POSTHUMOUS.bad : POSTHUMOUS[deed];
      const used2 = new Set([...u].filter((x) => x.endsWith(rank)).map((x) => x.slice(0, -1)));
      const s = pickUnused(pool, used2, T(k, U_TITLE)) || pickUnused(POSTHUMOUS.plain, used2, T(k, U_TITLE));
      title = s ? s + rank : '';
    }
    if (title) u.add(title);
    r.title = title;
    prev = r;
    prevDeed = lastOne ? 'last' : deed;
  });
}

/**
 * 一场战争:双方、起止、宣战那条史事的下标、要排统帅的每一仗(没打下来的战役、战役里打下来的州;
 * 议和割让、亡国时残部归攻方的不算;史事下标)
 */
interface WarFacts {
  id: number;
  a: number;
  b: number;
  start: Year;
  end: Year;
  decl: number;
  events: number[];
}

function warsOf(civ: PeopleInput): WarFacts[] {
  const A = civ.annals;
  const wars: WarFacts[] = [];
  const byId = new Map<number, WarFacts>();
  /** 不是打下来的攻占(割让、并掉残部) */
  const skip = new Set<number>();
  A.forEach((e, i) => {
    if (e.kind === 'peace' && e.region > 0) {
      for (let j = Math.max(0, i - e.region); j < i; j++) if (A[j].kind === 'conquer' && A[j].war === e.war) skip.add(j);
    } else if (e.kind === 'fall' && e.war >= 0) {
      const run: number[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const c = A[j];
        if (c.kind !== 'conquer' || c.war !== e.war || c.year !== e.year || c.a !== e.b || c.b !== e.a) break;
        run.push(j);
      }
      run.pop();
      for (const j of run) skip.add(j);
    }
  });
  A.forEach((e, i) => {
    if (e.kind === 'war' && e.war >= 0 && !byId.has(e.war)) {
      const w: WarFacts = { id: e.war, a: e.a, b: e.b, start: e.year, end: civ.endYear, decl: i, events: [] };
      byId.set(e.war, w);
      wars.push(w);
    } else if (e.war >= 0 && (e.kind === 'battle' || (e.kind === 'conquer' && !skip.has(i)))) byId.get(e.war)?.events.push(i);
    else if (e.kind === 'peace' && e.war >= 0) {
      const w = byId.get(e.war);
      if (w) w.end = e.year;
    }
  });
  return wars;
}

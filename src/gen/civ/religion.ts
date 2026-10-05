/**
 * 信仰(generateCiv 的第 ⑦ 步):推演结束后,照已有的历史把信仰"贴"上去 —— 国界、兴亡、战争、人物一个都不变。
 * 纯计算,不碰 DOM。
 *
 *   - 民间信仰:每个民族自带一种(编号 = 民族编号),州一有人住就是它;民族换了(同化、迁徙),民间信仰跟着换
 *   - 大教:2–5 个(按州数),在 FOUND_SPAN 里几个年份上(那年没有合适的城:不到两个大教就往后推,够两个就不创这一个),挑当时人口最多、离别的圣城够远、还信民间信仰的大城,
 *     由一位创教者创立;那座城是圣城
 *   - 传播:每 STEP 年向相邻的州传一次;同一国里快,奉它为国教的国里更快,跨国界、出海、翻山慢,已经信了别的大教的州很难改信
 *   - 国教:一国里某个大教占到 ADOPT 以上的州,或者国都改信了,国君皈依、立为国教;亡国时国教跟着结束
 *   - 教派:大教立教 SCHISM_AGE 年以后,另一片大陆(或离圣城很远)的大国奉它为国教 SCHISM_STATE_YEARS 年以上,
 *     有机会自立一派(国里信本教的州跟着改信);一个教最多分出两派
 *   - 圣城被国教不是这个教的国家夺了,记一件"圣城"的事(从部落地带手里拿到的不算)
 *
 * 结果是 Civ.religion:信仰列表、大事、各国国教,和一本"各州信仰"的变化日志(加每 100 年一份检查点),
 * 任意年份的各州信仰用 faithAt 查(和 ownersAt 一样:最近的检查点 + 补日志)。
 *
 * 随机数一律 keyed(subSeed(seed, 'trial-religion'), …)(用途名沿用最初试算时的叫法:改了它,同一个种子的信仰就全变了)。
 * 以后改这里的算法、让同一个种子的信仰变了,要把 edits.ts 的 GENERATOR_VERSION 加一。
 */
import type { Civ, Faith, FaithEvent, FaithForm, Religion, StateFaith, Year } from './types';
import type { World } from '../world';
import { AdjKind, Layer } from './types';
import { ownersAt, type Owners } from './timeline';
import { capitalAt, populationAt } from './growth';
import { personNamers } from './naming';
import { keyed, subSeed } from '../util';

/** 每多少年算一步 */
const STEP = 5;
/** 创教的年份段 */
const FOUND_SPAN: [number, number] = [900, 2250];
/** 圣城彼此至少隔多少步(州图) */
const HOLY_GAP = 9;
/** 每一步、每条邻边传过去的机会,和各种情形的倍数 */
const SPREAD = 0.022;
const SAME_STATE = 2.2;
const STATE_FAITH = 5;
const CROSS_BORDER = 0.35;
const TRIBAL = 0.6;
const FROM_GREAT = 0.06;
const OTHER_STATE = 0.25;
const SEA = 0.55;
const MOUNTAIN = 0.5;
/** 一国里某大教占到这么多州就立为国教 */
const ADOPT = 0.3;
/** 教派:大教立教多少年后才可能分;一国里至少多少州;隔多远(州图步数,或不在一片大陆);每次看分的机会;奉为国教至少多少年 */
const SCHISM_AGE = 350;
const SCHISM_MIN = 14;
const SCHISM_FAR = 10;
const SCHISM_ODDS = 0.12;
const SCHISM_STATE_YEARS = 120;
/** 一个大教最多分出几派 */
const SCHISM_MAX = 2;
/** 每隔多少年看一次教派分立 */
const SCHISM_EVERY = 50;
/** 检查点间隔(年) */
const CHECKPOINT = 100;

/** 大教的颜色(按创立先后取):金、蓝、绿、紫、灰蓝 */
export const GREAT_COLORS: readonly [number, number, number][] = [
  [214, 152, 32],
  [52, 98, 186],
  [30, 150, 112],
  [156, 72, 150],
  [96, 112, 134],
];
/** 民间信仰的颜色(米灰) */
export const FOLK_COLOR: [number, number, number] = [214, 207, 192];

/** 东方语感的教名用字(避开现实里有的教名、宗派名) */
const EAST_WORDS = ['玄晖', '澄元', '照冥', '衡一', '昭虚', '守素', '含光', '归穹'];
/** 民族的生计 → 创出的大教可能是哪几类 */
const FORM_BY_KIND: Record<string, FaithForm[]> = {
  river: ['一神', '二元'],
  lake: ['多神', '哲理'],
  farm: ['二元', '多神', '哲理'],
  sea: ['多神', '一神'],
  highland: ['修行', '哲理'],
  nomad: ['一神', '多神'],
  forest: ['多神', '修行'],
};

/** 颜色变浅(t > 0,往白里调)/ 变深(t < 0) */
export function shade([r, g, b]: readonly number[], t: number): [number, number, number] {
  const m = (c: number) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  return [m(r), m(g), m(b)];
}

/** 教派相对圣城在哪个方向(东西南北;东西跨 180° 经线照算) */
function sectDir(world: World, holyCell: number, capCell: number): string {
  const { x, y } = world.mesh;
  const width = world.width;
  let dx = x[capCell] - x[holyCell];
  if (dx > width / 2) dx -= width;
  if (dx < -width / 2) dx += width;
  const dy = y[capCell] - y[holyCell];
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? '东' : '西') : dy > 0 ? '南' : '北';
}

/** 推演结束后算信仰(见文件头)。没有民族 = 空的信仰列表 */
export function buildReligion(world: World, civ: Civ): Religion {
  const seed = subSeed(civ.seed, 'trial-religion');
  const R = civ.regions.count;
  const { adjStart, adj, landmass } = civ.regions;
  const S = civ.settlements;
  const C = civ.cultures.length;
  const namers = personNamers(civ.seed);
  const faiths: Faith[] = civ.cultures.map((cu) => ({
    id: cu.id,
    kind: 'folk',
    name: `${cu.name}${folkSuffix(namers(cu.style).family === 'eastern')}`,
    culture: cu.id,
    color: FOLK_COLOR,
  }));
  const events: FaithEvent[] = [];
  const states: StateFaith[] = [];
  const book = new FaithBook(R);
  const faith = book.faith;
  const checkpoints: Religion['checkpoints'] = [];
  const lastCulture = new Int16Array(R).fill(-1);
  const P = civ.polities.length;
  /** 各国现在的国教(−1 = 没有) */
  const stateOf = new Int32Array(P).fill(-1);
  /** 各大教分出了几派 */
  const sects = new Map<number, number>();
  /** 各大教是哪个民族创的(教派起名的语感跟着它) */
  const foundedBy = new Map<number, number>();
  /** 各大教的圣城上一步属哪国(−2 = 还没看过) */
  const holyOwner = new Map<number, number>();
  /** 已经传入过的(国家, 大教):记过"传入"就不再记 */
  const entered = new Set<number>();
  /** 州 → 州里的城(按编号) */
  const cityIn: number[][] = Array.from({ length: R }, () => []);
  for (const s of S) if (s.region >= 0 && s.region < R) cityIn[s.region].push(s.id);

  const set = (y: Year, r: number, f: number) => book.set(y, r, f);
  // 信仰 → 是不是民间信仰、所属的大教(查表:循环里每步要查几十万次)
  let isFolk = new Uint8Array(C + 16);
  let rootArr = new Int16Array(C + 16);
  for (let i = 0; i < C; i++) {
    isFolk[i] = 1;
    rootArr[i] = i;
  }
  const addFaith = (f: Faith) => {
    if (f.id >= isFolk.length) {
      const a = new Uint8Array(isFolk.length * 2);
      const b = new Int16Array(isFolk.length * 2);
      a.set(isFolk);
      b.set(rootArr);
      isFolk = a;
      rootArr = b;
    }
    isFolk[f.id] = f.kind === 'folk' ? 1 : 0;
    rootArr[f.id] = f.kind === 'sect' ? f.parent! : f.id;
    faiths.push(f);
  };
  const rootOf = (f: number) => rootArr[f];
  const folk = (f: number) => isFolk[f] === 1;

  // 创教的年份:把年份段均分成 nGreat 段,每段里随机一年
  const nGreat = Math.max(2, Math.min(5, Math.round(R / 220)));
  const foundYears = Array.from({ length: nGreat }, (_, i) => {
    const a = FOUND_SPAN[0] + ((FOUND_SPAN[1] - FOUND_SPAN[0]) * i) / nGreat;
    return Math.round(a + keyed(seed, 1, i) * ((FOUND_SPAN[1] - FOUND_SPAN[0]) / nGreat) * 0.8);
  });
  let nextFound = 0;

  /** 从 from 出发按州图走,max 步以内的州的步数(更远的 = −1) */
  const hops = (from: number, max: number): Int16Array => {
    const d = new Int16Array(R).fill(-1);
    d[from] = 0;
    const q = [from];
    for (let h = 0; h < q.length; h++) {
      const r = q[h];
      if (d[r] >= max) continue;
      for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
        const n = adj[k];
        if (d[n] < 0) {
          d[n] = d[r] + 1;
          q.push(n);
        }
      }
    }
    return d;
  };

  const rulerAt = (p: number, y: Year) =>
    civ.people?.find((x) => x.role === 'ruler' && x.polity === p && (x.from ?? 0) <= y && (x.until ?? 1e9) > y)?.id;

  const adoptState = (y: Year, p: number, f: number) => {
    if (stateOf[p] === f) return;
    const open = states.find((s) => s.polity === p && s.until === undefined);
    if (open) open.until = y;
    stateOf[p] = f;
    states.push({ polity: p, faith: f, from: y });
    const cap = S[capitalAt(civ.polities[p], y)];
    events.push({ year: y, kind: 'state', faith: f, polity: p, region: cap?.region ?? -1, settlement: cap?.id ?? -1, ruler: rulerAt(p, y) });
  };

  // 各州的归属:按年份往后翻日志(和 ownersAt 同一个结果,只是一步步接着翻,不每步从检查点重来)
  const own: Owners = { culture: new Int16Array(R).fill(-1), polity: new Int16Array(R).fill(-1) };
  const ownC = own.culture;
  const ownP = own.polity;
  const L = civ.log;
  let li = 0;
  const next = new Int16Array(R);
  /** 各国有几个州;(国家, 大教) → 几个州信它(含教派);(国家, 信仰) → 几个州 */
  const total = new Int32Array(P);
  let inPolity = new Int32Array(0);
  let count = new Int32Array(0);
  /** 国教那一步:按第一次扫到的先后排的国家、各国按第一次扫到的先后排的信仰(同样多时取先扫到的) */
  const seenP = new Int32Array(P);
  const order: number[] = [];
  const faithOrder: number[][] = Array.from({ length: P }, () => []);
  // 每 STEP 年一步;结束年份不在整步上时最后补一步,让结束那年的信仰也对得上那年的民族、国家
  const years: Year[] = [];
  for (let y = 0; y <= civ.endYear; y += STEP) years.push(y);
  if (years[years.length - 1] < civ.endYear) years.push(civ.endYear);
  for (let step = 0; step < years.length; step++) {
    const y = years[step];
    for (; li < L.size && L.year[li] <= y; li++) {
      if (L.layer[li] === Layer.Culture) ownC[L.region[li]] = L.value[li];
      else ownP[L.region[li]] = L.value[li];
    }
    // 有人住了 / 民族换了:民间信仰跟着民族(信大教的不变)
    followCultures(book, y, ownC, lastCulture, isFolk);
    // 亡国:国教跟着结束
    for (const s of states) {
      const end = civ.polities[s.polity].ended;
      if (s.until === undefined && end !== undefined && end <= y) {
        s.until = end;
        stateOf[s.polity] = -1;
      }
    }

    // 创教
    if (nextFound < foundYears.length && y >= foundYears[nextFound]) {
      const far = faiths.filter((f) => f.kind === 'great').map((f) => hops(S[f.holy!].region, HOLY_GAP));
      let best = -1;
      let bestScore = 0;
      for (const s of S) {
        if (s.founded > y || (s.ended !== undefined && s.ended <= y)) continue;
        if (faith[s.region] < 0 || !folk(faith[s.region])) continue;
        if (far.some((d) => d[s.region] >= 0)) continue;
        const pol = ownP[s.region];
        const isCap = pol >= 0 && capitalAt(civ.polities[pol], y) === s.id;
        const score = populationAt(s, y) * (isCap ? 1.4 : 1) * (0.6 + 0.8 * keyed(seed, 2, s.cell, nextFound));
        if (score > bestScore) {
          bestScore = score;
          best = s.id;
        }
      }
      if (best >= 0) {
        const s = S[best];
        // 创教的是城里现在住的民族(城被同化过的话,Settlement.culture 还是建城的那族)
        const cu = civ.cultures[ownC[s.region]] ?? civ.cultures[s.culture];
        const namer = namers(cu.style);
        const k = faiths.length;
        const forms = FORM_BY_KIND[cu.kind] ?? ['多神'];
        const form = forms[Math.floor(keyed(seed, 3, s.cell) * forms.length)];
        const given = namer.given(s.cell, 77);
        const age = 30 + Math.floor(keyed(seed, 5, s.cell) * 15);
        const taken = (n: string) => faiths.some((f) => f.name === n);
        let name: string;
        if (namer.family === 'eastern') {
          const tail = form === '修行' ? '宗' : form === '哲理' ? '道' : '教';
          const w0 = Math.floor(keyed(seed, 4, s.cell) * EAST_WORDS.length);
          let i = 0;
          while (i < EAST_WORDS.length - 1 && taken(`${EAST_WORDS[(w0 + i) % EAST_WORDS.length]}${tail}`)) i++;
          name = `${EAST_WORDS[(w0 + i) % EAST_WORDS.length]}${tail}`;
        } else {
          name = `${given.slice(0, Math.min(3, Math.max(2, given.length - 1)))}教`;
          if (taken(name)) name = `${given}教`;
        }
        addFaith({
          id: k,
          kind: 'great',
          name,
          form,
          founded: y,
          holy: best,
          founder: { name: namer.surname(s.cell, 77) + given, born: y - age, died: y - age + 55 + Math.floor(keyed(seed, 6, s.cell) * 25) },
          color: GREAT_COLORS[faiths.filter((f) => f.kind === 'great').length % GREAT_COLORS.length],
        });
        set(y, s.region, k);
        events.push({ year: y, kind: 'found', faith: k, polity: ownP[s.region], region: s.region, settlement: best });
        foundedBy.set(k, cu.id);
        nextFound++;
      } else if (faiths.filter((f) => f.kind === 'great').length >= 2) nextFound++;
      // 这一年没有合适的城(都信了大教、离圣城太近):已经有两个大教就不创这一个,不到两个下一步再找
    }

    // 传播:大教 / 教派向相邻的州传(结束年份补的那一步不满 STEP 年,不传,只跟上归属的变化)
    if (y % STEP === 0) spreadStep(seed, y, civ.regions, faith, next, ownP, stateOf, isFolk, rootArr);
    else next.set(faith);
    // 改信:第一次传进一国(那国里还没有别的州信这一教)记一件"传入"
    const F = faiths.length;
    if (inPolity.length < P * F) {
      inPolity = new Int32Array(P * F);
      count = new Int32Array(P * F);
    } else inPolity.fill(0, 0, P * F);
    countRoots(R, F, ownP, faith, isFolk, rootArr, inPolity);
    for (let r = changed(next, faith, 0); r < R; r = changed(next, faith, r + 1)) {
      const f = next[r];
      const pn = ownP[r];
      if (pn >= 0) {
        const root = rootOf(f);
        const ek = pn * 65536 + root;
        if (!inPolity[pn * F + root] && !entered.has(ek)) {
          entered.add(ek);
          const city = cityIn[r].find((id) => S[id].founded <= y && (S[id].ended ?? 1e9) > y) ?? -1;
          events.push({ year: y, kind: 'enter', faith: f, polity: pn, region: r, settlement: city });
        }
        const g = faith[r];
        if (g >= 0 && !folk(g)) inPolity[pn * F + rootOf(g)]--;
        inPolity[pn * F + root]++;
      }
      set(y, r, f);
    }

    // 国教:国都改信了别的大教(而且信它的州更多),或者没有国教、某大教占到 ADOPT 以上
    countFaiths(F, ownP, faith, isFolk, total, count, seenP, step + 1, order, faithOrder);
    for (const p of order) {
      const cap = S[capitalAt(civ.polities[p], y)];
      const capF = cap ? faith[cap.region] : -1;
      let best = -1;
      let bestN = 0;
      for (const f of faithOrder[p]) if (count[p * F + f] > bestN) [best, bestN] = [f, count[p * F + f]];
      const cur = stateOf[p];
      const n = (f: number) => (f >= 0 && f < F ? count[p * F + f] : 0);
      if (capF >= 0 && !folk(capF) && cur !== capF && (cur < 0 || n(capF) > n(cur))) adoptState(y, p, capF);
      else if (cur < 0 && bestN >= ADOPT * total[p]) {
        adoptState(y, p, best);
        if (cap) set(y, cap.region, best);
      }
    }

    // 圣城易手:被国教不是这个教(及其教派)的国家夺了
    for (const f of faiths) {
      if (f.kind !== 'great') continue;
      const hr = S[f.holy!].region;
      const p = ownP[hr];
      const prev = holyOwner.get(f.id) ?? -2;
      if (p === prev) continue;
      if (prev >= 0 && p >= 0) {
        const st = stateOf[p];
        if (st < 0 || rootOf(st) !== f.id) events.push({ year: y, kind: 'holy', faith: f.id, polity: p, region: hr, settlement: f.holy!, from: prev });
      }
      holyOwner.set(f.id, p);
    }

    // 教派分立
    if (y % SCHISM_EVERY === 0) {
      for (const f of faiths.slice()) {
        if (f.kind !== 'great' || y - f.founded! < SCHISM_AGE || (sects.get(f.id) ?? 0) >= SCHISM_MAX) continue;
        const hr = S[f.holy!].region;
        const d = hops(hr, 200);
        for (const s of states) {
          if (s.until !== undefined || s.faith !== f.id || y - s.from < SCHISM_STATE_YEARS) continue;
          const cap = S[capitalAt(civ.polities[s.polity], y)];
          if (!cap || ownP[hr] === s.polity) continue;
          const farAway = landmass[cap.region] !== landmass[hr] || d[cap.region] < 0 || d[cap.region] >= SCHISM_FAR;
          let n = 0;
          for (let r = 0; r < R; r++) if (ownP[r] === s.polity && faith[r] === f.id) n++;
          if (!farAway || n < SCHISM_MIN) continue;
          if (keyed(seed, 20 + y, s.polity, f.id) >= SCHISM_ODDS) continue;
          const k = faiths.length;
          const nth = sects.get(f.id) ?? 0;
          const eastern = namers(civ.cultures[foundedBy.get(f.id) ?? S[f.holy!].culture].style).family === 'eastern';
          addFaith({
            id: k,
            kind: 'sect',
            name: sectName(faiths, f.name, sectDir(world, civ.regions.seat[hr], civ.regions.seat[cap.region]), cap.name, eastern),
            form: f.form,
            parent: f.id,
            founded: y,
            polity: s.polity,
            seat: cap.id,
            color: shade(f.color, nth === 0 ? 0.32 : -0.28),
          });
          sects.set(f.id, nth + 1);
          for (let r = 0; r < R; r++) if (ownP[r] === s.polity && faith[r] === f.id) set(y, r, k);
          s.until = y;
          states.push({ polity: s.polity, faith: k, from: y });
          stateOf[s.polity] = k;
          events.push({ year: y, kind: 'schism', faith: k, polity: s.polity, region: cap.region, settlement: cap.id, ruler: rulerAt(s.polity, y) });
          break;
        }
      }
    }
    if (y % CHECKPOINT === 0) checkpoints.push({ year: y, faith: Int16Array.from(faith) });
  }
  return {
    faiths,
    events,
    states,
    log: { size: book.year.length, year: Float32Array.from(book.year), region: Int32Array.from(book.region), value: Int16Array.from(book.value) },
    checkpoints,
  };
}

/** 各州现在的信仰 + 变化日志 */
class FaithBook {
  readonly faith: Int16Array;
  readonly year: number[] = [];
  readonly region: number[] = [];
  readonly value: number[] = [];
  constructor(R: number) {
    this.faith = new Int16Array(R).fill(-1);
  }
  set(y: Year, r: number, f: number) {
    if (this.faith[r] === f) return;
    this.faith[r] = f;
    this.year.push(y);
    this.region.push(r);
    this.value.push(f);
  }
}

/** 有人住了 / 民族换了:民间信仰跟着民族(信大教的不变;没人住了 = −1) */
function followCultures(book: FaithBook, y: Year, ownC: Int16Array, lastCulture: Int16Array, isFolk: Uint8Array): void {
  const faith = book.faith;
  for (let r = 0; r < ownC.length; r++) {
    const cu = ownC[r];
    if (cu === lastCulture[r]) continue;
    lastCulture[r] = cu;
    if (cu < 0) book.set(y, r, -1);
    else if (faith[r] < 0 || isFolk[faith[r]] === 1) book.set(y, r, cu);
  }
}

/** 从 from 起第一个 a、b 不一样的下标;没有 = 长度 */
function changed(a: Int16Array, b: Int16Array, from: number): number {
  let r = from;
  while (r < a.length && a[r] === b[r]) r++;
  return r;
}

/**
 * 立国教那一步要的数:各国的州数(total)、各国信各大教 / 教派的州数(count[国家 × F + 信仰]),
 * order = 按第一次扫到的先后排的国家,faithOrder[国家] = 这国按第一次扫到的先后排的信仰(同样多时取先扫到的)
 */
function countFaiths(
  F: number,
  ownP: Int16Array,
  faith: Int16Array,
  isFolk: Uint8Array,
  total: Int32Array,
  count: Int32Array,
  seenP: Int32Array,
  stamp: number,
  order: number[],
  faithOrder: number[][],
): void {
  total.fill(0);
  count.fill(0, 0, total.length * F);
  order.length = 0;
  for (let r = 0; r < ownP.length; r++) {
    const p = ownP[r];
    if (p < 0) continue;
    total[p]++;
    const f = faith[r];
    if (f < 0 || isFolk[f] === 1) continue;
    if (seenP[p] !== stamp) {
      seenP[p] = stamp;
      order.push(p);
      faithOrder[p].length = 0;
    }
    if (count[p * F + f]++ === 0) faithOrder[p].push(f);
  }
}

/** 传播一步:信大教 / 教派的州向相邻的州传,结果写进 next(next 先要是 faith 的拷贝;一个州一步只改信一次) */
function spreadStep(
  seed: number,
  y: Year,
  regions: Civ['regions'],
  faith: Int16Array,
  next: Int16Array,
  ownP: Int16Array,
  stateOf: Int32Array,
  isFolk: Uint8Array,
  rootArr: Int16Array,
): void {
  const { adjStart, adj, adjKind } = regions;
  next.set(faith);
  for (let r = 0; r < regions.count; r++) {
    const f = faith[r];
    if (f < 0 || isFolk[f] === 1) continue;
    const pr = ownP[r];
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
      const n = adj[k];
      const g = faith[n];
      if (g < 0 || g === f || next[n] !== g) continue;
      const gFolk = isFolk[g] === 1;
      if (rootArr[g] === rootArr[f] && !gFolk) continue;
      const pn = ownP[n];
      let p = SPREAD;
      if (pn < 0) p *= TRIBAL;
      else if (pn === pr) p *= SAME_STATE;
      else p *= CROSS_BORDER;
      const st = pn >= 0 ? stateOf[pn] : -1;
      if (st === f) p *= STATE_FAITH;
      else if (st >= 0) p *= OTHER_STATE;
      if (!gFolk) p *= st === f ? 0.3 : FROM_GREAT;
      const kind = adjKind[k];
      if (kind === AdjKind.SeaRoute || kind === AdjKind.Strait) p *= SEA;
      else if (kind === AdjKind.Mountain) p *= MOUNTAIN;
      if (keyed(seed, 10 + y, r, n) < p) next[n] = f;
    }
  }
}

/** 各国信各大教(含教派)的州数:out[国家 × F + 大教] */
function countRoots(R: number, F: number, ownP: Int16Array, faith: Int16Array, isFolk: Uint8Array, rootArr: Int16Array, out: Int32Array): void {
  for (let r = 0; r < R; r++) {
    const p = ownP[r];
    const f = faith[r];
    if (p >= 0 && f >= 0 && isFolk[f] === 0) out[p * F + rootArr[f]]++;
  }
}

/** 民间信仰的名字:族名 + 祖灵(东方)/ 旧神(西幻) */
export function folkSuffix(eastern: boolean): string {
  return eastern ? '祖灵' : '旧神';
}

/** 教派的名字:教名去掉末字 + 方位 + 宗(东方)/ 派(西幻);重名时用那国国都名字的前两个字 */
function sectName(faiths: readonly Faith[], parent: string, dir: string, capital: string, eastern: boolean): string {
  const root = parent.slice(0, -1);
  const byDir = eastern ? `${root}${dir}宗` : `${root}${dir}派`;
  if (!faiths.some((x) => x.name === byDir)) return byDir;
  return eastern ? `${capital.slice(0, 2)}宗` : `${root}${capital.slice(0, 2)}派`;
}

// ---------------------------------------------------------------------------
// 查询

/** 大教 / 教派 / 民间信仰 → 它所属的大教(教派 = 本教;其余 = 它自己) */
export function faithRoot(rel: Religion, f: number): number {
  const x = rel.faiths[f];
  return x && x.kind === 'sect' && x.parent !== undefined ? x.parent : f;
}

/** 日志里第一条年份 > year 的下标 */
function faithLogAfter(log: Religion['log'], year: Year): number {
  let lo = 0;
  let hi = log.size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (log.year[mid] <= year) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 某一年各州的信仰(−1 = 没人住 / 还没算到);没有信仰 = 全 −1。out 可复用 */
export function faithAt(civ: Civ, year: Year, out?: Int16Array): Int16Array {
  const R = civ.regions.count;
  if (!out || out.length !== R) out = new Int16Array(R);
  const rel = civ.religion;
  if (!rel) return out.fill(-1);
  const cps = rel.checkpoints;
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cps[mid].year <= year) lo = mid + 1;
    else hi = mid;
  }
  const cp = lo > 0 ? cps[lo - 1] : null;
  let i = 0;
  if (cp) {
    out.set(cp.faith);
    i = faithLogAfter(rel.log, cp.year);
  } else out.fill(-1);
  const { log } = rel;
  for (; i < log.size && log.year[i] <= year; i++) out[log.region[i]] = log.value[i];
  return out;
}

/** 从头翻日志(不用检查点)。测试用来核对 faithAt */
export function faithFromScratch(civ: Civ, year: Year): Int16Array {
  const out = new Int16Array(civ.regions.count).fill(-1);
  const log = civ.religion?.log;
  if (log) for (let i = 0; i < log.size && log.year[i] <= year; i++) out[log.region[i]] = log.value[i];
  return out;
}

/** 最近 span 年里 (year − span, year] 信仰变过的州:out[州] = 变化的年份,其余为 −Infinity(画信仰色块的渐入用) */
export function faithChanges(civ: Civ, year: Year, span: number, out: Float32Array): Float32Array {
  out.fill(-Infinity);
  const log = civ.religion?.log;
  if (!log) return out;
  const end = faithLogAfter(log, year);
  for (let i = faithLogAfter(log, year - span); i < end; i++) out[log.region[i]] = log.year[i];
  return out;
}

/** 某国某一年的国教;没有 = null */
export function stateFaithAt(rel: Religion | undefined, polity: number, year: Year): StateFaith | null {
  if (!rel) return null;
  for (const s of rel.states) if (s.polity === polity && s.from <= year && (s.until === undefined || s.until > year)) return s;
  return null;
}

/** 某一年奉这种信仰为国教的(按开始的年份) */
export function statesOfFaith(rel: Religion | undefined, faith: number, year: Year): StateFaith[] {
  if (!rel) return [];
  return rel.states.filter((s) => s.faith === faith && s.from <= year && (s.until === undefined || s.until > year)).sort((a, b) => a.from - b.from || a.polity - b.polity);
}

/** 这种信仰到某一年为止有没有出现过(大教、教派:创立了没有;民间信仰:那个民族诞生了没有) */
export function faithBorn(civ: Civ, f: Faith, year: Year): boolean {
  if (f.kind === 'folk') return (civ.cultures[f.culture ?? f.id]?.born ?? 0) <= year;
  return (f.founded ?? 0) <= year;
}

/**
 * 某一年各信仰有几个州(有人住的州):n[信仰编号],folk = 所有民间信仰加起来,total = 有人住的州。
 * own = 那一年的归属(ownersAt;给了就不再算)
 */
export function faithCounts(civ: Civ, year: Year, faiths?: Int16Array, own?: Owners): { n: Int32Array; folk: number; total: number } {
  const rel = civ.religion;
  const n = new Int32Array(rel?.faiths.length ?? 0);
  let folk = 0;
  let total = 0;
  if (!rel) return { n, folk, total };
  const fa = faiths ?? faithAt(civ, year);
  const o = own ?? ownersAt(civ, year);
  for (let r = 0; r < civ.regions.count; r++) {
    const f = fa[r];
    if (o.culture[r] < 0 || f < 0) continue;
    total++;
    n[f]++;
    if (rel.faiths[f].kind === 'folk') folk++;
  }
  return { n, folk, total };
}

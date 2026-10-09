/**
 * 技术层(generateCiv 的末步):推演结束后照已有历史"贴"上去 —— 国界、兴亡、战争一个都不变。
 *
 *   - **气质**:按一国的寿命、峰值州数、开战次数、邻国接触、生计等打出一两枚中文标签(守成 / 好战 / 商路发达……),
 *     国家面板展示;发明 / 传播的纪事措辞偶尔带上气质。
 *   - **时代**:世界按摇篮年表分成金石 → 铁器 → 火药 → 刊印几段;一国离最近文明摇篮越远,进入同一时代越晚
 *     (每一步州图路程大约几十年),领先 / 落后写在面板上。
 *   - **扩散**:冶铁、火器等几样技术先在一国出现,再经战争或商路传到邻国;每一步都是一条带年份的编年史
 *     (techText.ts 的 techEntries → fullChronicle)。
 *
 * 随机数一律 keyed(subSeed(seed, 'civ-tech'), …)。改了算法、同一个种子的技术层变了,要把 edits.ts 的 GENERATOR_VERSION 加一。
 */
import type { Civ, Polity, Tech, TechEraDef, TechEvent, TechKind, TechPolity, TechTemperament, Year } from './types';
import { AdjKind } from './types';
import { ownersAt, type Owners } from './timeline';
import { capitalAt, polityAlive } from './growth';
import { keyed, keyed4, subSeed } from './rand';

/** 世界时代(摇篮年表;名字给界面和纪事用) */
export const TECH_ERAS: readonly TechEraDef[] = [
  { id: 0, name: '金石', from: 300 },
  { id: 1, name: '铁器', from: 900 },
  { id: 2, name: '火药', from: 1650 },
  { id: 3, name: '刊印', from: 2200 },
];

/** 会扩散的技术:所属时代、发明 / 传入的重要度 */
const TECHS: readonly { kind: TechKind; name: string; era: number; inventImp: 1 | 2 | 3; spreadImp: 1 | 2 | 3 }[] = [
  { kind: 'iron', name: '冶铁', era: 1, inventImp: 3, spreadImp: 2 },
  { kind: 'stirrup', name: '马镫', era: 1, inventImp: 2, spreadImp: 1 },
  { kind: 'compass', name: '指南针', era: 2, inventImp: 2, spreadImp: 1 },
  { kind: 'gunpowder', name: '火器', era: 2, inventImp: 3, spreadImp: 2 },
  { kind: 'print', name: '印刷术', era: 3, inventImp: 3, spreadImp: 2 },
];

export const TECH_NAME: Readonly<Record<TechKind, string>> = Object.fromEntries(TECHS.map((t) => [t.kind, t.name])) as Record<TechKind, string>;

/** 离摇篮一步州图路程,进入时代晚多少年 */
const YEARS_PER_STEP = 28;
/** 取最早诞生的几个民族发源地当文明摇篮 */
const CRADLE_N = 3;
/** 商路传播:邻国每隔这么多年看一次 */
const TRADE_GAP = 40;
/** 气质最多几枚 */
const TEMPER_MAX = 2;

/** 技术中文名 */
export function techLabel(kind: TechKind): string {
  return TECH_NAME[kind] ?? kind;
}

/** 摇篮年表上、第 year 年已经进入第几段时代(0 起;-1 = 还在金石以前) */
export function worldEraIndex(year: Year): number {
  let k = -1;
  for (const e of TECH_ERAS) if (year >= e.from) k = e.id;
  return k;
}

/** 一国在第 year 年所处时代下标(已扣掉相对摇篮的落后;发明过技术的略超前) */
export function polityEraIndex(tp: TechPolity, year: Year): number {
  return worldEraIndex(year - tp.lagYears);
}

/** 领先 / 落后的说法:正 = 领先摇篮,负 = 落后。不到十年写"与摇篮相当" */
export function lagLabel(lagYears: number): string {
  const n = Math.round(Math.abs(lagYears) / 10) * 10;
  if (n < 10) return '与摇篮相当';
  return lagYears < 0 ? `领先约 ${n} 年` : `落后约 ${n} 年`;
}

/** 时代全称:"铁器时代" */
export function eraTitle(era: number): string {
  const e = TECH_ERAS[era];
  return e ? `${e.name}时代` : '前金石';
}

/** 推演结束后算技术层(见文件头)。没有国家 = 空壳 */
export function buildTech(civ: Civ): Tech {
  const seed = subSeed(civ.seed, 'civ-tech');
  const empty: Tech = { eras: TECH_ERAS.map((e) => ({ ...e })), cradles: [], polities: [], events: [] };
  if (!civ.viable || !civ.polities.length) return empty;

  const cradles = pickCradles(civ);
  const dist = regionDist(civ, cradles);
  const stats = polityStats(civ);
  const wars = warPairs(civ);
  const polities: TechPolity[] = civ.polities.map((p) => {
    const st = stats[p.id];
    const cradleDist = capitalDist(civ, p, dist);
    const temperaments = temperOf(p, st, seed);
    // 地理越远越落后;发明过技术的国家在后面补一个提前量
    let lagYears = cradleDist * YEARS_PER_STEP;
    // 开疆 / 好战略赶超,守成略慢(气质定了以后微调,仍是确定性的)
    if (temperaments.includes('开疆')) lagYears -= 20;
    if (temperaments.includes('好战')) lagYears -= 10;
    if (temperaments.includes('守成')) lagYears += 15;
    if (temperaments.includes('商路发达')) lagYears -= 15;
    return { polity: p.id, temperaments, cradleDist, lagYears, known: [] };
  });

  const events = diffuse(civ, polities, wars, seed);
  // 发明国再提前一点(已经写进 events 了,回头改 lag / known)
  for (const e of events) {
    if (e.kind !== 'invent') continue;
    const tp = polities[e.polity];
    if (!tp) continue;
    tp.lagYears = Math.max(0, tp.lagYears - 35);
    if (!tp.known.includes(e.tech)) tp.known.push(e.tech);
  }
  for (const e of events) {
    if (e.kind !== 'spread') continue;
    const tp = polities[e.polity];
    if (tp && !tp.known.includes(e.tech)) tp.known.push(e.tech);
  }
  for (const tp of polities) tp.known.sort();

  return {
    eras: TECH_ERAS.map((e) => ({ ...e })),
    cradles: cradles.slice(),
    polities,
    events,
  };
}

/** 某国在某一年来的技术概况(面板用;没有技术层 = null) */
export function polityTechAt(civ: Civ, id: number, year: Year): { temperaments: TechTemperament[]; era: number; lagYears: number; eraName: string; lagText: string } | null {
  const tech = civ.tech;
  if (!tech) return null;
  const tp = tech.polities[id];
  if (!tp) return null;
  const era = Math.max(0, polityEraIndex(tp, year));
  return {
    temperaments: tp.temperaments,
    era,
    lagYears: tp.lagYears,
    eraName: eraTitle(era),
    lagText: lagLabel(tp.lagYears),
  };
}

// ---------------------------------------------------------------------------
// 摇篮与路程

/** 最早诞生的几个民族的发源州 = 文明摇篮 */
function pickCradles(civ: Civ): number[] {
  const list = civ.cultures.slice().sort((a, b) => a.born - b.born || a.id - b.id);
  const out: number[] = [];
  for (const c of list) {
    if (c.hearth < 0 || c.hearth >= civ.regions.count) continue;
    if (!out.includes(c.hearth)) out.push(c.hearth);
    if (out.length >= CRADLE_N) break;
  }
  return out;
}

/** 各州到最近摇篮的州图步数(接壤边;海峡 / 航线也算一步) */
function regionDist(civ: Civ, cradles: number[]): Int16Array {
  const R = civ.regions.count;
  const dist = new Int16Array(R).fill(32767);
  if (!cradles.length) return dist;
  const { adjStart, adj } = civ.regions;
  const q: number[] = [];
  for (const c of cradles) {
    if (c >= 0 && c < R) {
      dist[c] = 0;
      q.push(c);
    }
  }
  for (let i = 0; i < q.length; i++) {
    const r = q[i];
    const d = dist[r] + 1;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
      const n = adj[k];
      if (d < dist[n]) {
        dist[n] = d;
        q.push(n);
      }
    }
  }
  return dist;
}

/** 一国的摇篮路程:立国时国都所在州;找不到就取峰值时任一州 */
function capitalDist(civ: Civ, p: Polity, dist: Int16Array): number {
  const cap = civ.settlements[p.capital];
  if (cap && cap.region >= 0 && cap.region < dist.length && dist[cap.region] < 32767) return dist[cap.region];
  let best = 32767;
  for (let r = 0; r < dist.length; r++) if (dist[r] < best) best = dist[r];
  return best === 32767 ? 0 : best;
}

// ---------------------------------------------------------------------------
// 气质与统计

interface Stats {
  peak: number;
  wars: number;
  conquers: number;
  neighbors: number;
  seaTouch: number;
  assimilate: number;
  years: number;
}

function polityStats(civ: Civ): Stats[] {
  const n = civ.polities.length;
  const out: Stats[] = Array.from({ length: n }, () => ({ peak: 0, wars: 0, conquers: 0, neighbors: 0, seaTouch: 0, assimilate: 0, years: 0 }));
  for (const p of civ.polities) {
    const end = p.ended ?? civ.endYear;
    out[p.id].years = Math.max(1, end - p.founded);
  }
  for (const a of civ.annals) {
    if (a.kind === 'war' && a.a >= 0 && a.a < n) out[a.a].wars++;
    if (a.kind === 'conquer' && a.a >= 0 && a.a < n) out[a.a].conquers++;
    if (a.kind === 'assimilate' && a.a >= 0 && a.a < n) out[a.a].assimilate++;
  }
  const nearAll: Set<number>[] = Array.from({ length: n }, () => new Set());
  let own: Owners | undefined;
  for (let y = 0; y <= civ.endYear; y += 50) {
    own = ownersAt(civ, y, own);
    const size = new Int32Array(n);
    const sea = new Int32Array(n);
    for (let r = 0; r < civ.regions.count; r++) {
      const p = own.polity[r];
      if (p >= 0) size[p]++;
    }
    for (let p = 0; p < n; p++) if (size[p] > out[p].peak) out[p].peak = size[p];
    const { adjStart, adj, adjKind } = civ.regions;
    for (let r = 0; r < civ.regions.count; r++) {
      const p = own.polity[r];
      if (p < 0) continue;
      for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
        const q = own.polity[adj[k]];
        if (q >= 0 && q !== p) nearAll[p].add(q);
        if (adjKind[k] === AdjKind.Strait || adjKind[k] === AdjKind.SeaRoute) sea[p]++;
      }
    }
    for (let p = 0; p < n; p++) if (sea[p] > out[p].seaTouch) out[p].seaTouch = sea[p];
  }
  for (let p = 0; p < n; p++) out[p].neighbors = nearAll[p].size;
  return out;
}

function temperOf(p: Polity, st: Stats, seed: number): TechTemperament[] {
  const scores: { t: TechTemperament; s: number }[] = [];
  const warRate = st.wars / (st.years / 100);
  const conquerRate = st.conquers / Math.max(1, st.peak);
  scores.push({ t: '好战', s: warRate * 2.2 + (p.expansionism > 1.15 ? 0.4 : 0) });
  scores.push({ t: '开疆', s: conquerRate * 1.8 + (p.expansionism > 1.05 ? 0.3 : 0) + st.peak / 80 });
  scores.push({ t: '守成', s: (st.years > 600 ? 1.2 : 0.4) + (warRate < 0.8 ? 1.0 : 0) + (st.peak >= 8 && st.peak < 40 ? 0.5 : 0) - conquerRate });
  scores.push({ t: '商路发达', s: (p.kind === 'sea' ? 1.6 : 0) + st.seaTouch / 40 + (p.kind === 'river' ? 0.4 : 0) });
  scores.push({ t: '孤悬一方', s: st.neighbors <= 2 ? 1.5 + (4 - st.neighbors) * 0.4 : st.neighbors <= 3 ? 0.6 : 0 });
  scores.push({ t: '兼收并蓄', s: st.neighbors / 6 + st.assimilate / 8 });
  scores.push({ t: '雄踞一方', s: st.peak >= 25 ? st.peak / 30 : 0 });
  scores.push({ t: '短促', s: st.years < 180 ? 1.8 : st.years < 280 ? 0.8 : 0 });
  // 同分按种子微扰,避免各国标签过于雷同
  scores.forEach((x, i) => {
    x.s += keyed(seed, p.id, i + 1) * 0.15;
  });
  scores.sort((a, b) => b.s - a.s || a.t.localeCompare(b.t, 'zh'));
  const out: TechTemperament[] = [];
  for (const x of scores) {
    if (x.s < 0.85) continue;
    // 互相排斥的几对
    if (x.t === '守成' && out.includes('好战')) continue;
    if (x.t === '好战' && out.includes('守成')) continue;
    if (x.t === '短促' && out.includes('雄踞一方')) continue;
    if (x.t === '孤悬一方' && out.includes('兼收并蓄')) continue;
    out.push(x.t);
    if (out.length >= TEMPER_MAX) break;
  }
  if (!out.length) out.push(scores[0].s >= 0.5 ? scores[0].t : '守成');
  return out;
}

// ---------------------------------------------------------------------------
// 战争对与扩散

interface WarPair {
  year: Year;
  a: number;
  b: number;
}

function warPairs(civ: Civ): WarPair[] {
  const out: WarPair[] = [];
  for (const e of civ.annals) {
    if (e.kind === 'war' && e.a >= 0 && e.b >= 0) out.push({ year: e.year, a: e.a, b: e.b });
  }
  return out;
}

/** 发明 + 经战争 / 商路扩散;写入 events,顺带填 polities[].known 的发明部分 */
function diffuse(civ: Civ, polities: TechPolity[], wars: WarPair[], seed: number): TechEvent[] {
  const events: TechEvent[] = [];
  const end = civ.endYear;
  for (const tech of TECHS) {
    const eraFrom = TECH_ERAS[tech.era]?.from ?? end;
    // 各国本地发明年份 = 摇篮时代起点 + 落后 + 一点抖动
    let bestP = -1;
    let bestY = Infinity;
    for (const p of civ.polities) {
      const tp = polities[p.id];
      const y0 = eraFrom + tp.lagYears + Math.floor(keyed(seed, tech.era, p.id, 1) * 90);
      if (y0 < p.founded || y0 >= (p.ended ?? end + 1)) continue;
      // 太小的部不发明大事技术
      if (tech.inventImp >= 3 && (polityPeakBefore(civ, p.id, y0) < 5)) continue;
      if (y0 < bestY || (y0 === bestY && p.id < bestP)) {
        bestY = y0;
        bestP = p.id;
      }
    }
    if (bestP < 0) continue;
    const inventYear = bestY;
    const region = inventRegion(civ, bestP, inventYear);
    events.push({
      year: inventYear,
      kind: 'invent',
      tech: tech.kind,
      polity: bestP,
      via: 'origin',
      region,
      importance: tech.inventImp,
    });
    const have = new Map<number, Year>([[bestP, inventYear]]);
    // 按学会的先后往外传:先看战争缴获,再看商路(新学会的国也会继续往外传)
    const order = [bestP];
    for (let qi = 0; qi < order.length; qi++) {
      const src = order[qi];
      const since = have.get(src)!;
      for (const w of wars) {
        if (w.year < since) continue;
        const other = w.a === src ? w.b : w.b === src ? w.a : -1;
        if (other < 0 || have.has(other) || !polityAlive(civ.polities[other], w.year)) continue;
        const y = w.year + 2 + Math.floor(keyed(seed, tech.era, src, other) * 6);
        if (y > end || y >= (civ.polities[other].ended ?? end + 1)) continue;
        have.set(other, y);
        order.push(other);
        events.push({
          year: y,
          kind: 'spread',
          tech: tech.kind,
          polity: other,
          from: src,
          via: 'war',
          region: inventRegion(civ, other, y),
          importance: tech.spreadImp,
        });
      }
      let own: Owners | undefined;
      for (let y = Math.ceil(since / TRADE_GAP) * TRADE_GAP; y <= end; y += TRADE_GAP) {
        if (!polityAlive(civ.polities[src], y)) break;
        own = ownersAt(civ, y, own);
        for (const nbr of neighborsOf(civ, own, src)) {
          if (have.has(nbr) || !polityAlive(civ.polities[nbr], y)) continue;
          const srcT = polities[src].temperaments;
          const nbrT = polities[nbr].temperaments;
          let chance = 0.35;
          if (srcT.includes('商路发达') || nbrT.includes('商路发达')) chance += 0.25;
          if (nbrT.includes('兼收并蓄')) chance += 0.15;
          if (nbrT.includes('孤悬一方')) chance -= 0.15;
          if (keyed4(seed, tech.era, src, nbr, Math.floor(y)) > chance) continue;
          const sy = y + Math.floor(keyed4(seed, tech.era, nbr, Math.floor(y), 1) * 8);
          if (sy > end || sy >= (civ.polities[nbr].ended ?? end + 1)) continue;
          have.set(nbr, sy);
          order.push(nbr);
          events.push({
            year: sy,
            kind: 'spread',
            tech: tech.kind,
            polity: nbr,
            from: src,
            via: 'trade',
            region: inventRegion(civ, nbr, sy),
            importance: tech.spreadImp,
          });
        }
      }
    }
  }
  events.sort((a, b) => a.year - b.year || a.polity - b.polity || a.tech.localeCompare(b.tech));
  return events;
}

function polityPeakBefore(civ: Civ, id: number, year: Year): number {
  let peak = 0;
  let own: Owners | undefined;
  for (let y = civ.polities[id].founded; y <= year; y += 50) {
    own = ownersAt(civ, y, own);
    let n = 0;
    for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === id) n++;
    if (n > peak) peak = n;
  }
  return peak;
}

function inventRegion(civ: Civ, polity: number, year: Year): number {
  const p = civ.polities[polity];
  if (!p) return -1;
  const sid = capitalAt(p, year);
  const s = civ.settlements[sid];
  return s ? s.region : -1;
}

function neighborsOf(civ: Civ, own: Owners, id: number): number[] {
  const out = new Set<number>();
  const { adjStart, adj } = civ.regions;
  for (let r = 0; r < civ.regions.count; r++) {
    if (own.polity[r] !== id) continue;
    for (let k = adjStart[r]; k < adjStart[r + 1]; k++) {
      const q = own.polity[adj[k]];
      if (q >= 0 && q !== id) out.add(q);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 城市人口、城市分级、国号形态 —— 纯函数,推演(polities.ts)和界面(面板、悬停、画城镇符号)共用。
 * 单独放一个文件,不引入起名器和推演代码:主线程只用得到这些,打包时不用把地名词库带上。
 *
 * 人口单位:千人。
 *
 * **城市怎么长**:S 形曲线逐年逼近上限,任何年份都能现算,不用存每年的人口:
 *   人口(年) = 上限 ÷ (1 + GROWTH_A × e^(−速度 × (年 − 建城年)))
 *   建城那年人口约是上限的 1/41(几百到一两千人的村子);国都的上限再高 CAPITAL_BOOST,在 CAPITAL_RAMP 年里渐渐加上去。
 *
 * **城市兴衰**(阶段 3,cities.ts):洗劫后人口大减、之后慢慢恢复(Settlement.sacks);迁都 / 亡国后旧都的国都加成慢慢退掉
 * (Settlement.capitalSpans);被毁(Settlement.ended)后为 0。都按年份段现算,见 populationAt。
 *
 * **城市分级**(按当年人口):村 < 8 千 ≤ 镇 < 2.5 万 ≤ 城 < 8 万 ≤ 大城。国都另画(不看人口)。
 *
 * **国号**:按当年的国土(州数)分四档,"升格"是推演里的一条事件(polities.ts),记在 Polity.titles 里。
 *
 * 西幻语感(音译的国名)—— 全称 = 国名词根 + 当年的国号,如"索拉特部 → 索拉特汗国 → 索拉特大汗国":
 *
 *   | 档 | 州数   | 农耕一系 | 游牧(汗国一系) | 海洋(城邦共和一系) |
 *   |----|--------|----------|------------------|----------------------|
 *   | 0  | 1–4    | 部       | 部               | 城邦                 |
 *   | 1  | 5–24   | 国       | 汗国             | 共和国               |
 *   | 2  | 25–69  | 王国     | 汗国             | 共和国               |
 *   | 3  | ≥ 70   | 帝国     | 大汗国           | 帝国                 |
 *
 * 东方语感(Polity.eastern)走中式写法(见 easternTitles):单字国名配"王国 / 帝国"是翻译腔("昌王国"),
 * 改成"昌部 → 昌国 → 大昌 → 大昌王朝";游牧"昌部 → 昌汗国 → 大昌汗国";海洋民族也走农耕这一套。
 * 两个字的国名不硬加"大"("景辰国 → 景辰王朝 → 景辰皇朝"),自带"大"的("大安")不叠成"大大安"。
 *
 * **王朝更替**(阶段 3,Polity.dynasties):东方国家改朝换代换国号,词根按年份取当朝的("大昌 → 大景",档位不变);
 * 西幻国家王室更迭,国名不变。国名一律经由 polityName / polityTitles(p, 年份) / polityShortTitle(p, 档位, 年份) 取,
 * 界面、地图、编年史就都跟着年份变;不给年份 = 第一朝(立国时的国名)。
 */
import type { Civ, Polity, PolityLineage, PopulationAt, Settlement, Year } from './types';
import { fexp, flog } from './rand';

/** S 形成长的初值比:建城那年人口 = 上限 ÷ (1 + GROWTH_A) */
export const GROWTH_A = 40;
/** 国都:人口上限 × (1 + CAPITAL_BOOST),立都后 CAPITAL_RAMP 年里渐渐加上去 */
export const CAPITAL_BOOST = 0.6;
export const CAPITAL_RAMP = 200;
/** 旧都衰落(阶段 3 城市兴衰):失去国都之位后,国都加成在这么多年里渐渐退掉(人口一两百年里回落) */
export const CAPITAL_DECLINE = 150;
/** 洗劫后人口慢慢恢复:折损按 e^(−年数 ÷ SACK_RECOVER) 淡去(约 70 年恢复一大半,两百年后几乎看不出) */
export const SACK_RECOVER = 70;

/**
 * 国都加成此刻加到了几成(0..1):按做国都的年份段(Settlement.capitalSpans)分段现算 ——
 * 做国都时每年 +1/CAPITAL_RAMP、不做了每年 −1/CAPITAL_DECLINE(再次立都从剩下的那几成接着加)
 */
export function capitalLevel(s: Settlement, year: Year): number {
  const spans = s.capitalSpans;
  if (!spans) return s.capitalFrom !== undefined && year > s.capitalFrom ? Math.min(1, (year - s.capitalFrom) / CAPITAL_RAMP) : 0;
  let lvl = 0;
  /** 上一段结束的年份(还没有结束过的段 = NaN) */
  let off = NaN;
  for (const sp of spans) {
    if (!(year > sp.from)) break;
    if (off === off) lvl = Math.max(0, lvl - (sp.from - off) / CAPITAL_DECLINE);
    const until = sp.until ?? Infinity;
    lvl = Math.min(1, lvl + (Math.min(year, until) - sp.from) / CAPITAL_RAMP);
    if (year <= until) return lvl;
    off = until;
  }
  return off === off ? Math.max(0, lvl - (year - off) / CAPITAL_DECLINE) : lvl;
}

/**
 * 某年的人口(千人);还没建城 / 已经被毁 = 0。
 * = S 形曲线 × 国都加成(capitalLevel)× 各次洗劫后还没恢复的那部分(1 − 折损 × e^(−年数 ÷ SACK_RECOVER))。
 * 全是现算,任何年份都能直接算,不存每年的人口
 */
export const populationAt: PopulationAt = (s: Settlement, year: Year): number => {
  if (!(year >= s.founded) || (s.ended !== undefined && year >= s.ended)) return 0;
  let cap = s.capacity;
  if (s.capitalFrom !== undefined && year > s.capitalFrom) cap *= 1 + CAPITAL_BOOST * capitalLevel(s, year);
  const sacks = s.sacks;
  if (sacks) {
    for (const k of sacks) {
      if (!(year >= k.year)) break;
      cap *= 1 - k.loss * fexp(-(year - k.year) / SACK_RECOVER);
    }
  }
  return cap / (1 + GROWTH_A * fexp(-s.growth * (year - s.founded)));
};

/** 不算国都加成时,人口越过 level(千人)的年份;上限不够 = Infinity */
export function yearReaching(s: Settlement, level: number): Year {
  const ratio = s.capacity / level - 1;
  if (!(ratio > 0)) return Infinity;
  return s.founded + Math.max(0, flog(GROWTH_A / ratio) / s.growth);
}

/** 城市分级:按人口(千人)的门槛 */
export const SETTLEMENT_RANKS: readonly { name: string; min: number }[] = [
  { name: '村', min: 0 },
  { name: '镇', min: 8 },
  { name: '城', min: 25 },
  { name: '大城', min: 80 },
];

/** 人口 → 分级(0 村 / 1 镇 / 2 城 / 3 大城) */
export function settlementRank(pop: number): number {
  let r = 0;
  for (let i = 1; i < SETTLEMENT_RANKS.length; i++) if (pop >= SETTLEMENT_RANKS[i].min) r = i;
  return r;
}

/** 阶段 3 城市兴衰:被毁的城被毁前一刻的级别(0 村 … 3 大城);没被毁 = −1 */
export function ruinRank(s: Settlement): number {
  return s.ended === undefined ? -1 : settlementRank(populationAt(s, s.ended - 1 / 256));
}

/** 地形大事里沉入海中的城(史事 sunk,b = 1)和城址沉了的遗址(UpheavalFact.ruins):城 → 哪一年沉的(同一份史事只数一次) */
const drownedMemo = new WeakMap<readonly unknown[], Map<number, Year>>();
function drownedCities(civ: Civ): Map<number, Year> {
  let d = drownedMemo.get(civ.annals);
  if (!d) {
    d = new Map();
    if (civ.upheavals?.length) {
      for (const e of civ.annals) if (e.kind === 'sunk' && e.b === 1) d.set(e.settlement, e.year);
      for (const f of civ.upheavals) for (const s of f.ruins ?? []) if (!d.has(s)) d.set(s, f.year);
    }
    drownedMemo.set(civ.annals, d);
  }
  return d;
}

/**
 * 某一年地图上的遗址:毁了、到这一年还没在故址上重建起新城的城(按编号)。
 * 同一处先后毁过几次的只算最近那一座;沉入海中的(地形大事;早先的遗址从城址沉了那年起)没有遗址
 */
export function ruinSites(civ: Civ, year: Year): Settlement[] {
  const S = civ.settlements;
  /** 旧城 → 在它故址上重建的新城 */
  const next = new Map<number, Settlement>();
  for (const s of S) if (s.rebuilds !== undefined) next.set(s.rebuilds, s);
  const drowned = drownedCities(civ);
  const out: Settlement[] = [];
  for (const s of S) {
    if (s.ended === undefined || !(s.ended <= year) || (drowned.get(s.id) ?? Infinity) <= year) continue;
    const n = next.get(s.id);
    if (n && n.founded <= year) continue;
    out.push(s);
  }
  return out;
}

/** 人口的说法:"约 3.2 万人"、"约 4000 人" */
export function populationLabel(pop: number): string {
  if (pop >= 10) return `约 ${(pop / 10).toFixed(pop >= 100 ? 0 : 1).replace(/\.0$/, '')} 万人`;
  const n = Math.max(100, Math.round(pop * 10) * 100);
  return `约 ${n} 人`;
}

/** 国号四档的州数门槛:第 i 档要 ≥ TIER_REGIONS[i] 个州 */
export const TIER_REGIONS: readonly number[] = [1, 5, 25, 70];

export function tierOf(regions: number): number {
  let t = 0;
  for (let i = 1; i < TIER_REGIONS.length; i++) if (regions >= TIER_REGIONS[i]) t = i;
  return t;
}

/** 国号形态表(西幻语感,按一系、档位):全称 = 词根 + 国号 */
export const POLITY_FORMS: Record<PolityLineage, readonly [string, string, string, string]> = {
  realm: ['部', '国', '王国', '帝国'],
  khanate: ['部', '汗国', '汗国', '大汗国'],
  republic: ['城邦', '共和国', '共和国', '帝国'],
};

type Titles = readonly [string, string, string, string];

/**
 * 东方语感的国号形态表(按一系、档位)。root = 国名词根;single = 单字词根(或"大"+ 单字,如"大安"),
 * core = 去掉"大"的那个字。第 2、3 档单字国名加"大"(大昌、大昌王朝),两个字的不加(景辰王朝、景辰皇朝)。
 */
const EASTERN_FORMS: Record<'realm' | 'khanate', (root: string, single: boolean, core: string) => Titles> = {
  realm: (root, single, core) => [
    `${root}部`,
    `${root}国`,
    single ? `大${core}` : `${root}王朝`,
    single ? `大${core}王朝` : `${root}皇朝`,
  ],
  khanate: (root, single, core) => [
    `${root}部`,
    `${root}汗国`,
    `${root}汗国`,
    single ? `大${core}汗国` : `${root}大汗国`,
  ],
};

/** 词根拆成 [是否单字, 核心字]:"昌" → [true, 昌];"大安" → [true, 安];"景辰" → [false, 景辰] */
function splitRoot(root: string): [boolean, string] {
  const cs = [...root];
  if (cs.length === 1) return [true, root];
  if (cs.length === 2 && cs[0] === '大') return [true, cs[1]];
  return [false, root];
}

/** 东方语感的四档全称(海洋民族也走农耕这一套:中式没有"共和国") */
export function easternTitles(root: string, lineage: PolityLineage = 'realm'): Titles {
  const [single, core] = splitRoot(root);
  return EASTERN_FORMS[lineage === 'khanate' ? 'khanate' : 'realm'](root, single, core);
}

/**
 * 某一年是第几朝(Polity.dynasties 的下标,改朝换代那一刻起算新朝;没改朝换代过 = 0)。
 * 年份早于立国 = 第一朝
 */
export function dynastyIndexAt(p: Polity, year: Year): number {
  const d = p.dynasties;
  if (!d || d.length < 2) return 0;
  let i = 0;
  while (i + 1 < d.length && d[i + 1].year <= year) i++;
  return i;
}

/** 某一年的那一朝(没改朝换代过 = undefined) */
export function dynastyAt(p: Polity, year: Year): { year: Year; name: string; seat: number } | undefined {
  const d = p.dynasties;
  return d && d.length ? d[dynastyIndexAt(p, year)] : undefined;
}

/**
 * 某一年的国名词根:东方语感按当朝(改朝换代后换国号:"昌" → "景");西幻语感国名不变(王室换了,国名照旧)。
 * 新朝还没起名(推演中途)= 原词根
 */
export function polityRootAt(p: Polity, year: Year): string {
  if (!p.eastern || !p.dynasties || p.dynasties.length < 2) return p.name;
  return p.dynasties[dynastyIndexAt(p, year)].name || p.name;
}

/**
 * 某一朝的王朝名:东方 = 国名词根("景",编年史里写"大景"之类用 polityName);西幻 = "卡诺王朝"。
 * 没改朝换代过、或还没起名 = 空串
 */
export function dynastyTitle(p: Polity, i: number): string {
  const d = p.dynasties?.[i];
  if (!d || !d.name) return '';
  return p.eastern ? d.name : `${d.name}王朝`;
}

const titleCache = new WeakMap<Polity, Map<string, Titles>>();

/** 词根 root 的四档全称(按这个国家的语感、一系) */
function titlesOf(p: Polity, root: string): Titles {
  const key = `${root}|${p.lineage ?? 'realm'}|${p.eastern ? 1 : 0}`;
  let m = titleCache.get(p);
  if (!m) titleCache.set(p, (m = new Map()));
  let t = m.get(key);
  if (!t) {
    const lineage = p.lineage ?? 'realm';
    t = p.eastern ? easternTitles(root, lineage) : (POLITY_FORMS[lineage].map((f) => root + f) as unknown as Titles);
    m.set(key, t);
  }
  return t;
}

/**
 * 这个国家四档的全称(按语感、一系)。给了年份就按那一年的那一朝(东方改朝换代后国号换了);
 * 不给 = 第一朝(立国时的国名)
 */
export function polityTitles(p: Polity, year?: Year): Titles {
  return titlesOf(p, year === undefined ? p.name : polityRootAt(p, year));
}

/** 这个国家先后用过的国名词根(第一朝在前,去重;西幻只有一个) */
export function polityRoots(p: Polity): string[] {
  const out = [p.name];
  if (p.eastern) for (const d of p.dynasties ?? []) if (d.name && !out.includes(d.name)) out.push(d.name);
  return out;
}

/** 这个国家历朝历代各档的全称和简称(地图文字的字表、字体预载用) */
export function polityAllTitles(p: Polity): string[] {
  const out = new Set<string>();
  for (const root of polityRoots(p)) {
    const t = titlesOf(p, root);
    for (let tier = 0; tier < 4; tier++) {
      out.add(t[tier]);
      out.add(shortTitle(p, root, tier));
    }
  }
  return [...out];
}

function shortTitle(p: Polity, root: string, tier: number): string {
  if (tier < 0) return root;
  if (!p.eastern) return root;
  const [single, core] = splitRoot(root);
  if (!single) return root;
  if (tier >= 2 && p.lineage !== 'khanate') return `大${core}`;
  return titlesOf(p, root)[tier];
}

/**
 * 地图上用的简称(国土放不下全称时写它):西幻语感 = 词根("索拉特王国" → "索拉特");
 * 东方语感:单字国名第 2 档起 = "大X"("大昌王朝" → "大昌"),两个字的 = 词根("景辰皇朝" → "景辰"),
 * 单字国名第 0、1 档("昌部""昌国")单写一个字认不出是国名,简称就是全称。
 * 给了年份就按那一年的那一朝(改朝换代后"大昌" → "大景");不给 = 第一朝
 */
export function polityShortTitle(p: Polity, tier: number, year?: Year): string {
  return shortTitle(p, year === undefined ? p.name : polityRootAt(p, year), tier);
}

/** 某一年的国号档位(按 titles 查);还没立国 = −1 */
export function polityTierAt(p: Polity, year: Year): number {
  if (!(year >= p.founded)) return -1;
  const t = p.titles;
  if (!t || !t.length) return 0;
  let tier = t[0].tier;
  for (let i = 1; i < t.length && t[i].year <= year; i++) tier = t[i].tier;
  return tier;
}

/** 某一年的全称("索拉特王国"、"大昌王朝");还没立国 = 词根 */
export function polityName(p: Polity, year: Year): string {
  const tier = polityTierAt(p, year);
  return tier < 0 ? p.name : polityTitles(p, year)[tier];
}

/**
 * 国号升格的路线(去重):"昌部 → 昌国 → 大昌 → 大昌王朝"。
 * 东方改朝换代过的(阶段 3),写实际用过的国号,按先后:"昌部 → 昌国 → 大昌 → 大景 → 大景王朝 → 大雍王朝"
 * (西幻王室更迭国名不变,照旧)。这里的字都是国号里的字(本文件的字面量会收进地图字体的字表)
 */
export function polityTitleChain(p: Polity): string {
  const d = p.dynasties;
  if (!p.eastern || !d || d.length < 2 || !d[1].name) {
    return polityTitles(p)
      .filter((f, i, a) => a.indexOf(f) === i)
      .join(' → ');
  }
  const years = [...(p.titles ?? []).map((x) => x.year), ...d.map((x) => x.year)].sort((a, b) => a - b);
  const out: string[] = [];
  for (const y of years) {
    const n = polityName(p, y);
    if (out[out.length - 1] !== n) out.push(n);
  }
  return out.join(' → ');
}

/**
 * 某一年的国都(Settlement id;按 capitals 查,迁都当年起算新国都)。还没立国的年份 = 立国时的国都。
 * 画国都符号、悬停、面板都用它,别直接读 p.capital(那只是立国时的国都)
 */
export function capitalAt(p: Polity, year: Year): number {
  const c = p.capitals;
  if (!c || !c.length) return p.capital;
  let s = c[0].settlement;
  for (let i = 1; i < c.length && c[i].year <= year; i++) s = c[i].settlement;
  return s;
}

/** 国家在某一年存在(已立国、还没灭亡) */
export function polityAlive(p: Polity, year: Year): boolean {
  return year >= p.founded && (p.ended === undefined || year < p.ended);
}

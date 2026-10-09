/**
 * AI 写史书(阶段 5)的提示词:把推演出来的历史整理成"材料",连同写作要求交给 AI。
 * 纯函数:只读 civ(界面用的那份,用户改过的名字已经套上),不碰 DOM、不调 AI;同一个 civ + 选项永远得到同样的文字。
 *
 * - 写什么(HistoryScope):世界通史 / 某国国史(从立国到灭亡或至今,含历朝)/ 某段时代(起止年份)
 * - 文体(HistoryStyle):史书体(半文言)/ 白话讲述 / 传说故事;篇幅(HistoryLength):短 / 中 / 长
 * - 材料:这个范围里的编年史条目(buildChronicle 写好的纪事;大事为主,篇幅够时补小事和战争细节)、
 *   涉及的国家(国号先后、国都、历朝、极盛时多大、怎么亡的)、民族、主要山河湖海、这一时代开始 / 结束时的格局
 * - **按重要度裁剪**:每档篇幅给材料定一个字数上限(HISTORY_LENGTHS 的 budget),先放大事,再放小事、战争细节,
 *   放不下的略去(条数写进材料,让 AI 知道"材料不全,别硬凑")。一次调用的输入不超过一万来字,远在模型上下文之内
 * - **分章**:通史按时代、国史按朝代(东方国家改朝换代过的)或按兴衰分段;"中"篇一次写完、分几章,
 *   "长"篇每章单独调用一次(每次带上全书的章节表和上一章的结尾,接着往下写)
 * - 系统提示要求不改动事实(年份、国名、胜负、存亡以编年史为准),可以补细节和人物但要合情理
 * - 历史指纹(historyFingerprint):这个范围里的纪事、国号、地名的摘要。改名 / 干预 / 改地形重推以后变了,
 *   界面就给旧史书标"写于历史改变之前"
 */
import type { Civ, Polity, Year } from '../../gen/civ/types';
import { buildChronicle, cnNumber, entryInvolves, entryYearLabel, yearText, type ChronicleEntry } from '../../gen/civ/chronicle';
import { capitalAt, dynastyTitle, polityName, polityShortTitle, polityTierAt, polityTitleChain } from '../../gen/civ/growth';
import { KIND_INFO, cultureLabel, regionLabel, regionNamed } from '../../gen/civ/display';
import { rulerShort } from '../../gen/civ/peopleText';
import { ownersAt, type Owners } from '../../gen/civ/timeline';
import { polityKey, resolveKey } from '../../gen/edits';
import type { AiMessage } from '../types';

// ---------------------------------------------------------------------------
// 选项

/**
 * 文体:annals 编年体 / biography 纪传体 / plain 白话通俗(成书用);classic 史书体、legend 传说是早先版本的文体,旧存档里的史书还带着,照常显示、重写
 */
export type HistoryStyle = 'classic' | 'plain' | 'legend' | 'annals' | 'biography';
/** 篇幅:k3 / k10 / k30 = 约三千 / 一万 / 三万字(成书用);short / medium / long = 800 / 2000 / 5000 字(早先版本的篇幅,旧史书沿用) */
export type HistoryLength = 'short' | 'medium' | 'long' | 'k3' | 'k10' | 'k30';
export type HistoryScope = { kind: 'world' } | { kind: 'polity'; polity: number } | { kind: 'era'; from: Year; to: Year };

export interface HistoryOptions {
  scope: HistoryScope;
  style: HistoryStyle;
  length: HistoryLength;
}

export interface HistoryStyleSpec {
  label: string;
  hint: string;
  rule: string;
  temperature: number;
  /** 章的叫法:"章"(第一章)/ "卷"(卷一) */
  unit?: '章' | '卷';
}

export const HISTORY_STYLES: Record<HistoryStyle, HistoryStyleSpec> = {
  classic: {
    label: '史书体',
    hint: '半文言,纪传 / 编年的味道',
    temperature: 0.7,
    rule:
      '用浅近的文言写(半文半白,读者不查字典也能读懂),仿正史笔法,纪传与编年相参:以时间为纲,关键人物可以有简短的传记式描写' +
      '(名、字、出身、性情、结局);行文简练庄重,少用形容词。每章末尾可以有一段"史臣曰",一两句,说这一章特有的得失,不要空谈"合久必分"之类的套话。',
  },
  plain: {
    label: '白话讲述',
    hint: '现代白话,像通俗历史读物',
    temperature: 0.7,
    rule:
      '用现代汉语,像一本写给普通读者的通俗历史读物:讲清来龙去脉和前因后果,节奏明快,可以有少量生动的细节和人物言行;' +
      '不用文言腔,也不要写成干巴巴的年表;少写景、少抒情,不用网络流行语和现代术语("地缘""政权雏形""多极"之类)。',
  },
  legend: {
    label: '传说故事',
    hint: '口耳相传的传说与史诗',
    temperature: 0.9,
    rule:
      '像世代口耳相传的传说,由说书人讲给听众:口语化,句子短,有画面;可以有预兆、梦兆、歌谣、英雄与传奇色彩,可以用"相传""据说"引出夸张的细节,' +
      '但不要堆砌辞藻和比喻。大事的年代、先后、胜负与兴亡必须和材料一致。',
  },
  annals: {
    label: '编年体',
    hint: '按年记事,像《资治通鉴》',
    temperature: 0.6,
    unit: '卷',
    rule:
      '严格按年份先后记事,每一年(或几件事同在的一年)另起一段,以"第 N 年,"开头;用浅近的文言,记事为主,简洁准确,' +
      '写清谁、在哪里、做了什么、结果如何,战事写出攻守、得失的城和州;人物只在事件里出现,不单独立传;' +
      '少数关键的事后面可以加一段"史臣曰"评论(全书三五处即可,不要每段都评)。',
  },
  biography: {
    label: '纪传体',
    hint: '本纪 + 列传,像《史记》',
    temperature: 0.7,
    rule:
      '以人和国为纲,不以年为纲。用浅近的文言。"本纪"写一国(或一朝)的兴衰,按年叙它的立国、升格、战争、迁都、改朝换代与存亡;' +
      '"列传"每篇写一个人(君主以外的将相、使臣、谋士、叛将、遗民……,材料里写到的统帅可以立传,也可以另补人物),从出身写到结局,他经历的战事、兴亡要和材料对得上;' +
      '篇末可以有"太史公曰"式的一两句评论,写成"史臣曰"。',
  },
};

export interface HistoryLengthSpec {
  label: string;
  /** 正文字数目标 */
  chars: number;
  /** 一次调用里材料的字数上限 */
  budget: number;
  /** 一次调用最多输出多少 token */
  maxTokens: number;
  /** 分章:none 不分;inline 一次写完、分几章;calls 每章单独调用一次 */
  split: 'none' | 'inline' | 'calls';
  /** 想分几章:[通史 / 断代史, 国史] */
  chapters: [number, number];
}

/**
 * 篇幅。budget、maxTokens 按每次调用算。通义 / DeepSeek 中文一个字约 0.8–1 个 token(2026-09 实测),
 * maxTokens 给到这次正文的两倍上下(开着深度思考时思考过程也占这个数),但不超过 8192(不开思考时的输出上限)。
 * 一次调用最好不超过四五千字:再长模型容易虎头蛇尾、字数失控,所以一万字以上一章一次
 */
export const HISTORY_LENGTHS: Record<HistoryLength, HistoryLengthSpec> = {
  short: { label: '短', chars: 800, budget: 4000, maxTokens: 3000, split: 'none', chapters: [1, 1] },
  medium: { label: '中', chars: 2000, budget: 9000, maxTokens: 6000, split: 'inline', chapters: [4, 3] },
  long: { label: '长', chars: 5000, budget: 7000, maxTokens: 5000, split: 'calls', chapters: [4, 3] },
  k3: { label: '短', chars: 3000, budget: 9000, maxTokens: 7000, split: 'inline', chapters: [3, 3] },
  k10: { label: '中', chars: 10000, budget: 8000, maxTokens: 6000, split: 'calls', chapters: [5, 5] },
  k30: { label: '长', chars: 30000, budget: 8000, maxTokens: 7000, split: 'calls', chapters: [12, 10] },
};

/** 早先版本的文体 / 篇幅(旧存档里的史书沿用;篇幅按史事降档时在各自那一组里找,见 buildHistoryPrompts) */
export const PANEL_STYLES: readonly HistoryStyle[] = ['classic', 'plain', 'legend'];
export const PANEL_LENGTHS: readonly HistoryLength[] = ['short', 'medium', 'long'];
/** 成书窗口的文体 / 篇幅:纪传体 / 编年体 / 白话通俗 × 约三千 / 一万 / 三万字 */
export const BOOK_STYLES: readonly HistoryStyle[] = ['biography', 'annals', 'plain'];
export const BOOK_LENGTHS: readonly HistoryLength[] = ['k3', 'k10', 'k30'];

/**
 * 分章多次写时,下一章带上前文的这么多字(从末尾往前取)。整篇前文都给,模型才不会重复用过的人名、字号、评语
 * (只给四百字时,三章里出现了三个"字明远"的人);输入 token 便宜,六千字约五千 token
 */
export const PREV_CONTEXT = 6000;

/**
 * 地名语感(Culture.style)→ 给 AI 看的说明。和 gen/names 的 NAME_STYLES 一致(单测核对);
 * 抄一份在这里是为了不把地名词库打进主页面的包
 */
export const NAME_FLAVOR: Record<string, { family: 'eastern' | 'western'; label: string }> = {
  imperial: { family: 'western', label: '安息(西国风)' },
  kingdom: { family: 'western', label: '绿洲(城邦风)' },
  nordic: { family: 'western', label: '北庭(漠北风)' },
  slavic: { family: 'western', label: '康居(粟特风)' },
  hellenic: { family: 'western', label: '大秦(远西风)' },
  desert: { family: 'western', label: '沙洲(大食风)' },
  steppe: { family: 'western', label: '草原(突厥蒙古风)' },
  elven: { family: 'western', label: '于阗(玉国风)' },
  central: { family: 'eastern', label: '关陇(汉风)' },
  xianxia: { family: 'eastern', label: '河西(走廊风)' },
  frontier: { family: 'eastern', label: '边塞(西域风)' },
  mythic: { family: 'eastern', label: '奇国(异闻风)' },
};

// ---------------------------------------------------------------------------
// 小工具

/** 语感的说明不带括号:"帝国(拉丁风)" → "帝国·拉丁风"(材料里本身就在括号里) */
function flavorLabel(label: string): string {
  return label.replace(/^(.*)\((.*)\)$/, "$1·$2");
}

/** 估算 token 数:汉字(含中文标点)约 0.85 个,其余字符约 0.3 个(通义、DeepSeek 实测 0.8–0.9,只用来给用户一个量级) */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3400 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || c >= 0x20000) cjk++;
  }
  const other = [...s].length - cjk;
  return Math.ceil(cjk * 0.85 + other * 0.3);
}

/** 两个 32 位 FNV-1a 拼成 16 位十六进制(历史指纹用,不求密码学强度) */
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const Y = (y: Year) => Math.floor(y);
/** 中文字数(不算空白) */
const len = (s: string) => s.replace(/\s/g, '').length;
/** 年份段:"第 120—432 年" / "第 120 年" */
const span = (a: Year, b: Year) => (Y(b) > Y(a) ? `第 ${Y(a)}—${Y(b)} 年` : `第 ${Y(a)} 年`);
/** 一串名字最多列 n 个:"甲、乙、丙等七个" */
function listNames(xs: string[], n: number, unit = '个'): string {
  if (xs.length <= n) return xs.join('、');
  return `${xs.slice(0, n).join('、')}等${cnNumber(xs.length)}${unit}`;
}
function cityName(civ: Civ, s: number): string {
  return civ.settlements[s]?.name ?? '';
}
function regionName(civ: Civ, r: number): string {
  return r >= 0 && r < civ.regions.count ? regionLabel(civ, r) : '';
}
/** 国家最后存在的时刻(亡了 = 亡国前一刻;还在 = 结束年份) */
function lastMoment(civ: Civ, p: Polity): Year {
  return p.ended !== undefined ? Math.max(p.founded, p.ended - 1 / 512) : civ.endYear;
}
/** 某年的国名;还没立国 = 立国时的国名,已亡 = 亡国前的国名 */
function nameAt(civ: Civ, p: Polity, year: Year): string {
  const y = Math.min(Math.max(year, p.founded), lastMoment(civ, p));
  return polityName(p, y) || p.name;
}

/** 一国先后用过的国号(去重,按先后;"隆部、隆国、大隆、大恒……") */
function distinctNames(civ: Civ, p: Polity): string[] {
  const end = lastMoment(civ, p);
  const ys = [p.founded, ...(p.titles ?? []).map((t) => t.year), ...(p.dynasties ?? []).map((d) => d.year)]
    .filter((y) => y >= p.founded && y <= end)
    .sort((a, b) => a - b);
  const out: string[] = [];
  for (const y of ys) {
    const n = polityName(p, y);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 国家的规模(按年份取样数州数,每个 civ 算一次)

interface PolityStat {
  /** 极盛时的州数和年份 */
  peak: number;
  peakYear: Year;
}

/** 取样的年份:每隔约 1/60 段历史一次,含结束年份 */
function sampleYears(civ: Civ): number[] {
  const end = Math.max(0, civ.endYear);
  const step = Math.max(10, Math.round(end / 60));
  const ys: number[] = [];
  for (let y = 0; y < end; y += step) ys.push(y);
  ys.push(end);
  return ys;
}

/** 各取样年份每国的州数(每个 civ 算一次) */
const sampleCache = new WeakMap<Civ, { years: number[]; counts: Int32Array[] }>();
function samples(civ: Civ): { years: number[]; counts: Int32Array[] } {
  const hit = sampleCache.get(civ);
  if (hit) return hit;
  const years = sampleYears(civ);
  const counts: Int32Array[] = [];
  let own: Owners | undefined;
  for (const y of years) {
    own = ownersAt(civ, y, own);
    const cnt = new Int32Array(civ.polities.length);
    for (let r = 0; r < civ.regions.count; r++) {
      const q = own.polity[r];
      if (q >= 0 && q < cnt.length) cnt[q]++;
    }
    counts.push(cnt);
  }
  const out = { years, counts };
  sampleCache.set(civ, out);
  return out;
}

const statCache = new WeakMap<Civ, Map<string, PolityStat[]>>();

/** 各国在 from—to 年间最大时的州数和年份(断代史、分章时只看这一段;取样年份之外再补算 to 那一年) */
function rangeStats(civ: Civ, from: Year, to: Year): PolityStat[] {
  let m = statCache.get(civ);
  if (!m) statCache.set(civ, (m = new Map()));
  const key = `${Y(from)}-${Y(to)}`;
  const hit = m.get(key);
  if (hit) return hit;
  const stats = civ.polities.map((p) => ({ peak: 0, peakYear: p.founded }));
  const { years, counts } = samples(civ);
  const take = (y: number, cnt: ArrayLike<number>) => {
    for (let q = 0; q < cnt.length; q++) {
      if (cnt[q] > stats[q].peak) {
        stats[q].peak = cnt[q];
        stats[q].peakYear = y;
      }
    }
  };
  years.forEach((y, i) => {
    if (y >= from && y <= to) take(y, counts[i]);
  });
  if (!years.includes(to)) {
    const cnt = new Int32Array(civ.polities.length);
    for (const [q, k] of sizesAt(civ, to)) if (q < cnt.length) cnt[q] = k;
    take(to, cnt);
  }
  m.set(key, stats);
  return stats;
}

/** 各国整部历史里的极盛 */
function polityStats(civ: Civ): PolityStat[] {
  return rangeStats(civ, 0, Math.max(0, civ.endYear));
}

/** 某年各国的州数 */
function sizesAt(civ: Civ, year: Year): Map<number, number> {
  const own = ownersAt(civ, year);
  const m = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) {
    const q = own.polity[r];
    if (q >= 0) m.set(q, (m.get(q) ?? 0) + 1);
  }
  return m;
}

/** 国家怎么结束的(按史事):亡于某国 / 瓦解 / 并入某国 */
function endings(civ: Civ): Map<number, { how: 'fall' | 'merge'; by: number; year: Year }> {
  const m = new Map<number, { how: 'fall' | 'merge'; by: number; year: Year }>();
  for (const a of civ.annals ?? []) {
    if (a.kind === 'fall' && a.a >= 0 && !m.has(a.a)) m.set(a.a, { how: 'fall', by: a.b, year: a.year });
    if (a.kind === 'merge' && a.b >= 0 && !m.has(a.b)) m.set(a.b, { how: 'merge', by: a.a, year: a.year });
  }
  return m;
}

// ---------------------------------------------------------------------------
// 范围:哪些纪事、从哪年到哪年

interface ScopeInfo {
  from: Year;
  to: Year;
  /** 这个范围里的纪事(按年份;时代范围里折叠条目的子条目只留范围内的) */
  entries: ChronicleEntry[];
  /** 国史的主角 */
  subject: Polity | null;
}

function scopeInfo(civ: Civ, scope: HistoryScope): ScopeInfo | null {
  const all = buildChronicle(civ);
  const end = Y(civ.endYear);
  if (scope.kind === 'world') return { from: 0, to: end, entries: all, subject: null };
  if (scope.kind === 'polity') {
    const p = civ.polities[scope.polity];
    if (!p) return null;
    return { from: Y(p.founded), to: Y(p.ended ?? civ.endYear), entries: all.filter((e) => entryInvolves(e, p.id)), subject: p };
  }
  const from = Math.max(0, Math.min(end, Y(Math.min(scope.from, scope.to))));
  const to = Math.max(0, Math.min(end, Y(Math.max(scope.from, scope.to))));
  const inside = (y: Year) => Y(y) >= from && Y(y) <= to;
  const entries: ChronicleEntry[] = [];
  for (const e of all) {
    if (Y(e.end) < from || Y(e.year) > to) continue;
    if (!e.children) entries.push(e);
    else {
      const kids = e.children.filter((c) => inside(c.year));
      entries.push(kids.length === e.children.length ? e : { ...e, children: kids });
    }
  }
  return { from, to, entries, subject: null };
}

// ---------------------------------------------------------------------------
// 分章

export interface HistorySection {
  from: Year;
  to: Year;
  /** 国史按朝代 / 王室分章时,这一朝的国号(东方)或王朝名(西幻)(给 AI 起章名参考) */
  reign?: string;
  /**
   * 纪传体的篇:annal = 本纪(一国或一朝),house = 世家(较小的国),lives = 列传(写人,polity = −1)。
   * 编年体、史书体等按时间分章的没有这个字段
   */
  part?: 'annal' | 'house' | 'lives';
  /** 本纪 / 世家写的是哪国 */
  polity?: number;
  /** 本纪 / 世家的篇名里用的国名 */
  name?: string;
}

const WEIGHT = [0, 0.5, 1.5, 3];
const weightOf = (es: readonly ChronicleEntry[]) => es.reduce((t, e) => t + (WEIGHT[e.importance] ?? 1), 0);

/** 两件事之间挑一个"整"年份切开:a < 切点 ≤ b,尽量是 500 / 100 / 50 / 10 的倍数 */
function niceCut(a: number, b: number): number {
  for (const step of [500, 100, 50, 10, 5, 1]) {
    const y = Math.ceil((a + 1) / step) * step;
    if (y <= b) return y;
  }
  return b;
}

/** 按纪事的分量(大事重)切成 n 段,每段分量差不多;切点落在两件事之间的整年份上 */
function splitByWeight(entries: readonly ChronicleEntry[], from: Year, to: Year, n: number): HistorySection[] {
  if (n <= 1 || entries.length < 2) return [{ from, to }];
  const w = entries.map((e) => WEIGHT[e.importance] ?? 1);
  const total = w.reduce((s, x) => s + x, 0);
  const cuts: number[] = [];
  let acc = 0;
  for (let i = 0; i < entries.length - 1 && cuts.length < n - 1; i++) {
    acc += w[i];
    if (acc < (total * (cuts.length + 1)) / n) continue;
    const a = Math.max(Y(entries[i].year), cuts.at(-1) ?? from);
    const b = Math.min(Y(entries[i + 1].year), to);
    if (b > a) cuts.push(niceCut(a, b));
  }
  const out: HistorySection[] = [];
  let start = from;
  for (const c of cuts) {
    if (c <= start || c > to) continue;
    out.push({ from: start, to: c - 1 });
    start = c;
  }
  out.push({ from: start, to });
  return out;
}

/** 这一朝 / 王室的名字:东方 = 这一朝最后的国号;西幻 = 王朝名 */
function reignLabel(civ: Civ, p: Polity, i: number): string {
  const d = p.dynasties ?? [];
  if (!p.eastern) return dynastyTitle(p, i) || nameAt(civ, p, d[i]?.year ?? p.founded);
  return nameAt(civ, p, i + 1 < d.length ? d[i + 1].year - 1 / 512 : lastMoment(civ, p));
}

/**
 * 改朝换代(东方)/ 王室更迭(西幻)过的国家:按朝代分章(一朝一章;太多就把分量小的相邻两朝并成一章)。
 * western = false 时只认东方国家(史书体、白话按朝代分章只用于东方;纪传体的本纪西幻也按王室分)
 */
function splitByReign(civ: Civ, p: Polity, info: ScopeInfo, max: number, western = false): HistorySection[] | null {
  const d = p.dynasties;
  if ((!p.eastern && !western) || !d || d.length < 2) return null;
  let out: HistorySection[] = d.map((x, i) => ({
    from: Math.max(info.from, Y(x.year)),
    to: i + 1 < d.length ? Y(d[i + 1].year) - 1 : info.to,
    reign: reignLabel(civ, p, i),
  }));
  out = out.filter((s) => s.to >= s.from);
  const weight = (s: HistorySection) => weightOf(info.entries.filter((e) => Y(e.year) >= s.from && Y(e.year) <= s.to));
  const total = out.reduce((t, x) => t + weight(x), 0);
  // 太多就并掉分量最小的相邻两朝;分量太小(不到一成的一半多)的一朝并进相邻较轻的那一朝
  while (out.length > 1) {
    const ws = out.map(weight);
    let at = -1;
    if (out.length > max) {
      let bw = Infinity;
      for (let i = 0; i + 1 < out.length; i++) {
        if (ws[i] + ws[i + 1] < bw) {
          bw = ws[i] + ws[i + 1];
          at = i;
        }
      }
    } else if (out.length > 2) {
      const tiny = ws.indexOf(Math.min(...ws));
      if (ws[tiny] < total * 0.06) at = tiny === 0 ? 0 : tiny === out.length - 1 ? tiny - 1 : ws[tiny - 1] <= ws[tiny + 1] ? tiny - 1 : tiny;
    }
    if (at < 0) break;
    const a = out[at];
    const b = out[at + 1];
    out.splice(at, 2, { from: a.from, to: b.to, reign: `${a.reign}、${b.reign}` });
  }
  return out;
}

/** 分章太少(比如只有两三朝)而篇幅很长时,把分量大的章再按分量切开,凑到大约 want 章 */
function refine(sections: HistorySection[], info: ScopeInfo, want: number): HistorySection[] {
  if (sections.length >= want) return sections;
  const ws = sections.map((s) => weightOf(info.entries.filter((e) => Y(e.year) >= s.from && Y(e.year) <= s.to)));
  const W = ws.reduce((a, b) => a + b, 0) || 1;
  const out: HistorySection[] = [];
  sections.forEach((s, i) => {
    const k = Math.max(1, Math.round((ws[i] / W) * want));
    const es = info.entries.filter((e) => Y(e.year) >= s.from && Y(e.year) <= s.to);
    const parts = splitByWeight(es, s.from, s.to, Math.min(k, Math.floor(es.length / 3) || 1));
    out.push(...parts.map((x, j) => ({ ...x, reign: s.reign ? (parts.length > 1 ? `${s.reign}·${cnNumber(j + 1)}` : s.reign) : undefined })));
  });
  return out;
}

/**
 * 纪传体的篇目:国史 = 每朝(东方)/ 每个王室(西幻)一篇本纪 + 列传;
 * 通史、断代史 = 史事最多的几国各一篇(极盛七十州以上的叫本纪,其余叫世家)+ 列传
 */
function bioSections(civ: Civ, info: ScopeInfo, want: number, lives = 1): HistorySection[] {
  const n = Math.max(1, want - lives);
  const out: HistorySection[] = [];
  const p = info.subject;
  if (p) {
    const reigns = splitByReign(civ, p, info, n, true) ?? splitByWeight(info.entries, info.from, info.to, Math.min(n, Math.max(1, Math.floor(info.entries.length / 6))));
    for (const r of reigns) out.push({ ...r, part: 'annal', polity: p.id, name: r.reign ?? nameAt(civ, p, Math.min(r.to, lastMoment(civ, p))) });
  } else {
    const score = new Map<number, number>();
    for (const e of info.entries) for (const q of e.polities) score.set(q, (score.get(q) ?? 0) + (WEIGHT[e.importance] ?? 1));
    const stats = rangeStats(civ, info.from, info.to);
    const top = [...score]
      .filter(([q]) => civ.polities[q])
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, n)
      .map(([q]) => civ.polities[q])
      .sort((a, b) => a.founded - b.founded || a.id - b.id);
    for (const q of top) {
      const from = Math.max(info.from, Y(q.founded));
      const to = Math.min(info.to, Y(q.ended ?? civ.endYear));
      const peak = stats[q.id]?.peak ?? 0;
      // 篇名用这一段结束时的国号(和卡片上一样;亡了的用亡国前的),不用极盛时的:后来改了国号的,篇名和地图对得上
      out.push({ from, to, part: peak >= 70 ? 'annal' : 'house', polity: q.id, name: nameAt(civ, q, Math.min(info.to, lastMoment(civ, q))) });
    }
  }
  // 列传:篇幅长时分几篇(一次写不下七八千字),按时间切开,各篇写各自那段的人
  const big = info.entries.filter((e) => e.importance >= 2);
  const slices = lives > 1 ? splitByWeight(big, info.from, info.to, lives) : [{ from: info.from, to: info.to }];
  slices.forEach((x, i) => out.push({ from: x.from, to: x.to, part: 'lives', polity: -1, name: slices.length > 1 ? cnNumber(i + 1) : undefined }));
  return out;
}

function sectionsFor(civ: Civ, opts: HistoryOptions, info: ScopeInfo, L: HistoryLengthSpec): HistorySection[] {
  const whole = [{ from: info.from, to: info.to }];
  if (L.split === 'none') return whole;
  const want = opts.scope.kind === 'world' ? L.chapters[0] : L.chapters[1];
  // 列传占全书两成半;分章多次写时一篇不超过三千字上下
  if (opts.style === 'biography') return bioSections(civ, info, want, L.split === 'calls' ? Math.max(1, Math.round((L.chars * 0.25) / 3000)) : 1);
  // 纪事太少就少分几章(一章至少三四件事)
  const n = Math.max(1, Math.min(want, Math.floor(info.entries.length / 4)));
  if (info.subject) {
    const reigns = splitByReign(civ, info.subject, info, Math.max(5, n));
    if (reigns && reigns.length >= 2) return L.split === 'calls' ? refine(reigns, info, n) : reigns;
  }
  return splitByWeight(info.entries, info.from, info.to, n);
}

/** 这些史事最多值得写多少字:按分量(大事 3、小事 1.5、琐事 0.5)每一分一百二十字,至少写短篇 */
export function charCap(entries: readonly ChronicleEntry[]): number {
  return Math.max(HISTORY_LENGTHS.short.chars, Math.round((weightOf(entries) * 120) / 100) * 100);
}

/** 第几章的叫法:"第一章" / "卷一" */
function chapterName(i: number, unit: '章' | '卷' = '章'): string {
  return unit === '卷' ? `卷${cnNumber(i + 1)}` : `第${cnNumber(i + 1)}章`;
}

/** 纪传体的篇名:"本纪·大衍" / "世家·萨布斯坦王国" / "列传" */
function partName(s: HistorySection): string {
  if (s.part === 'lives') return s.name ? `列传·${s.name}` : '列传';
  return `${s.part === 'house' ? '世家' : '本纪'}·${s.name ?? ''}`;
}

/** 纪事落在第几章(按开始的年份;折叠的战争跟着开战那年)。只用于按时间分的章 */
function sectionOf(sections: readonly HistorySection[], e: ChronicleEntry): number {
  const k = sections.findIndex((x) => Y(e.year) <= x.to);
  return k < 0 ? sections.length - 1 : k;
}

/** 第 i 章(篇)用到的纪事:按时间分的章 = 落在这一章的;本纪 / 世家 = 和这国有关的;列传 = 大事和小事(战争、兴亡) */
function entriesOf(sections: readonly HistorySection[], i: number, entries: readonly ChronicleEntry[]): ChronicleEntry[] {
  const s = sections[i];
  if (s.part === 'lives') return entries.filter((e) => e.importance >= 2 && Y(e.end) >= s.from && Y(e.year) <= s.to);
  if (s.part) {
    const inside = (e: ChronicleEntry) => Y(e.end) >= s.from && Y(e.year) <= s.to;
    return entries.filter((e) => inside(e) && (s.polity === undefined || s.polity < 0 || entryInvolves(e, s.polity)));
  }
  return entries.filter((e) => sectionOf(sections, e) === i);
}

/** 各章的字数:四成平分、六成按史事的分量分(大事多的章写得长),五十字取整,每章至少三百字;列传占两成多 */
function allotChars(total: number, entries: readonly ChronicleEntry[], sections: readonly HistorySection[]): number[] {
  const n = sections.length;
  const isLives = (i: number) => n > 1 && sections[i].part === 'lives';
  const k = sections.filter((_, i) => isLives(i)).length;
  const rest = k ? total * 0.75 : total;
  const m = n - k;
  const w = sections.map((_, i) => (isLives(i) ? 0 : weightOf(entriesOf(sections, i, entries))));
  const W = w.reduce((a, b) => a + b, 0);
  const r50 = (x: number) => Math.max(300, Math.round(x / 50) * 50);
  return sections.map((_, i) => (isLives(i) ? r50((total * 0.25) / k) : r50(rest * (0.4 / m + (W > 0 ? (0.6 * w[i]) / W : 0.6 / m)))));
}

// ---------------------------------------------------------------------------
// 材料的各部分

/** 国号先后(带年份):"昌部(第 120 年)→ 昌国(第 180 年)→ 大昌(第 400 年)";太长的掐掉中间 */
function titleSteps(civ: Civ, p: Polity, until: Year): string {
  const ys = [p.founded, ...(p.titles ?? []).map((t) => t.year), ...(p.dynasties ?? []).map((d) => d.year)]
    .filter((y) => y >= p.founded && y <= until)
    .sort((a, b) => a - b);
  const steps: string[] = [];
  let last = '';
  for (const y of ys) {
    const n = polityName(p, y);
    if (n && n !== last) steps.push(`${n}(第 ${Y(y)} 年)`);
    last = n || last;
  }
  if (steps.length > 8) return [...steps.slice(0, 3), '……', ...steps.slice(-4)].join(' → ');
  return steps.join(' → ') || nameAt(civ, p, until);
}

/** 国都先后;until = 只写到这一年(断代史、分章) */
function capitalsText(civ: Civ, p: Polity, until: Year = Infinity): string {
  const c0 = p.capitals?.length ? p.capitals : [{ year: p.founded, settlement: p.capital }];
  const c = c0.filter((x, i) => i === 0 || x.year <= until);
  const xs = c.map((x) => `${cityName(civ, x.settlement) || '某城'}(第 ${Y(x.year)} 年)`);
  return xs.length > 6 ? [...xs.slice(0, 2), '……', ...xs.slice(-3)].join(' → ') : xs.join(' → ');
}

/**
 * 历朝(东方)/ 王室(西幻)先后,只写到 until 那年。新朝从哪里起兵不写 ——
 * 编年史里写着("某某起于某州,入主某城"),这里再写一个城名,模型会当成迁都
 */
function reignsText(civ: Civ, p: Polity, until: Year = Infinity): string {
  const d = (p.dynasties ?? []).filter((x, i) => i === 0 || x.year <= until);
  if (d.length < 2) return '';
  const end = Math.min(lastMoment(civ, p), until);
  const xs = d.map((x, i) => {
    const stop = i + 1 < d.length ? d[i + 1].year : end;
    const name = p.eastern ? nameAt(civ, p, i + 1 < d.length ? stop - 1 / 512 : end) : dynastyTitle(p, i) || '某王朝';
    return `${name}(${span(x.year, stop)})`;
  });
  return `${p.eastern ? '历朝' : '王室'}:${xs.join(' → ')}`;
}

/**
 * 历代君主(国史的主角),只写 clip 这一段里在位的:"太祖林遥(第 120—151 年)、太宗林……"。
 * 东方写"庙号 + 名字"(还在位的没有庙号,只写名字),西幻写名字 + 序数;共和国是"历任执政";太多就写头尾几位
 */
function rulersText(civ: Civ, p: Polity, clip: Clip): string {
  const end = Math.min(lastMoment(civ, p), clip.to);
  const rs = (civ.people ?? [])
    .filter((x) => x.role === 'ruler' && x.polity === p.id && x.from! <= end && (x.until ?? Infinity) > clip.from)
    .sort((a, b) => a.from! - b.from!);
  if (rs.length < 2) return '';
  const xs = rs.map((x) => {
    const titled = x.title && (x.until === undefined || x.until <= end);
    const who = p.eastern ? `${titled ? x.title : ''}${x.name}` : rulerShort(civ, x);
    return `${who}(${span(x.from!, Math.min(x.until ?? end, end))})`;
  });
  const MAX = 24;
  const list = xs.length > MAX ? [...xs.slice(0, 14), '……', ...xs.slice(-8)] : xs;
  return `${p.lineage === 'republic' ? '历任执政' : '历代君主'}(${cnNumber(rs.length)}位):${list.join('、')}`;
}

/** 国家的来历:"第 120 年立国" / "第 900 年叛大昌自立" / "第 1100 年脱大渭复国(复故昌)" */
function originText(civ: Civ, p: Polity): string {
  const y = `第 ${Y(p.founded)} 年`;
  const parent = p.parent !== undefined ? civ.polities[p.parent] : undefined;
  if (p.restores !== undefined) {
    const old = civ.polities[p.restores];
    return `${y}${parent ? `脱${nameAt(civ, parent, p.founded)}` : ''}复国${old ? `(复故${nameAt(civ, old, lastMoment(civ, old))})` : ''}`;
  }
  if (parent) return `${y}叛${nameAt(civ, parent, p.founded)}自立`;
  return `${y}立国`;
}

function endText(civ: Civ, p: Polity, ends: ReturnType<typeof endings>, until: Year = Infinity): string {
  const e = ends.get(p.id);
  if (p.ended === undefined || p.ended > until) return `至第 ${Y(Math.min(civ.endYear, until))} 年尚存`;
  const y = `第 ${Y(p.ended)} 年`;
  if (!e || e.by < 0) return `${y}土崩瓦解`;
  const by = civ.polities[e.by];
  const who = by ? nameAt(civ, by, p.ended) : '他国';
  return e.how === 'merge' ? `${y}并入${who}` : `${y}亡于${who}`;
}

/** 国家的风格:"东方式·中原(古风)·农耕" / "西幻式·草原(突厥蒙古风)·游牧·汗国" */
function polityFlavor(civ: Civ, p: Polity): string {
  const cu = civ.cultures[p.culture];
  const f = cu ? NAME_FLAVOR[cu.style] : undefined;
  const parts = [p.eastern ? '东方式' : '西幻式'];
  if (f) parts.push(flavorLabel(f.label));
  parts.push(KIND_INFO[p.kind]?.name ?? '');
  if (p.lineage === 'khanate') parts.push('汗国一系');
  else if (p.lineage === 'republic' && !p.eastern) parts.push('城邦共和一系');
  return parts.filter(Boolean).join('·');
}

/** 极盛时的疆域:"极盛约八十州(第 1400 年前后),含汾州、瑞州、青州等" */
function peakText(civ: Civ, p: Polity, stat: PolityStat | undefined, withRegions: boolean, clipped = false): string {
  if (!stat || stat.peak <= 0) return '';
  let t = `${clipped ? '这一段最大时' : '极盛'}约${cnNumber(stat.peak)}州(第 ${Y(stat.peakYear)} 年前后)`;
  if (withRegions) {
    const own = ownersAt(civ, stat.peakYear);
    const rs: number[] = [];
    for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === p.id) rs.push(r);
    rs.sort((a, b) => civ.regions.capacity[b] - civ.regions.capacity[a] || a - b);
    const names = rs.map((r) => regionName(civ, r)).filter(Boolean);
    if (names.length) t += `,含${listNames(names, 6, '州')}`;
  }
  return t;
}

/** 国家境内的民族(极盛时各州的民族):"隆族(七成)、恒族(二成)" */
function folksText(civ: Civ, p: Polity, stat: PolityStat | undefined): string {
  const own0 = civ.cultures[p.culture] ? cultureLabel(civ.cultures[p.culture]) : '';
  if (!stat || stat.peak <= 0) return own0;
  const own = ownersAt(civ, stat.peakYear);
  const m = new Map<number, number>();
  let n = 0;
  for (let r = 0; r < civ.regions.count; r++) {
    if (own.polity[r] !== p.id) continue;
    n++;
    const c = own.culture[r];
    if (c >= 0) m.set(c, (m.get(c) ?? 0) + 1);
  }
  const xs = [...m].sort((a, b) => b[1] - a[1]).filter(([, k], i) => i === 0 || k / n >= 0.1);
  if (!xs.length) return own0;
  if (xs.length === 1 && xs[0][1] / n >= 0.95) return civ.cultures[xs[0][0]] ? `几乎全是${cultureLabel(civ.cultures[xs[0][0]])}` : own0;
  return xs
    .slice(0, 3)
    .map(([c, k]) => `${civ.cultures[c] ? cultureLabel(civ.cultures[c]) : '某族'}(约${cnNumber(Math.max(1, Math.round((k / n) * 10)))}成)`)
    .join('、');
}

/** 某年和它接壤的国家(按共同边界的长短,长的在前) */
function neighborsAt(civ: Civ, p: Polity, year: Year): number[] {
  const own = ownersAt(civ, year);
  const R = civ.regions;
  const m = new Map<number, number>();
  for (let r = 0; r < R.count; r++) {
    if (own.polity[r] !== p.id) continue;
    for (let k = R.adjStart[r]; k < R.adjStart[r + 1]; k++) {
      const q = own.polity[R.adj[k]];
      if (q >= 0 && q !== p.id) m.set(q, (m.get(q) ?? 0) + 1 + (R.adjBorder?.[k] ?? 0));
    }
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([q]) => q);
}

/** 国史主角的四邻:极盛时、(还在的)推演结束时 / (亡了的)亡国前 */
function neighborYears(civ: Civ, p: Polity, stat: PolityStat | undefined, until: Year = Infinity): Year[] {
  const ys = [stat && stat.peak > 0 ? stat.peakYear : p.founded, Math.min(lastMoment(civ, p), until)];
  return Math.abs(ys[1] - ys[0]) < 50 ? [ys[1]] : ys;
}

/** 材料里国家写到哪一年为止:断代史 = 这一时代结束;分章写 = 这一章结束(免得提前透露后面的事);通史、国史 = 全部 */
interface Clip {
  from: Year;
  to: Year;
}

/**
 * 一国的材料。detail = 国史的主角 / 通史里的大国:写全;否则一行带过。main = 国史的主角(再写四邻)。
 * clip:只写到 clip.to 那年(国号、国都、历朝、存亡),疆域取 clip 这一段里最大时
 */
function polityLine(civ: Civ, p: Polity, detail: boolean, ends: ReturnType<typeof endings>, clip: Clip, main = false): string {
  const until = Math.min(lastMoment(civ, p), clip.to);
  // 这一段盖住了它的一生 = 写"极盛";只盖住一部分 = "这一段最大时"
  const whole = clip.from <= p.founded && until >= lastMoment(civ, p);
  const stat = rangeStats(civ, clip.from, clip.to)[p.id];
  const cap = cityName(civ, p.capital);
  const head = `- ${nameAt(civ, p, Math.min(stat && stat.peak > 0 ? stat.peakYear : p.founded, until))}(${polityFlavor(civ, p)})`;
  if (!detail) {
    const bits = [`${originText(civ, p)}${cap ? `,都于${cap}` : ''}`, peakText(civ, p, stat, false, !whole), endText(civ, p, ends, clip.to)];
    const names = titleSteps(civ, p, until);
    return `${head}:${bits.filter(Boolean).join(';')}。国号:${names}`;
  }
  const lines = [
    `${head}:${originText(civ, p)}${cap ? `,都于${cap}` : ''};${endText(civ, p, ends, clip.to)}`,
    `  国号先后:${titleSteps(civ, p, until)}`,
    `  国都:${capitalsText(civ, p, until)}`,
  ];
  const reigns = reignsText(civ, p, until);
  if (reigns) lines.push(`  ${reigns}`);
  const rulers = main ? rulersText(civ, p, clip) : '';
  if (rulers) lines.push(`  ${rulers}`);
  const peak = peakText(civ, p, stat, true, !whole);
  if (peak) lines.push(`  疆域:${peak}`);
  const folks = folksText(civ, p, stat);
  if (folks) lines.push(`  民族:${folks}`);
  if (main) {
    for (const y of neighborYears(civ, p, stat, until)) {
      const ns = neighborsAt(civ, p, y).map((q) => nameAt(civ, civ.polities[q], y));
      if (ns.length) lines.push(`  四邻(第 ${Y(y)} 年前后):${listNames(ns, 6, '国')}`);
    }
  }
  return lines.join('\n');
}

/** 一个民族的材料;until = 只写到这一年(断代史、分章:之后的迁徙、建国、消亡不写) */
function cultureLine(civ: Civ, id: number, until: Year = Infinity): string {
  const cu = civ.cultures[id];
  const f = NAME_FLAVOR[cu.style];
  const kind = KIND_INFO[cu.kind]?.name;
  const bits = [`${kind ? `${kind}民族` : '民族'}${f ? `,${f.family === 'eastern' ? '东方' : '西幻'}语感(${flavorLabel(f.label)})` : ''}`];
  const hearth = regionName(civ, cu.hearth);
  bits.push(`第 ${Y(cu.born)} 年兴起${hearth ? `于${hearth}` : ''}`);
  const mig = (cu.migrations ?? []).filter((m) => m.year <= until);
  if (mig.length) {
    const ADV: Record<string, string> = { 东: '东迁', 西: '西迁', 南: '南迁', 北: '北迁' };
    bits.push(listNames(mig.map((m) => `第 ${Y(m.year)} 年${ADV[m.dir] ?? '迁徙'}`), 4, '次'));
  }
  const made = civ.polities.filter((p) => p.culture === id && p.founded <= until).map((p) => nameAt(civ, p, Math.min(lastMoment(civ, p), until)));
  if (made.length) bits.push(`建立过${listNames([...new Set(made)], 4, '国')}`);
  if (cu.ended !== undefined && cu.ended <= until) bits.push(`第 ${Y(cu.ended)} 年消亡`);
  return `- ${cultureLabel(cu)}:${bits.join(';')}`;
}

const PLACE_KIND: Record<string, string> = { sea: '海洋', mountains: '山脉', river: '河流', lake: '湖泊', island: '岛屿', desert: '荒漠' };
const PLACE_ORDER = ['sea', 'mountains', 'river', 'lake', 'desert', 'island'] as const;
const PLACE_MAX: Record<string, number> = { sea: 5, mountains: 5, river: 5, lake: 3, desert: 3, island: 4 };

/** 材料里列哪些地理实体:通史 / 断代史 = 全世界最大的几处;国史 = 锚点在它先后占过的州里的(海除外) */
function placesFor(civ: Civ, info: ScopeInfo): number[] {
  const P = civ.places;
  let ok: (i: number) => boolean = () => true;
  let max = PLACE_MAX;
  if (info.subject) {
    const held = new Uint8Array(civ.regions.count);
    let own: Owners | undefined;
    for (const y of sampleYears(civ)) {
      if (y < info.from || y > info.to) continue;
      own = ownersAt(civ, y, own);
      for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === info.subject.id) held[r] = 1;
    }
    const R = civ.regions.of;
    ok = (i) => {
      const c = P[i].cell;
      if (P[i].kind === 'sea' || c === undefined || c < 0 || c >= R.length) return false;
      return R[c] >= 0 && held[R[c]] === 1;
    };
    max = { sea: 0, mountains: 4, river: 4, lake: 3, desert: 2, island: 3 };
  }
  const out: number[] = [];
  for (const kind of PLACE_ORDER) {
    const ids = P.map((_, i) => i)
      .filter((i) => P[i].kind === kind && P[i].name && ok(i))
      .sort((a, b) => P[a].rank - P[b].rank || (P[b].size ?? 0) - (P[a].size ?? 0) || a - b);
    out.push(...ids.slice(0, max[kind] ?? 3));
  }
  return out;
}

function geographyText(civ: Civ, ids: number[]): string {
  const lines: string[] = [];
  const R = civ.regions.of;
  for (const kind of PLACE_ORDER) {
    const xs = ids
      .filter((i) => civ.places[i].kind === kind)
      .map((i) => {
        const p = civ.places[i];
        const r = p.kind !== 'sea' && p.cell !== undefined && p.cell >= 0 && p.cell < R.length ? R[p.cell] : -1;
        const where = r >= 0 && regionNamed(civ, r) ? regionName(civ, r) : '';
        return where ? `${p.name}(在${where}一带)` : p.name;
      });
    if (xs.length) lines.push(`- ${PLACE_KIND[kind]}:${xs.join('、')}`);
  }
  return lines.join('\n');
}

/** 某一年的格局:"大昌(约八十州,都于汾城)、索拉特王国(约三十州,都于……)等九国" */
function snapshotText(civ: Civ, year: Year): string {
  const sizes = sizesAt(civ, year);
  const xs = [...sizes]
    .filter(([q]) => civ.polities[q])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([q, n]) => {
      const p = civ.polities[q];
      const cap = cityName(civ, capitalAt(p, year));
      return `${polityName(p, year) || p.name}(约${cnNumber(n)}州${cap ? `,都于${cap}` : ''})`;
    });
  if (!xs.length) return `第 ${Y(year)} 年:还没有国家`;
  return `第 ${Y(year)} 年:${listNames(xs, 6, '国')}`;
}

// ---------------------------------------------------------------------------
// 纪事的取舍(按重要度裁剪)

interface Pick {
  e: ChronicleEntry;
  /** 子条目:属于哪一条(上一级) */
  parent: ChronicleEntry | null;
  pri: number;
  text: string;
}

/** 0..m-1 按"二进制反转"排:先取两头和中间,再逐步加密 —— 放不下全部时挑出来的条目在时间上分布均匀 */
function spreadOrder(m: number): number[] {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, m))));
  const rev = (i: number) => {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    return r;
  };
  return Array.from({ length: m }, (_, i) => i).sort((a, b) => rev(a) - rev(b));
}

function entryLine(e: ChronicleEntry): string {
  return `- ${e.importance >= 3 ? '★' : ''}${entryYearLabel(e)} ${e.text}`;
}
function childLine(c: ChronicleEntry): string {
  return `  - ${yearText(c.year)} ${c.text}`;
}

/**
 * 在 budget 字以内挑纪事:大事 → 小事(重要度 2)→ 大事里战争的细节 → 琐事(重要度 1)→ 其余战争细节。
 * 一档放不下全部时,按时间均匀地挑,挑满为止(后面的档不再放)。返回挑中的(按原顺序)和略去的条数
 */
function pickEntries(entries: readonly ChronicleEntry[], budget: number): { picked: Set<ChronicleEntry>; dropped: number; total: number } {
  const tiers: Pick[][] = [[], [], [], [], [], []];
  let total = 0;
  for (const e of entries) {
    total++;
    const top = e.importance >= 3 ? 0 : e.importance === 2 ? 1 : 3;
    tiers[top].push({ e, parent: null, pri: top, text: entryLine(e) });
    const kidTier = e.importance >= 3 ? 2 : e.importance === 2 ? 4 : 5;
    for (const c of e.children ?? []) {
      total++;
      tiers[kidTier].push({ e: c, parent: e, pri: kidTier, text: childLine(c) });
    }
  }
  const picked = new Set<ChronicleEntry>();
  let used = 0;
  let full = false;
  for (const tier of tiers) {
    if (full) break;
    const need = tier.reduce((s, x) => s + x.text.length + 1, 0);
    if (used + need <= budget) {
      for (const x of tier) if (!x.parent || picked.has(x.parent)) picked.add(x.e);
      used += need;
      continue;
    }
    full = true;
    for (const i of spreadOrder(tier.length)) {
      const x = tier[i];
      if (x.parent && !picked.has(x.parent)) continue;
      if (used + x.text.length + 1 > budget) continue;
      picked.add(x.e);
      used += x.text.length + 1;
    }
  }
  return { picked, dropped: total - picked.size, total };
}

/** 挑中的纪事写成文字;按时间分了章的按章加小标题(纪传体的篇不按时间分,不加) */
function chronicleBlock(entries: readonly ChronicleEntry[], picked: Set<ChronicleEntry>, sections: HistorySection[] | null, unit: '章' | '卷' = '章'): string {
  const out: string[] = [];
  let sec = -1;
  const timed = !!sections && sections.length > 1 && !sections.some((s) => s.part);
  const heading = (i: number) => {
    const s = sections![i];
    return `### ${chapterName(i, unit)} ${span(s.from, s.to)}${s.reign ? `(${s.reign})` : ''}`;
  };
  for (const e of entries) {
    if (!picked.has(e)) continue;
    if (timed) {
      const i = Math.max(sectionOf(sections!, e), sec);
      while (sec < i) out.push(heading(++sec));
    }
    out.push(entryLine(e));
    for (const c of e.children ?? []) if (picked.has(c)) out.push(childLine(c));
  }
  if (timed) while (sec < sections!.length - 1) out.push(heading(++sec), '- (这一段没有记下的大事)');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 提示词

export interface HistoryCall {
  /** 调用记录里的说明("世界通史 · 第二章") */
  title: string;
  /** "长"篇:这是第几章(0 起);一次写完的 = null */
  chapter: number | null;
  /** 这次要写多少字 */
  chars: number;
  maxTokens: number;
  temperature: number;
  /** 用户消息:写作要求(前文插在它后面)+ 材料 */
  head: string;
  body: string;
  /** 材料里的纪事:放进去几条 / 这一段一共几条(含战争细节) */
  used: number;
  total: number;
}

export interface HistoryPrompts {
  options: HistoryOptions;
  /** 书名:"世界通史" / "大昌史" / "第 1200—1500 年史" */
  title: string;
  /** 写的是哪一段:"第 0—3000 年" */
  range: string;
  /** 正文一共要写多少字(史事太少时比所选篇幅少,见 charCap) */
  chars: number;
  system: string;
  sections: HistorySection[];
  calls: HistoryCall[];
  /** 这个范围里一件史事都没有(没有国家、这段时间什么也没发生) */
  empty: boolean;
  /** 历史指纹(见 historyFingerprint) */
  fingerprint: string;
  /** 发给 AI 的总字数(系统提示每次都发;多章时带的前文按 PREV_CONTEXT 封顶估)和估算的 token 数 */
  inputChars: number;
  inputTokens: number;
}

export const SYSTEM_PROMPT = [
  '你是一位擅长写架空历史的中文作家,正在为一部奇幻世界的设定集撰写史书。这个世界的历史由推演程序生成,用户会给你「材料」:编年史、国家、民族、地理。',
  '',
  '必须遵守:',
  '1. 史实以材料为准,不得改动:年份、国名(用当年的国号)、人名、族名、地名、战争的胜负与得失、国家的兴亡和先后顺序。',
  '2. 年份照材料写成"第 1288 年"这样的阿拉伯数字,每处都带"第"(不要写成"第一千二百八十八年""千二百八十八年"),不要换算成干支、公元、世纪或别的纪年;' +
    '不要写"三十年后""又六十六年"这类推算出来的年数,直接写年份。补写的细节不要另编年份:材料里没有的年份不要出现。',
  '3. 战事照材料写:得几州就是几州,"得某州"不等于灭国,材料没写亡的国家就还在;材料写了洗劫、纵兵大掠、夷为平地、毁城,就不要写成秋毫无犯、开仓放粮;' +
    '"某王朝兴""某某起于某地代之""权臣某某废某某自立"是改朝换代,不是父死子继;国家升格、称帝要等到材料里写的那一年。',
  '4. 材料里写到的人物(君主、统帅、叛将、权臣)照材料写:谁在位、谁领兵、谁亲征、谁战死、谁出降,都不改,也不要张冠李戴。' +
    '可以补充细节:材料没写的将相、使者、谋士、百姓等人物,对话、场景、民生风俗、事情的前因后果,但要合情合理,不得和材料矛盾。' +
    '不要虚构材料里没有的灭国、改朝换代、迁都、称帝或大战,也不要把几件事的先后写反。',
  '5. 名字一律照材料原样写 —— 有的是作者自己改过的,不要"纠正",也不要换成近音字或简称。国号随年份变化,写到哪一年就用那一年的国号。',
  '6. 新添的人名要合所属民族的语感:东方式国家用中式姓名(一朝的皇族都姓开国之君的姓);西幻式国家用音译名,风格参照这一族的地名、国名。' +
    '同一部书里不同的人不要重名,也不要共用同一个字号;名字要有这一族的特色,不要千篇一律。新添人物的一生要合情理(活不过百岁),几百年间的事分给不同的人,不要让一个人横跨几百年。',
  '7. 这是架空世界:不要出现地球上真实的国家、朝代、民族、语言、宗教、神祇、人物、典籍、制度、年号和地名,也不要借用现成小说、游戏里的人名地名。' +
    '材料括号里的风格标签(东方式、西幻式、某某风)只是告诉你起名和行文的味道:正文里不要写出这些词,也不要顺着它们写出现实里的语言、神祇、制度和人名。',
  '8. 只输出正文(Markdown):不写全书的书名,不写"好的""以下是……"之类的开场白,不加括号注释说明材料缺什么,结尾也不要解释你做了什么。',
].join('\n');

/** 书名 */
function bookTitle(civ: Civ, info: ScopeInfo, scope: HistoryScope): string {
  if (scope.kind === 'world') return '世界通史';
  if (scope.kind === 'era') return `第 ${info.from}—${info.to} 年史`;
  const p = info.subject!;
  const d = p.dynasties;
  if (p.eastern && d && d.length >= 2) {
    const end = lastMoment(civ, p);
    const first = polityShortTitle(p, Math.max(0, polityTierAt(p, d[1].year - 1 / 512)), d[1].year - 1 / 512);
    const last = polityShortTitle(p, Math.max(0, polityTierAt(p, end)), end);
    if (first && last && first !== last) return `${first}—${last}史`;
  }
  const stat = polityStats(civ)[p.id];
  return `${nameAt(civ, p, stat?.peakYear ?? p.founded)}史`;
}

function subjectText(civ: Civ, info: ScopeInfo, scope: HistoryScope): string {
  if (scope.kind === 'world') return `这个世界第 ${info.from}—${info.to} 年的通史:民族兴起、诸国兴衰、改朝换代、改变格局的战争`;
  if (scope.kind === 'era') return `第 ${info.from}—${info.to} 年间整个世界的历史(断代史):开头交代这一时代开始时的格局,结尾交代结束时的格局`;
  const p = info.subject!;
  const end = p.ended === undefined ? `写到第 ${info.to} 年(至今尚存)` : `写到第 ${info.to} 年灭亡`;
  const reigns = p.dynasties && p.dynasties.length >= 2 ? (p.eastern ? ',含历朝更替' : ',含王室更迭') : '';
  const names = distinctNames(civ, p);
  const who = names.length > 1 ? `这个国家(先后称${listNames(names, 8)})` : names[0] || p.name;
  return `${who}一国的国史:从第 ${info.from} 年立国${end}${reigns};别国只在和它有关时提到`;
}

/** 材料(不含纪事)里的国家:国史的主角在前;其余按在纪事里出现的次数、极盛时的大小 */
function politiesFor(civ: Civ, info: ScopeInfo, picked: Set<ChronicleEntry>, clip: Clip): number[] {
  const count = new Map<number, number>();
  for (const e of info.entries) {
    if (!picked.has(e)) continue;
    for (const q of e.polities) count.set(q, (count.get(q) ?? 0) + (e.importance >= 3 ? 3 : 1));
    for (const c of e.children ?? []) if (picked.has(c)) for (const q of c.polities) count.set(q, (count.get(q) ?? 0) + 0.2);
  }
  const stats = rangeStats(civ, clip.from, clip.to);
  const ids = [...count.keys()].filter((q) => civ.polities[q] && q !== info.subject?.id);
  ids.sort((a, b) => count.get(b)! - count.get(a)! || (stats[b]?.peak ?? 0) - (stats[a]?.peak ?? 0) || a - b);
  if (!info.subject) return ids;
  // 国史:纪事里没提到的邻国也列上(放在后面)
  const p = info.subject;
  const until = Math.min(lastMoment(civ, p), clip.to);
  for (const y of neighborYears(civ, p, stats[p.id], until)) for (const q of neighborsAt(civ, p, y).slice(0, 6)) if (!ids.includes(q)) ids.push(q);
  return [p.id, ...ids];
}

/** 材料里的民族:通史 / 断代史 = 这段时间里在世的;国史 = 境内的(极盛时)和它自己的 */
function culturesFor(civ: Civ, info: ScopeInfo): number[] {
  if (info.subject) {
    const p = info.subject;
    const stat = polityStats(civ)[p.id];
    const ids = new Set<number>([p.culture]);
    if (stat && stat.peak > 0) {
      const own = ownersAt(civ, stat.peakYear);
      const m = new Map<number, number>();
      for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] === p.id && own.culture[r] >= 0) m.set(own.culture[r], (m.get(own.culture[r]) ?? 0) + 1);
      for (const [c, k] of m) if (k / stat.peak >= 0.1) ids.add(c);
    }
    return [...ids].filter((c) => civ.cultures[c]);
  }
  return civ.cultures
    .filter((cu) => Y(cu.born) <= info.to && (cu.ended === undefined || Y(cu.ended) >= info.from))
    .sort((a, b) => a.born - b.born || a.id - b.id)
    .map((cu) => cu.id);
}

/** 世界概况(几行) */
function overviewText(civ: Civ, info: ScopeInfo): string {
  const stats = polityStats(civ);
  const great = civ.polities.filter((p) => (stats[p.id]?.peak ?? 0) >= 25).length;
  const peopled = civ.regions.count;
  const lines = [
    `- 纪年:第一批定居者到来那年算第 0 年;推演到第 ${Y(civ.endYear)} 年为止。本书写第 ${info.from}—${info.to} 年`,
    `- 全世界约${cnNumber(peopled)}个州(州是地图上的地区单位,大小约相当于一个郡);先后兴起过${cnNumber(civ.cultures.length)}个民族、${cnNumber(civ.polities.length)}个国家,其中${cnNumber(great)}个成为大国(极盛时二十五州以上)`,
    '- 国号随国土大小升格:部 / 城邦(一州)→ 国(五州以上)→ 王国、大某(二十五州以上)→ 帝国、某某王朝(七十州以上);东方式国家约三百年一易代、换国号,西幻式国家国名不变、王室更迭',
  ];
  const eastern = civ.polities.some((p) => p.eastern);
  const western = civ.polities.some((p) => !p.eastern);
  if (eastern && western) lines.push('- 这个世界东西两种风格并存:东方式国家是中式国号、中式人名;西幻式国家是音译的国名、人名');
  return lines.join('\n');
}

interface Parts {
  overview: string;
  geography: string;
  cultures: string;
  polities: string;
  situation: string;
}

/**
 * 材料(纪事之外的部分),按预算裁剪:国家、民族按顺序放,放不下的略去。
 * info = 这一次调用写的那一段(分章时是一章),book = 全书;snapshots = 列出哪几年的格局;clip = 国家材料写到哪年
 */
function contextParts(civ: Civ, info: ScopeInfo, book: ScopeInfo, picked: Set<ChronicleEntry>, budget: number, snapshots: Year[], clip: Clip): Parts {
  const stats = rangeStats(civ, clip.from, clip.to);
  const ends = endings(civ);
  const overview = overviewText(civ, book);
  const geography = geographyText(civ, placesFor(civ, book));
  const situation = snapshots.map((y) => `- ${snapshotText(civ, y)}`).join('\n');
  let left = budget - overview.length - geography.length - situation.length;
  // 民族在前(每条短,最多占三成),国家其次:大国 / 主角写全,放不下全的改成一行,一行也放不下就略去
  const cuLines: string[] = [];
  const cus = culturesFor(civ, info);
  let cuLeft = Math.max(0, left * 0.3);
  for (const c of cus) {
    const line = cultureLine(civ, c, clip.to);
    if (line.length > cuLeft && cuLines.length) break;
    cuLines.push(line);
    cuLeft -= line.length + 1;
    left -= line.length + 1;
  }
  if (cuLines.length < cus.length) cuLines.push(`- (另有${cnNumber(cus.length - cuLines.length)}个民族从略)`);
  const polLines: string[] = [];
  const pols = politiesFor(civ, info, picked, clip);
  let skipped = 0;
  for (const q of pols) {
    const p = civ.polities[q];
    const main = q === info.subject?.id;
    const detail = main || (!info.subject && (stats[q]?.peak ?? 0) >= 25);
    let line = polityLine(civ, p, detail, ends, clip, main);
    if (detail && !main && line.length > left) line = polityLine(civ, p, false, ends, clip);
    if (line.length > left && !main) {
      skipped++;
      continue;
    }
    polLines.push(line);
    left -= line.length + 1;
  }
  if (skipped) polLines.push(`- (另有${cnNumber(skipped)}个国家从略)`);
  return { overview, geography, cultures: cuLines.join('\n'), polities: polLines.join('\n'), situation };
}

function materialText(parts: Parts, chron: string, dropped: number, chapter = '', clipTo?: Year): string {
  const out = [
    `【材料】(推演生成的史实,以此为准。★ = 大事;战争下面缩进的是战事细节${dropped > 0 ? `;篇幅所限,略去了${cnNumber(dropped)}条(多是小事和战事细节)` : ''})`,
    '',
    '〔世界概况〕',
    parts.overview,
  ];
  if (parts.geography) out.push('', '〔地理〕', parts.geography);
  if (parts.cultures) out.push('', '〔民族〕(兴起 = 这一族出现的年份,不是立国;哪年立的什么国看〔国家〕和〔编年史〕)', parts.cultures);
  if (parts.polities) {
    const until = clipTo !== undefined ? `;只写到第 ${Y(clipTo)} 年为止` : '';
    out.push('', `〔国家〕(括号里是起名和行文的风格提示,不要写进正文;国号随年份变化,写到哪一年就用那一年的国号${until})`, parts.polities);
  }
  if (parts.situation) out.push('', '〔格局〕(当时各国的大小和国都)', parts.situation);
  out.push('', `〔编年史〕${chapter}`, chron || '- (这段时间没有记下什么事)');
  return out.join('\n');
}

/** 写作要求里的"取舍"一条 */
const CHOOSE =
  '- 取舍:以 ★ 大事为骨架,挑能说明因果的小事写,其余一笔带过或略去;不要逐条复述编年史,要写成连贯的叙述;材料里没有的时期就少写,不要硬凑';

/** 写作要求里的"笔调"一条(各文体共用) */
const TONE = '- 笔调:平实,少用比喻、排比和空泛的抒情;不要每段都发议论,结尾不要升华成大道理;战争写攻守得失,不要渲染杀戮和血腥场面(服务商的内容审核会拦)';

function styleLine(opts: HistoryOptions): string {
  const s = HISTORY_STYLES[opts.style];
  return `- 文体:${s.label}。${s.rule}`;
}

/**
 * 篇幅一条:约 N 字,只给上限。模型普遍写超(qwen-plus 要 800 字常写到 1000 字);
 * 实测给了下限("不少于……")反而写得更长,所以只说上限和"宁可略短"
 */
function lengthLine(chars: number, what = ''): string {
  const r = (x: number) => Math.round(x / 50) * 50;
  return `- 篇幅:${what}约 ${chars} 字(正文的中文字数;最多不超过 ${r(chars * 1.1)} 字,宁可略短)`;
}

/** 各章字数的说法:"每章约 600 字" / "各章约 第一章 700 字、第二章 500 字……" */
function allotText(per: number[], label: (i: number) => string): string {
  return per.every((c) => c === per[0]) ? `每${label(-1)}约 ${per[0]} 字` : `各${label(-1)}约 ${per.map((c, i) => `${label(i)} ${c} 字`).join('、')}`;
}

/** 整理材料、写好提示词。国家不存在(国史)时 empty = true、calls 为空 */
export function buildHistoryPrompts(civ: Civ, opts: HistoryOptions): HistoryPrompts {
  const style = HISTORY_STYLES[opts.style];
  const unit = style.unit ?? '章';
  const bio = opts.style === 'biography';
  const info = scopeInfo(civ, opts.scope);
  if (!info) {
    return { options: opts, title: '', range: '', chars: 0, system: SYSTEM_PROMPT, sections: [], calls: [], empty: true, fingerprint: 'none', inputChars: 0, inputTokens: 0 };
  }
  // 史事太少的(短命小国、没什么事的年代)写不了那么长:按史事的分量封顶,篇幅跟着降到同一组里够用的那一档
  const chars = Math.min(HISTORY_LENGTHS[opts.length].chars, charCap(info.entries));
  const family = BOOK_LENGTHS.includes(opts.length) ? BOOK_LENGTHS : PANEL_LENGTHS;
  const eff: HistoryLength = family.find((k) => chars <= HISTORY_LENGTHS[k].chars) ?? opts.length;
  const L = { ...HISTORY_LENGTHS[eff], chars };
  const title = bookTitle(civ, info, opts.scope);
  const range = span(info.from, info.to);
  const sections = sectionsFor(civ, { ...opts, length: eff }, info, L);
  const subject = subjectText(civ, info, opts.scope);
  const calls: HistoryCall[] = [];
  const perCall = L.split === 'calls' && sections.length > 1;
  const n = sections.length;
  const per = allotChars(L.chars, info.entries, sections);
  /** 第 i 章 / 篇的叫法(i = −1:单位本身,"章""卷""篇") */
  const label = (i: number) => (i < 0 ? (bio ? '篇' : unit) : bio ? partName(sections[i]) : chapterName(i, unit));
  const whole: Clip = { from: info.from, to: info.to };
  const clipped = opts.scope.kind === 'era';

  if (!perCall) {
    // 一次写完:材料按预算裁剪,纪事先占六成,余下给国家、民族等;国家、民族没用完的再还给纪事
    const trial = pickEntries(info.entries, Math.round(L.budget * 0.6));
    // 格局:通史写推演结束时,断代史写这一时代开始和结束时;国史不写(别国的大小和它关系不大)
    const snaps = opts.scope.kind === 'world' ? [civ.endYear] : opts.scope.kind === 'era' ? [info.from, info.to] : [];
    const parts = contextParts(civ, info, info, trial.picked, Math.round(L.budget * 0.4), snaps, whole);
    const ctxLen = Object.values(parts).reduce((t, x) => t + x.length, 0);
    const { picked, dropped, total } = pickEntries(info.entries, Math.max(Math.round(L.budget * 0.5), L.budget - ctxLen));
    const chron = chronicleBlock(info.entries, picked, sections, unit);
    let structure: string;
    if (bio && n > 1) {
      structure =
        `- 结构:按纪传体分篇,依次是 ${sections.map((x, i) => `${label(i)}${x.part === 'lives' ? '' : `(${span(x.from, x.to)})`}`).join('、')};` +
        `各篇以"## 本纪·某国""## 世家·某国""## 列传"这样的一行开头(篇名照这里写);列传写两到四个人,每人以"### 某某传"开头;${allotText(per, label)}`;
    } else if (bio) {
      structure = '- 结构:按纪传体,先"## 本纪·国名"写这一国的兴衰,再"## 列传"写一两个人(每人以"### 某某传"开头)';
    } else if (n > 1) {
      structure =
        `- 结构:分${cnNumber(n)}${unit},和〔编年史〕里的分段一一对应;每${unit}以"## ${chapterName(0, unit)} ${unit}名(第 A—B 年)"这样的一行开头,${unit}名你来起(四到八个字);` +
        allotText(per, label);
    } else {
      structure = `- 结构:不分${unit},${L.chars <= 1000 ? '三到五段' : '分若干段'};开头交代地理和民族的背景,结尾收束全篇`;
    }
    const head = [`请根据下面的材料,写「${title}」。`, '', '【写作要求】', `- 写什么:${subject}`, styleLine(opts), lengthLine(L.chars), structure, CHOOSE, TONE].join('\n');
    calls.push({
      title,
      chapter: null,
      chars: L.chars,
      maxTokens: L.maxTokens,
      temperature: style.temperature,
      head,
      body: materialText(parts, chron, dropped, '', clipped ? info.to : undefined),
      used: picked.size,
      total,
    });
  } else {
    // 分章多次调用:每章一份材料(这一章的纪事 + 涉及的国家、民族,国家只写到这一章结束),带上全书的目录;前文由 historyMessages 接上
    const uw = label(-1);
    sections.forEach((s, i) => {
      const inSec = entriesOf(sections, i, info.entries);
      const last = i === n - 1;
      const secInfo: ScopeInfo = { ...info, from: s.from, to: s.to, entries: inSec };
      const sliced = s.part !== 'lives' || !!s.name;
      const clip: Clip = sliced ? { from: s.from, to: s.to } : whole;
      const trial = pickEntries(inSec, Math.round(L.budget * 0.6));
      // 格局:按时间分章的通史 / 断代史每章写这一章开始时(第 0 年还没有国家,不写)、最后一章再写结束时;国史、纪传体不写
      const snaps: Year[] = [];
      if (opts.scope.kind !== 'polity' && !s.part) {
        if (i > 0 || opts.scope.kind === 'era') snaps.push(s.from);
        if (last) snaps.push(s.to);
      }
      const parts = contextParts(civ, secInfo, info, trial.picked, Math.round(L.budget * 0.4), snaps, clip);
      const ctxLen = Object.values(parts).reduce((t, x) => t + x.length, 0);
      const { picked, dropped, total } = pickEntries(inSec, Math.max(Math.round(L.budget * 0.5), L.budget - ctxLen));
      const chron = chronicleBlock(inSec, picked, s.part ? null : [s], unit);
      const tocLine = (x: HistorySection, k: number) =>
        `${label(k)}${x.part === 'lives' && !x.name ? '' : ` ${span(x.from, x.to)}`}${!x.part && x.reign ? `(${x.reign})` : ''}` +
        (k < i ? '(已写完)' : k === i ? ` ← 这次写这一${uw}` : '(之后再写)');
      const lines = [
        `请根据下面的材料,写「${title}」的${label(i)}(全书共${cnNumber(n)}${uw},分${cnNumber(n)}次写,这次只写这一${uw})。`,
        '',
        '【全书目录】',
        sections.map(tocLine).join('\n'),
        '',
        '【写作要求】',
        `- 全书写什么:${subject}`,
      ];
      if (s.part === 'lives') {
        const when = s.name ? `${span(s.from, s.to)}间` : '这段历史里';
        lines.push(`- 这一篇写什么:${label(i)} —— 为${when}的关键人物立传(将相、使臣、谋士、叛将、遗民……,两到四人,君主写在本纪里),材料里写到的统帅可以立传,也可以另补人物;他们经历的战事、兴亡照材料写,前面本纪里出现过的人物可以接着写,名字照前文`);
      } else if (s.part) {
        const who = s.polity !== undefined && s.polity >= 0 ? civ.polities[s.polity] : null;
        lines.push(`- 这一篇写什么:${label(i)} —— ${who && who.id !== info.subject?.id ? `${s.name}一国` : `${s.name}一朝`}${span(s.from, s.to)}的兴衰;别国只在和它有关时提到`);
      }
      lines.push(styleLine(opts), lengthLine(per[i], `本${uw}`));
      if (s.part === 'lives') lines.push(`- 结构:以"## ${label(i)}"这一行开头;每人一篇,各以"### 某某传"开头`);
      else if (s.part) lines.push(`- 结构:以"## ${label(i)}"这一行开头`);
      else lines.push(`- 结构:以"## ${chapterName(i, unit)} ${unit}名(${span(s.from, s.to)})"这样的一行开头,${unit}名你来起(四到八个字)`);
      const keep = '前文出现过的人物沿用原名,新人物不要和前文的人重名、同字号;不要照抄前文的句子、人物描写和评语,开头、结尾、"史臣曰"的句式也要和前面几篇不同';
      if (i === 0) lines.push(`- 衔接:这是第一${uw},开头交代地理和民族的背景;不要提前写后面${uw === '篇' ? '各篇' : `的${uw}`}的事,也不要写全书的结语`);
      else if (s.part) lines.push(`- 衔接:〔前文〕是已经写好的几篇;前文写过的事这一篇只一笔带过;${keep}${last ? ';这是最后一篇,末尾可以有一段总结全书的"史臣曰"' : ''}`);
      else lines.push(`- 衔接:接着〔前文〕往下写,不重复前文写过的事;${keep};${last ? `这是最后一${uw},末尾可以有一段总结全书的结语` : `不要提前写后面${uw}的事,也不要写全书的结语`}`);
      lines.push(CHOOSE, TONE);
      calls.push({
        title: `${title} · ${label(i)}`,
        chapter: i,
        chars: per[i],
        maxTokens: L.maxTokens,
        temperature: style.temperature,
        head: lines.join('\n'),
        body: materialText(parts, chron, dropped, `(本${uw}:${label(i)}${sliced ? ` ${span(s.from, s.to)}` : ''})`, clip.to < civ.endYear ? clip.to : undefined),
        used: picked.size,
        total,
      });
    });
  }
  // 输入估算:系统提示每次都发;第 2 次起带前文(前几章的字数之和,封顶 PREV_CONTEXT)
  let inputChars = 0;
  let prev = 0;
  let prevSum = 0;
  calls.forEach((c, i) => {
    const ctx = i > 0 ? Math.min(PREV_CONTEXT, prevSum) + 30 : 0;
    inputChars += SYSTEM_PROMPT.length + c.head.length + c.body.length + ctx;
    prev += ctx;
    prevSum += c.chars;
  });
  const sample = calls.map((c) => SYSTEM_PROMPT + c.head + c.body).join('') + '字'.repeat(prev);
  return {
    options: opts,
    title,
    range,
    chars,
    system: SYSTEM_PROMPT,
    sections,
    calls,
    empty: info.entries.length === 0,
    fingerprint: historyFingerprint(civ, opts.scope),
    inputChars,
    inputTokens: estimateTokens(sample),
  };
}

/**
 * 第 i 次调用发给 AI 的消息。分章写的从第二章起,prevText = 已经写好的前文(整篇给,太长取最后 PREV_CONTEXT 字),
 * 让 AI 接着写、不重复用过的人名和评语
 */
export function historyMessages(p: HistoryPrompts, i: number, prevText = ''): AiMessage[] {
  const c = p.calls[i];
  let ctx = '';
  if (c.chapter && prevText.trim()) {
    const t = prevText.trim();
    const cut = t.length > PREV_CONTEXT;
    ctx = `\n\n〔前文〕(已经写好的${cut ? '最后一部分' : '部分'};接着它往下写,不要重复)\n${cut ? '……' + t.slice(-PREV_CONTEXT) : t}`;
  }
  return [
    { role: 'system', content: p.system },
    { role: 'user', content: `${c.head}${ctx}\n\n${c.body}` },
  ];
}

/** 字数(正文里的非空白字符) */
export function textLength(s: string): number {
  return len(s);
}

// ---------------------------------------------------------------------------
// 历史指纹

/**
 * 这个范围里的历史摘要:每条纪事(含战争细节)的年份和正文、国史主角的国号先后、材料里列的地名。
 * 改名(名字都写在纪事里)、干预、改地形重推之后变了 —— 旧史书就标"写于历史改变之前"。
 * 只看这个范围:别国改名、这段时间以外的干预不影响
 */
export function historyFingerprint(civ: Civ, scope: HistoryScope): string {
  const info = scopeInfo(civ, scope);
  if (!info) return 'none';
  const parts: string[] = [`${info.from}-${info.to}`];
  for (const e of info.entries) {
    parts.push(`${entryYearLabel(e)} ${e.text}`);
    for (const c of e.children ?? []) parts.push(`${yearText(c.year)} ${c.text}`);
  }
  if (info.subject) parts.push(polityTitleChain(info.subject), capitalsText(civ, info.subject));
  for (const i of placesFor(civ, info)) parts.push(civ.places[i].name);
  return hash(parts.join('\n'));
}

// ---------------------------------------------------------------------------
// 存档里记的"写什么"(国家按稳定键记:改地形重推后编号变了也找得到)

export type StoredScope = { kind: 'world' } | { kind: 'polity'; key: string; name: string } | { kind: 'era'; from: number; to: number };

export function storeScope(civ: Civ, scope: HistoryScope): StoredScope {
  if (scope.kind === 'polity') {
    const p = civ.polities[scope.polity];
    return { kind: 'polity', key: p ? polityKey(civ, p.id) : '', name: p ? nameAt(civ, p, polityStats(civ)[p.id]?.peakYear ?? p.founded) : '' };
  }
  if (scope.kind === 'era') return { kind: 'era', from: Y(Math.min(scope.from, scope.to)), to: Y(Math.max(scope.from, scope.to)) };
  return { kind: 'world' };
}

/** 存档里记的 → 这个世界里的范围;国家在现在的历史里找不到了 = null */
export function loadScope(civ: Civ, s: StoredScope): HistoryScope | null {
  if (s.kind === 'polity') {
    const r = resolveKey(civ, s.key);
    return r && r.kind === 'polity' && civ.polities[r.id] ? { kind: 'polity', polity: r.id } : null;
  }
  if (s.kind === 'era') return { kind: 'era', from: s.from, to: s.to };
  return { kind: 'world' };
}

/** 笔记的键:同一个范围 + 文体 + 篇幅 = 同一部(重写就覆盖) */
export function historyNoteKey(s: StoredScope, style: HistoryStyle, length: HistoryLength): string {
  const where = s.kind === 'polity' ? `polity:${s.key}` : s.kind === 'era' ? `era:${s.from}-${s.to}` : 'world';
  return `史书:${where}:${style}:${length}`;
}

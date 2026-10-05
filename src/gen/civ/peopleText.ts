/**
 * 人物的称呼(编年史、AI 材料共用):纯函数,只引 growth.ts / types.ts,不引起名器和推演代码。
 *
 * - 君主(带国名):东方 —— 帝国级 "大昌太宗"、王国 "昌庄王"、国 "昌穆公"、亡国之君 "大昌哀帝"、部落 "昌部首领李昭"、
 *   汗国 "乌耐汗国咄苾可汗";还在位的没有称号,写君号 + 名字:"大昌皇帝李昭""昌王李昭"。
 *   西幻 —— 国名词根 + 君号 + 名字(+ 序数 / 大帝):"索拉特国王阿尔德里克三世""索拉特皇帝阿尔德里克大帝""提布里亚执政官卡西乌斯"
 *   (汗国:汗 / 大汗;部落:酋长 / 首领)。
 * - 君主(不带国名,国名前文已经写了):rulerBare 带君号 —— 东方 "太宗""庄王""咄苾可汗""皇帝李昭",西幻 "国王阿尔德里克三世";
 *   rulerShort 不带君号 —— 东方 "太宗""李昭",西幻 "阿尔德里克三世"。
 * - 统帅:"大渭将李牧"(国名用当年的简称)。
 * 国名一律按年份现查(growth.ts),作者改了国名,称呼跟着变。
 */
import type { Civ, Person, Polity, Year } from './types';
import { polityName, polityRootAt, polityShortTitle, polityTierAt, polityTitles } from './growth';

/** 西幻的君号(按国号一系、档位) */
const WEST_RANK: Record<string, readonly [string, string, string, string]> = {
  realm: ['酋长', '国王', '国王', '皇帝'],
  khanate: ['首领', '汗', '汗', '大汗'],
  republic: ['执政官', '执政官', '执政官', '皇帝'],
};
/** 东方还在位(没有称号)的君号 */
const EAST_RANK = ['首领', '公', '王', '皇帝'] as const;

function polityOfPerson(civ: Civ, x: Person): Polity | null {
  return x.polity >= 0 && x.polity < civ.polities.length ? civ.polities[x.polity] : null;
}

const clampTier = (t: number) => Math.min(3, Math.max(0, t));

/** 东方单字国名去掉"大":"大昌" → "昌"(王、公、帝的称号前用) */
function core(root: string): string {
  const cs = [...root];
  return cs.length === 2 && cs[0] === '大' ? cs[1] : root;
}

/** 君主在位时的国号档位(按 year;year 不在在位期间就夹到在位期间里) */
function tierFor(p: Polity, x: Person, year: Year): number {
  const from = x.from ?? p.founded;
  const until = x.until ?? Infinity;
  const y = Math.min(Math.max(year, from), until - 1 / 512);
  return clampTier(polityTierAt(p, y));
}

/**
 * 君主的称呼,不带国名(国名前文已经写了):东方有称号的写称号("太宗""庄王""哀帝"),没有的写名字;
 * 西幻 名字 + 序数("阿尔德里克三世""阿尔德里克大帝")
 */
export function rulerShort(civ: Civ, x: Person): string {
  const p = polityOfPerson(civ, x);
  if (p?.eastern) return x.title || x.name;
  return `${x.name}${x.title ?? ''}`;
}

/** 君主的称呼,带国名(year = 写到的那一刻,决定国号和还在位时的君号) */
export function rulerRef(civ: Civ, x: Person, year: Year): string {
  return refOf(civ, x, year, true);
}

/**
 * 君主的称呼,不带国名、带君号(国名前文已经写了):东方有称号的写称号("哀帝""庄王"),没有的写君号 + 名字
 * ("咄苾可汗""首领李昭""皇帝李昭""昌王李昭");西幻 "国王阿尔德里克三世"
 */
export function rulerBare(civ: Civ, x: Person, year: Year): string {
  return refOf(civ, x, year, false);
}

function refOf(civ: Civ, x: Person, year: Year, realm: boolean): string {
  const p = polityOfPerson(civ, x);
  if (!p) return x.name;
  const tier = tierFor(p, x, year);
  const at = Math.min(Math.max(year, x.from ?? p.founded), (x.until ?? Infinity) - 1 / 512);
  if (p.eastern) {
    const tribe = realm ? polityTitles(p, at)[0] : '';
    if (p.lineage === 'khanate') return tier <= 0 ? `${tribe}首领${x.name}` : `${realm ? polityName(p, at) : ''}${x.name}可汗`;
    if (tier <= 0) return `${tribe}首领${x.name}`;
    const root = polityRootAt(p, at);
    if (x.title) return !realm ? x.title : tier >= 3 ? `${polityShortTitle(p, 3, at)}${x.title}` : `${core(root)}${x.title}`;
    if (tier >= 3) return `${realm ? polityShortTitle(p, 3, at) : ''}皇帝${x.name}`;
    return `${core(root)}${EAST_RANK[tier]}${x.name}`;
  }
  const rank = (WEST_RANK[p.lineage ?? 'realm'] ?? WEST_RANK.realm)[tier];
  return `${realm ? polityRootAt(p, at) : ''}${rank}${x.name}${x.title ?? ''}`;
}

/** 统帅的称呼:"大渭将李牧";君主亲征的用 rulerRef */
export function generalRef(civ: Civ, x: Person, year: Year): string {
  if (x.role === 'ruler') return rulerRef(civ, x, year);
  const p = polityOfPerson(civ, x);
  if (!p) return x.name;
  const tier = clampTier(polityTierAt(p, year));
  return `${polityShortTitle(p, tier, year)}将${x.name}`;
}

/** 某年的岁数(取整) */
export function ageAt(x: Person, year: Year): number {
  return Math.floor(year - x.born);
}

// ---------------------------------------------------------------------------
// 人物卡片、人物页用的写法

/** 人物页、人物卡片上的名字:东方有称号的 称号 + 名字("圣宗柳玄"),没有的写名字;西幻 "阿尔德里克三世";统帅 = 名字 */
export function personName(civ: Civ, x: Person): string {
  if (x.role !== 'ruler') return x.name;
  const p = polityOfPerson(civ, x);
  if (p?.eastern) return x.title ? `${x.title}${x.name}` : x.name;
  return rulerShort(civ, x);
}

/** 君主在位的最后那一刻(还在位 = 结束年份;身份、国号都按它) */
function lastReignYear(civ: Civ, x: Person): Year {
  const end = x.until ?? civ.endYear;
  return Math.max(x.from ?? 0, end - 1 / 512);
}

/**
 * 君主的身份(卡片上名字下面那行的开头):国名 + 君号,按在位最后那年 ——
 * 东方 "大景皇帝""昌王""昌公""昌部首领""乌耐汗国可汗";西幻 "索拉特国王""提布里亚执政官"
 */
export function rulerRole(civ: Civ, x: Person): string {
  const p = polityOfPerson(civ, x);
  if (!p) return '';
  const at = lastReignYear(civ, x);
  const tier = tierFor(p, x, at);
  if (p.eastern) {
    if (p.lineage === 'khanate') return tier <= 0 ? `${polityTitles(p, at)[0]}首领` : `${polityName(p, at)}可汗`;
    if (tier <= 0) return `${polityTitles(p, at)[0]}首领`;
    if (tier >= 3) return `${polityShortTitle(p, 3, at)}皇帝`;
    return `${core(polityRootAt(p, at))}${EAST_RANK[tier]}`;
  }
  return `${polityRootAt(p, at)}${(WEST_RANK[p.lineage ?? 'realm'] ?? WEST_RANK.realm)[tier]}`;
}

/** 统帅的身份:"大景将领"(国名按第一次领兵那年的简称) */
export function generalRole(civ: Civ, x: Person): string {
  const p = polityOfPerson(civ, x);
  if (!p) return '将领';
  const y = x.commands?.[0]?.from ?? x.born;
  return `${polityShortTitle(p, clampTier(polityTierAt(p, y)), y)}将领`;
}

/** 共和国的执政官(写"执政""在任""任满",不写"君主""在位") */
export function isConsul(civ: Civ, x: Person): boolean {
  return x.role === 'ruler' && polityOfPerson(civ, x)?.lineage === 'republic';
}

/**
 * 后一位君主是前一位的什么人:按两人的年纪差说(差十四岁以上是子,四十岁以上是孙,不然是弟;后一位年长的是兄)。
 * 推演没有记父子,编年史的"其子 / 其弟"和人物卡片的"父 / 兄"都按这个算,两边一致
 */
export function kinOf(prev: Person, next: Person): '子' | '孙' | '弟' | '兄' {
  const gap = next.born - prev.born;
  if (gap >= 40) return '孙';
  if (gap < 0) return '兄';
  return gap >= 14 ? '子' : '弟';
}

/** kinOf 倒过来:前一位是后一位的什么人 */
export const KIN_BACK: Record<ReturnType<typeof kinOf>, string> = { 子: '父', 孙: '祖父', 弟: '兄', 兄: '弟' };

/** 君主的结局(卡片、人物页):"驾崩""遇弑""被废""殉国"……;还在位 = 空串 */
export function rulerFateWord(civ: Civ, x: Person): string {
  const p = polityOfPerson(civ, x);
  if (!p || !x.fate) return '';
  const tier = tierFor(p, x, lastReignYear(civ, x));
  switch (x.fate) {
    case 'died':
      if (!p.eastern) return tier >= 1 ? '驾崩' : '去世';
      return p.lineage === 'khanate' || tier <= 0 ? '去世' : tier >= 3 ? '驾崩' : '薨';
    case 'murdered':
      return p.eastern ? '遇弑' : '遇刺身亡';
    case 'deposed':
      return '被废';
    case 'overthrown':
      return '死于兵乱';
    case 'fell':
      return '亡国殉国';
    case 'surrendered':
      return '亡国出降';
    case 'fled':
      return '亡国出奔';
    case 'merged':
      return '国并入他国';
    case 'retired':
      return '任满';
    case 'battle':
      return '战死';
  }
}

/**
 * 编年史(阶段 3):把 civ.annals(史事)写成一条条中文纪事,给界面上的"编年史"面板和"复制全文"用。
 * 纯函数,主线程用;只引 growth.ts / display.ts / types.ts,不引起名器和推演代码。
 *
 * - 一律按史事的字段读(各种类的字段含义见 types.ts 的 AnnalKind),不去翻变化日志推断。
 * - 国名用事发当年的国号(growth.ts 的 polityName),州名用 display.ts 的 regionLabel,城名用 settlements[i].name。
 * - **折叠**:同一个战争编号的宣战、攻占、被迫迁都(国都失守,capital 带战争编号)、灭亡、议和折叠成一条"战争"
 *   (起止年份、交战双方、结果),子条目是每一件事;标题写结果:"得瑞州等五州"、"昌国国都汾城陷落"(一场战争里
 *   迁了两次以上写"昌国连迁三都")、"昌国亡"。攻方先得后失写"得瑞州等三州而失雪西"(只有攻方的得失不带主语,
 *   国都失守不写"失国都",免得两个"失"说的不是同一方)。
 *   不是打下来的攻占各合成一条子条目,不写"攻取":议和时划清边界割让的(史事 peace 的 region = 紧挨在它前面的几条)
 *   写"议定疆界,乌绝原等三州划归大渭,雪西划归昌国"(标签"割");丢了国都撑不下去、残部一并归攻方的
 *   (亡国前同一刻连着的几条攻占)写"余下瑞州等三州尽归大渭"。
 *   不在战争里、收服部落地带的攻占,同一国前后相隔不到 TRIBAL_GAP 年的也折叠成一条(一条最长 TRIBAL_SPAN 年)。
 *   灭亡除了在战争的子条目里,也单独列一条(按国家筛选时要看得到;"大事"里由战争那一条说,不重复)。
 * - **分合**(阶段 3):分裂写"瑞州叛大渭自立,号瑞国,都于瑞城";复国(新国家有 Polity.restores)写
 *   "故昌遗民据瑞州起兵,脱大渭复国,号后昌国,都于瑞城"(标签"复");合并写"梅利斯国并入梅西亚王国"。
 *   攻占以前占有过的州(被夺走、议和割让、分裂出去之后又打回来)写"夺回"。
 * - **王朝更替**(阶段 3):东方写"大昌享国 312 年而亡,景氏起于青州代之,国号大景,定都青阳"(权臣篡位:"权臣景氏篡位,国号大景";
 *   入主旧都:"景氏起于青州,入主昌京,国号大景");西幻写"索拉特王国王室更迭,塞伦纳王朝享国 312 年而终,卡诺王朝兴,迁都卡诺"
 *   (汗国写"汗位易主")。标签"朝"。"享国 N 年"一律按当朝算(灭亡时也是),复国写"故景遗民"(亡国时那一朝的国号)。
 * - **城市兴衰**(阶段 3):洗劫写"大渭纵兵大掠汾城"(标签"掠"),折进那场战争;毁城写"大渭破昌国国都汾城,屠其民"
 *   (标签"毁"),折进战争,也单独列一条(和亡国一样);重建写"汾城重建"(换了民族另起新名:"汾城故址上筑起新城瑞城",标签"建");
 *   旧都衰落写"大昌旧都汾城渐衰"(亡了的国写"故都",标签"衰")。洗劫、毁城在史事里记在攻占前面,战争的子条目里排回攻占后面;
 *   战争标题里写毁了哪几座城("毁汾城")。
 * - **重要度**(界面上的"大事" = 重要度 3,一个世界 3000 年三四十条,一页读完,能当"世界简史"读:几个大国怎么兴起、
 *   打了哪几场改变格局的仗、怎么改朝换代、谁亡了;"全部"里什么都有):
 *   3 = 大国(到过第 2 档)立国、升格到一生最高的第 2 档以上(称王 / 称帝)、分出来的(复国的)国家日后长成大国、
 *       并掉的是大国、大国土崩瓦解、东方改朝换代(当时第 DYNASTY_TIER 档以上)、帝国级(第 CAPITAL_TIER 档)主动迁都、
 *       改变格局的战争:灭了大国、吞并一个像样的国家(亡的是"国"、易手 ≥ FALL_WAR 州;小国分出去又被原主收回的不算)、
 *       易手 ≥ BIG_WAR 州、攻下大国做了 ≥ OLD_CAPITAL 年的国都、两个第 3 档的帝国交兵且易手 ≥ TITAN_WAR 州、
 *       毁了大城(或做国都的城);
 *   2 = 小国立国、小国分裂 / 复国 / 并入大国、小国的改朝换代、降格、其余有得失的战争、战争里的每一件事(亡国、毁城那一条
 *       也单列,"大事"里由战争说)、夺别国的州、部落亡了、西幻的王室更迭(国名不变,地图上看不出来)、洗劫、城被毁、
 *       城(以上)重建、旧都衰落;
 *   1 = 部 → 国、只扩土不改国号、无功而还的战争、收服部落、村镇被毁、村镇重建。
 * - **大事合写**(combine):同一国家短时间(COMBINE_GAP 年)里连着的大事,后一件写进前一件,"大事"里不再单占一行
 *   ("全部"里照旧单列):改朝换代后不久有州叛离("…,国号大辰;七年后喀勒川叛大辰王朝自立,号库兹汗国");
 *   亡国之后逃难的迁徙写进那场战争("…,艾莱斯国亡,艾莱斯族南迁,入阿拉斯等五州")。
 * - **来历**(introduce):只看大事时,某国第一次出现、它的立国 / 分裂 / 复国不在大事里的,名字后面带一句来历:
 *   "艾莱斯国(第 2341 年立国)"、"塔提特汗国(第 2082 年叛哈尔提亚王国自立)"、"新塔提特汗国(第 2455 年脱哈尔提亚帝国复国)";
 *   改朝换代换了国号、那次改朝换代不在大事里的:"伊罗汗国(原居兰汗国)"。
 * - **同化与迁徙**(阶段 3,史事的 a、b 是民族):一波迁徙(同一刻、同一民族、同一起因)折成一条
 *   "居兰族避大渭兵锋西迁,入疏勒原等五州" / "乌耐族随乌耐汗国南下,徙居瑞州等三州"(方位读 Culture.migrations);
 *   逐州的同化按"新民族 + 原民族 + 统治的国家"折叠,相隔不到 ASSIM_GAP 年的算一段(一段最长 ASSIM_SPAN 年):
 *   "大渭治下,瑞州等五州的居兰人渐为渭人";统治民族反被同化写"大渭的居兰人渐染渭俗,…渐为渭人";
 *   部落地带的孤地(没有国家)写"瑞州的居兰人渐为渭人"。民族消亡单列一条"乌耐族亡"(大事)。
 *   迁入 ≥ MIGRATE_MAJOR 州的迁徙、同化 ≥ ASSIM_MAJOR 州的一段、民族消亡是大事。
 * - **干预**(阶段 4,史事 intervene;哪一条干预见 Civ.interventions[e.war]):"【干预】大昌与索拉特结盟"
 *   "【干预】大昌自此不亡"(有截止年份的加",至第 2750 年")"【干预】大昌向索拉特宣战"(没打成的写原因:"…,然两国不接壤,未能成行");
 *   划州"【干预】瑞州自大渭划归大昌,永为大昌之土";立国"【干预】瑞州脱大渭自立,号瑞国,都于瑞城"(紧跟着的 found 并进这一条);
 *   迁都"【干预】大昌自汾城迁都瑞城"(紧跟着的 capital 并进这一条);不许扩张"【干预】大昌自此止戈息兵,不再开疆拓土"。
 *   没生效的写原因("…,然其地无人居住""…,然瑞城属大渭");界面上的干预列表也用它(interventionOutcome)。标签"干",一律是大事。
 *   援盟参战的战争(史事 war 的 settlement 列 = 盟国)写"索拉特应大昌之约伐某国"。
 * - 年份写法和时间轴一致:"第 N 年"(N = 年份取整)。州数等计数用中文数字("得瑞州等五州"),年数用阿拉伯数字。
 *
 * buildChronicle 按 civ 缓存(同一个 civ 只算一次)。
 */
import type { Annal, AnnalKind, Civ, Culture, MigrationDir, Polity, Year } from './types';
import {
  TIER_REGIONS,
  dynastyIndexAt,
  dynastyTitle,
  polityName,
  polityRootAt,
  polityShortTitle,
  polityTierAt,
  polityTitles,
  populationAt,
  settlementRank,
} from './growth';
import { cultureLabel, regionLabel } from './display';

/** 重要度:3 最重要 */
export type Importance = 1 | 2 | 3;
/** "大事"的门槛:重要度 3 */
export const MAJOR: Importance = 3;
/** 收服部落:同一国前后两次相隔不到这么多年,算同一轮,折叠成一条 */
export const TRIBAL_GAP = 30;
/** 收服部落:一轮最长这么多年(国家一直在扩张时,每一百年左右记一条,不会一条跨上千年) */
export const TRIBAL_SPAN = 100;
/** 易手这么多州以上的战争改变格局(大事) */
export const BIG_WAR = 10;
/** 攻下做了这么多年以上的国都(故都陷落)的战争是大事 */
export const OLD_CAPITAL = 300;
/** 到过这一档(王国 / 二十五州)以上的是大国:立国算大事 */
export const GREAT_TIER = 2;
/** 双方开战时都在这一档(帝国 / 七十州)以上:大国交兵,有得失就算大事 */
export const TITAN_TIER = 3;
/** 大国交兵:易手这么多州以上才算大事 */
export const TITAN_WAR = 5;
/** 灭国之战:亡的是大国,或者易手这么多州以上(吞并一个像样的国家),才算大事;小国(残部)被收拾掉的只在"全部"里 */
export const FALL_WAR = 5;
/** 改朝换代(东方)、主动迁都:当时在这一档(帝国 / 七十州)以上的是大事;小一些的国家只在"全部"里 */
export const DYNASTY_TIER = 2;
export const CAPITAL_TIER = 3;
/** 同化:同一国治下、同一对民族,前后相隔不到这么多年的算一段,折叠成一条;一段最长这么多年 */
export const ASSIM_GAP = 120;
export const ASSIM_SPAN = 300;
/** 一段同化改换了这么多州以上是大事;不到 ASSIM_MINOR 州的只在"全部"里算小事(重要度 1) */
export const ASSIM_MAJOR = 10;
export const ASSIM_MINOR = 3;
/** 一波迁徙迁入这么多州以上是大事 */
export const MIGRATE_MAJOR = 5;

export interface ChronicleEntry {
  /** 这一条(第一条)史事在 civ.annals 里的下标;列表里唯一,当 key 用 */
  id: number;
  kind: AnnalKind;
  /** 发生的年份(引擎精度的原值,1/256 年;显示取整)。折叠的条目 = 第一件事的年份 */
  year: Year;
  /** 截止年份:折叠的条目 = 最后一件事的年份(战争到结束年份还没打完 = civ.endYear);其余 = year */
  end: Year;
  /** 纪事正文(不带年份) */
  text: string;
  /** 一个字的标签(界面上的小印章):立 升 降 战 占 征 和 割 亡 迁 分 复 合 朝 徙 化 湮 掠 毁 建 衰 干 */
  tag: string;
  importance: Importance;
  /** 相关国家(按国家筛选、地图高亮用;先主后次,不含 −1) */
  polities: number[];
  /** 事发的州(地图高亮用;升格、宣战、合并这类没有具体州的为空,界面高亮相关国家的国土) */
  regions: number[];
  /** 相关的城(立国 / 迁都的国都、攻占的城);没有 = −1 */
  settlement: number;
  /** 折叠进来的每一件事(按先后) */
  children?: ChronicleEntry[];
  /** 战争到结束年份还没打完 */
  ongoing?: boolean;
}

// ---------------------------------------------------------------------------
// 小工具

const CN_DIGITS = '零一二三四五六七八九';
const CN_UNITS = ['', '十', '百', '千'];

/** 计数用的中文数字(0–9999):5 → 五,12 → 十二,25 → 二十五,105 → 一百零五 */
export function cnNumber(n: number): string {
  const v = Math.floor(n);
  if (!(v >= 0) || v >= 10000) return String(Number.isFinite(v) ? v : 0);
  if (v < 10) return CN_DIGITS[v];
  const ds = String(v).split('').map(Number);
  let out = '';
  let zero = false;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    const u = CN_UNITS[ds.length - 1 - i];
    if (d === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += '零';
    zero = false;
    out += (d === 1 && u === '十' && i === 0 ? '' : CN_DIGITS[d]) + u;
  }
  return out;
}

/** "第 N 年"(和时间轴一致:年份取整) */
export function yearText(y: Year): string {
  return `第 ${Math.floor(y)} 年`;
}

/** 条目的年份:"第 1240 年";跨年的折叠条目 "第 1240—1256 年" */
export function entryYearLabel(e: ChronicleEntry): string {
  const a = Math.floor(e.year);
  const b = Math.floor(e.end);
  return b > a ? `第 ${a}—${b} 年` : `第 ${a} 年`;
}

function polityOf(civ: Civ, id: number): Polity | null {
  return id >= 0 && id < civ.polities.length ? civ.polities[id] : null;
}

/** 某年的国名(当年的国号);编号无效 = "某国" */
function pn(civ: Civ, id: number, year: Year): string {
  const p = polityOf(civ, id);
  return p ? polityName(p, year) || p.name || '某国' : '某国';
}

/** 城名;编号无效 / 没名字 = 空串 */
function cityName(civ: Civ, s: number): string {
  return s >= 0 && s < civ.settlements.length ? civ.settlements[s].name || '' : '';
}

/** 州名;编号无效 = 空串 */
function regionName(civ: Civ, r: number): string {
  return r >= 0 && r < civ.regions.count ? regionLabel(civ, r) : '';
}

/** 一串州:"瑞州"、"瑞州、青州"、"瑞州等五州"(人口上限大的写在前面) */
function regionList(civ: Civ, rs: readonly number[]): string {
  const ok = rs.filter((r) => r >= 0 && r < civ.regions.count);
  if (!ok.length) return '';
  const cap = civ.regions.capacity;
  const sorted = [...ok].sort((a, b) => cap[b] - cap[a] || a - b);
  if (sorted.length === 1) return regionName(civ, sorted[0]);
  if (sorted.length === 2) return `${regionName(civ, sorted[0])}、${regionName(civ, sorted[1])}`;
  return `${regionName(civ, sorted[0])}等${cnNumber(sorted.length)}州`;
}

function cultureOf(civ: Civ, id: number): Culture | null {
  return id >= 0 && id < civ.cultures.length ? civ.cultures[id] : null;
}

/** 族名:"居兰族";编号无效 = "某族" */
function cn(civ: Civ, id: number): string {
  const c = cultureOf(civ, id);
  return c && c.name ? cultureLabel(c) : '某族';
}

/** 族人:"居兰人";编号无效 = "异族人" */
function folk(civ: Civ, id: number): string {
  const c = cultureOf(civ, id);
  return c && c.name ? `${c.name}人` : '异族人';
}

/** 某年之前(不含这一年这一刻)的国都 */
function capitalBefore(p: Polity, year: Year): number {
  const c = p.capitals;
  if (!c || !c.length) return p.capital;
  let s = c[0].settlement;
  for (let i = 1; i < c.length && c[i].year < year; i++) s = c[i].settlement;
  return s;
}

/** 某年之前(不含这一刻)的国都做了多少年国都 */
function capitalHeld(p: Polity, year: Year): number {
  const c = p.capitals;
  if (!c || !c.length) return year - p.founded;
  let since = c[0].year;
  for (let i = 1; i < c.length && c[i].year < year; i++) since = c[i].year;
  return year - since;
}

/** 到过的最高档位(没有 titles = 0) */
function peakTier(p: Polity): number {
  let t = 0;
  for (const x of p.titles ?? []) if (x.tier > t) t = x.tier;
  return t;
}

/** 大国:到过第 GREAT_TIER 档(王国 / 二十五州)以上 */
function isGreat(p: Polity | null): boolean {
  return !!p && peakTier(p) >= GREAT_TIER;
}

/** 是个"国":到过第 1 档,或是分裂 / 复国出来的。一直是"X部"的部落亡了不算灭国 */
function isState(p: Polity | null): boolean {
  return !!p && (peakTier(p) >= 1 || p.parent !== undefined || p.restores !== undefined);
}

const uniq = (xs: number[]) => xs.filter((x, i) => x >= 0 && xs.indexOf(x) === i);

// ---------------------------------------------------------------------------
// 单条史事 → 纪事

/** 国号变化:第几条 rank 史事对应 titles 里的哪一条(同一年有两条时按先后对上) */
interface Ctx {
  civ: Civ;
  /** 国家 → 已经用掉的 titles 下标 */
  titleUsed: Map<number, number>;
  /** 是"夺回"的攻占(史事下标):攻方以前占有过这一州(被夺走、议和割让、分裂出去之后又打回来) */
  retake: Set<number>;
  /** 分裂 / 复国出来的国家 → 它是从哪国分出去的(split 史事的 b) */
  splitFrom: Map<number, number>;
  /** 逃难的一波迁徙(条目 id)→ 不带起因的短句"艾莱斯族南迁,入阿拉斯等五州"(合写进战争那一条用,见 combine) */
  flight: Map<number, string>;
}

/**
 * 哪些攻占是"夺回":按史事从头翻,记下每一州先后归过哪些国家(攻占的原主、分裂出去的原主国),
 * 攻方以前占有过的就是夺回。只看史事(扩张得来、后来丢掉的州,丢的那条攻占里原主就是它)
 */
function retakes(A: readonly Annal[]): Set<number> {
  const had = new Map<number, Set<number>>();
  const out = new Set<number>();
  const add = (r: number, p: number) => {
    if (r < 0 || p < 0) return;
    let s = had.get(r);
    if (!s) had.set(r, (s = new Set()));
    s.add(p);
  };
  A.forEach((e, i) => {
    if (e.kind === 'conquer') {
      if (e.a >= 0 && had.get(e.region)?.has(e.a)) out.add(i);
      add(e.region, e.b);
      add(e.region, e.a);
    } else if (e.kind === 'split') {
      add(e.region, e.b);
      add(e.region, e.a);
    }
  });
  return out;
}

/** 升格 / 降格:[之前的档位, 之后的档位] */
function rankTiers(ctx: Ctx, e: Annal, p: Polity): [number, number] {
  const t = p.titles ?? [];
  const used = ctx.titleUsed.get(p.id) ?? 0;
  for (let j = Math.max(1, used); j < t.length; j++) {
    if (t[j].year === e.year) {
      ctx.titleUsed.set(p.id, j + 1);
      return [t[j - 1].tier, t[j].tier];
    }
  }
  // 数据对不上(titles 没记这一次):按年份现查
  let before = 0;
  let after = 0;
  for (const x of t) {
    if (x.year < e.year) before = x.tier;
    if (x.year <= e.year) after = x.tier;
  }
  return [before, after];
}

function rankEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const p = polityOf(civ, e.a);
  let text: string;
  let importance: Importance = 1;
  let tag = '升';
  if (!p) text = '某国更定国号';
  else {
    const titles = polityTitles(p, e.year);
    const [b, a] = rankTiers(ctx, e, p);
    const oldName = titles[Math.min(3, Math.max(0, b))];
    const newName = titles[Math.min(3, Math.max(0, a))];
    if (a > b) {
      if (newName === oldName) {
        text = `${newName}拓地至${cnNumber(TIER_REGIONS[Math.min(3, a)])}州`;
        importance = a >= GREAT_TIER ? 2 : 1;
      } else if (newName.endsWith('帝国') && !oldName.endsWith('帝国')) {
        text = `${oldName}称帝,改号${newName}`;
        importance = 3;
      } else {
        text = `${oldName}升格为${newName}`;
        // 升到第 2 档以上(称王 / 称帝)是大事;后来还会再升一档的,"大事"里只留最高的那一次
        // (帝国的一生读起来是"立国 → 称帝",不再夹一条"称王");部 → 国是小事
        importance = a >= GREAT_TIER ? (a >= peakTier(p) ? 3 : 2) : 1;
      }
    } else if (a < b) {
      tag = '降';
      text = newName === oldName ? `${newName}国势衰微` : `${oldName}国势衰微,降为${newName}`;
      importance = newName === oldName ? 1 : 2;
    } else text = `${newName}更定国号`;
  }
  return base(e, id, text, importance, [e.a], [], tag);
}

/** 各种类的一字标签(降格另写"降";收服部落写"征") */
const TAG: Record<AnnalKind, string> = {
  found: '立',
  rank: '升',
  war: '战',
  conquer: '占',
  peace: '和',
  fall: '亡',
  capital: '迁',
  split: '分',
  merge: '合',
  dynasty: '朝',
  migrate: '徙',
  assimilate: '化',
  vanish: '湮',
  sack: '掠',
  ruin: '毁',
  rebuild: '建',
  decline: '衰',
  intervene: '干',
};

function base(
  e: Annal,
  id: number,
  text: string,
  importance: Importance,
  polities: number[],
  regions: number[],
  tag = e.kind === 'conquer' && e.b < 0 ? '征' : TAG[e.kind] ?? '事',
): ChronicleEntry {
  return {
    id,
    kind: e.kind,
    year: e.year,
    end: e.year,
    text,
    tag,
    importance,
    polities: uniq(polities),
    regions: uniq(regions),
    settlement: e.settlement >= 0 ? e.settlement : -1,
  };
}

/**
 * 攻占一州:"大渭攻取瑞州,国都汾城陷落";war = 所在战争的双方(写子条目时守方是谁不用再说);
 * retake = 这一州开战前本来就是攻方的(战争中被夺走又打回来):"昌国夺回柳州,收复柳城"
 */
function conquerText(civ: Civ, e: Annal, war?: [number, number], retake = false): string {
  const A = pn(civ, e.a, e.year);
  const r = regionName(civ, e.region) || '一州';
  if (e.b < 0) return `${A}征服${r}诸部`;
  const B = pn(civ, e.b, e.year);
  const implied = war && (e.b === war[0] || e.b === war[1]);
  const city = cityName(civ, e.settlement);
  if (retake) return `${A}${implied ? '' : `自${B}手中`}夺回${r}${city ? `,收复${city}` : ''}`;
  let t = implied ? `${A}攻取${r}` : `${A}攻取${B}之${r}`;
  if (city) {
    const owner = polityOf(civ, e.b);
    const wasCapital = owner && capitalBefore(owner, e.year) === e.settlement && owner.founded <= e.year;
    t += wasCapital ? `,国都${city}陷落` : `,${city}陷落`;
  }
  return t;
}

function fallText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  let t = e.b >= 0 ? `${A}亡于${pn(civ, e.b, e.year)}` : `${A}土崩瓦解`;
  const p = polityOf(civ, e.a);
  if (p && Number.isFinite(p.founded)) {
    // 享国按当朝算(改朝换代过的,从新朝那年起)
    const n = Math.floor(e.year) - Math.floor(reignStart(p, e.year));
    if (n >= 1) t += `,享国 ${n} 年`;
  }
  return t;
}

/** 某年那一朝从哪年起(没改朝换代过 = 立国那年) */
function reignStart(p: Polity, year: Year): Year {
  const d = p.dynasties;
  return d && d.length ? d[dynastyIndexAt(p, year)].year : p.founded;
}

/**
 * 编年史里称呼某一朝(year 年时的国号档位):东方 = 那一朝的国号简称("大昌""昌国";汗国写全称"乌耐汗国"),
 * 西幻 = "塞伦纳王朝"
 */
function reignName(civ: Civ, p: Polity, i: number, year: Year): string {
  if (!p.eastern) return dynastyTitle(p, i) || '旧王室';
  const d = p.dynasties?.[i];
  if (!d) return pn(civ, p.id, year);
  const tier = Math.max(0, polityTierAt(p, year));
  return p.lineage === 'khanate' ? polityTitles(p, d.year)[tier] : polityShortTitle(p, tier, d.year);
}

/**
 * 改朝换代 / 王室更迭:
 * 东方 "大昌享国 312 年而亡,景氏起于青州代之,国号大景,定都青阳"(根据地就是国都 = 权臣篡位;没迁都 = 入主旧都);
 * 西幻 "索拉特王国王室更迭,塞伦纳王朝享国 312 年而终,卡诺王朝兴,迁都卡诺"(汗国"汗位易主")
 */
function dynastyText(civ: Civ, e: Annal): string {
  const p = polityOf(civ, e.a);
  if (!p) return '某国改朝换代';
  const y = e.year;
  const i = Math.max(1, dynastyIndexAt(p, y));
  const d = p.dynasties ?? [];
  const n = d.length > i ? Math.floor(y) - Math.floor(d[i - 1].year) : 0;
  const lasted = n >= 1 ? `享国 ${n} 年` : '';
  const oldCap = capitalBefore(p, y);
  const moved = e.settlement >= 0 && e.settlement !== oldCap;
  const city = cityName(civ, e.settlement);
  const oldName = reignName(civ, p, i - 1, y);
  if (p.eastern) {
    const oldRoot = polityRootAt(p, y - 1 / 512);
    const newRoot = polityRootAt(p, y);
    const newName = reignName(civ, p, i, y);
    const house = newRoot !== oldRoot ? `${newRoot}氏` : '新朝';
    const r = regionName(civ, e.region);
    const coup = e.region >= 0 && oldCap >= 0 && oldCap < civ.settlements.length && civ.settlements[oldCap].region === e.region;
    let t = `${oldName}${lasted ? `${lasted}而亡` : '亡'}`;
    if (coup || !r) t += `,权臣${house}篡位`;
    else if (moved) t += `,${house}起于${r}代之`;
    else t += `,${house}起于${r}${cityName(civ, oldCap) ? `,入主${cityName(civ, oldCap)}` : '代之'}`;
    t += `,国号${newName}`;
    if (moved && city) t += `,定都${city}`;
    return t;
  }
  const realm = pn(civ, p.id, y);
  const what = p.lineage === 'khanate' ? '汗位易主' : '王室更迭';
  let t = `${realm}${what},${oldName}${lasted ? `${lasted}而终` : '绝嗣'},${reignName(civ, p, i, y)}兴`;
  if (moved && city) t += `,迁都${city}`;
  return t;
}

/** 城 sid 在 year 这一刻之前的级别(0 村 … 3 大城;被毁的城看被毁前一刻) */
function rankBefore(civ: Civ, sid: number, year: Year): number {
  const s = sid >= 0 && sid < civ.settlements.length ? civ.settlements[sid] : null;
  return s ? settlementRank(populationAt(s, year - 1 / 512)) : 0;
}

/** 攻城那一刻被攻下的城:是守方的国都就写"昌国国都汾城",不是写"汾城" */
function besieged(civ: Civ, e: Annal): { city: string; capital: boolean } {
  const city = cityName(civ, e.settlement) || '一城';
  const owner = polityOf(civ, e.b);
  const capital = !!owner && owner.founded <= e.year && capitalBefore(owner, e.year) === e.settlement;
  return { city: capital ? `${pn(civ, e.b, e.year)}国都${city}` : city, capital };
}

/**
 * 毁城:城以上"大渭破昌国国都汾城,屠其民" / "…焚毁汾城,城遂成废墟" / "…破汾城,夷为平地";
 * 村镇轻一些:"柳镇毁于大渭兵火" / "大渭焚毁柳镇" / "大渭破柳镇,夷为平地"。
 * 三种说法按城、年份轮换,和攻方是哪种国家无关
 */
function ruinText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  const { city } = besieged(civ, e);
  const v = (Math.max(0, e.settlement) * 7 + Math.floor(e.year)) % 3;
  if (rankBefore(civ, e.settlement, e.year) >= 2) {
    if (v === 0) return `${A}破${city},屠其民`;
    if (v === 1) return `${A}焚毁${city},城遂成废墟`;
    return `${A}破${city},夷为平地`;
  }
  if (v === 0) return `${city}毁于${A}兵火`;
  if (v === 1) return `${A}焚毁${city}`;
  return `${A}破${city},夷为平地`;
}

/** 毁城的重要度:大城(或做国都的城)被毁 3,城 2,村镇 1 */
function ruinImportance(civ: Civ, e: Annal): Importance {
  const rank = rankBefore(civ, e.settlement, e.year);
  return rank >= 3 || (rank >= 2 && besieged(civ, e).capital) ? 3 : rank >= 2 ? 2 : 1;
}

/** 洗劫:"大渭洗劫汾城";折损五成五以上写"纵兵大掠",七成以上再加"十室九空" */
function sackText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  const { city } = besieged(civ, e);
  const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
  const loss = s?.sacks?.find((k) => k.year === e.year)?.loss ?? 0;
  if (loss >= 0.7) return `${A}纵兵大掠${city},十室九空`;
  if (loss >= 0.55) return `${A}纵兵大掠${city}`;
  return `${A}洗劫${city}`;
}

/** 重建:"汾城重建"(荒废一百年以上写"荒废 230 年的汾城重建");换了民族另起新名:"汾城故址上筑起新城瑞城" */
function rebuildText(civ: Civ, e: Annal): string {
  const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
  const city = cityName(civ, e.settlement) || '新城';
  const old = s?.rebuilds !== undefined ? civ.settlements[s.rebuilds] : undefined;
  if (!old) return `${city}建城`;
  if (old.name && old.name !== s!.name) return `${old.name}故址上筑起新城${city}`;
  const gap = old.ended !== undefined ? Math.floor(e.year) - Math.floor(old.ended) : 0;
  return gap >= 100 ? `荒废 ${gap} 年的${city}重建` : `${city}重建`;
}

/** 旧都衰落:"大昌旧都汾城渐衰";国家已经亡了(被并)的写"故都"(国名用亡国时的):"昌国故都汾城渐衰" */
function declineText(civ: Civ, e: Annal): string {
  const city = cityName(civ, e.settlement) || '旧都';
  const p = polityOf(civ, e.a);
  if (!p) return `旧都${city}渐衰`;
  if (p.ended !== undefined && p.ended <= e.year) return `${pn(civ, p.id, p.ended - 1 / 512)}故都${city}渐衰`;
  return `${pn(civ, p.id, e.year)}旧都${city}渐衰`;
}

/** 此刻(第 id 条史事之前)两国正在交战 */
function atWarBefore(civ: Civ, a: number, b: number, id: number): boolean {
  const open = new Set<number>();
  const A = civ.annals;
  for (let i = 0; i < id && i < A.length; i++) {
    const e = A[i];
    if (e.kind === 'war' && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) open.add(e.war);
    else if (e.kind === 'peace') open.delete(e.war);
  }
  return open.size > 0;
}

/** 干预(阶段 4)的说法和结果:text = 编年史正文;ok = 生效了;why = 没生效的原因(短句,界面上的干预列表用) */
interface IvStory {
  text: string;
  ok: boolean;
  why?: string;
}

/** 干预(阶段 4):"【干预】大昌与索拉特结盟";没生效的写原因 */
/** 州键指不到州(改地形后那块地方成了水,或者格式不对) */
const NO_REGION = '这个世界没有这个州(改地形后那块地方可能成了水)';

function interveneStory(civ: Civ, e: Annal, id: number): IvStory {
  const v = civ.interventions?.[e.war];
  const y = e.year;
  const A = e.a >= 0 ? pn(civ, e.a, y) : '';
  const B = e.b >= 0 ? pn(civ, e.b, y) : '';
  const dead = (p: number) => {
    const q = polityOf(civ, p);
    return !!q && q.ended !== undefined && q.ended <= y;
  };
  const fail = (text: string, why: string): IvStory => ({ text: `【干预】${text}`, ok: false, why });
  const done = (text: string): IvStory => ({ text: `【干预】${text}`, ok: true });
  /** 紧跟在这条干预后面(同一刻)的史事 */
  const next = (k = 1) => {
    const n = civ.annals[id + k];
    return n && n.year === y ? n : undefined;
  };
  if (!v) return done(A);
  const R = regionName(civ, e.region) || '其州';
  switch (v.kind) {
    case 'protect': {
      const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
      return dead(e.a) ? fail(`欲保${A}不亡,然${A}已亡`, `那一年${A}已亡`) : done(`${A}自此不亡${until}`);
    }
    case 'unity':
      return dead(e.a) ? fail(`欲令${A}四境无叛,然${A}已亡`, `那一年${A}已亡`) : done(`${A}自此四境无叛,再无州郡自立`);
    case 'halt': {
      if (dead(e.a)) return fail(`欲令${A}止戈,然${A}已亡`, `那一年${A}已亡`);
      const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
      const peace = next()?.kind === 'peace' && next()!.a === e.a ? ',所起之兵尽罢' : '';
      return done(`${A}自此止戈息兵,不再开疆拓土${until}${peace}`);
    }
    case 'ally': {
      const until = v.until !== undefined ? `,约至第 ${v.until} 年` : '';
      if (!B) return fail(`${A}欲与他国结盟,然其国不存`, '对方在新历史里没有(或那一年还没立国)');
      const gone = dead(e.a) ? A : dead(e.b) ? B : '';
      return gone ? fail(`${A}欲与${B}结盟,然${gone}已亡`, `那一年${gone}已亡`) : done(`${A}与${B}结盟${until}`);
    }
    case 'declare': {
      if (!B) return fail(`${A}欲伐他国,然其国不存`, '对方在新历史里没有(或那一年还没立国)');
      const n = next();
      if (n && n.kind === 'war' && n.a === e.a && n.b === e.b) return done(`${A}向${B}宣战`);
      if (dead(e.a)) return fail(`欲令${A}伐${B},然${A}已亡`, `那一年${A}已亡`);
      if (dead(e.b)) return fail(`${A}欲伐${B},然${B}已亡`, `那一年${B}已亡`);
      if (atWarBefore(civ, e.a, e.b, id)) return fail(`${A}欲伐${B},然两国已在交战`, '两国那时已在交战');
      return fail(`${A}欲伐${B},然两国不接壤,未能成行`, '两国那时不接壤');
    }
    case 'cede': {
      if (e.region < 0) return fail(`欲以某州划归${A},然无此州`, NO_REGION);
      if (e.b === -2) return fail(`欲以${R}划归${A},然其地无人居住`, `那一年${R}没人住`);
      if (dead(e.a)) return fail(`欲以${R}划归${A},然${A}已亡`, `那一年${A}已亡`);
      const forever = v.permanent ? `,永为${A}之土` : '';
      if (e.b === e.a) return done(`${R}本属${A}${v.permanent ? `,自此永为${A}之土` : ''}`);
      return done(`${R}${e.b >= 0 ? `自${B}` : ''}划归${A}${forever}`);
    }
    case 'found': {
      if (e.a < 0 && e.region < 0) return fail('欲于某州立国,然无此州', NO_REGION);
      if (e.a < 0) return fail(`欲于${R}立国,然其地无人居住`, `那一年${R}没人住`);
      const city = cityName(civ, e.settlement);
      const built = civ.settlements[e.settlement]?.founded === y;
      const seat = city ? (built ? `,筑${city}为都` : `,都于${city}`) : '';
      return done(e.b >= 0 ? `${R}脱${B}自立,号${A}${seat}` : `${R}立国,号${A}${seat}`);
    }
    case 'move': {
      const city = cityName(civ, e.settlement);
      if (!city) return fail(`${A}欲迁都,然其城尚未建起`, '那一年还没有这座城');
      if (dead(e.a)) return fail(`欲令${A}迁都${city},然${A}已亡`, `那一年${A}已亡`);
      if (e.b === -2) return fail(`${A}欲迁都${city},然${city}已毁`, `那一年${city}已毁`);
      if (e.b !== e.a) {
        return e.b >= 0
          ? fail(`${A}欲迁都${city},然${city}属${B}`, `${city}那时属${B},不在本国国土里`)
          : fail(`${A}欲迁都${city},然${city}不在${A}境内`, `${city}那时不在本国国土里`);
      }
      const n = next();
      if (!(n && n.kind === 'capital' && n.a === e.a && n.war < 0)) return done(`${city}本为${A}国都`);
      const p = polityOf(civ, e.a);
      const old = p ? cityName(civ, capitalBefore(p, y)) : '';
      return done(`${A}${old && old !== city ? `自${old}` : ''}迁都${city}`);
    }
    default:
      return done(A);
  }
}

/** 这条史事(立国的 found、迁都的 capital)是紧跟在干预后面、由它引起的:编年史并进干预那一条,不另列 */
function foldedIntoIntervene(civ: Civ, i: number): boolean {
  const e = civ.annals[i];
  const d = civ.annals[i - 1];
  if (!d || d.kind !== 'intervene' || d.year !== e.year || d.a !== e.a) return false;
  const kind = civ.interventions?.[d.war]?.kind;
  return (e.kind === 'found' && kind === 'found') || (e.kind === 'capital' && e.war < 0 && kind === 'move');
}

/**
 * 第 i 条干预(Civ.interventions 的下标)在这份历史里的结果(界面上的干预列表用):
 * annal = 它那条史事 intervene 的下标(没记 = −1:国家键指不到,原因由调用方按键说);ok = 生效了;why = 没生效的原因
 */
export function interventionOutcome(civ: Civ, i: number): { annal: number; ok: boolean; why?: string } {
  const A = civ.annals;
  for (let k = 0; k < A.length; k++) {
    if (A[k].kind !== 'intervene' || A[k].war !== i) continue;
    const r = interveneStory(civ, A[k], k);
    return { annal: k, ok: r.ok, why: r.why };
  }
  return { annal: -1, ok: false };
}

function simpleEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  switch (e.kind) {
    case 'found': {
      const city = cityName(civ, e.settlement);
      const where = city || regionName(civ, e.region);
      // 大国立国是大事;后来没长成大国的(小国、部落)只在"全部"里
      const imp = isGreat(polityOf(civ, e.a)) ? 3 : 2;
      return base(e, id, `${pn(civ, e.a, y)}立国${where ? `,都于${where}` : ''}`, imp, [e.a], [e.region]);
    }
    case 'rank':
      return rankEntry(ctx, e, id);
    case 'war':
      // 援盟(阶段 4 干预的结盟):settlement 列是盟国,不是城
      if (e.settlement >= 0) {
        return { ...base(e, id, `${pn(civ, e.a, y)}应${pn(civ, e.settlement, y)}之约,起兵伐${pn(civ, e.b, y)}`, 2, [e.a, e.b, e.settlement], []), settlement: -1 };
      }
      return base(e, id, `${pn(civ, e.a, y)}起兵伐${pn(civ, e.b, y)}`, 2, [e.a, e.b], []);
    case 'conquer':
      return base(e, id, conquerText(civ, e, undefined, ctx.retake.has(id)), e.b >= 0 ? 2 : 1, [e.a, e.b], [e.region]);
    case 'peace':
      return base(e, id, `${pn(civ, e.a, y)}与${pn(civ, e.b, y)}议和`, 2, [e.a, e.b], []);
    case 'fall':
      // 亡于战争的,"大事"里由那场战争说("…,昌国亡");不在战争里土崩瓦解的,大国是大事,小国、部落是小事
      return base(e, id, fallText(civ, e), e.war < 0 && isGreat(polityOf(civ, e.a)) ? 3 : 2, [e.a, e.b], [e.region]);
    case 'capital': {
      // 主动迁都(被迫迁都折进战争,见 warEntry):帝国级的是大事
      const p = polityOf(civ, e.a);
      const old = p ? cityName(civ, capitalBefore(p, y)) : '';
      const now = cityName(civ, e.settlement) || regionName(civ, e.region);
      const text = now
        ? `${pn(civ, e.a, y)}${old && old !== now ? `自${old}` : ''}迁都${now}`
        : `${pn(civ, e.a, y)}迁都`;
      return base(e, id, text, p && polityTierAt(p, y) >= CAPITAL_TIER ? 3 : 2, [e.a], [e.region]);
    }
    case 'split': {
      const A = pn(civ, e.a, y);
      const r = regionName(civ, e.region);
      const fallen = polityOf(civ, polityOf(civ, e.a)?.restores ?? -1);
      let t: string;
      if (fallen) {
        // 复国:"故昌遗民据瑞州起兵,脱大渭复国,号后昌国"
        // 故国改朝换代过的,称它亡国时那一朝的国号("故景遗民")
        const who = `故${(fallen.name && polityRootAt(fallen, fallen.ended ?? y)) || '国'}遗民${r ? `据${r}` : ''}`;
        t = e.b >= 0 ? `${who}起兵,脱${pn(civ, e.b, y)}复国,号${A}` : `${who}复国,号${A}`;
      } else if (e.b >= 0) t = r ? `${r}叛${pn(civ, e.b, y)}自立,号${A}` : `${A}脱离${pn(civ, e.b, y)}自立`;
      else t = r ? `${r}自立,号${A}` : `${A}自立`;
      const city = cityName(civ, e.settlement);
      if (city) t += `,都于${city}`;
      // 分出来(复国)以后长成大国的、复的是大国的是大事;小国分分合合只在"全部"里
      // (日后在"大事"里出现时,名字后面带一句来历,见 introduce)
      const imp = isGreat(polityOf(civ, e.a)) ? 3 : 2;
      return base(e, id, t, imp, [e.a, e.b], [e.region], fallen ? '复' : '分');
    }
    case 'merge': {
      // 并掉的是大国才是大事
      const t = e.b >= 0 ? `${pn(civ, e.b, y)}并入${pn(civ, e.a, y)}` : `${pn(civ, e.a, y)}并吞邻邦`;
      return base(e, id, t, isGreat(polityOf(civ, e.b)) ? 3 : 2, [e.a, e.b], []);
    }
    case 'dynasty': {
      // 东方帝国级的国家改朝换代(换国号,地图上的国名跟着变)是大事;西幻的王室更迭国名不变,小一些的国家的也不算
      // (换了的国号日后在"大事"里出现时带一句"原某国",见 introduce)
      const p = polityOf(civ, e.a);
      const imp = p && p.eastern && polityTierAt(p, y) >= DYNASTY_TIER ? 3 : 2;
      return base(e, id, dynastyText(civ, e), imp, [e.a], [e.region]);
    }
    case 'sack':
      return base(e, id, sackText(civ, e), 2, [e.a, e.b], [e.region]);
    case 'ruin': {
      // 大城(或国都)被毁是大事,"大事"里由那场战争说("…,毁汾城",和亡国一样不重复);城被毁在"全部"里;村镇被毁是小事
      const imp = ruinImportance(civ, e);
      return base(e, id, ruinText(civ, e), e.war >= 0 ? (Math.min(imp, 2) as Importance) : imp, [e.a, e.b], [e.region]);
    }
    case 'rebuild': {
      const old = civ.settlements[e.settlement]?.rebuilds;
      const imp = old !== undefined && civ.settlements[old]?.ended !== undefined && rankBefore(civ, old, civ.settlements[old].ended!) >= 2 ? 2 : 1;
      return base(e, id, rebuildText(civ, e), imp, [e.a], [e.region]);
    }
    case 'decline':
      return base(e, id, declineText(civ, e), 2, [e.a], [e.region]);
    case 'vanish': {
      // 民族消亡:"乌耐族亡,最后的瑞州亦为渭人"
      const r = regionName(civ, e.region);
      const t = e.b >= 0 && r ? `${cn(civ, e.a)}亡,最后的${r}亦为${folk(civ, e.b)}` : `${cn(civ, e.a)}亡`;
      return { ...base(e, id, t, 3, [], [e.region]), settlement: -1 };
    }
    case 'assimilate':
      return assimChild(civ, e, id);
    case 'migrate':
      return migrateChild(civ, e, id, false);
    case 'intervene':
      return base(e, id, interveneStory(civ, e, id).text, 3, [e.a, e.b], [e.region]);
    default:
      return base(e, id, `${pn(civ, e.a, y)}有事`, 1, [e.a], []);
  }
}

// ---------------------------------------------------------------------------
// 战争:折叠成一条

function warEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const list = ids.map((i) => A[i]);
  const decl = list.find((e) => e.kind === 'war') ?? list[0];
  const atk = decl.a;
  const def = decl.b;
  const start = list[0].year;
  // 净得失:每一州最早的原主、最后是谁打下来的
  const firstOwner = new Map<number, number>();
  const lastBy = new Map<number, number>();
  const fought: number[] = [];
  for (const e of list) {
    if (e.kind !== 'conquer' || e.region < 0) continue;
    if (!firstOwner.has(e.region)) {
      firstOwner.set(e.region, e.b);
      fought.push(e.region);
    }
    lastBy.set(e.region, e.a);
  }
  const gained = (side: number) => fought.filter((r) => lastBy.get(r) === side && firstOwner.get(r) !== side);
  const gainA = gained(atk);
  const gainD = def >= 0 ? gained(def) : [];
  const falls = list.filter((e) => e.kind === 'fall');
  // 被迫迁都(国都失守),按国家分:这场战争里亡了的不再说迁都
  const moves = new Map<number, Annal[]>();
  for (const e of list) {
    if (e.kind !== 'capital' || falls.some((f) => f.a === e.a)) continue;
    let m = moves.get(e.a);
    if (!m) moves.set(e.a, (m = []));
    m.push(e);
  }
  const peace = [...list].reverse().find((e) => e.kind === 'peace');
  const lastYear = list[list.length - 1].year;
  const over = !!peace || falls.some((f) => f.a === atk || f.a === def);
  const end = over ? (peace ? peace.year : lastYear) : Math.max(lastYear, civ.endYear);

  // 子条目:洗劫、毁城在史事里记在攻占前面(同一刻),这里排回那条攻占后面
  const order: number[] = [];
  let held: number[] = [];
  for (const i of ids) {
    const e = A[i];
    if (e.kind === 'sack' || e.kind === 'ruin') {
      held.push(i);
      continue;
    }
    order.push(i);
    if (e.kind === 'conquer' && held.length) {
      order.push(...held.filter((j) => A[j].region === e.region));
      held = held.filter((j) => A[j].region !== e.region);
    }
  }
  order.push(...held);
  // 不是打下来的攻占:议和时划界割让的(peace 的 region = 紧挨在它前面的几条)、丢了国都撑不下去残部一并归攻方的
  // (亡国前同一刻连着的几条攻占,第一条是打下国都的那一仗)。各合成一条子条目,不写"攻取"
  const special = new Map<number, 'cede' | 'annex'>();
  for (const i of ids) {
    const e = A[i];
    if (e.kind === 'peace' && e.region > 0) {
      for (let j = Math.max(0, i - e.region); j < i; j++) if (A[j].kind === 'conquer' && A[j].war === e.war) special.set(j, 'cede');
    } else if (e.kind === 'fall') {
      const run: number[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const c = A[j];
        if (c.kind !== 'conquer' || c.war !== e.war || c.year !== e.year || c.a !== e.b || c.b !== e.a) break;
        run.push(j);
      }
      run.pop();
      for (const j of run) special.set(j, 'annex');
    }
  }
  const children: ChronicleEntry[] = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const sp = special.get(i);
    if (!sp) {
      children.push(childEntry(i));
      continue;
    }
    const group = [i];
    while (k + 1 < order.length && special.get(order[k + 1]) === sp) group.push(order[++k]);
    const e = A[i];
    const rs = uniq(group.map((j) => A[j].region));
    let text: string;
    if (sp === 'cede') {
      // "议定疆界,乌绝原等三州划归大渭,雪西划归昌国"
      const to = uniq(group.map((j) => A[j].a));
      text = `议定疆界,${to.map((p) => `${regionList(civ, group.filter((j) => A[j].a === p).map((j) => A[j].region)) || '一州'}划归${pn(civ, p, e.year)}`).join(',')}`;
    } else text = rs.length > 1 ? `余下${regionList(civ, rs)}尽归${pn(civ, e.a, e.year)}` : `余下${regionList(civ, rs) || '一州'}亦归${pn(civ, e.a, e.year)}`;
    const kids = group.map((j) => A[j]);
    children.push({ ...base(e, i, text, 2, kids.flatMap((c) => [c.a, c.b]), rs, sp === 'cede' ? '割' : '占'), settlement: -1 });
  }
  function childEntry(i: number): ChronicleEntry {
    const e = A[i];
    if (e.kind === 'conquer') {
      // 这场战争里被夺走又打回来的,或者以前就是攻方的(议和割让、分裂出去、上一场战争丢掉的)
      const retake = (e.region >= 0 && firstOwner.get(e.region) === e.a) || ctx.retake.has(i);
      return base(e, i, conquerText(civ, e, [atk, def], retake), e.b >= 0 ? 2 : 1, [e.a, e.b], [e.region]);
    }
    if (e.kind === 'peace') {
      const y = e.year;
      const fallen = falls.find((f) => f.year <= y && (f.a === atk || f.a === def));
      // 一方在另一场战争里亡国,这场仗随之结束(见 wars.ts:亡国的国家打着的仗都记一条议和)
      const gone = fallen
        ? -1
        : [atk, def].find((s) => {
            const p = polityOf(civ, s);
            return !!p && p.ended !== undefined && p.ended <= y;
          }) ?? -1;
      let t: string;
      if (fallen) t = `${pn(civ, fallen.a, fallen.year)}既亡,兵戈遂息`;
      else if (gone >= 0) t = `${pn(civ, gone, y)}既亡,兵戈遂息`;
      else {
        t = `${pn(civ, e.a, y)}与${pn(civ, e.b, y)}议和`;
        const ga = gainA.length ? `${e.a === atk ? '' : pn(civ, atk, y)}得${regionList(civ, gainA)}` : '';
        const gd = gainD.length ? `${pn(civ, def, y)}得${regionList(civ, gainD)}` : '';
        if (ga || gd) t += `,${[ga, gd].filter(Boolean).join(';')}`;
        else t += ',疆界如故';
      }
      return base(e, i, t, 2, [e.a, e.b], [...gainA, ...gainD]);
    }
    if (e.kind === 'capital') {
      // 被迫迁都:紧跟在"国都某城陷落"那一条攻占后面,只说迁到哪
      const now = cityName(civ, e.settlement) || regionName(civ, e.region);
      return base(e, i, `${pn(civ, e.a, e.year)}${now ? `迁都${now}` : '另立国都'}`, 2, [e.a], [e.region]);
    }
    return simpleEntry(ctx, e, i);
  }

  // 标题:"大渭伐昌,得瑞州等五州";攻方先得后失:"得瑞州等三州而失雪西"(只有攻方的得失不带主语,别的一律点名)
  const parts: string[] = [];
  const got = gainA.length ? `${over ? '' : '已'}得${regionList(civ, gainA)}` : '';
  if (gainD.length) parts.push(`${got ? `${got}而` : '反'}失${regionList(civ, gainD)}`);
  else if (got) parts.push(got);
  // 国都失守:"昌国国都汾城陷落"(不写"昌国失国都",免得和攻方的"失某州"两个"失"说的不是同一方);迁了两次以上:"昌国连迁三都"
  let oldCapital = false;
  for (const [pid, ms] of moves) {
    const p = polityOf(civ, pid);
    if (isGreat(p) && ms.some((e) => capitalHeld(p!, e.year) >= OLD_CAPITAL)) oldCapital = true;
    const who = pn(civ, pid, start);
    if (ms.length >= 2) parts.push(`${who}连迁${ms.length === 2 ? '两' : cnNumber(ms.length)}都`);
    else {
      const lost = p ? cityName(civ, capitalBefore(p, ms[0].year)) : '';
      parts.push(lost ? `${who}国都${lost}陷落` : `${who}国都陷落`);
    }
  }
  for (const f of falls) parts.push(`${pn(civ, f.a, f.year)}亡`);
  // 毁了哪几座城(村镇不说):"毁汾城、瑞城"
  const razed = list.filter((e) => e.kind === 'ruin' && rankBefore(civ, e.settlement, e.year) >= 2).map((e) => cityName(civ, e.settlement));
  if (razed.some(Boolean)) parts.push(`毁${razed.filter(Boolean).slice(0, 2).join('、')}${razed.length > 2 ? '等城' : ''}`);
  if (!over) parts.push('战事未休');
  else if (!parts.length) parts.push('无功而还');
  // 援盟(阶段 4 干预的结盟):"索拉特应大昌之约伐某国"
  const ally = decl.kind === 'war' && decl.settlement >= 0 ? decl.settlement : -1;
  const text = `${pn(civ, atk, start)}${ally >= 0 ? `应${pn(civ, ally, start)}之约` : ''}伐${pn(civ, def, start)},${parts.join(',')}`;
  // 改变格局的战争是大事:灭了大国(或吞并一个像样的国家)、易手很多州、攻下做了很久的国都、两个帝国交兵且有得失
  const A0 = polityOf(civ, atk);
  const D0 = polityOf(civ, def);
  const gains = gainA.length + gainD.length;
  const titans = !!A0 && !!D0 && polityTierAt(A0, start) >= TITAN_TIER && polityTierAt(D0, start) >= TITAN_TIER && gains >= TITAN_WAR;
  const conquest = falls.some((f) => {
    const p = polityOf(civ, f.a);
    // 小国分出去(复国)又被原主收回:分出去那一条只在"全部"里,收回来也不算改变格局(易手很多州的照旧是大事)
    const back = !!p && ctx.splitFrom.get(p.id) === f.b;
    return isGreat(p) || (isState(p) && gains >= FALL_WAR && !back);
  });
  // 毁了大城 / 国都的战争也是大事(毁城那一条单列,但"大事"里由战争说)
  const razedMajor = list.some((e) => e.kind === 'ruin' && ruinImportance(civ, e) >= MAJOR);
  const major = conquest || gains >= BIG_WAR || oldCapital || titans || razedMajor;
  const importance: Importance = major ? 3 : gains > 0 || moves.size > 0 || falls.length > 0 ? 2 : 1;
  const polities = [atk, def];
  for (const e of list) polities.push(e.a, e.b);
  if (ally >= 0) polities.push(ally);
  return {
    id: ids[0],
    kind: 'war',
    year: start,
    end,
    text,
    tag: '战',
    importance,
    polities: uniq(polities),
    regions: fought,
    settlement: -1,
    children,
    ongoing: !over,
  };
}

// ---------------------------------------------------------------------------
// 同化与迁徙(阶段 3):史事的 a、b 是民族,war 列借来记国家

/** 同化的一州:"瑞州的居兰人渐为渭人" */
function assimChild(civ: Civ, e: Annal, id: number): ChronicleEntry {
  const r = regionName(civ, e.region) || '一州';
  return { ...base(e, id, `${r}的${folk(civ, e.b)}渐为${folk(civ, e.a)}`, 1, [e.war], [e.region]), settlement: -1 };
}

/** 随征服而来的移民(起因的国家是迁徙民族自己的国家) */
function isSettlers(civ: Civ, e: Annal): boolean {
  return polityOf(civ, e.war)?.culture === e.a;
}

/** 迁徙的一州:"居兰人迁入疏勒原(原为乌耐人所居)" */
function migrateChild(civ: Civ, e: Annal, id: number, inWave: boolean): ChronicleEntry {
  const r = regionName(civ, e.region) || '一州';
  const verb = isSettlers(civ, e) ? '徙居' : '迁入';
  const was = e.b >= 0 ? `(原为${folk(civ, e.b)}所居)` : '(原为无人之地)';
  return { ...base(e, id, `${folk(civ, e.a)}${verb}${r}${was}`, inWave ? 2 : 1, [e.war], [e.region]), settlement: -1 };
}

/** 迁徙的方位(Culture.migrations 里同一年的那一波;同一年有几波按先后对上) */
function migrationDir(civ: Civ, e: Annal, used: Map<number, number>): MigrationDir | null {
  const list = cultureOf(civ, e.a)?.migrations ?? [];
  const from = used.get(e.a) ?? 0;
  for (let i = from; i < list.length; i++) {
    if (list[i].year === e.year) {
      used.set(e.a, i + 1);
      return list[i].dir;
    }
  }
  return null;
}

/** 随征服南下 / 北上 / 东进 / 西进 */
const ADVANCE: Record<MigrationDir, string> = { 东: '东进', 西: '西进', 南: '南下', 北: '北上' };

/** 一波迁徙(同一刻、同一民族、同一起因)折成一条 */
function migrationEntry(ctx: Ctx, ids: number[], dirUsed: Map<number, number>): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e0 = A[ids[0]];
  const dir = migrationDir(civ, e0, dirUsed);
  const regions = uniq(ids.map((i) => A[i].region));
  const where = regionList(civ, regions) || '他处';
  const who = cn(civ, e0.a);
  let text: string;
  if (isSettlers(civ, e0)) text = `${who}随${pn(civ, e0.war, e0.year)}${dir ? ADVANCE[dir] : '而来'},徙居${where}`;
  else if (e0.war >= 0) {
    text = `${who}避${pn(civ, e0.war, e0.year)}兵锋${dir ? `${dir}迁` : '外迁'},入${where}`;
    ctx.flight.set(ids[0], `${who}${dir ? `${dir}迁` : '外迁'},入${where}`);
  }
  else text = `${who}${dir ? `${dir}迁` : '迁徙'},入${where}`;
  const kids = ids.map((i) => migrateChild(civ, A[i], i, true));
  const importance: Importance = regions.length >= MIGRATE_MAJOR ? 3 : 2;
  return {
    id: ids[0],
    kind: 'migrate',
    year: e0.year,
    end: e0.year,
    text,
    tag: '徙',
    importance,
    polities: uniq([e0.war]),
    regions,
    settlement: -1,
    children: kids.length > 1 ? kids : undefined,
  };
}

/** 同化:同一国治下、同一对民族,相隔不到 ASSIM_GAP 年的折成一段(一段最长 ASSIM_SPAN 年) */
function assimEntries(ctx: Ctx, groups: Map<string, number[]>, out: ChronicleEntry[]) {
  const { civ } = ctx;
  const A = civ.annals;
  for (const ids of groups.values()) {
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const first = A[group[0]];
      const last = A[group[group.length - 1]];
      const regions = uniq(group.map((i) => A[i].region));
      const where = regionList(civ, regions) || '一州';
      const P = polityOf(civ, first.war);
      let text: string;
      if (P && P.culture === first.b) text = `${pn(civ, first.war, first.year)}的${folk(civ, first.b)}渐染${cultureOf(civ, first.a)?.name ?? '异族'}俗,${where}渐为${folk(civ, first.a)}`;
      else if (P) text = `${pn(civ, first.war, first.year)}治下,${where}的${folk(civ, first.b)}渐为${folk(civ, first.a)}`;
      else text = `${where}的${folk(civ, first.b)}渐为${folk(civ, first.a)}`;
      const importance: Importance = regions.length >= ASSIM_MAJOR ? 3 : regions.length >= ASSIM_MINOR ? 2 : 1;
      const kids = group.map((i) => assimChild(civ, A[i], i));
      out.push({
        id: group[0],
        kind: 'assimilate',
        year: first.year,
        end: last.year,
        text,
        tag: '化',
        importance,
        polities: uniq([first.war]),
        regions,
        settlement: -1,
        children: kids.length > 1 ? kids : undefined,
      });
      group = [];
    };
    for (const i of ids) {
      if (group.length && (A[i].year - A[group[group.length - 1]].year > ASSIM_GAP || A[i].year - A[group[0]].year > ASSIM_SPAN)) flush();
      group.push(i);
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// 收服部落:同一国接连几次折叠成一条

function tribalEntries(ctx: Ctx, byPolity: Map<number, number[]>, out: ChronicleEntry[]) {
  const { civ } = ctx;
  const A = civ.annals;
  for (const [pid, ids] of byPolity) {
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const kids = group.map((i) => simpleEntry(ctx, A[i], i));
      if (kids.length === 1) out.push(kids[0]);
      else {
        const first = A[group[0]];
        const last = A[group[group.length - 1]];
        const regions = uniq(group.map((i) => A[i].region));
        out.push({
          id: group[0],
          kind: 'conquer',
          year: first.year,
          end: last.year,
          text: `${pn(civ, pid, first.year)}征服${regionList(civ, regions)}诸部`,
          tag: '征',
          importance: 1,
          polities: [pid],
          regions,
          settlement: -1,
          children: kids,
        });
      }
      group = [];
    };
    for (const i of ids) {
      if (group.length && (A[i].year - A[group[group.length - 1]].year > TRIBAL_GAP || A[i].year - A[group[0]].year > TRIBAL_SPAN)) {
        flush();
      }
      group.push(i);
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// "大事"里合写:同一国家短时间里连着的几件大事,后一件写进前一件里,"大事"里不再单占一行("全部"里照旧单列)

/** 前一件事之后这么多年以内的,合写进前一件 */
export const COMBINE_GAP = 10;

/** 合写:返回"哪一条里说了哪几国的来历"(合写进改朝换代那一条的分裂) */
function combine(ctx: Ctx, list: ChronicleEntry[]): Map<ChronicleEntry, number> {
  const told = new Map<ChronicleEntry, number>();
  const { civ } = ctx;
  const A = civ.annals;
  const later = (n: number) => (n >= 1 ? `${cnNumber(n)}年后` : '同年');
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (e.importance < MAJOR) continue;
    // 改朝换代之后不久就有州叛离:"…国号大辰;七年后喀勒川叛大辰王朝自立,号库兹汗国"
    if (e.kind === 'split' && e.polities.length > 1) {
      const from = e.polities[1];
      let d: ChronicleEntry | undefined;
      for (let j = k - 1; j >= 0 && e.year - list[j].year <= COMBINE_GAP; j--) {
        const x = list[j];
        if (x.kind === 'dynasty' && x.importance >= MAJOR && x.polities[0] === from) {
          d = x;
          break;
        }
      }
      if (d) {
        d.text += `;${later(Math.floor(e.year) - Math.floor(d.year))}${e.text}`;
        d.polities = uniq([...d.polities, ...e.polities]);
        d.regions = uniq([...d.regions, ...e.regions]);
        e.importance = 2;
        told.set(d, e.polities[0]);
      }
    }
    // 亡国(失地)之后逃难的一波迁徙:"…,艾莱斯国亡,艾莱斯族南迁,入阿拉斯等五州"
    const short = e.kind === 'migrate' ? ctx.flight.get(e.id) : undefined;
    if (short) {
      const by = A[e.id].war;
      const folk = A[e.id].a;
      let w: ChronicleEntry | undefined;
      for (let j = k - 1; j >= 0; j--) {
        const x = list[j];
        if (x.kind !== 'war' || x.importance < MAJOR || e.year - x.end > COMBINE_GAP || e.year < x.year) continue;
        const [a, b] = x.polities;
        const other = a === by ? b : b === by ? a : -1;
        if (other >= 0 && polityOf(civ, other)?.culture === folk) {
          w = x;
          break;
        }
      }
      if (w) {
        w.text += `,${short}`;
        w.regions = uniq([...w.regions, ...e.regions]);
        e.importance = 2;
      }
    }
  }
  return told;
}

// ---------------------------------------------------------------------------
// "大事"里的来历:只看大事时,第一次出现、来历没说过的国家带一句来历

/**
 * 改了国号的国家,旧国号 root 那一朝最后一刻(改朝换代的前一刻)的全称,和到 year 年为止又改了几次:
 * "原居兰汗国"、"原居兰汗国,两度易代"。找不到 = "原" + root
 */
function renamedFrom(p: Polity, root: string, year: Year): string {
  const d = p.dynasties ?? [];
  const now = dynastyIndexAt(p, year);
  for (let i = Math.min(now, d.length - 1); i >= 1; i--) {
    if (polityRootAt(p, d[i - 1].year) !== root) continue;
    const n = now - i + 1;
    return `原${polityName(p, d[i].year - 1 / 512)}${n >= 2 ? `,${n === 2 ? '两' : cnNumber(n)}度易代` : ''}`;
  }
  return `原${root}`;
}

/** 这个国家在 year 年可能写进纪事里的名字(四档全称 + 简称;长的在前) */
function namesOf(p: Polity, year: Year): string[] {
  const out = new Set<string>(polityTitles(p, year));
  for (let t = 0; t < 4; t++) out.add(polityShortTitle(p, t, year));
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** 名字在正文里第一次出现的位置(不算嵌在别国名字里的:"后高弥汗国"里的"高弥汗国");没有 = null */
function firstMention(text: string, mine: string[], others: string[]): { at: number; len: number } | null {
  const spans: [number, number][] = [];
  for (const n of others) for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) spans.push([i, i + n.length]);
  let best: { at: number; len: number } | null = null;
  for (const n of mine) {
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
      const end = i + n.length;
      if (spans.some(([s, e]) => s <= i && e >= end && e - s > n.length)) continue;
      if (!best || i < best.at || (i === best.at && n.length > best.len)) best = { at: i, len: n.length };
      break;
    }
  }
  return best;
}

/**
 * 只看"大事"也读得懂:按先后翻大事,每个国家第一次出现、它的来历(立国 / 分裂 / 复国)不在大事里的,名字后面带一句来历:
 * "艾莱斯国(第 1850 年立国)"、"塔提特汗国(第 2082 年叛哈尔提亚王国自立)"、"新塔提特汗国(第 2455 年脱哈尔提亚帝国复国)";
 * 改朝换代换了国号(东方小一些的国家改朝换代不是大事)、新国号在大事里第一次出现的:"伊罗汗国(原居兰汗国)"。
 * 只改大事的正文(全部里也是这一条,多一句来历不碍事)
 */
function introduce(civ: Civ, list: ChronicleEntry[], told: ReadonlyMap<ChronicleEntry, number>): void {
  const A = civ.annals;
  // 每个国家的来历(立国 / 分裂 / 复国那条史事)
  const origin = new Map<number, Annal>();
  for (const e of A) if ((e.kind === 'found' || e.kind === 'split') && e.a >= 0 && !origin.has(e.a)) origin.set(e.a, e);
  /** 国家 → 大事里最近一次出现时的国号词根 */
  const shown = new Map<number, string>();
  for (const e of list) {
    if (e.importance < MAJOR) continue;
    const y = e.year;
    const pids = e.polities.filter((id) => polityOf(civ, id));
    // 立国、分裂、复国这一条本身就是来历(干预"立国"那一条也是)
    const founding = e.kind === 'found' || e.kind === 'split' || (e.kind === 'intervene' && civ.interventions?.[A[e.id]?.war]?.kind === 'found');
    if (founding && pids.length) shown.set(pids[0], polityRootAt(civ.polities[pids[0]], y));
    const also = told.get(e);
    if (also !== undefined && polityOf(civ, also)) shown.set(also, polityRootAt(civ.polities[also], y));
    const names = new Map<number, string[]>();
    const nameAt = (id: number) => {
      let n = names.get(id);
      if (!n) {
        const p = civ.polities[id];
        // 改朝换代这一条写的是旧朝的国号("大昌享国 312 年而亡")
        n = e.kind === 'dynasty' && id === pids[0] ? namesOf(p, y - 1 / 512) : namesOf(p, y);
        names.set(id, n);
      }
      return n;
    };
    // 位置都按原文找(不在加进去的来历里找),最后从后往前插
    const inserts: { at: number; note: string }[] = [];
    for (const id of pids) {
      const p = civ.polities[id];
      // 只管正文里写到的(战争的子条目里才有的第三国不算出现过)
      const m = firstMention(e.text, nameAt(id), pids.filter((x) => x !== id).flatMap(nameAt));
      if (!m) continue;
      // 改朝换代这一条写的是旧朝的国号:按前一刻算
      const at = e.kind === 'dynasty' && id === pids[0] ? y - 1 / 512 : y;
      const root = polityRootAt(p, at);
      const was = shown.get(id);
      let note = '';
      if (was === undefined) {
        const o = origin.get(id);
        if (o) {
          const oy = o.year;
          if (o.kind === 'found') note = `第 ${Math.floor(oy)} 年立国`;
          else if (p.restores !== undefined) note = o.b >= 0 ? `第 ${Math.floor(oy)} 年脱${pn(civ, o.b, oy)}复国` : `第 ${Math.floor(oy)} 年复国`;
          else note = o.b >= 0 ? `第 ${Math.floor(oy)} 年叛${pn(civ, o.b, oy)}自立` : `第 ${Math.floor(oy)} 年自立`;
          const first = polityRootAt(p, oy);
          if (first !== root) note += `,${renamedFrom(p, first, at)}`;
        }
      } else if (was !== root) note = renamedFrom(p, was, at);
      if (note) inserts.push({ at: m.at + m.len, note });
      shown.set(id, e.kind === 'dynasty' && id === pids[0] ? polityRootAt(p, y) : root);
    }
    inserts.sort((a, b) => b.at - a.at);
    for (const { at, note } of inserts) e.text = `${e.text.slice(0, at)}(${note})${e.text.slice(at)}`;
  }
}

// ---------------------------------------------------------------------------

const cache = new WeakMap<Civ, ChronicleEntry[]>();

/** civ.annals → 编年史条目(按年份排好;同一年按发生先后)。按 civ 缓存 */
export function buildChronicle(civ: Civ): ChronicleEntry[] {
  const hit = cache.get(civ);
  if (hit) return hit;
  const A = civ.annals ?? [];
  const splitFrom = new Map<number, number>();
  for (const e of A) if (e.kind === 'split' && e.a >= 0 && e.b >= 0) splitFrom.set(e.a, e.b);
  const ctx: Ctx = { civ, titleUsed: new Map(), retake: retakes(A), splitFrom, flight: new Map() };
  const out: ChronicleEntry[] = [];
  const wars = new Map<number, number[]>();
  const tribal = new Map<number, number[]>();
  // 同化与迁徙:一波迁徙(同一刻、同一民族、同一起因);同一国治下同一对民族的同化
  const waves = new Map<string, number[]>();
  const assim = new Map<string, number[]>();
  // 分裂出来的国家不再记"立国";并入别国的不再记"瓦解"(合并那条已经说了)
  const splitOf = new Set<number>();
  const mergedAt = new Set<string>();
  for (const e of A) {
    if (e.kind === 'split' && e.a >= 0) splitOf.add(e.a);
    if (e.kind === 'merge' && e.b >= 0) mergedAt.add(`${e.b}|${e.year}`);
  }
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    // 被迫迁都(capital 带战争编号)、洗劫、毁城(阶段 3 城市兴衰)也折进那场战争
    const inWar =
      e.war >= 0 &&
      (e.kind === 'war' || e.kind === 'conquer' || e.kind === 'peace' || e.kind === 'fall' || e.kind === 'capital' || e.kind === 'sack' || e.kind === 'ruin');
    if (inWar) {
      let g = wars.get(e.war);
      if (!g) wars.set(e.war, (g = []));
      g.push(i);
      // 亡国、毁城另列一条(下面照常处理)
      if (e.kind !== 'fall' && e.kind !== 'ruin') continue;
    }
    if (e.kind === 'found' && splitOf.has(e.a)) continue;
    // 干预引起的立国、迁都并进干预那一条
    if ((e.kind === 'found' || e.kind === 'capital') && foldedIntoIntervene(civ, i)) continue;
    if (e.kind === 'fall' && e.b < 0 && mergedAt.has(`${e.a}|${e.year}`)) continue;
    if (e.kind === 'conquer' && e.b < 0 && e.a >= 0) {
      let g = tribal.get(e.a);
      if (!g) tribal.set(e.a, (g = []));
      g.push(i);
      continue;
    }
    if (e.kind === 'migrate' || e.kind === 'assimilate') {
      const map = e.kind === 'migrate' ? waves : assim;
      const key = e.kind === 'migrate' ? `${e.year}|${e.a}|${e.war}` : `${e.a}|${e.b}|${e.war}`;
      let g = map.get(key);
      if (!g) map.set(key, (g = []));
      g.push(i);
      continue;
    }
    out.push(simpleEntry(ctx, e, i));
  }
  for (const ids of wars.values()) out.push(warEntry(ctx, ids));
  tribalEntries(ctx, tribal, out);
  const dirUsed = new Map<number, number>();
  for (const ids of waves.values()) out.push(migrationEntry(ctx, ids, dirUsed));
  assimEntries(ctx, assim, out);
  out.sort((a, b) => a.year - b.year || a.id - b.id);
  introduce(civ, out, combine(ctx, out));
  cache.set(civ, out);
  return out;
}

export interface ChronicleFilter {
  /** 只看大事(重要度 ≥ MAJOR) */
  major?: boolean;
  /** 只看和这个国家有关的(null / 不给 = 全部国家) */
  polity?: number | null;
}

/** 这一条和某国有关(折叠条目:它自己或任一子条目) */
export function entryInvolves(e: ChronicleEntry, polity: number): boolean {
  return e.polities.includes(polity) || !!e.children?.some((c) => c.polities.includes(polity));
}

/** 按"大事 / 全部"、国家筛选(保持顺序) */
export function filterChronicle(entries: readonly ChronicleEntry[], f: ChronicleFilter): ChronicleEntry[] {
  const pol = f.polity ?? null;
  return entries.filter((e) => (!f.major || e.importance >= MAJOR) && (pol === null || entryInvolves(e, pol)));
}

/** 纯文本(复制给 OC 作者写设定用):一条一行,折叠条目的子条目缩进列在下面 */
export function chronicleText(entries: readonly ChronicleEntry[], title?: string): string {
  const lines: string[] = [];
  if (title) lines.push(title, '');
  for (const e of entries) {
    lines.push(`${entryYearLabel(e)} ${e.text}`);
    for (const c of e.children ?? []) lines.push(`    ${yearText(c.year)} ${c.text}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 导出(阶段 4):整本编年史写成 Markdown / 纯文本文件,给 OC 作者拿去写设定

/** 导出时一个时代(一节)多少年:整段历史分成五到八节 */
export function chronicleEraYears(endYear: Year): number {
  const want = Math.max(1, endYear) / 6;
  return [50, 100, 200, 250, 500, 1000, 2000].find((n) => n >= want) ?? 5000;
}

export interface ChronicleDocOptions {
  format: 'md' | 'txt';
  /** 标题里的世界种子 */
  seed: number;
  /** 和默认值不同的世界参数(一句话,可选;同一种子 + 参数 = 同一个世界) */
  params?: string;
  /** 一节多少年;不给按 chronicleEraYears */
  eraYears?: number;
}

/** Markdown 里有特殊含义的几个符号前面加反斜杠(纪事是中文,一般用不到,防个万一) */
function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

/**
 * 整本编年史:标题带种子和年份范围;先"大事"(一页简史,按时代分节,不列战争里的每一件事),
 * 再"全部纪事"(按时代分节,战争等折叠条目的每一件事缩进列在下面)。同一个 civ 永远得到同样的文字。
 */
export function chronicleDocument(civ: Civ, opt: ChronicleDocOptions): string {
  const md = opt.format === 'md';
  const all = buildChronicle(civ);
  const majors = filterChronicle(all, { major: true });
  const end = Math.floor(civ.endYear);
  const span = Math.max(1, Math.floor(opt.eraYears ?? chronicleEraYears(civ.endYear)));
  const title = `编年史 · 种子 ${opt.seed} · 第 0—${end} 年`;
  const esc = md ? mdEscape : (s: string) => s;
  const out: string[] = [];
  out.push(md ? `# ${esc(title)}` : title, '');
  const about = all.length
    ? `「文明与地图」推演生成。大事 ${majors.length} 条(一页简史);全部 ${all.length} 条(每一次攻占、洗劫、同化、迁徙都在)。`
    : '「文明与地图」推演生成。这颗星球上没有文明兴起,编年史是空的。';
  const params = opt.params ? `世界参数:${opt.params}(同一种子 + 参数 = 同一个世界)` : '同一种子 + 默认参数 = 同一个世界。';
  if (md) out.push(`> ${esc(about)}  `, `> ${esc(params)}`, '');
  else out.push(about, params, '');

  // 最后一节包含结束年份(三千年:第 2500—3000 年,不单开一节"第 3000—3000 年")
  const lastEra = Math.max(0, Math.ceil(end / span) - 1);
  const eraOf = (y: Year) => Math.min(Math.floor(Math.max(0, y) / span), lastEra);
  const eraTitle = (i: number) => `第 ${i * span}—${i === lastEra ? end : (i + 1) * span - 1} 年`;
  const section = (name: string, list: readonly ChronicleEntry[], children: boolean) => {
    out.push(md ? `## ${name}` : `════ ${name} ════`, '');
    if (!list.length) out.push('(无)', '');
    let era = -1;
    for (const e of list) {
      const i = eraOf(e.year);
      if (i !== era) {
        if (era >= 0) out.push('');
        era = i;
        out.push(md ? `### ${eraTitle(i)}` : `【${eraTitle(i)}】`, '');
      }
      out.push(md ? `- **${entryYearLabel(e)}** ${esc(e.text)}` : `${entryYearLabel(e)} ${e.text}`);
      if (children) for (const c of e.children ?? []) out.push(md ? `  - ${yearText(c.year)} ${esc(c.text)}` : `    ${yearText(c.year)} ${c.text}`);
    }
    out.push('');
  };
  if (all.length) {
    section('大事', majors, false);
    section('全部纪事', all, true);
  }
  return out.join('\n');
}

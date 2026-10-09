/**
 * 人名生成器:君主、统帅的名字,和地名用同一套语感。
 *
 * - western 族:先拼拉丁拟音(词根 + 可选中间音节 + 词尾),再落成西域译名式汉字(疏勒王一类的音译名)。
 * - eastern 族:关陇是"姓 + 名";边塞 / 河西是西域音译式的名(两三个字);奇国是上古式的两字名。
 *
 * 按键取:同一个 seed + 语感 + 用途 + 键 → 同一个名字,和调用先后无关(键 = 国家的位置锚、第几位……,见 gen/civ/people.ts)。
 * 不查重:调用方自己挑(同一朝的君主不重名时换下一个键)。
 *
 * 人名只在编年史、面板里出现,不上地图:这个文件的字不收进地图字体的字表(见 scripts/lib/charset.ts)。
 * 纯计算,不碰 DOM;随机数来自 subSeed(seed, 'persons:风格')。
 */
import { mulberry32, subSeed, type Rng } from '../util';
import { WESTERN_STYLES } from './western';
import { transcribe, type TranscribeOptions } from './transcribe';
import { latinBlocked, zhBlocked } from './filters';
import { list, parts, pick, wpick, type Part, type Weighted } from './spec';

export interface PersonNamer {
  readonly style: string;
  readonly family: 'western' | 'eastern';
  /** 这种语感的人名带不带姓(中原、仙侠带;边塞、山海、西幻不带) */
  readonly surnamed: boolean;
  /** 姓;不带姓的语感 = 空串 */
  surname(...key: number[]): string;
  /** 名(带姓的语感不含姓) */
  given(...key: number[]): string;
}

// ---------------------------------------------------------------------------
// 西幻:拉丁原形 + 音译

interface WesternPersonStyle {
  stems: Part[];
  mids: Part[];
  /** 插中间音节的概率 */
  mid: number;
  ends: Weighted<Part>[];
}

/** 各语感的人名构词表(自拟音译音节,不照搬真实名人) */
const WESTERN_PERSONS: Record<string, WesternPersonStyle> = {
  imperial: {
    stems: list('an=安 xi=息 da=大 xia=夏 li=黎 zhi=支 ju=居 kang=康'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('xi=息:2 xia=夏:1 zhi=支:2 ju=居:2 lu=禄:1 mi=弥:1'),
  },
  kingdom: {
    stems: list('shu=疏 wen=温 gu=姑 yu=于 wei=尉 qu=渠 jing=精 lou=楼 yi=伊 bi=卑'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('le=勒:2 ci=兹:2 su=宿:1 mo=末:1 lan=兰:1 li=犁:1 zhi=支:1'),
  },
  nordic: {
    stems: list('jian=坚 ding=丁 hu=呼 gu=骨 hun=浑 he=贺 mo=莫 yan=延'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('kun=昆:2 ling=零:1 lu=禄:2 hun=浑:1 li=利:1 tuo=陀:1'),
  },
  slavic: {
    stems: list('kang=康 an=安 shi=石 mu=穆 mi=米 he=何 luo=罗'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('ju=居:2 mi=密:2 lu=禄:2 luo=罗:1 ye=耶:1'),
  },
  hellenic: {
    stems: list('da=大 li=黎 qin=秦 an=安 du=都 si=斯'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('qin=秦:1 xuan=轩:2 si=斯:2 du=都:1 luo=罗:1'),
  },
  desert: {
    stems: list('sa=撒 mo=末 luo=逻 bu=布 ha=哈 ka=喀 za=扎'),
    mids: list('- a='),
    mid: 0.1,
    ends: parts('mo=末:2 mi=密:2 la=拉:1 ha=哈:1 si=斯:1'),
  },
  steppe: {
    stems: list('bat=巴 tog=托 kub=库 men=门 bor=博 kai=凯 tem=铁 tol=托 bek=别 gu=骨 he=贺'),
    mids: list('a= u='),
    mid: 0.15,
    ends: parts('u:1 ul=兀:1 lu=禄:3 ai=艾:1 ar=尔:1 an=安:1 dai=歹:1 tur=突:1'),
  },
  elven: {
    stems: list('yu=于 pi=毗 sha=沙 ni=尼 ju=拘 mi=弥 tuo=陀 bo=钵'),
    mids: list('-'),
    mid: 0.05,
    ends: parts('mi=弥:2 sha=沙:2 luo=罗:1 ni=尼:1 ye=耶:1 ti=提:1'),
  },
};

/** 他人作品里、现实里太有名的西幻名字(拼出来正好撞上就重抽) */
const WESTERN_FAMOUS = new Set(
  'legolas elrond thranduil galadriel celeborn finrod fingolfin feanor turgon glorfindel elendil isildur aragorn arwen gildor haldir earendil ' +
    'julius augustus tiberius hadrian octavian aurelius maximus marcus brutus alaric attila charlemagne harald ragnar sigurd olaf vladimir ' +
    'yaroslav svyatoslav pericles alexander achilles odysseus leonidas themistocles aristides saladin rashid batu kublai temujin ogedei',
);

const VOW = /[aeiouy]/;

/** 两段拼接:元音相撞去掉前一段末尾的元音,辅音挤成一团插一个元音 */
function join(a: string, b: string, link: string): string {
  if (!b) return a;
  const ae = a[a.length - 1];
  const bs = b[0];
  if (VOW.test(ae) && VOW.test(bs)) return a.slice(0, -1) + b;
  const tail = a.match(/[^aeiouy]*$/)![0];
  const head = b.match(/^[^aeiouy]*/)![0];
  if (tail.length + head.length >= 3) return a + link + b;
  return a + b;
}

/** 拼出来的拉丁串像不像人名:三个元音连写、同元音双写、四个辅音连写都不要 */
function latinShapeOk(l: string): boolean {
  if (/[aeiou]{3}/.test(l)) return false;
  if (/(aa|ii|uu|ee|oo|yy)/.test(l)) return false;
  if (/[^aeiouy]{4}/.test(l)) return false;
  return l.length >= 3;
}

function westernPerson(st: WesternPersonStyle, tr: TranscribeOptions, link: string, r: Rng): string | null {
  const stem = pick(r, st.stems);
  const mid = r() < st.mid ? pick(r, st.mids) : null;
  const end = wpick(r, st.ends);
  const useMid = !!(mid && mid.l);
  const segs = useMid ? [stem, mid!, end] : [stem, end];
  let l = stem.l;
  if (useMid) l = join(l, mid!.l, link);
  l = join(l, end.l, link);
  if (WESTERN_FAMOUS.has(l) || latinBlocked(l)) return null;
  let zh: string;
  if (segs.every((p) => p.zh !== undefined)) {
    zh = segs.map((p) => p.zh!).join('');
  } else {
    if (!latinShapeOk(l)) return null;
    zh = transcribe(l, tr);
  }
  const n = [...zh].length;
  // 西域译名人名两到四字(骨禄、安居弥);过短过长都不要
  if (n < 2 || n > 5 || zhBlocked(zh)) return null;
  return zh;
}

// ---------------------------------------------------------------------------
// 东方:字库组合

interface EasternPersonStyle {
  /** 单姓、复姓(带姓的语感) */
  surnames?: string;
  compound?: string[];
  /** 复姓的机会 */
  compoundChance?: number;
  /** 名:单字名的机会、名的用字 */
  single: number;
  chars: string;
  /** 不带姓的语感:名 = 前字 + 后字(+ 第三字的机会) */
  first?: string;
  third?: number;
  /** 撞上就重抽的现成名字(神话人物等) */
  famous?: string[];
}

const EASTERN_PERSONS: Record<string, EasternPersonStyle> = {
  central: {
    surnames: '李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯董萧程曹袁邓许傅沈彭吕苏卢蒋蔡贾魏薛叶阎潘杜戴夏钟汪田任姜范方石姚谭邹熊陆孔白崔康秦江顾侯邵孟段雷钱汤尹易常乔贺',
    compound: ['司马', '欧阳', '上官', '慕容', '宇文', '长孙', '独孤', '皇甫', '令狐', '尉迟'],
    compoundChance: 0.08,
    single: 0.45,
    chars: '昭恒怀煜晟珩琰瑾璋昱晖熙承弘宏泰康宁靖安定允恪慎谦敬晏曜旻晔炜烨焕桓楷栋渊泓澈涵洵濂浚湛润峻岳崇嵩修仪信俊佑德徽彰显景曦朗明晨昶睿哲彦毅勋骏骥驰鹏翔翊霆霖震鸿晋绍继统绪谟询遥逸远迪琮瑜琛璟钧铉锐镇',
  },
  xianxia: {
    single: 0,
    first: '贺康安石曹米何穆火罗末撒达骨耶勿',
    chars: '密禄特斯浑设延德思居罗耶干连弥提',
    third: 0.3,
  },
  frontier: {
    single: 0,
    first: '阿伊苏尉莫贺骨吐伏拔达支失毕屈沙钵那罗摩提婆迦耶勒斤萨乌车鞠',
    chars: '利达罗那支提斤勒设特毗婆尼斯延陀陵罕密拉兹宿',
    third: 0.35,
  },
  mythic: {
    single: 0,
    first: '少太颛帝共祝后伯仲叔季夸句烛应契稷鸿重羲陶皋玄青白赤',
    chars: '昊顼喾工融羿益夷父龙芒阴鸿皋陶明光华丘翼鸾桑熊虎鹿',
    third: 0,
    famous: ['少昊', '太昊', '帝喾', '共工', '祝融', '后羿', '夸父', '句芒', '烛阴', '伯益', '皋陶', '应龙', '帝俊', '重黎', '太一', '后土'],
  },
};

const chars = (s: string) => [...s];

function easternGiven(st: EasternPersonStyle, r: Rng): string | null {
  let zh: string;
  if (st.first) {
    zh = pick(r, chars(st.first)) + pick(r, chars(st.chars));
    if (r() < (st.third ?? 0)) zh += pick(r, chars(st.chars));
  } else {
    const cs = chars(st.chars);
    zh = pick(r, cs);
    if (r() >= st.single) zh += pick(r, cs);
  }
  const cs = [...zh];
  if (new Set(cs).size !== cs.length) return null;
  if (st.famous?.includes(zh) || zhBlocked(zh)) return null;
  return zh;
}

// ---------------------------------------------------------------------------

/** 32 位整数混合(murmur3 fmix32):把几个整数揉成一个种子 */
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 这几个整数键的随机数发生器(use 区分姓 / 名) */
function keyRng(base: number, use: number, key: number[]): Rng {
  let h = fmix((base ^ Math.imul(use + 1, 0x27d4eb2f)) >>> 0);
  for (const k of key) h = fmix((h ^ Math.imul(k | 0, 0x9e3779b1)) >>> 0);
  return mulberry32(h);
}

/** 抽不出合格的名字时(极少见)的兜底 */
const FALLBACK_WEST = '安居';
const FALLBACK_EAST = '昭';
const TRIES = 60;

/** 有没有这种语感的人名表 */
export function hasPersonStyle(styleId: string): boolean {
  return styleId in WESTERN_PERSONS || styleId in EASTERN_PERSONS;
}

/** 某种语感的人名生成器(不认识的语感按"王国"风) */
export function createPersonNamer(seed: number, styleId: string): PersonNamer {
  const base = subSeed(seed, 'persons:' + styleId);
  const east = EASTERN_PERSONS[styleId];
  if (east) {
    const surnamed = !!east.surnames;
    return {
      style: styleId,
      family: 'eastern',
      surnamed,
      surname(...key) {
        if (!east.surnames) return '';
        const r = keyRng(base, 0, key);
        if (east.compound && r() < (east.compoundChance ?? 0)) return pick(r, east.compound);
        return pick(r, chars(east.surnames));
      },
      given(...key) {
        const r = keyRng(base, 1, key);
        for (let t = 0; t < TRIES; t++) {
          const g = easternGiven(east, r);
          if (g) return g;
        }
        return FALLBACK_EAST;
      },
    };
  }
  const west = WESTERN_PERSONS[styleId] ?? WESTERN_PERSONS.kingdom;
  const ws = WESTERN_STYLES.find((s) => s.id === styleId) ?? WESTERN_STYLES.find((s) => s.id === 'kingdom')!;
  return {
    style: styleId,
    family: 'western',
    surnamed: false,
    surname: () => '',
    given(...key) {
      const r = keyRng(base, 1, key);
      for (let t = 0; t < TRIES; t++) {
        const g = westernPerson(west, ws.tr, ws.link, r);
        if (g) return g;
      }
      return FALLBACK_WEST;
    },
  };
}

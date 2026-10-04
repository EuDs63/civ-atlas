/**
 * 人名生成器:君主、统帅的名字,和地名用同一套语感。
 *
 * - 西幻风:先拼拉丁字母原形(词根 + 可选的中间音节 + 词尾),再按这种语感的译音表转成中文(Aldric → 阿尔德里克)。
 * - 东方风:中原、仙侠是"姓 + 名"(名一两个字);边塞是西域音译式的名(两三个字);山海是上古式的两字名。都不带姓的语感,姓为空串。
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

/** 各语感的人名构词表(词根、中间音节、词尾都是自拟的,不照搬真实的名人、他人作品里的角色) */
const WESTERN_PERSONS: Record<string, WesternPersonStyle> = {
  imperial: {
    stems: list('aur fab flav jul luc marc max oct sev tib val vesp cass corn drus gall hadr quint serv tit aem anton aquil camil clem decim'),
    mids: list('el en ar il in'),
    mid: 0.3,
    ends: parts('ius:4 ian:2 us:2 inus:2 ianus:1 or:1 ens:1'),
  },
  kingdom: {
    stems: list('ald ed wil rich rob hen ger wal gil theo os al ber her gal leo ray rod tris per lan ste bald arn em od'),
    mids: list('er el an'),
    mid: 0.15,
    ends: parts('ric:3 bert:3 win:2 mund:2 ward:2 wald:1 frid:1 an:1 ard:2 gar:1 ulf:1 ain:1 old:1'),
  },
  nordic: {
    stems: list('har sig ulf bjor ragn tor ein gunn ol hal ket arn ing sven vid sten erl hrol as eyv thor'),
    mids: list('e a'),
    mid: 0.1,
    ends: parts('ald:3 urd:2 var:2 ulf:2 mund:1 ar:2 ir:1 grim:1 vald:1 ketil:1 leif:1 dan:1'),
  },
  slavic: {
    stems: list('vlad yaro svyato msti bor rad mir stan bole vela dobro lyub sudi miro rosti ole bogu zdeno vito'),
    mids: list('o e'),
    mid: 0.1,
    ends: parts('slav:5 mir:3 polk:1 dan:1 gost:1 voj:1 bor:1 mil:1'),
  },
  hellenic: {
    stems: list('ari kle the dem nik kal per lys phil hip xan eu ant tim arch dio her pol sos ast meg'),
    mids: list('o a i'),
    mid: 0.25,
    ends: parts('as:2 es:3 on:2 os:2 ides:3 ander:1 ippos:1 kles:2 menes:1 stratos:1 machos:1'),
  },
  desert: {
    stems: list('rash khal sal mus jaf zay tar nas ham kar mah far sul has bas mun qas hak ab wal'),
    mids: list('a i'),
    mid: 0.1,
    ends: parts('id:3 il:2 im:3 an:2 ud:1 ir:2 af:1 un:1 ar:1 ad:1'),
  },
  steppe: {
    stems: list('bat tog kub men ok ar bor kai qut yes tem chag jo ol sub mun bil tol al alt ur bek'),
    mids: list('a u i'),
    mid: 0.1,
    ends: parts('u:3 ul:2 ai:1 ar:2 ei:1 an:2 gul:1 dai:1 tai:1 lun:1 tur:1'),
  },
  elven: {
    stems: list('ael sil thal cael ith mir nim fael lir aer vael ser tir fin eir lith nar len myr sael aen ior'),
    mids: list('a e i an el'),
    mid: 0.3,
    ends: parts('ion:3 iel:2 orin:2 is:1 ar:2 en:1 ethil:1 wyn:1 as:2 andir:1 aen:1 or:2'),
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
  let l = pick(r, st.stems).l;
  if (r() < st.mid) l = join(l, pick(r, st.mids).l, link);
  l = join(l, wpick(r, st.ends).l, link);
  if (!latinShapeOk(l) || WESTERN_FAMOUS.has(l) || latinBlocked(l)) return null;
  const zh = transcribe(l, tr);
  const n = [...zh].length;
  if (n < 3 || n > 6 || zhBlocked(zh)) return null;
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
    compoundChance: 0.06,
    single: 0.45,
    chars: '昭恒怀煜晟珩琰瑾璋昱晖熙承弘宏泰康宁靖安定允恪慎谦敬晏曜旻晔炜烨焕桓楷栋渊泓澈涵洵濂浚湛润峻岳崇嵩修仪信俊佑德徽彰显景曦朗明晨昶睿哲彦毅勋骏骥驰鹏翔翊霆霖震鸿晋绍继统绪谟询遥逸远迪琮瑜琛璟钧铉锐镇',
  },
  xianxia: {
    surnames: '沈叶楚萧苏云白洛凌墨顾夜风林温谢江陆宁柳慕司君景燕裴晏',
    compound: ['慕容', '南宫', '司空', '东方', '上官', '独孤', '端木', '百里'],
    compoundChance: 0.15,
    single: 0.5,
    chars: '玄清尘寒渊霄羽澈墨离辰弦霜夜青冥珏曦霁弈遥衍霆渺沧溟曜烬月星岚雪云风尧泠琅瑶珩璃缈鸾翎昀',
  },
  frontier: {
    single: 0,
    first: '阿伊苏尉莫贺咄骨吐伏拔达支失毕屈沙钵那罗摩提婆迦耶勒斤颉曷萨乌车鞠',
    chars: '苾啜利达罗那支伽提斤勒设特毗婆尼斯延陀陵鞬罕密迦拉',
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
const FALLBACK_WEST = '阿尔德';
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

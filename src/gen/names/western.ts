/**
 * 西幻风:先按每种语感的构词规则拼出拉丁字母原形,再按译音表转成中文。
 *
 * 一个名字 = 词根 + (可选)中间音节 + 词尾;山 / 海 / 河再加通名(山脉 / 海 / 河)。
 * 词尾有两种:普通词尾和词根连在一起转写(ald + oria → 阿尔多里亚);
 * 固定译法的词尾直接接上(caste + ville → 卡斯特 + 维尔,wen + port → 温 + 港)。
 */
import type { Rng } from '../util';
import { transcribe, type TranscribeOptions } from './transcribe';
import { list, parts, pick, wpick, type Candidate, type NameKind, type Part, type Weighted } from './spec';

interface KindRule {
  ends: Weighted<Part>[];
  /** 插中间音节的概率 */
  mid: number;
  /** 这类名字专用的词根(不给就用风格的公共词根) */
  stems?: Part[];
}

export interface WesternStyle {
  id: string;
  label: string;
  desc: string;
  tr: TranscribeOptions;
  stems: Part[];
  mids: Part[];
  /** 辅音挤在一起时插入的连接元音 */
  link: string;
  kinds: Record<NameKind, KindRule>;
  /** 山名用"X山"(而不是"X山脉")的概率 */
  mount?: number;
  /** 意译名(风暴海、龙脊山脉)出现的概率与词库 */
  epithet?: { chance: number; sea: string[]; mountain: string[] };
}

// ---------------------------------------------------------------------------
// 拼接

const VOW = 'aeiouy';
const isVowel = (c: string | undefined) => !!c && VOW.includes(c);
const UNITS = ['th', 'sh', 'ch', 'kh', 'gh', 'ph', 'dh'];

function consUnits(cluster: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < cluster.length; ) {
    const two = cluster.slice(i, i + 2);
    if (UNITS.includes(two)) {
      out.push(two);
      i += 2;
    } else out.push(cluster[i++]);
  }
  return out;
}

const SONOR = new Set(['l', 'r', 'n', 'm', 's']);
const OBSTR_BEFORE_LIQUID = new Set(['b', 'd', 'g', 'k', 'p', 't', 'f', 'v', 'th', 'kh', 'gh']);
const BAD_PAIRS = new Set(['sr', 'sz', 'nm', 'mn', 'ml', 'mr', 'nl', 'lr', 'ms', 'mz', 'ns', 'nz']);
const OK_TRIPLES = new Set(['str', 'spr', 'skr', 'ndr', 'ntr', 'nst', 'rst', 'nsk', 'rsk', 'lsk', 'lst', 'mbr', 'ngr', 'ldr', 'rth', 'nth', 'lth', 'rsh']);

/** 两段拼接处的辅音串读得顺不顺 */
function clusterOk(cluster: string): boolean {
  const u = consUnits(cluster);
  if (u.length <= 1) return true;
  if (u.length === 2) {
    const [x, y] = u;
    if (x === y) return false;
    if (BAD_PAIRS.has(x + y)) return false;
    if (SONOR.has(x)) return true;
    if ((y === 'l' || y === 'r') && OBSTR_BEFORE_LIQUID.has(x) && x + y !== 'dl' && x + y !== 'tl') return true;
    if (['ks', 'ps', 'ft', 'kt', 'pt', 'sv', 'tv', 'dv', 'sk', 'st'].includes(x + y)) return true;
    return false;
  }
  return u.length === 3 && OK_TRIPLES.has(u.join(''));
}

const trailingCons = (s: string) => s.match(/[^aeiouy]*$/)![0];
const leadingCons = (s: string) => s.match(/^[^aeiouy]*/)![0];

interface Seg {
  l: string;
  zh?: string;
}

/** 把 b 接到段序列末尾,处理元音相撞和辅音堆叠;返回 false 表示接不上 */
function append(segs: Seg[], b: Part, link: string): boolean {
  if (!b.l) return true;
  const a = segs[segs.length - 1];
  const nb: Seg = { l: b.l, zh: b.zh };
  if (!a || (a.zh !== undefined && nb.zh !== undefined)) {
    // 两段都是固定译法(草原风的"查干 + 浩特"):词表是挑过的,直接接
    segs.push(nb);
    return true;
  }
  const aEnd = a.l[a.l.length - 1];
  const bStart = nb.l[0];
  if (isVowel(aEnd) && isVowel(bStart)) {
    // 元音相撞:能改哪段就去掉哪段的元音(zor + o + ia → zoria,不是 zoroa)
    if (!a.zh) {
      a.l = a.l.slice(0, -1);
      if (!a.l) segs.pop();
    } else if (!nb.zh && nb.l.length > 1) nb.l = nb.l.slice(1);
  } else if (!isVowel(aEnd) && !isVowel(bStart)) {
    const cl = trailingCons(a.l) + leadingCons(nb.l);
    // 固定译法的词尾(-兰、-维尔)中文不受影响,只在辅音实在太多时才插元音
    const ok = nb.zh !== undefined ? cl.length <= 3 : clusterOk(cl);
    if (!ok) {
      if (!a.zh) a.l += link;
      else if (!nb.zh) nb.l = link + nb.l;
      else return false;
    }
  }
  segs.push(nb);
  return true;
}

function render(segs: Seg[], tr: TranscribeOptions): { latin: string; zh: string } {
  let latin = '';
  let zh = '';
  let pending = '';
  for (const s of segs) {
    latin += s.l;
    if (s.zh === undefined) pending += s.l;
    else {
      if (pending) zh += transcribe(pending, tr);
      pending = '';
      zh += s.zh;
    }
  }
  if (pending) zh += transcribe(pending, tr);
  return { latin: latin[0].toUpperCase() + latin.slice(1), zh };
}

/** 拼好的拉丁串是否像"乱码":三个元音连写、同元音双写、元音太少 */
function latinShapeOk(l: string): boolean {
  const s = l.toLowerCase();
  if (/[aeiou]{3}/.test(s)) return false;
  if (/(aa|ii|uu|ee|oo|yy)/.test(s)) return false;
  if (/[^aeiouy]{4}/.test(s)) return false;
  if (s.includes('nen')) return false; // 译出来是"嫩",不好听
  return true;
}

/** 生成一个词根(不含通名) */
function root(st: WesternStyle, kind: NameKind, rng: Rng): { latin: string; zh: string; gen?: string; tokens: string[] } | null {
  const rule = st.kinds[kind];
  const stem = pick(rng, rule.stems ?? st.stems);
  const segs: Seg[] = [];
  append(segs, stem, st.link);
  const tokens = [stem.l];
  if (rule.mid > 0 && rng() < rule.mid) {
    const mid = pick(rng, st.mids);
    if (!append(segs, mid, st.link)) return null;
    tokens.push(stem.l + mid.l);
  }
  const end = wpick(rng, rule.ends);
  if (!append(segs, end, st.link)) return null;
  const { latin, zh } = render(segs, st.tr);
  if (segs.some((sg) => sg.zh === undefined) && !latinShapeOk(latin)) return null;
  // 太短的读着像中文地名或普通词:"文河""林郡""兰堡""卡拉"
  const len = [...zh].length;
  if (len < 2 || ((end.zh !== undefined || kind === 'state' || kind === 'city' || kind === 'region') && len < 3)) return null;
  return { latin, zh, gen: end.gen ? end.zh : undefined, tokens };
}

const MOUNTAIN_EN = (r: string) => `${r} Mountains`;

export function westernCandidate(st: WesternStyle, kind: NameKind, rng: Rng): Candidate | null {
  const ep = st.epithet;
  if (ep && (kind === 'sea' || kind === 'mountain') && rng() < ep.chance) {
    const [zh, en] = pick(rng, kind === 'sea' ? ep.sea : ep.mountain).split('|');
    const gen = kind === 'sea' ? '海' : zh.endsWith('山脉') ? '山脉' : undefined;
    return { zh, latin: en, generic: gen, tokens: [en] };
  }
  const r = root(st, kind, rng);
  if (!r) return null;
  // 词尾本身就是通名(草原风的 塔格 / 乌拉 / 戈壁):不再加"山脉"
  if (r.gen) return { zh: r.zh, latin: r.latin, generic: r.gen, tokens: r.tokens };
  switch (kind) {
    case 'mountain':
      if (rng() < (st.mount ?? 0.15)) return { zh: r.zh + '山', latin: `Mount ${r.latin}`, generic: '山', tokens: r.tokens };
      return { zh: r.zh + '山脉', latin: MOUNTAIN_EN(r.latin), generic: '山脉', tokens: r.tokens };
    case 'sea':
      return { zh: r.zh + '海', latin: `${r.latin} Sea`, generic: '海', tokens: r.tokens };
    case 'river':
      return { zh: r.zh + '河', latin: `${r.latin} River`, generic: '河', tokens: r.tokens };
    default:
      return { zh: r.zh, latin: r.latin, generic: r.gen, tokens: r.tokens };
  }
}

// ---------------------------------------------------------------------------
// 各语感的构词表

const k = (ends: string, mid = 0, stems?: string): KindRule => ({ ends: parts(ends), mid, stems: stems ? list(stems) : undefined });

/** 西幻共用的意译名:"中文|English"。都是自拟的形容 + 通名,不收真实海名 / 山名和典籍原句 */
const EP_SEA = [
  '风暴海|Sea of Storms', '迷雾海|Sea of Mists', '寂静海|Silent Sea', '晨曦海|Dawn Sea', '暮光海|Twilight Sea',
  '群星海|Sea of Stars', '翡翠海|Emerald Sea', '琥珀海|Amber Sea', '珍珠海|Pearl Sea', '落日海|Sunset Sea',
];
const EP_MOUNTAIN = [
  '龙脊山脉|Dragonspine Mountains', '灰岩山脉|Greystone Mountains', '铁脊山脉|Ironspine Mountains', '白峰山脉|Whitepeak Mountains',
  '雷鸣山脉|Thunder Mountains', '鹰巢山脉|Eyrie Mountains', '断剑山脉|Brokenblade Mountains', '巨人山脉|Giants’ Mountains',
];

export const WESTERN_STYLES: WesternStyle[] = [
  {
    id: 'imperial',
    label: '帝国(拉丁风)',
    desc: '古罗马式的庄重感,多以 -ia、-ona、-entia 收尾,如 阿尔多里亚、塞雷诺纳',
    tr: {},
    stems: list(
      'ald aur val cast cor ser ver mer tor lun sol ner ter vic cal ost ard arg luc fal tir ven sal bel lav cap vel sev tar fer pal cel clar sab vesp aquil cir lum orv tib fab corv drus',
    ),
    mids: list('en or an er al in ar el is ic it iv on'),
    link: 'e',
    kinds: {
      state: k('oria:3 enia:2 avia:2 icia:1 entia:2 aria:2 onia:2 ania:1 eria:2 elia:2 antia:1 inia:1 uria:1 ora:1 ea:1', 0.25),
      city: k('ona:3 enna:2 ano:2 ino:1 era:1 ica:1 ella:1 ara:2 ola:1 is:1', 0.3),
      mountain: k('ine:2 or:2 an:2 en:2 is:1 ic:1 ar:1', 0.15),
      sea: k('ian:3 ine:1 or:1 en:1 a:1', 0.2),
      river: k('a:3 o:2 is:1 on:1 er:1 us:1 en:1', 0.1),
      region: k('ia:2 ina:2 ica:1 ana:2 aria:1', 0.3),
    },
    epithet: {
      chance: 0.12,
      sea: [...EP_SEA, '帝王海|Imperial Sea', '金冠海|Sea of Crowns'],
      mountain: [...EP_MOUNTAIN, '鹰旗山脉|Eaglebanner Mountains'],
    },
  },
  {
    id: 'kingdom',
    label: '王国(英法风)',
    desc: '中世纪骑士王国,城镇多带 -顿、-维尔、-堡、-福德,如 卡斯特维尔、雷文福德',
    tr: {},
    stems: list(
      'ash bran wen bel rav hart mor pen lan car ald her ast ros stan ever wyn gil kel dun hal wil ard cal dor fen gar lor nor ren tam ver cor dar ken lyn mer sel bri',
    ),
    mids: list('er en el an ar in'),
    link: 'e',
    kinds: {
      state: k('ia:3 land=兰:2 mere=米尔:1 wen:1 or:1 dell=戴尔:1', 0.4),
      city: k(
        'ton=顿:3 ford=福德:2 wick=威克:2 bury=伯里:2 ville=维尔:3 mont=蒙特:1 bourg=堡:1 field=菲尔德:1 stead=斯特德:1 worth=沃思:1 ' +
          'gate=盖特:1 mouth=茅斯:1 chester=切斯特:1 dale=代尔:1 more=莫尔:1 by=比:1 port=港!:2 haven=黑文:1 well=韦尔:1 ' +
          'bridge=布里奇:1 wood=伍德:1 brook=布鲁克:1 castle=卡斯尔:1 holt=霍尔特:1 ley=利:1',
        0.4,
      ),
      mountain: k('ine:1 ian:1 en:2 or:2 ar:1 wyn:1 ell:1', 0.2),
      sea: k('ian:2 en:1 or:1 wyn:1 is:1 el:1', 0.15),
      river: k('a:2 on:2 en:2 ey:1 is:1 ar:1 el:1 ow:1', 0.1),
      region: k('shire=郡!:3 land=兰:2 mark=马克:1 dale=代尔:1 moor=莫尔:1 wold=沃尔德:1', 0.3),
    },
    epithet: { chance: 0.12, sea: [...EP_SEA, '狮心海|Lionheart Sea'], mountain: [...EP_MOUNTAIN, '王冠山脉|Crown Mountains'] },
  },
  {
    id: 'nordic',
    label: '北境(北欧风)',
    desc: '维京与冰原,常见 -海姆、-加德、-维克、-霍尔姆,如 斯卡尔海姆、拉夫维克',
    tr: { jAsY: true },
    stems: list(
      'skal ulf rav bjor jot vin sig ask eir grim hald kol lund nor osk ran sval tor vald brim dag gunn hrim isk ost rog skog stav trond varg hjal aud eid geir har jarn mund ragn sten',
    ),
    mids: list('e a ar en un'),
    link: 'e',
    kinds: {
      state: k('heim=海姆:3 gard=加德:3 land=兰:2 mark=马克:2 ia:1 rike=里克:1', 0.3),
      city: k('vik=维克:3 holm=霍尔姆:2 by=比:2 stad=斯塔德:2 havn=港!:1 borg=堡:2 heim=海姆:1 sund=松德:1 nes=内斯:1 dal=达尔:1', 0.3),
      mountain: k('en:2 ar:2 ur:1 ir:1 -:1', 0.1),
      sea: k('en:2 ar:2 a:1 ir:1', 0.1),
      river: k('a:3 en:2 ar:1 -:1', 0.1),
      region: k('mark=马克:2 land=兰:2 heim=海姆:1 dal=达尔:2 fjord=峡湾!:1', 0.3),
    },
    epithet: {
      chance: 0.15,
      sea: ['寒霜海|Frost Sea', '冰牙海|Icefang Sea', '鲸歌海|Whalesong Sea', '灰浪海|Greywave Sea', '风暴海|Sea of Storms', '极光海|Aurora Sea'],
      mountain: ['霜巨人山脉|Frostgiant Mountains', '冰牙山脉|Icefang Mountains', '雷鸣山脉|Thunder Mountains', '巨人之脊|Giant’s Spine', '白狼山脉|Whitewolf Mountains'],
    },
  },
  {
    id: 'slavic',
    label: '雪原(斯拉夫风)',
    desc: '东欧森林与雪原,城市多叫 -格勒、-斯克、-沃,如 别洛格勒、兹拉托沃',
    tr: {
      jAsY: true,
      table: { be: '别', de: '杰', te: '捷', ne: '涅', le: '列', re: '列', se: '谢', di: '季', ti: '季', cha: '恰', e: '叶', ye: '叶' },
    },
    stems: list(
      'vol bel dar gor kras mil mir nov rad slav vlad yar zor bor dob lub sved tver yas zlat ost prav stan svet bog dub vel vis kol mor sev chern bran drag',
    ),
    mids: list('o e a en ar in'),
    link: 'o',
    kinds: {
      state: k('ia:2 avia:2 ovia:1 ina:1 ania:1 ovina:1', 0.4),
      city: k('grad=格勒:3 gorod=哥罗德:2 sk:3 ovo:2 evo:1 ets:1 ava:1 in:1 ov:2 ka:1 itsa:1', 0.35),
      mountain: k('ar:1 an:1 in:1 ov:1 ava:1 ets:1', 0.1),
      sea: k('ar:1 ov:2 en:1 in:1 ets:1', 0.1),
      river: k('a:3 ava:2 na:1 ets:1 ina:1', 0.1),
      region: k('ia:2 ovina:1 avia:1 sk:1 ovo:1', 0.35),
    },
    epithet: {
      chance: 0.1,
      sea: ['冰封海|Frozen Sea', '雪狼海|Snowwolf Sea', '寒鸦海|Jackdaw Sea'],
      mountain: ['熊脊山脉|Bearspine Mountains', '冰冠山脉|Icecrown Mountains', '黑松山脉|Blackpine Mountains'],
    },
  },
  {
    id: 'hellenic',
    label: '群岛(希腊风)',
    desc: '爱琴海城邦与神话,常见 -斯、-波利斯、-亚,如 塞罗斯、卡利波利斯',
    tr: {},
    stems: list(
      'ther kal ast mel ker pel kor lyk dor ith kyth myr phal ster lamp pyr tel syr thal zak xan oph kas pha lem mes ol eph kyr nis per ser thes tyr',
    ),
    mids: list('o a e i on an ar y'),
    link: 'o',
    kinds: {
      state: k('ia:3 is:2 os:2 eia:1 ene:1 onia:1 aia:1', 0.35),
      city: k('polis=波利斯:3 os:3 a:1 ae:1 ion:1 on:1 ene:1 is:1 ea:1 thos:1 kos:1 ussa:1', 0.35),
      mountain: k('os:2 on:2 as:1 es:1 ys:1', 0.2),
      sea: k('ian:3 ean:2 on:1 ia:1 os:1', 0.2),
      river: k('os:2 on:2 es:1 is:1 as:1', 0.15),
      region: k('ia:2 is:2 ika:1 ene:1 onia:1', 0.3),
    },
    mount: 0.5,
    epithet: {
      chance: 0.12,
      sea: ['海妖海|Siren Sea', '群岛海|Sea of Isles', '晨曦海|Dawn Sea', '珍珠海|Pearl Sea'],
      mountain: ['众神山|Mount of the Gods', '雷霆山|Mount Thunder', '白峰山脉|Whitepeak Mountains'],
    },
  },
  {
    id: 'desert',
    label: '沙海(阿拉伯风)',
    desc: '沙漠、绿洲与商队,常见 -斯坦、-阿巴德、-尔,如 扎希尔、卡斯拉巴德',
    tr: { table: { me: '麦', ha: '哈', kha: '哈', ai: '艾' } },
    stems: list(
      'zah qas sham khal rash tam sul kar bas nas jaz faz sab tar ruz dar sar mir haz bah had jab kad mas nab qad rab saf tab wad yas zar sal amr ghar',
    ),
    mids: list('a i u ar ir am an'),
    link: 'a',
    kinds: {
      state: k('iya:2 stan=斯坦:3 an:2 ar:1 ah:1 id:1', 0.35),
      city: k('abad:2 kand=坎德:1 ah:2 ir:2 ar:1 un:1 is:1 ra:2 ad:1 iya:1 shahr=沙赫尔:1 an:1 at:1', 0.35),
      mountain: k('ar:1 an:1 il:1 ir:1 ad:1 -:1', 0.1),
      sea: k('ar:1 an:1 is:1 un:1 ah:1', 0.15),
      river: k('a:2 un:1 ar:1 is:1 an:1 ir:1', 0.15),
      region: k('iya:2 an:2 ah:1 ar:1', 0.35),
    },
    epithet: {
      chance: 0.12,
      sea: ['流沙海|Sea of Shifting Sands', '烈日海|Sunscorch Sea', '绿洲海|Oasis Sea', '香料海|Spice Sea', '珍珠海|Pearl Sea'],
      mountain: ['烈日山脉|Sunscorch Mountains', '赤岩山脉|Redrock Mountains', '驼峰山脉|Camelback Mountains'],
    },
  },
  {
    id: 'steppe',
    label: '草原(突厥蒙古风)',
    desc: '草原与游牧,沿用中文里熟悉的蒙古 / 突厥地名写法,如 查干浩特、喀拉郭勒',
    tr: { table: { ka: '喀', te: '铁', mu: '木' } },
    stems: list(
      'kara=喀拉 ak=阿克 kok=科克 sary=萨热 kyzyl=克孜勒 altan=阿勒坦 ulaan=乌兰 khokh=呼和 tsagaan=查干 khar=哈尔 shar=沙尔 temir=铁木尔 ' +
        'bayan=巴彦 mongon=孟根 tengri=腾格里 ikh=伊克 ongon=翁贡 arslan=阿尔斯兰 bori=博热 boz=博孜 tash=塔什 kum=库姆 ay=阿依 ' +
        'yulduz=尤勒都斯 tegin=特勤 batur=巴图尔 shira=西拉 nomin=诺敏 sain=赛音 bugha=布哈 altyn=阿勒屯 erdene=额尔德尼 mergen=莫日根 khatun=可敦',
    ),
    mids: list('a u i'),
    link: 'a',
    kinds: {
      // 国名走部落名的路子(克烈、乃蛮、塔塔尔一类),按译音表转写
      state: k('ait:2 an:2 it:1 ut:1 ar:2 gin:1 ir:1 at:1 un:1', 0.2, 'ker nai tat ong jal mer bar kip kan tol sal tur kel dur ogh bay khar ur sor'),
      city: k('khot=浩特!:3 balik=八里:2 kent=肯特:1 sumu=苏木:1 bulak=布拉克:2 bazar=巴扎:1 kurgan=库尔干:1 ordu=斡鲁朵:1'),
      mountain: k('tag=塔格!:3 ula=乌拉!:3'),
      sea: k('tengis=腾吉斯:2 dalai=达来:2'),
      river: k('gol=郭勒:3 su=苏:2 muren=木伦:2 darya=达里雅:1'),
      region: k('tal=塔拉!:2 gobi=戈壁!:2 kum=库姆:1 dala=达拉:1 bulun=布伦:1'),
    },
    epithet: undefined,
  },
  {
    id: 'elven',
    label: '林语(精灵风)',
    desc: '轻柔流动的精灵语感,多用 瑟、希、艾、林,如 艾尔瑟里昂、希尔瓦兰',
    tr: { table: { e: '艾', the: '瑟', se: '瑟', si: '希', thi: '希', ai: '艾', lai: '莱', lin: '琳' } },
    stems: list(
      'ael sil thal cel el ith mir nim gal fal eld ar lin sylv ery aer vael il naer ser tir fin aran eir lith nar cael len myr sael thar ven al',
    ),
    mids: list('a e i ar en el in an on il ir'),
    link: 'e',
    kinds: {
      state: k('ion:2 thas:1 ath:2 eth:1 dor:1 wen:1 lond:1 ara:1 iel:1 anor:1 ea:1 ia:1 aria:1', 0.45),
      city: k('ath:1 ond:1 ion:1 iel:1 as:1 eth:1 wen:1 rin:1 dil:1 mar:1 las:1 olin:1 ador:1 anis:1 est:1', 0.45),
      mountain: k('ith:1 ath:1 or:1 ion:1 en:1 ir:1', 0.2),
      sea: k('ae:1 ea:1 ion:1 en:1 ar:1 ith:1', 0.2),
      river: k('duin=杜因:2 uil:1 ion:1 en:1 ir:1 a:1', 0.15),
      region: k('ath:2 and:1 ion:1 ar:1 wen:1 orien:1', 0.35),
    },
    epithet: {
      chance: 0.15,
      sea: ['星辉海|Starlit Sea', '月语海|Moonwhisper Sea', '银波海|Silverwave Sea', '暮歌海|Evensong Sea', '晨星海|Morningstar Sea'],
      mountain: ['星穹山脉|Starvault Mountains', '月影山脉|Moonshadow Mountains', '晨星山脉|Morningstar Mountains', '银冠山脉|Silvercrown Mountains'],
    },
  },
];

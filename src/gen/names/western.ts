/**
 * 西域译名风(western 族):先拼拉丁字母原形(拟音),再落成古典汉籍里西域地名那一路的汉字写法。
 *
 * 一个名字 = 词根 + (可选)中间音节 + 词尾;山 / 海 / 河再加通名。
 * 词库以固定译写为主(shu + le → Shule / 疏勒),偶尔走音节表转写;
 * 多种语感都是丝路 / 西域一带的不同音系,不是拉丁 / 北欧 / 精灵那路西幻。
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
  const len = [...zh].length;
  if (len < 2) return null;
  // 全是固定译写时允许两字(疏勒、安息);走音节表转写的专名仍要三字起,避免"文河""卡拉"
  const fixed = segs.every((sg) => !sg.l || sg.zh !== undefined);
  if (!fixed && (kind === 'state' || kind === 'city' || kind === 'region') && len < 3) return null;
  return { latin, zh, gen: end.gen ? end.zh : undefined, tokens };
}

const MOUNTAIN_EN = (r: string) => `${r} Mountains`;

export function westernCandidate(st: WesternStyle, kind: NameKind, rng: Rng): Candidate | null {
  const ep = st.epithet;
  if (ep && (kind === 'sea' || kind === 'mountain') && rng() < ep.chance) {
    const [zh, en] = pick(rng, kind === 'sea' ? ep.sea : ep.mountain).split('|');
    const gen =
      kind === 'sea'
        ? zh.endsWith('海')
          ? '海'
          : zh.endsWith('泽')
            ? '泽'
            : undefined
        : zh.endsWith('山脉')
          ? '山脉'
          : zh.endsWith('岭')
            ? '岭'
            : zh.endsWith('山')
              ? '山'
              : undefined;
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

/** 丝路意译名:"中文|拉丁拟音"。自拟,不收典籍原句 / 真实专名整词 */
const EP_SEA = [
  '热海|Rehai', '盐泽|Yanze', '流沙海|Liusha Sea', '瀚海|Hanhai', '蒲昌海|Puchang Sea',
  '镜泽|Jingze', '雪海|Xuehai', '黑水泽|Heishui Ze',
];
const EP_MOUNTAIN = [
  '葱岭|Congling', '白山|Baishan', '金山|Jinshan', '雪山|Xueshan', '铁山|Tieshan',
  '青岭|Qingling', '石山|Shishan', '霜岭|Shuangling',
];

/**
 * 西域音节(固定译写)。字都落在地图字体字表里;两两相拼出疏勒、安息、康居一类的两字专名。
 * 拉丁字母是拟音原形,给界面 / AI 对照,不是欧洲拼法。
 */
const XY_STEM = list(
  'shu=疏 sha=莎 wen=温 gu=姑 yu=于 yan=焉 wei=尉 pu=蒲 qu=渠 qie=且 jing=精 lou=楼 ' +
    'yi=伊 wu=乌 bi=卑 eyi=依 ju=居 kun=昆 ba=巴 lun=轮 shan=善 a=阿 kang=康 gao=高 ku=库 ' +
    'he=贺 an=安 da=大 xia=夏 yue=月 sun=孙 che=车 shi=石 li=黎 xuan=轩 ' +
    'bo=钵 sa=萨 mo=末 mi=弥 tuo=陀 na=那 ye=耶 pi=毗 ni=尼',
);
const XY_END = 'le=勒 ci=兹 mo=末 su=宿 mok=墨 sun=孙 wu=吾 chang=昌 li=犁 nai=耐 zhi=支 yan=延 ' +
  'lun=仑 luo=罗 tuo=陀 ti=提 na=那 mi=弥 ye=耶 xi=息 xia=夏 ju=居 lan=兰 jue=绝 ' +
  'lu=禄 hun=浑 kun=昆 sha=沙 ni=尼';
const XY_GEO = 'le=勒 ci=兹 mo=末 su=宿 lan=兰 li=犁 zhi=支 yan=延 luo=罗 ti=提 mi=弥 xi=息 ju=居 lu=禄 sha=沙';
/** 城名插中间音节,拉开两字撞名(疏勒 / 疏弥勒) */
const XY_MID = list('lu=禄 mi=弥 ti=提 yan=延 luo=罗 na=那 ye=耶');

export const WESTERN_STYLES: WesternStyle[] = [
  {
    id: 'imperial',
    label: '安息(西国风)',
    desc: '汉籍里安息、大夏、月氏一路的西国译名,如 安息、大夏、黎轩',
    tr: {},
    stems: list(
      'an=安 da=大 xia=夏 yue=月 tiao=条 zhi=支 li=黎 xuan=轩 yan=奄 cai=蔡 xi=息 wan=宛 ju=居 kang=康 ' +
        'shu=疏 wen=温 gu=姑 yu=于 wei=尉 pu=蒲 qu=渠 jing=精 lou=楼 yi=伊 bi=卑 kun=昆 ba=巴',
    ),
    mids: XY_MID,
    link: 'a',
    kinds: {
      state: k('xi=息:3 xia=夏:2 shi=氏:2 zhi=支:2 xuan=轩:1 cai=蔡:1 ju=居:2 wan=宛:1 le=勒:1 ci=兹:1 lan=兰:1', 0.05),
      city: k('xi=息:2 xia=夏:1 zhi=支:2 ju=居:2 lan=兰:1 cheng=城!:2 le=勒:1 ci=兹:1', 0.55),
      mountain: k(XY_GEO, 0.05),
      sea: k(XY_GEO, 0.05),
      river: k(XY_GEO, 0.05),
      region: k('xi=息:1 xia=夏:1 ju=居:2 dao=道!:1 yuan=原!:1 lan=兰:1 le=勒:1', 0.05),
    },
    epithet: { chance: 0.08, sea: EP_SEA, mountain: EP_MOUNTAIN },
  },
  {
    id: 'kingdom',
    label: '绿洲(城邦风)',
    desc: '塔里木绿洲城邦式的音译专名,如 疏勒、温宿、渠勒、精绝',
    tr: {},
    stems: XY_STEM,
    mids: XY_MID,
    link: 'u',
    kinds: {
      state: k(XY_END, 0.05),
      city: k(XY_END + ' cheng=城!:1', 0.55),
      mountain: k(XY_GEO, 0.05),
      sea: k(XY_GEO, 0.05),
      river: k(XY_GEO, 0.05),
      region: k(XY_GEO + ' yuan=原!:1 chuan=川!:1', 0.05),
    },
    epithet: { chance: 0.06, sea: EP_SEA, mountain: EP_MOUNTAIN },
  },
  {
    id: 'nordic',
    label: '北庭(漠北风)',
    desc: '漠北部族式的硬音译名,如 坚昆、丁零、呼揭、骨仑',
    tr: { jAsY: true },
    stems: list(
      'jian=坚 ding=丁 hu=呼 gu=骨 tuo=拓 hun=浑 xue=薛 hui=回 kun=昆 ling=零 jie=揭 lu=禄 ' +
        'yan=延 ba=拔 ye=耶 he=贺 mo=莫 yi=伊 wu=乌 bi=卑 ju=居 lun=轮 shan=善',
    ),
    mids: XY_MID,
    link: 'u',
    kinds: {
      state: k('kun=昆:3 ling=零:2 jie=揭:2 lu=禄:2 hun=浑:1 yan=延:1 tuo=陀:1 li=利:1 le=勒:1 ci=兹:1', 0.05),
      city: k('kun=昆:1 lu=禄:2 hun=浑:1 yan=延:2 tuo=陀:1 cheng=城!:2 bao=堡!:1 le=勒:1', 0.55),
      mountain: k('kun=昆:2 lu=禄:2 ling=岭!:3 le=勒:1', 0.05),
      sea: k('ze=泽!:2 ling=零:2 hun=浑:1 lu=禄:1', 0.05),
      river: k('shui=水!:2 lu=禄:2 hun=浑:1 le=勒:1', 0.05),
      region: k('yuan=原!:3 dao=道!:2 kun=昆:1 lu=禄:1 le=勒:1', 0.05),
    },
    epithet: {
      chance: 0.1,
      sea: ['瀚海|Hanhai', '寒泽|Hanze', '雪海|Xuehai', '冰泽|Bingze'],
      mountain: ['白山|Baishan', '金山|Jinshan', '霜岭|Shuangling', '石山|Shishan'],
    },
  },
  {
    id: 'slavic',
    label: '康居(粟特风)',
    desc: '粟特商胡式的音译聚落名,如 康居、安国、石城、穆密',
    tr: { table: { ka: '喀', mu: '穆' } },
    stems: list(
      'kang=康 an=安 shi=石 cao=曹 mi=米 he=何 mu=穆 huo=火 luo=罗 sa=萨 mo=末 ' +
        'bo=钵 lu=禄 mii=弥 ye=耶 shu=疏 wen=温 gu=姑 yu=于 qu=渠 jing=精 lou=楼',
    ),
    mids: XY_MID,
    link: 'a',
    kinds: {
      state: k('ju=居:3 guo=国!:2 mi=密:1 lu=禄:1 luo=罗:1 ye=耶:1 le=勒:1 ci=兹:1 lan=兰:1', 0.05),
      city: k('ju=居:1 cheng=城!:3 guo=国!:1 mi=密:1 lu=禄:1 jv=聚:1 le=勒:1', 0.55),
      mountain: k('luo=罗:2 mi=弥:2 ling=岭!:2 le=勒:1', 0.05),
      sea: k('ze=泽!:3 mi=弥:1 le=勒:1', 0.05),
      river: k('shui=水!:3 mi=弥:1 le=勒:1', 0.05),
      region: k('dao=道!:2 ju=居:1 yuan=原!:1 lan=兰:1', 0.05),
    },
    epithet: { chance: 0.06, sea: EP_SEA, mountain: EP_MOUNTAIN },
  },
  {
    id: 'hellenic',
    label: '大秦(远西风)',
    desc: '汉籍所称大秦、黎轩一类的远西译名,如 大秦、黎轩、海西',
    tr: {},
    stems: list(
      'da=大 li=黎 xi=西 qin=秦 xuan=轩 du=都 luo=罗 si=斯 ma=马 ' +
        'shu=疏 wen=温 yu=于 wei=尉 qu=渠 jing=精 lou=楼 yi=伊 kang=康 ju=居 ba=巴',
    ),
    mids: XY_MID,
    link: 'o',
    kinds: {
      state: k('qin=秦:2 xuan=轩:2 xi=西:1 si=斯:1 du=都:1 le=勒:1 ci=兹:1 lan=兰:1 ju=居:1', 0.05),
      city: k('du=都:2 cheng=城!:2 xuan=轩:1 si=斯:1 luo=罗:1 le=勒:1 lan=兰:1', 0.55),
      mountain: k('ling=岭!:2 le=勒:2 ci=兹:1 lan=兰:1', 0.05),
      sea: k('ze=泽!:2 le=勒:2 ci=兹:1 lan=兰:1', 0.05),
      river: k('shui=水!:2 le=勒:2 ci=兹:1 lan=兰:1', 0.05),
      region: k('dao=道!:1 yuan=原!:1 le=勒:1 ci=兹:1 lan=兰:1 ju=居:1', 0.05),
    },
    mount: 0.4,
    epithet: {
      chance: 0.08,
      sea: ['西海|Xihai', '热海|Rehai', '镜泽|Jingze'],
      mountain: ['西山|Xishan', '金山|Jinshan', '葱岭|Congling'],
    },
  },
  {
    id: 'desert',
    label: '沙洲(大食风)',
    desc: '沙漠绿洲与商队的短音译名,如 撒末、逻斯、达密、布哈',
    tr: { table: { me: '麦', ha: '哈', kha: '哈', ai: '艾' } },
    stems: list(
      'sa=撒 mo=末 luo=逻 si=斯 da=达 mi=密 bu=布 ha=哈 ka=喀 la=拉 ' +
        'ba=巴 za=扎 ta=塔 ra=拉 su=苏 ya=雅',
    ),
    mids: list('- a= i='),
    link: 'a',
    kinds: {
      state: k('mo=末:2 si=斯:2 mi=密:2 la=拉:1 ha=哈:1', 0.1),
      city: k('mo=末:1 mi=密:2 la=拉:1 kand=坎德:1 abad=阿巴德:1 cheng=城!:1', 0.15),
      mountain: k('la=拉:2 ling=岭!:2', 0.05),
      sea: k('ze=泽!:3 la=拉:1', 0.05),
      river: k('shui=水!:3 la=拉:1', 0.05),
      region: k('mo=漠!:2 yuan=原!:2 dao=道!:1', 0.05),
    },
    epithet: {
      chance: 0.1,
      sea: ['流沙海|Liusha Sea', '热海|Rehai', '盐泽|Yanze'],
      mountain: ['赤山|Chishan', '沙岭|Shaling', '金山|Jinshan'],
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
      // 国名走部落名的路子,词根用固定译写音节,少出长音译
      state: k(
        'ait:1 an:1 it:1 ut:1 ar:1 gin:1 ir:1 at:1 un:1 le=勒:2 ci=兹:1 lu=禄:2 hun=浑:1',
        0.15,
        'ker=克 nai=乃 tat=塔 ong=翁 jal=札 mer=梅 bar=巴 kip=基 kan=坎 tol=托 sal=萨 tur=突 kel=克 dur=杜 ogh=乌 bay=巴 khar=哈 ur=乌 sor=索 ' +
          'gu=骨 he=贺 mo=莫 yan=延',
      ),
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
    label: '于阗(玉国风)',
    desc: '柔和的绿洲 / 佛国式音译,如 于弥、毗沙、拘罗、沙尼',
    tr: {},
    stems: list(
      'yu=于 pi=毗 sha=沙 ni=尼 ju=拘 luo=罗 mi=弥 tuo=陀 lan=兰 ruo=若 ti=提 ye=耶 ' +
        'na=那 bo=钵 sa=萨 wen=温 shu=疏 gu=姑 qu=渠 jing=精 lou=楼 yi=伊 kun=昆 ba=巴',
    ),
    mids: XY_MID,
    link: 'a',
    kinds: {
      state: k('mi=弥:2 sha=沙:2 luo=罗:2 ni=尼:1 ye=耶:1 lan=兰:1 ti=提:1 le=勒:1 ci=兹:1', 0.05),
      city: k('mi=弥:1 sha=沙:1 lan=兰:2 ti=提:1 cheng=城!:2 le=勒:1', 0.55),
      mountain: k('lan=兰:2 ling=岭!:2 le=勒:1 mi=弥:1', 0.05),
      sea: k('ze=泽!:3 lan=兰:1 mi=弥:1', 0.05),
      river: k('shui=水!:3 lan=兰:1 mi=弥:1', 0.05),
      region: k('yuan=原!:2 ye=野!:1 lan=兰:1 mi=弥:1', 0.05),
    },
    epithet: {
      chance: 0.08,
      sea: ['镜泽|Jingze', '玉海|Yuhai', '清泽|Qingze'],
      mountain: ['雪山|Xueshan', '玉山|Yushan', '白山|Baishan'],
    },
  },
];

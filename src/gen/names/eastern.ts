/**
 * 东方风:意象字 / 西域音译字 + 通名组合(疏勒、镇西城、玄冒之山)。
 *
 * 每种语感是一组"句式",句式从分好组的字库里取字,保证搭配有意思;
 * 再按平仄过滤:三字以上的名字不许全是仄声,全是平声的也少出。
 *
 * 整体落在汉籍西域译名与边地古地名的语感里(不是中原州郡铺开,也不是江南仙侠)。
 * 字库不收"照着真实地名 / 国名 / 朝代名 / 典籍原条目挑出来的整名";
 * 拼出来偶尔和现实重名没关系,那是巧合。
 */
import type { Rng } from '../util';
import { pick, wpick, type Candidate, type NameKind, type Weighted } from './spec';

// ---------------------------------------------------------------------------
// 平仄(普通话:一二声为平,三四声为仄)。东方风用到的每个字都要在这里,单测会检查。

const PING =
  '一七三丘东中丰临丹之乌乾于云亭人仑仙伊伏依侠元光兰关兴兹冠冥凉凌千华卑南危原双叠台司吉名君听吴吾周和咸唐喀嘉回国坤城堂墟' +
  '多天夫奇如姑威孙孤宁安宣容寒居屏山岐岩峡峰崇崖川州巢巫巴常平幽庄床庭康延弥归彭徐德忠怀恒息扶承招提摇摘支斯施旗时昆昌明星' +
  '春昭晖曹朝朱来松林枫栖桃桑梁梅梧楼槐歌殷江汤汾沂沅沙沧河泉泊泠波泽泾洋津洪洲洹流浊浮涂涛涞涟淄淇淑淮清渊渔渠温游湘溟溪溱' +
  '滋滦漆漓漳潇潍潭潮澄澜濠瀛灵烟烽焉熊燕牛犁狼玄王琼瑶甘田申留疏登白皇皋盘眉眠石神秋秦积空章端竹符精经绝绵罗羊羲耶腾花苍苏' +
  '英荒莎莱莲营蒙蒲蓬薛虚虞衡袁襄西观诗身车轩轮辉辕辰边辽达连追邢都金钟钱银长门闻阳阿陀陈陵隆随雍雕零霄霜霞青韩韶风飞饶驼骊' +
  '高鲸鳞鸣鸿鹏鹰黄黎黑齐龙岚珠舒曲京湖无涯冰狐方霆穹曦民晨雷牙龟坚丁呼浑揭毗尼拘条兜宾思何逻撒干';
const ZE =
  '万丈不与且两乐九五众保信兽冀内冒凤剑勒化北卧卫历县口古右叶后启善器固地坂坞域堡塞境墨壁士夏外大太女子孟定宿寨寿尉小尾岫岭' +
  '岳左帝广庆库府建异式弱影御意慎战扈抚揽日易映晋景月有朔望木末杜杞果柱柳桂梓梦楚次正武母水永汉汝沁泗泰洛济海润渡渭滏漠澧火' +
  '烈玉瑞益盖目碧秀竟素紫纪羽翠翰翼耐肃股胜臂舞若茂草落蔚蔡虎蜀衍角许话谷象豫贺赤赵越跃踏远道邑邓那郑郡里野铁镇镜问陆陇隐雁' +
  '雨雪雾霍靖静顶顺颍首马魏鲁鸟鹊鹤鹿齿驻引带浪顷浩渺翡琥珀瀚四六百脊氏奄宛拓骨禄密聚特米穆勿设';

const TONE = new Map<string, 'p' | 'z'>();
for (const c of PING) TONE.set(c, 'p');
for (const c of ZE) TONE.set(c, 'z');

export const toneOf = (ch: string) => TONE.get(ch);

/** 三字以上全是仄声不要;全是平声的三字名一半概率不要 */
function toneOk(zh: string, rng: Rng): boolean {
  const cs = [...zh];
  if (cs.length < 3) return true;
  const ts = cs.map((c) => TONE.get(c) ?? 'p');
  if (ts.every((t) => t === 'z')) return false;
  if (cs.length === 3 && ts.every((t) => t === 'p') && rng() < 0.4) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 句式

/** 一个句式:从字库拼出 专名 + 通名 */
type Pattern = (rng: Rng) => { zh: string; generic?: string; tokens: string[] };

const S = (s: string) => [...s];

/** 前字 × 后字 组合出两字专名 */
const pair = (a: string, b: string) => {
  const as = S(a);
  const bs = S(b);
  return (rng: Rng) => {
    const x = pick(rng, as);
    let y = pick(rng, bs);
    for (let t = 0; t < 4 && y === x; t++) y = pick(rng, bs);
    return x + y;
  };
};

/**
 * 分组搭配:"清长:风 寒空远:山" = (清 / 长)× 风 + (寒 / 空 / 远)× 山。
 * 前字只配同组的后字(清风、寒山,不会拼出"清山""寒风"这种不顺口的),
 * 所有搭配等概率;同一个字配自己的(风风)跳过。
 */
const combos = (spec: string) => {
  const all: string[] = [];
  for (const grp of spec.trim().split(/\s+/)) {
    const [a, b] = grp.split(':');
    for (const x of S(a)) for (const y of S(b)) if (x !== y) all.push(x + y);
  }
  return (rng: Rng) => pick(rng, all);
};

type Gen = (rng: Rng) => string;

/** 方位字不算"辨识度"部件:不然最近几个名字把东西南北占满,"雁北""河东"这类名字就很难再出 */
const DIR_CHARS = '东西南北中外左右';
const tokensOf = (c: string) => S(c).filter((ch) => !DIR_CHARS.includes(ch));

/** 专名 + 通名(通名按权重抽,'' 表示不加通名) */
function named(core: Gen, generics: string): Pattern {
  const gs: Weighted<string>[] = generics
    .trim()
    .split(/\s+/)
    .map((t) => {
      const [g, w] = t.split(':');
      return { item: g === '-' ? '' : g, w: w ? Number(w) : 1 };
    });
  return (rng) => {
    const c = core(rng);
    const g = wpick(rng, gs);
    return { zh: c + g, generic: g && !g.startsWith('之') ? g : g ? g.slice(1) : undefined, tokens: tokensOf(c) };
  };
}

/** 前缀 + 专名(大靖、北沂) */
function prefixed(prefixes: string, core: Gen, suffix = ''): Pattern {
  const ps = S(prefixes);
  return (rng) => {
    const c = core(rng);
    return { zh: pick(rng, ps) + c + suffix, generic: suffix || undefined, tokens: tokensOf(c) };
  };
}

const oneOf = (s: string): Gen => {
  const cs = S(s);
  return (rng) => pick(rng, cs);
};

/** 几种造专名的办法按权重挑一种 */
const either = (...xs: Array<[Gen, number]>): Gen => {
  const ws: Weighted<Gen>[] = xs.map(([item, w]) => ({ item, w }));
  return (rng) => wpick(rng, ws)(rng);
};

export interface EasternStyle {
  id: string;
  label: string;
  desc: string;
  kinds: Record<NameKind, Weighted<Pattern>[]>;
}

const W = (...xs: Array<[Pattern, number]>): Weighted<Pattern>[] => xs.map(([item, w]) => ({ item, w }));

// ---------------------------------------------------------------------------
// 关陇(汉风)

/**
 * 国号三种句式:
 * - "大" + 国号字(大靖、大昭):国号字取"安定、光明、兴盛"一类的好寓意;
 * - 方位 + 古国字(北沂、南漳):以水立国,再分南北东西,像一国分裂成两支;
 * - 古国字 + 国(淮国、潍国)。
 * 古国字取常用的水名用字;方位只配古国字,不配吉字(免得拼成"南昌""北平"这类现代城市名)。
 */
const C_HAO = '宁靖昭乾康安定兴隆昌景瑞雍顺嘉宣崇恒启承';
const C_GUGUO = '沂漳沁滦潍淄汝汾渭洛淮济漓湘';
/** 州名用字:吉字 + 地理意象 */
const C_ZHOU = '宁安平恒永庆瑞嘉和兴顺昌隆定靖怀明丰康云青沧丹翠松雁鹤龙凤石金玉银霜桑梧岚';
/** "山南水北为阳":前字取山水景物 */
const C_YANG = '云青丹平昭清松丰霞岚桑柳鹤雁霜石翠';
const C_AUSP1 = '永长泰广安嘉宣延承宁兴建顺昌隆怀靖德崇丰定乐清万昭端元咸保正启景瑞';
const C_AUSP2 = '安宁平定昌兴丰和康泰乐庆寿德远化';
/** 陵 / 门 / 川 / 津:景物、颜色、鸟兽 */
const C_LING = '丹云石鹿金玉翠松苍青龙凤竹桂';
const C_MEN = '石铁云风霜雪松鹤鹿龙虎雁剑月';
const C_CHUAN = '云平清丰秀翠碧青';
const C_JIN = '平龙渔桃柳白松石';

// 山:动物(伏虎、鸣凤)/ 颜色 + 形状(翠屏)/ 数 + 物(五峰)三种路数
const M_BEAST = combos('伏卧盘腾回飞跃:龙 伏卧:虎牛 驻回跃飞:马 栖鸣舞引来飞:凤 归栖鸣:鹤鸿雁 白青苍:鹿牛');
const M_COLOR = '翠玉金紫碧青苍白赤丹铁石';
const M_SHAPE = '屏顶岩柱冠';
const M_NUM = '三五七九千万双';
const M_NUMOBJ = '峰叠泉台';

/** 地区:"某地 + 方位"(河东、岭南一类的构词法),某地取地理通名或景物 */
const C_REGION = either(
  [combos('河江山关岭海湖:东西南北 江山河关:左右'), 1],
  [combos('云雁松霜雪丹苍鹿桑梧岚霞:东西南北'), 2],
);

const central: EasternStyle = {
  id: 'central',
  label: '关陇(汉风)',
  desc: '关陇边地与汉式聚落名,如 大靖、安西城、云塞、雁北道(少用州郡)',
  kinds: {
    state: W(
      [prefixed('大', oneOf(C_HAO)), 3],
      [prefixed('北南东西', oneOf(C_GUGUO)), 2],
      [named(oneOf(C_GUGUO), '国'), 2],
    ),
    city: W(
      [named(oneOf(C_ZHOU), '城:4 塞:2 堡:2 邑:1'), 5],
      [named(oneOf(C_YANG), '城:2 塞:1'), 2],
      [named(pair(C_AUSP1, C_AUSP2), '-'), 3],
      [named(oneOf(C_LING), '堡:1 城:1'), 1],
      [named(oneOf(C_MEN), '关:2 塞:1'), 2],
      [named(oneOf(C_CHUAN), '堡:1'), 1],
      [named(oneOf(C_JIN), '城:1'), 1],
    ),
    mountain: W(
      [named(M_BEAST, '山:3 岭:2'), 4],
      [named(pair(M_COLOR, M_SHAPE), '山:3 岭:1 峰:1'), 4],
      [named(pair(M_NUM, M_NUMOBJ), '山:3 岭:1'), 1],
    ),
    sea: W(
      [named(pair('沧苍碧青玄澄镜静长广明金银鲸瀚', '澜波涛潮渊'), '海'), 5],
      [named(combos('明映孤望:月 星云:河 云雪烟:涛 霞珠星:光 金银白:沙'), '海'), 2],
      [named(oneOf('镜澄鲸'), '海'), 1],
    ),
    river: W(
      [named(oneOf('清浊白青碧金玉丹桃柳兰桑灵澄涟沧蒲枫鹿'), '水:4 河:3 川:1'), 5],
      [named(combos('白金银黄:沙 青白赤:石 清柳桃:溪 碧金玉:泉 双九:溪 九:曲 白青:马牛 桃梅:花 玉:带'), '河'), 2],
    ),
    region: W(
      [named(C_REGION, '-:5 道:4'), 5],
      [named(pair(C_AUSP1, C_AUSP2), '道'), 2],
      [named(oneOf(C_ZHOU), '道:2 塞:1'), 2],
    ),
  },
};

// ---------------------------------------------------------------------------
// 边塞(西域风) + 河西(走廊风)

const F_GUARD = '镇定靖安宁威平抚御怀固';
const F_GUARD_T = '北西东远边朔沙漠海川';
const F_ADJ = '黄白黑赤金铁青苍寒';
const F_NATURE = '沙草水石泉岩崖峡风烟霜雪门旗';
const F_BEAST_ADJ = '苍孤野飞白黑黄赤回落';
const F_BEAST = '狼鹰雁马驼雕';
/** 唐诗边塞意象:孤烟、长风、落日、烽火 */
const F_BLEAK = combos('孤:烟城 长:风河 朔寒烈秋:风 大:漠 寒飞黄:沙 白:草 黄:云 落:日 狼:烟 烽:火烟 雷:霆');
/** 西域风的读音字:两两随机组合(楼勒、伊昌、姑兹、龟兹感) */
const XY_A = '楼疏莎精且温姑乌伊康于高尉蒲卑依渠焉贺居昆喀库巴轮善阿龟';
const XY_B = '兰勒绝末宿墨孙吾昌犁耐支延仑善兹罗陀提那弥耶宛息';
const xiyu = pair(XY_A, XY_B);

function frontierImage(): Gen {
  return either([pair(F_ADJ, F_NATURE), 3], [pair(F_BEAST_ADJ, F_BEAST), 2], [F_BLEAK, 2]);
}

const frontier: EasternStyle = {
  id: 'frontier',
  label: '边塞(西域风)',
  desc: '西域古国式音译为主,间有边关,如 疏勒、楼兰、龟兹、镇西城、伊昌泽',
  kinds: {
    state: W([named(xiyu, '-:5 国:1'), 1]),
    city: W(
      [named(xiyu, '-:4 城:2'), 6],
      [named(pair(F_GUARD, F_GUARD_T), '城:2 关:2 堡:1 -:1'), 2],
      [named(frontierImage(), '关:2 城:1 堡:1'), 1],
    ),
    mountain: W(
      [named(xiyu, '山:3 岭:1'), 5],
      [named(frontierImage(), '山:2 岭:1'), 2],
    ),
    sea: W([named(xiyu, '海:2 泊:1 泽:2'), 1]),
    river: W(
      [named(xiyu, '河:4 水:2'), 5],
      [named(combos('黄白黑金:沙 白黑赤青:石 白黄:草 寒冰金:泉'), '河'), 2],
    ),
    region: W(
      [named(xiyu, '原:2 川:2 道:1'), 3],
      [named(combos('漠沙河关塞:北南西东外 雪云雁霜:北南西东'), '-:3 道:2'), 2],
      [named(oneOf('黄苍黑寒白赤沙'), '漠:3 荒:2 原:1'), 4],
    ),
  },
};

/** 河西 / 走廊:另一套西域音节,和边塞错开 */
const HX_A = '贺逻末撒达骨耶勿康安石曹米何火罗';
const HX_B = '干连密禄特斯浑设延德思居国罗耶';
const hexi = pair(HX_A, HX_B);

const xianxia: EasternStyle = {
  id: 'xianxia',
  label: '河西(走廊风)',
  desc: '河西走廊与丝路聚落的音译地名,如 贺密、康居城、末禄泽、石国',
  kinds: {
    state: W(
      [named(hexi, '-:5 国:1'), 5],
      [named(pair('康安石米何穆', '居密禄罗延思'), '-:3 国:1'), 2],
    ),
    city: W(
      [named(hexi, '-:3 城:3 堡:1'), 5],
      [named(pair(F_GUARD, F_GUARD_T), '城:2 关:2 堡:1'), 2],
    ),
    mountain: W(
      [named(hexi, '山:3 岭:2'), 4],
      [named(frontierImage(), '山:2 岭:1'), 2],
    ),
    sea: W([named(hexi, '泽:3 海:2 泊:1'), 1]),
    river: W(
      [named(hexi, '河:3 水:2'), 4],
      [named(combos('黄白黑金:沙 白黑赤:石'), '河'), 2],
    ),
    region: W(
      [named(hexi, '道:2 原:2 川:1'), 3],
      [named(oneOf('黄苍黑寒白赤沙'), '漠:3 荒:2 原:1'), 4],
      [named(combos('关塞漠沙:外西北南'), '-:3 道:1'), 1],
    ),
  },
};

// ---------------------------------------------------------------------------
// 山海(异闻风)

/** 远方异闻式的读音字:两两随机组合,读着古奥(翼留、玄冒、桂台) */
const MY_A = '鹿龙凤鸟翼乐积长章三符槐泰崇钱松太石竹天高众皇中丹青白玄金玉招堂浮苍九常羊虎熊鹊桃桂柳梧蓬瑶帝';
const MY_B = '首台床望游石留危江器吾来果华帝涂历兽皇吴冒时次摇庭丘翼羽角尾鸣歌舞泉光明门柱屏渊周母';
const myXY = pair(MY_A, MY_B);

/**
 * 国名走远方异闻的构词法,但字是自己配的:
 * 数 + 身体(千目国、长眉国)、颜色 + 身体(赤鳞国)、"有" + 鸟兽树木(有鹿、有桑)、景物 + 民(雪民、星民)。
 * ("民"字句后面不加"国",加了会被屏蔽表拦下)
 */
const MY_NUM = '一两三四五六七九千百长双';
const MY_BODY = '首目臂身尾翼齿角股眉脊牙';
const MY_COLOR = '白黑青赤玄金苍紫';
const MY_SKIN = '羽鳞齿股角翼眉牙';

const mythic: EasternStyle = {
  id: 'mythic',
  label: '奇国(异闻风)',
  desc: '远方异闻式的奇地名,如 玄冒之山、翼留之台、雷墟、千目国、桂台之野',
  kinds: {
    state: W(
      [named(pair(MY_NUM, MY_BODY), '国'), 3],
      [named(pair(MY_COLOR, MY_SKIN), '国'), 3],
      [prefixed('有', oneOf('鹿虎熊狐龙凤鹤雁鹊鸿鹰雕桑梧桂'), ''), 1],
      [named(oneOf('云雪星月霞羽鳞桑竹岩'), '民'), 1],
    ),
    city: W(
      [named(oneOf('幽玄青丹紫苍碧赤瑶灵云霞星羽雷雪桑梧鹤凤'), '都:2 丘:2 台:2 邑:1'), 3],
      [named(myXY, '之丘:2 之台:1'), 2],
    ),
    mountain: W(
      [named(myXY, '之山'), 6],
      [named(oneOf('玉石竹松桂槐桑鹿熊凤鹤雷'), '山'), 2],
      [named(myXY, '山'), 2],
    ),
    sea: W(
      [named(oneOf('北南东西沧苍碧寒霜雪'), '冥'), 0.5],
      [named(oneOf('玄幽沧苍碧青赤金云星雷鲸鳞'), '墟:1 渊:1'), 4],
      [named(myXY, '之海:2 之渊:1'), 3],
      [named(oneOf('沧玄幽苍碧鲸鳞星'), '海'), 2],
    ),
    river: W(
      [named(oneOf('赤黑白青丹苍玄金玉甘浊清桂桑兰'), '水'), 5],
      [named(myXY, '之水'), 3],
      [named(myXY, '水'), 2],
    ),
    region: W(
      [named(myXY, '之野'), 6],
      [named(oneOf('东西南北'), '荒'), 1],
      [named(myXY, '之丘'), 2],
    ),
  },
};

export const EASTERN_STYLES: EasternStyle[] = [central, xianxia, frontier, mythic];

export function easternCandidate(st: EasternStyle, kind: NameKind, rng: Rng): Candidate | null {
  const pat = wpick(rng, st.kinds[kind]);
  const r = pat(rng);
  const cs = [...r.zh];
  // 同一个字出现两次(竹溪溪、山月山)不要
  if (new Set(cs).size !== cs.length) return null;
  if (!toneOk(r.zh, rng)) return null;
  return { zh: r.zh, generic: r.generic, tokens: r.tokens };
}

/** 单测用:所有东方风句式可能用到的字(粗略:从源码字库里收集) */
export const EASTERN_TONES = TONE;

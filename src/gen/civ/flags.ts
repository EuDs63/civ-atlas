/**
 * 国家旗帜:推演结束后照已有的历史给每个国家配旗("贴上去",国界、战争、人物一样不改,不影响 GENERATOR_VERSION)。
 * 纯计算,不碰 DOM。画法在 render/flag/,旗上每样东西的意思在 flagText.ts。
 *
 * ## 怎么配
 *
 * - 颜色看民族:每个民族按它的稳定键挑 2–3 色(一个金属色白 / 金 + 一两个颜色),同族的国家都从这几色里取;
 *   各语感有偏好(斯拉夫白红蓝、北境红白蓝、沙海绿白黑红、精灵绿白青……)。相邻两块尽量一个金属色一个颜色(纹章的老规矩)。
 * - 样式看国体和语感:王国照本族常用的样式,河湖民族有四成是波纹;共和国用条纹 / 三色竖条 / 十字 / 左上角方块;
 *   汗国(和游牧民族的国家)用燕尾旗 + 部族烙印;东方语感的王朝用牙旗(犬牙边)。
 * - 图案看王室兴起的城(第一朝 = 立国时的国都,之后 = 每朝的根据地):港口、山城、河边、林中、草原沙漠、平原各有几样。
 * - 东方牙旗:底色按五德(木青、火红、土黄、金白、水黑),立国那朝随机,之后每换一朝按相生(木 → 火 → 土 → 金 → 水 → 木)换;
 *   旗上不写字,中间一只神兽或一样纹样(古代旗帜、器物上用过的),和犬牙边同色,换朝代换一样、和上一朝不重样。
 * - 换朝代:西幻换图案(颜色、样式不变);东方换底色和图案;汗国换烙印。
 * - 分家:西幻沿用母国当时的旗,换一个颜色、左上角加星(第几个分出来就几颗,最多三颗);
 *   东方沿用母国当时的德和图案,加一道镶边;汗国在母国的烙印上加一笔。复国:用回故国亡国前的最后那面旗。
 * - 随机数都从 subSeed(种子, 'flag:' + 国家的稳定键 …) 取:同一个种子永远同一面旗。
 *
 * ## 作者改过的旗
 *
 * WorldEdits.flags(edits.ts):稳定键 → 编码过的旗(encodeFlag)。键是国家(`polity:…`,第一朝)或朝代(`dynasty:…/2`,第 2 朝);
 * 改的是"这一国从这一朝起"的旗:之后换朝代时照改过的那面往下配(东方从改过的底色按五德往下推,西幻换图案、颜色样式照改过的)。
 * 旧存档没有这一项 = 全部自动配。
 */
import type { World } from '../world';
import type { Civ, Polity } from './types';
import { Biome } from '../biomes';
import { mulberry32, subSeed, type Rng } from '../util';
import { cultureKey, dynastyKey, polityKey } from '../edits';

// ---------------------------------------------------------------------------
// 颜色

/** 旗的颜色:W 白、Y 金、R 红、M 绛、B 蓝、S 天蓝、G 绿、T 青、K 黑、P 紫、O 橙、N 褐 */
export type Tinct = 'W' | 'Y' | 'R' | 'M' | 'B' | 'S' | 'G' | 'T' | 'K' | 'P' | 'O' | 'N';

/** 色板:比地图的国家色深、饱和(旗要醒目);白、金是"金属色" */
export const TINCT: Record<Tinct, { hex: string; name: string; metal?: true }> = {
  W: { hex: '#F3F0E8', name: '白', metal: true },
  Y: { hex: '#E3A92E', name: '金', metal: true },
  R: { hex: '#B8322C', name: '红' },
  M: { hex: '#7E2131', name: '绛' },
  B: { hex: '#21508F', name: '蓝' },
  S: { hex: '#5C97CD', name: '天蓝' },
  G: { hex: '#2F6B3F', name: '绿' },
  T: { hex: '#1D6563', name: '青' },
  K: { hex: '#25272C', name: '黑' },
  P: { hex: '#5B3374', name: '紫' },
  O: { hex: '#D4692A', name: '橙' },
  N: { hex: '#7A5133', name: '褐' },
};

/** 色板的顺序(改旗时一排色点) */
export const TINCTS = Object.keys(TINCT) as Tinct[];

export const isMetal = (t: Tinct) => !!TINCT[t].metal;

// ---------------------------------------------------------------------------
// 旗的样子

/** 旗形:方旗、燕尾旗、牙旗(犬牙边) */
export type Shape = 'rect' | 'swallow' | 'banner';

/** 底子的分法 */
export type Layout =
  | 'plain'
  | 'bi-h'
  | 'bi-v'
  | 'tri-h'
  | 'tri-v'
  | 'fess'
  | 'pale'
  | 'nordic'
  | 'cross'
  | 'saltire'
  | 'per-bend'
  | 'chevron'
  | 'canton'
  | 'stripes'
  | 'bordure'
  | 'quarterly'
  | 'disc'
  | 'wavy'
  | 'hoist';

export const LAYOUT_NAME: Record<Layout, string> = {
  plain: '纯色',
  'bi-h': '上下两色',
  'bi-v': '左右两色',
  'tri-h': '三色横条',
  'tri-v': '三色竖条',
  fess: '中间一道横条',
  pale: '中间一道竖条',
  nordic: '偏十字',
  cross: '十字',
  saltire: '斜十字',
  'per-bend': '斜分两色',
  chevron: '旗杆边三角',
  canton: '左上角方块',
  stripes: '条纹',
  bordure: '镶边',
  quarterly: '四格',
  disc: '圆',
  wavy: '波纹',
  hoist: '旗杆边竖条',
};

/** 改旗时能挑的样式(按这个顺序排) */
export const EDIT_LAYOUTS: Layout[] = ['tri-h', 'tri-v', 'bi-h', 'bi-v', 'plain', 'fess', 'pale', 'nordic', 'cross', 'saltire', 'per-bend', 'chevron', 'canton', 'stripes', 'bordure', 'quarterly', 'disc', 'wavy'];

/** 每种样式用几块颜色(按顺序:上 / 中 / 下,或 底 / 图形 / 第三色) */
export const LAYOUT_COLORS: Record<Layout, number> = {
  plain: 1,
  'bi-h': 2,
  'bi-v': 2,
  'tri-h': 3,
  'tri-v': 3,
  fess: 2,
  pale: 2,
  nordic: 3,
  cross: 2,
  saltire: 2,
  'per-bend': 2,
  chevron: 3,
  canton: 2,
  stripes: 3,
  bordure: 2,
  quarterly: 2,
  disc: 2,
  wavy: 2,
  hoist: 2,
};

/** 西幻、汗国旗上的图案 */
export type Sym =
  | 'star'
  | 'star8'
  | 'sun'
  | 'crescent'
  | 'tower'
  | 'crown'
  | 'mountain'
  | 'ship'
  | 'anchor'
  | 'trident'
  | 'tree'
  | 'leaf'
  | 'rose'
  | 'key'
  | 'sword'
  | 'wheat'
  | 'fish'
  | 'bird'
  | 'bow'
  | 'tamga';

export const SYM_NAME: Record<Sym, string> = {
  star: '五角星',
  star8: '八角星',
  sun: '太阳',
  crescent: '新月',
  tower: '塔楼',
  crown: '王冠',
  mountain: '山',
  ship: '帆船',
  anchor: '锚',
  trident: '三叉戟',
  tree: '松树',
  leaf: '叶子',
  rose: '玫瑰',
  key: '钥匙',
  sword: '剑',
  wheat: '麦穗',
  fish: '鱼',
  bird: '飞鸟',
  bow: '弓',
  tamga: '烙印',
};

/** 改旗时能挑的图案(按这个顺序排) */
export const EDIT_SYMS: Sym[] = ['crown', 'tower', 'star', 'star8', 'sun', 'crescent', 'mountain', 'ship', 'anchor', 'trident', 'tree', 'leaf', 'rose', 'key', 'sword', 'wheat', 'fish', 'bird', 'bow', 'tamga'];

/** 东方旗上的纹样:都从古代旗帜、器物上用过的标志抽象出来 */
export type Emblem = 'ri' | 'riyue' | 'dou' | 'san' | 'lei' | 'huo' | 'taiji' | 'qian' | 'ling' | 'shui';
/** 东方旗上的神兽:四灵和《山海经》里的几种,一色剪影 */
export type Beast = 'long' | 'feng' | 'baihu' | 'hu' | 'gui' | 'yao' | 'bifang' | 'taotie';
/** 东方旗中间画的:神兽或纹样 */
export type Mark = Emblem | Beast;

export const BEASTS: Beast[] = ['long', 'feng', 'baihu', 'gui', 'hu', 'yao', 'bifang', 'taotie'];
export const EMBLEMS: Emblem[] = ['ri', 'riyue', 'dou', 'san', 'huo', 'lei', 'shui', 'ling', 'qian', 'taiji'];
/** 改旗时能挑的(神兽在前) */
export const MARKS: Mark[] = [...BEASTS, ...EMBLEMS];
export const isBeast = (m: Mark): m is Beast => (BEASTS as Mark[]).includes(m);

export const MARK_NAME: Record<Mark, string> = {
  long: '龙',
  feng: '凤',
  baihu: '白虎',
  hu: '九尾狐',
  gui: '旋龟',
  yao: '文鳐鱼',
  bifang: '毕方',
  taotie: '饕餮',
  ri: '日',
  riyue: '日月',
  dou: '北斗',
  san: '三星',
  lei: '雷纹',
  huo: '火',
  taiji: '太极',
  qian: '钱纹',
  ling: '菱纹',
  shui: '水纹',
};

/** 神兽、纹样从哪来(旗帜详情里那一行的后半句) */
export const MARK_NOTE: Record<Mark, string> = {
  long: '取自《周礼》九旗“交龙为旂”，清代黄龙旗上的龙戏珠',
  feng: '取自《山海经·南山经》丹穴山“五采而文”的凤皇',
  baihu: '取自古代行军“左青龙而右白虎”的白虎旗（《礼记·曲礼》）',
  gui: '取自《山海经·南山经》“其状如龟而鸟首虺尾”的旋龟',
  hu: '取自《山海经·南山经》青丘山的九尾狐',
  yao: '取自《山海经·西山经》“鱼身而鸟翼”、游于东海的文鳐鱼',
  bifang: '取自《山海经·西山经》“其状如鹤，一足”的火鸟毕方',
  taotie: '取自商周青铜器上的兽面纹（饕餮）',
  ri: '取自古代天子旗上的日月（《周礼》“日月为常”）',
  riyue: '取自《周礼》九旗里天子的旗“常”，上画日月',
  dou: '取自古代行军时中军的北斗旗（《礼记》“招摇在上”）',
  san: '取自参宿的三颗星，古代熊虎旗对应的星（《考工记》“熊旗六斿以象伐”）',
  huo: '取自五行里的火',
  lei: '取自商周青铜器上的雷纹',
  shui: '取自彩陶、铜镜上的水波纹',
  taiji: '取自宋明以来的太极图',
  qian: '取自圆钱方孔的钱纹',
  ling: '取自汉代织锦上的菱纹',
};

/** 图案放在哪:旗中间、旗杆边、左上角 */
export type ChargeAt = 'center' | 'hoist' | 'canton';

/** 一面旗 */
export interface FlagSpec {
  shape: Shape;
  layout: Layout;
  /** 底子的颜色(按 layout 用前几块,见 LAYOUT_COLORS) */
  c: Tinct[];
  /** 西幻、汗国的图案;烙印的样子在 tamga(主干 + 一两笔,见 render/flag 的烙印) */
  charge?: { sym: Sym; t: Tinct; at: ChargeAt; tamga?: number };
  /** 左上角的小星(分出来的国家用来区别母国):颜色、几颗 */
  mullet?: Tinct;
  mullets?: number;
  /** 东方旗:犬牙边和中间图案的颜色(有这一项 = 东方旗) */
  edge?: Tinct;
  /** 东方旗:中间的神兽或纹样;没有 = 不画 */
  mark?: Mark;
  /** 东方旗:镶边(从别国分出来的,像清代八旗的"镶") */
  trim?: Tinct;
}

/** 东方旗(牙旗,或东方的方旗 / 燕尾旗):中间画神兽、纹样,颜色按五德 */
export const isEastern = (s: FlagSpec) => s.edge !== undefined;

// ---------------------------------------------------------------------------
// 各语感的偏好

/** 各语感偏爱的颜色(前面的更常用)和样式 */
const TASTE: Record<string, { colors: Tinct[]; layouts: Layout[] }> = {
  slavic: { colors: ['W', 'R', 'B', 'Y', 'M'], layouts: ['tri-h', 'tri-h', 'bi-h', 'chevron', 'cross'] },
  nordic: { colors: ['R', 'W', 'B', 'Y', 'K'], layouts: ['nordic', 'nordic', 'nordic', 'bi-h'] },
  kingdom: { colors: ['R', 'W', 'Y', 'B', 'K'], layouts: ['quarterly', 'cross', 'saltire', 'bi-v', 'bordure', 'plain'] },
  imperial: { colors: ['P', 'Y', 'M', 'W', 'R'], layouts: ['bordure', 'pale', 'plain', 'fess', 'disc'] },
  hellenic: { colors: ['B', 'W', 'S', 'Y'], layouts: ['stripes', 'cross', 'bi-h', 'plain', 'disc'] },
  desert: { colors: ['G', 'W', 'K', 'R', 'Y'], layouts: ['tri-h', 'chevron', 'pale', 'plain'] },
  steppe: { colors: ['S', 'Y', 'R', 'B', 'W'], layouts: ['plain', 'hoist'] },
  elven: { colors: ['G', 'W', 'T', 'S', 'Y'], layouts: ['bordure', 'per-bend', 'pale', 'disc', 'wavy'] },
  frontier: { colors: ['R', 'K', 'W', 'Y', 'S'], layouts: ['plain', 'hoist'] },
};

const tasteOf = (style: string) => TASTE[style] ?? TASTE.kingdom;

const REPUBLIC_LAYOUTS: Layout[] = ['stripes', 'tri-v', 'cross', 'canton'];

/** 王室兴起的城是哪一类 */
export type Seat = 'sea' | 'mountain' | 'river' | 'forest' | 'dry' | 'plain';

const SEAT_SYMS: Record<Seat, Sym[]> = {
  sea: ['ship', 'anchor', 'trident', 'star8'],
  mountain: ['mountain', 'star', 'tower'],
  river: ['fish', 'tower', 'key'],
  forest: ['tree', 'leaf', 'bird'],
  dry: ['sun', 'crescent', 'star8'],
  plain: ['wheat', 'tower', 'crown', 'sword', 'key', 'rose'],
};

/** 东方:神兽、纹样各占一半 */
const SEAT_MARKS: Record<Seat, Mark[]> = {
  sea: ['yao', 'long', 'dou', 'shui'],
  mountain: ['baihu', 'taotie', 'san', 'lei'],
  river: ['gui', 'long', 'shui', 'qian'],
  forest: ['hu', 'feng', 'taiji', 'ling'],
  dry: ['bifang', 'huo', 'ri'],
  plain: ['feng', 'long', 'riyue', 'qian'],
};

// ---------------------------------------------------------------------------
// 五德

export const DE = ['木', '火', '土', '金', '水'] as const;
/** 五德的底色 */
export const DE_TINCT: Tinct[] = ['T', 'R', 'Y', 'W', 'K'];
/** 五德的犬牙边(土德、金德用红,水德用白) */
export const DE_EDGE: Tinct[] = ['Y', 'Y', 'R', 'R', 'W'];
/** 底色是第几德(不是五德的颜色 = −1) */
export const deOf = (t: Tinct | undefined) => (t ? DE_TINCT.indexOf(t) : -1);

// ---------------------------------------------------------------------------
// 一国历代的旗

/** 这一面是怎么来的(旗帜详情里讲意思用,见 flagText.ts) */
export interface FlagWhy {
  /** 东方(牙旗)/ 汗国(燕尾旗 + 烙印)/ 西幻和共和国 */
  kind: 'east' | 'khan' | 'west';
  /** 第几朝(Polity.dynasties 的下标;0 = 立国那一朝) */
  dyn: number;
  /** 这一朝兴起的城(Settlement id)和它是哪一类 */
  city: number;
  seat: Seat;
  /** 从哪国分出来的(只在第一面) */
  parent?: number;
  /** 西幻分家:第几个分出来的、换掉的颜色(旧 → 新) */
  nth?: number;
  swap?: [Tinct, Tinct];
  /** 东方分家:第一面沿用了母国的图案 */
  inheritMark?: boolean;
  /** 汗国分家:在母国的烙印上加了一笔 */
  nomadParent?: boolean;
  /** 复国:用回了哪个故国的旗(只在第一面) */
  restores?: number;
}

export interface FlagEra {
  /** 从哪年起(第一面 = 立国那年) */
  year: number;
  /** 第几朝 */
  dyn: number;
  /** 作者改旗用的稳定键:第一朝 = 国家的键,之后 = 朝代的键 */
  key: string;
  spec: FlagSpec;
  /** auto = 按规则配的;edited = 作者改的这一面;derived = 照作者更早改过的那面往下配的 */
  how: 'auto' | 'edited' | 'derived';
  why: FlagWhy;
}

/** 作者改过的旗(稳定键 → 旗),见文件头 */
export type FlagOverrides = Readonly<Record<string, FlagSpec>>;

const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng() * a.length)];
/** 偏向前面的挑法 */
const pickFront = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng() * rng() * a.length)];

/** 民族的一套颜色:2–3 色,至少一个金属色(白 / 金)和一个颜色 */
export function culturePalette(seed: number, civ: Civ, cu: number): Tinct[] {
  const c = civ.cultures[cu];
  const rng = mulberry32(subSeed(seed, 'flag-culture:' + cultureKey(civ, cu)));
  const taste = tasteOf(c.style);
  const metals = taste.colors.filter(isMetal);
  const colors = taste.colors.filter((t) => !isMetal(t));
  const m = pickFront(rng, metals.length ? metals : (['W', 'Y'] as Tinct[]));
  const a = pickFront(rng, colors);
  const rest = colors.filter((t) => t !== a);
  const out: Tinct[] = [a, m];
  if (rng() < 0.65 && rest.length) out.push(pickFront(rng, rest));
  return out;
}

/** 城是哪一类:港口、海拔 1100 米以上、大河边、林中、草原沙漠、平原 */
export function seatOf(world: World, civ: Civ, sid: number): Seat {
  const s = civ.settlements[sid];
  if (!s) return 'plain';
  if (s.port) return 'sea';
  const r = s.region;
  const el = civ.regions.elevation[r];
  if (el > 1100) return 'mountain';
  if ((world.flux[s.cell] ?? 0) > world.riverThreshold * 2) return 'river';
  const b = civ.regions.biome[r];
  if (b === Biome.TemperateForest || b === Biome.TemperateRainforest || b === Biome.Taiga || b === Biome.Rainforest || b === Biome.TropicalDryForest) return 'forest';
  if (b === Biome.Steppe || b === Biome.HotDesert || b === Biome.TemperateDesert || b === Biome.ColdDesert || b === Biome.Savanna) return 'dry';
  return 'plain';
}

/** 图案放在哪个颜色上(用来挑反差色) */
export function underCharge(spec: Pick<FlagSpec, 'layout' | 'c'>, at: ChargeAt): Tinct {
  const c = spec.c;
  switch (spec.layout) {
    case 'plain':
    case 'bordure':
    case 'saltire':
      return c[0];
    case 'disc':
      return c[1] ?? c[0];
    case 'bi-h':
    case 'tri-h':
      return at === 'canton' ? c[0] : (c[1] ?? c[0]);
    case 'fess':
    case 'pale':
    case 'tri-v':
    case 'canton':
      return c[1] ?? c[0];
    case 'bi-v':
      return c[0];
    case 'chevron':
      return c[2] ?? c[0];
    case 'stripes':
      return c[2] ?? c[1] ?? c[0];
    case 'quarterly':
    case 'nordic':
    case 'cross':
    case 'per-bend':
    case 'wavy':
    case 'hoist':
      return c[0];
  }
}

/** 按样式,图案放在哪 */
export function chargeAt(layout: Layout): ChargeAt {
  if (layout === 'canton' || layout === 'stripes' || layout === 'quarterly' || layout === 'nordic' || layout === 'cross' || layout === 'per-bend' || layout === 'wavy') return 'canton';
  if (layout === 'chevron' || layout === 'bi-v' || layout === 'fess' || layout === 'hoist') return 'hoist';
  return 'center';
}

/** 和底色有反差的颜色:底是金属色就挑颜色,反之挑金属色 */
function contrast(rng: Rng, under: Tinct, pal: Tinct[]): Tinct {
  const want = (isMetal(under) ? pal.filter((t) => !isMetal(t)) : pal.filter(isMetal)).filter((t) => t !== under);
  const fall: Tinct[] = isMetal(under) ? ['R', 'B', 'K'] : ['Y', 'W'];
  return pickFront(rng, want.length ? want : fall);
}

/** 按样式排好颜色:相邻的块尽量一个金属色一个颜色 */
function arrange(rng: Rng, layout: Layout, pal: Tinct[]): Tinct[] {
  const metals = pal.filter(isMetal);
  const colors = pal.filter((t) => !isMetal(t));
  const m = metals[0] ?? 'W';
  const a = colors[0] ?? 'R';
  const b = colors[1];
  switch (layout) {
    case 'tri-h':
    case 'tri-v':
      // 中间是金属色:颜色、金属、颜色;只有一种颜色就 金属、颜色、金属
      return b ? (rng() < 0.5 ? [a, m, b] : [b, m, a]) : [m, a, m];
    case 'fess':
    case 'pale':
      return [a, m, a];
    case 'chevron':
      return b ? [m, a, b] : [m, a, a === 'K' ? 'R' : 'K'];
    case 'stripes':
      return [a, m, b ?? (a === 'B' ? 'R' : 'B')];
    case 'quarterly':
    case 'disc':
    case 'hoist':
    case 'bordure':
    case 'canton':
      return [a, m];
    case 'nordic':
    case 'cross':
    case 'saltire':
      return b ? [a, m, b] : [a, m];
    case 'bi-h':
    case 'bi-v':
    case 'per-bend':
      return rng() < 0.6 ? [m, a] : [a, m];
    default:
      return [a, m];
  }
}

/** 烙印:低 3 位是主干(六种),再往上每 3 位一笔(0 = 没有) */
function tamgaCode(rng: Rng): number {
  const base = Math.floor(rng() * 6);
  const m1 = 1 + Math.floor(rng() * 6);
  return base | (m1 << 3);
}

/** 给烙印加一笔(分出来的部族) */
function tamgaPlus(code: number, rng: Rng): number {
  const used = [(code >> 3) & 7, (code >> 6) & 7];
  if (!used[0]) return (code & 7) | ((1 + Math.floor(rng() * 6)) << 3);
  if (!used[1]) {
    let m = 1 + Math.floor(rng() * 6);
    if (m === used[0]) m = (m % 6) + 1;
    return (code & 0o77) | (m << 6);
  }
  let m = 1 + Math.floor(rng() * 6);
  if (m === used[0] || m === used[1]) m = (m % 6) + 1;
  return (code & 0o7) | (used[0] << 3) | (m << 6);
}

/** 东方语感、不是汗国的国家:配牙旗 */
const easternRealm = (p: Polity) => !!p.eastern && p.lineage !== 'khanate';
/** 汗国或游牧民族的国家:配燕尾旗 */
const nomadic = (civ: Civ, p: Polity) => p.lineage === 'khanate' || civ.cultures[p.culture]?.kind === 'nomad';

/** 某一年的那一面(没立国 = 第一面,已亡 = 最后一面) */
export function flagAt(eras: readonly FlagEra[], year: number): FlagEra {
  let e = eras[0];
  for (const x of eras) if (x.year <= year) e = x;
  return e;
}

/** 历朝:没改朝换代过 = 一朝(立国那年、国都) */
function dynastiesOf(p: Polity): { year: number; name: string; seat: number }[] {
  return p.dynasties && p.dynasties.length ? p.dynasties : [{ year: p.founded, name: p.name, seat: p.capital }];
}

/** 第 i 朝的改旗键 */
export function flagKey(civ: Civ, id: number, i: number): string {
  return i === 0 ? polityKey(civ, id) : dynastyKey(civ, id, i);
}

interface Ctx {
  world: World;
  civ: Civ;
  seed: number;
  overrides: FlagOverrides;
  memo: Map<number, FlagEra[]>;
}

/** 某国在某年的那一面(分家、复国要看母国 / 故国当时的旗) */
function specOf(ctx: Ctx, id: number, year: number): FlagSpec {
  const eras = polityEras(ctx, id);
  return eras.length ? flagAt(eras, year).spec : { shape: 'rect', layout: 'plain', c: ['W'] };
}

const copy = (s: FlagSpec): FlagSpec => ({ ...s, c: s.c.slice(), charge: s.charge ? { ...s.charge } : undefined });

/**
 * 一个国家历代的旗(第一面 = 立国那年;每换一朝一面)。overrides = 作者改过的(见文件头);
 * memo 存已经算过的国家(分出来的要看母国,复国的要看故国)
 */
function polityEras(ctx: Ctx, id: number): FlagEra[] {
  const hit = ctx.memo.get(id);
  if (hit) return hit;
  // 先占位:母国、故国的链再长也不会绕回自己(保险起见)
  ctx.memo.set(id, []);
  const { world, civ, seed } = ctx;
  const p = civ.polities[id];
  const key = polityKey(civ, id);
  const rng = mulberry32(subSeed(seed, 'flag:' + key));
  const cu = civ.cultures[p.culture];
  const pal = culturePalette(seed, civ, p.culture);
  const taste = tasteOf(cu.style);
  const dyn = dynastiesOf(p);
  const eras: FlagEra[] = [];
  const parent = p.parent !== undefined ? civ.polities[p.parent] : undefined;
  const cityOf = (i: number) => (i === 0 ? p.capital : dyn[i].seat);
  let edited = false;
  /** 套上作者改过的:这一朝改过 = 用改过的那面 */
  const push = (i: number, spec: FlagSpec, why: FlagWhy) => {
    const k = flagKey(civ, id, i);
    const ov = ctx.overrides[k];
    if (ov) edited = true;
    eras.push({ year: i === 0 ? p.founded : dyn[i].year, dyn: i, key: k, spec: ov ? copy(ov) : spec, how: ov ? 'edited' : edited ? 'derived' : 'auto', why });
  };

  // ---- 第一面 ----
  const why0 = (kind: FlagWhy['kind']): FlagWhy => ({ kind, dyn: 0, city: p.capital, seat: seatOf(world, civ, p.capital), parent: parent ? parent.id : undefined });
  if (p.restores !== undefined && civ.polities[p.restores]) {
    // 复国:用回故国最后那面旗
    const old = polityEras(ctx, p.restores);
    const last = old[old.length - 1];
    if (last) push(0, copy(last.spec), { ...why0(last.why.kind), parent: undefined, restores: p.restores });
  }
  if (!eras.length && easternRealm(p)) {
    // 东方王朝:牙旗,五德
    let de = Math.floor(rng() * 5);
    let inherit: FlagSpec | undefined;
    let trim: Tinct | undefined;
    if (parent && easternRealm(parent)) {
      inherit = specOf(ctx, parent.id, p.founded);
      de = Math.max(0, deOf(inherit.c[0]));
      // 清代八旗:正黄 → 镶黄(加红边);红旗镶白边
      trim = inherit.c[0] === 'R' ? 'W' : 'R';
      if (inherit.trim === trim) trim = trim === 'R' ? 'Y' : 'R';
    }
    const shape: Shape = p.lineage === 'republic' ? 'rect' : 'banner';
    const seat = seatOf(world, civ, p.capital);
    const drng = mulberry32(subSeed(seed, `flag:${key}/0`));
    let mark: Mark = inherit?.mark ? inherit.mark : pick(drng, SEAT_MARKS[seat]);
    // 白底红日太像别处的国旗:金德(白底)改画日月
    if (mark === 'ri' && DE_TINCT[de] === 'W') mark = 'riyue';
    push(0, { shape, layout: 'plain', c: [DE_TINCT[de]], edge: trim ?? DE_EDGE[de], mark, trim }, { ...why0('east'), inheritMark: !!inherit?.mark });
  } else if (!eras.length && nomadic(civ, p)) {
    // 汗国:燕尾旗 + 烙印
    let code = tamgaCode(rng);
    let spec: FlagSpec;
    const layout: Layout = pick(rng, ['plain', 'hoist'] as Layout[]);
    const nomadParent = !!parent && nomadic(civ, parent);
    if (nomadParent) {
      const at = specOf(ctx, parent!.id, p.founded);
      code = tamgaPlus(at.charge?.tamga ?? code, rng);
      const c = at.c.slice();
      // 换底色
      const alt = pal.filter((t) => !isMetal(t) && t !== c[0]);
      c[0] = alt.length ? alt[0] : c[0] === 'S' ? 'R' : 'S';
      spec = { ...at, c, charge: { sym: 'tamga', t: contrast(rng, c[0], pal), at: 'hoist', tamga: code } };
      if (!at.charge || at.shape !== 'swallow') spec = { ...spec, shape: 'swallow', edge: undefined, mark: undefined, trim: undefined };
    } else {
      const c = arrange(rng, layout, pal);
      spec = { shape: 'swallow', layout, c, charge: { sym: 'tamga', t: contrast(rng, c[0], pal), at: layout === 'hoist' ? 'center' : 'hoist', tamga: code } };
    }
    push(0, spec, { ...why0('khan'), nomadParent });
  } else if (!eras.length) {
    // 西幻王国 / 共和国
    let base: FlagSpec;
    let split: Pick<FlagWhy, 'nth' | 'swap'> | null = null;
    if (parent && !parent.eastern && parent.lineage !== 'khanate') {
      // 沿用母国的样式,换一种颜色,左上角加星
      const at = specOf(ctx, parent.id, p.founded);
      const c = at.c.slice();
      const swap = c.findIndex((t) => !isMetal(t));
      const alt = [...pal, ...(TASTE[cu.style]?.colors ?? [])].filter((t) => !isMetal(t) && !c.includes(t));
      if (swap >= 0 && alt.length) c[swap] = alt[0];
      const nth = civ.polities.filter((q) => q.parent === parent.id && q.restores === undefined && q.id <= p.id).length;
      const ns = Math.min(3, Math.max(1, nth));
      base = { ...at, c, mullet: isMetal(c[0]) ? 'R' : 'W', mullets: ns };
      split = { nth, swap: swap >= 0 ? [at.c[swap], c[swap]] : undefined };
    } else {
      let layout: Layout;
      if (p.lineage === 'republic') layout = pick(rng, REPUBLIC_LAYOUTS);
      else {
        layout = pickFront(rng, taste.layouts);
        if ((cu.kind === 'river' || cu.kind === 'lake') && rng() < 0.4) layout = 'wavy';
      }
      base = { shape: 'rect', layout, c: arrange(rng, layout, pal) };
    }
    const drng = mulberry32(subSeed(seed, `flag:${key}/0`));
    const seat = seatOf(world, civ, p.capital);
    const spec = westStep(base, undefined, seat, p, pal, drng);
    // 分出来的:图案沿用母国的,只重新挑颜色
    if (split && base.charge) spec.charge = { ...base.charge, t: contrast(drng, underCharge(base, chargeAt(base.layout)), [...pal, ...base.c]) };
    push(0, spec, { ...why0('west'), ...split });
  }

  // ---- 之后每换一朝 ----
  for (let i = 1; i < dyn.length; i++) {
    const prev = eras[i - 1].spec;
    const city = cityOf(i);
    const seat = seatOf(world, civ, city);
    const drng = mulberry32(subSeed(seed, `flag:${key}/${i}`));
    const why: FlagWhy = { kind: 'west', dyn: i, city, seat };
    if (isEastern(prev)) {
      // 东方:按五德相生换底色,换一样图案(和上一朝不重样)
      const d0 = deOf(prev.c[0]);
      const de = d0 < 0 ? -1 : (d0 + 1) % 5;
      const ms = SEAT_MARKS[seat];
      let mark: Mark = pick(drng, ms);
      if (mark === prev.mark) mark = ms.find((z) => z !== prev.mark) ?? (prev.mark === 'ri' ? 'dou' : 'ri');
      const c0 = de < 0 ? prev.c[0] : DE_TINCT[de];
      if (mark === 'ri' && c0 === 'W') mark = 'riyue';
      push(i, { ...prev, c: [c0], edge: prev.trim ?? (de < 0 ? prev.edge : DE_EDGE[de]), mark }, { ...why, kind: 'east' });
    } else if (prev.charge?.sym === 'tamga') {
      // 汗国:换一家部族掌权,换烙印
      push(i, { ...prev, charge: { ...prev.charge, tamga: tamgaCode(drng) } }, { ...why, kind: 'khan' });
    } else {
      // 西幻:换王室换图案,颜色和样式不变
      push(i, westStep({ ...prev, charge: undefined }, prev.charge?.sym, seat, p, pal, drng), why);
    }
  }
  ctx.memo.set(id, eras);
  return eras;
}

/** 西幻换一朝:按王室兴起的城挑一样图案(和上一朝不重样),颜色挑和底子有反差的 */
function westStep(base: FlagSpec, prevSym: Sym | undefined, seat: Seat, p: Polity, pal: Tinct[], drng: Rng): FlagSpec {
  let syms = SEAT_SYMS[seat].slice();
  if (p.lineage === 'republic') syms = syms.filter((s) => s !== 'crown' && s !== 'sword');
  let sym: Sym = pickFront<Sym>(drng, syms.length ? syms : ['star']);
  if (prevSym === sym) sym = syms.find((x) => x !== prevSym) ?? (prevSym === 'crown' ? 'tower' : 'crown');
  const at = base.shape === 'swallow' && base.layout === 'plain' ? 'hoist' : chargeAt(base.layout);
  return { ...base, charge: { sym, t: contrast(drng, underCharge(base, at), [...pal, ...base.c]), at } };
}

/** 一个世界里所有国家的旗(下标 = 国家编号) */
export interface FlagBook {
  eras: FlagEra[][];
}

/** 算出所有国家历代的旗;overrides = 作者改过的(键 → 旗) */
export function flagBook(world: World, civ: Civ, overrides: FlagOverrides = {}): FlagBook {
  const ctx: Ctx = { world, civ, seed: world.params.seed, overrides, memo: new Map() };
  return { eras: civ.polities.map((p) => polityEras(ctx, p.id)) };
}

/** 某国某年的那一面(没立国 = 第一面,已亡 = 最后一面);没有这国 = null */
export function polityFlagAt(book: FlagBook, id: number, year: number): FlagEra | null {
  const eras = book.eras[id];
  return eras && eras.length ? flagAt(eras, year) : null;
}

/** 某国所有朝代的改旗键(恢复自动配的时一起删) */
export function polityFlagKeys(civ: Civ, id: number): string[] {
  return dynastiesOf(civ.polities[id]).map((_, i) => flagKey(civ, id, i));
}

// ---------------------------------------------------------------------------
// 换一面:同样的规矩换几次随机

/**
 * 某国某一朝的候选旗(第 batch 批,每批 n 面;不含现在这面):
 * - 东方旗:底色不变,换神兽或纹样(先挑这朝兴起的城那一类)、犬牙边和图案的颜色、旗形(牙旗 / 方旗 / 燕尾)
 * - 汗国:燕尾旗,本族的颜色,换样式和烙印
 * - 西幻 / 共和国:本族的颜色和常用样式,图案按这一朝兴起的城挑
 */
export function flagAlternatives(world: World, civ: Civ, id: number, era: FlagEra, batch = 0, n = 8): FlagSpec[] {
  const p = civ.polities[id];
  const seed = world.params.seed;
  const pal = culturePalette(seed, civ, p.culture);
  const taste = tasteOf(civ.cultures[p.culture].style);
  const seat = era.why.seat;
  const cur = era.spec;
  const out: FlagSpec[] = [];
  const seen = new Set([sameKey(cur)]);
  for (let k = 0; out.length < n && k < 80; k++) {
    const j = batch * 80 + k;
    const rng = mulberry32(subSeed(seed, `flag-alt:${era.key}#${j}`));
    let spec: FlagSpec;
    if (isEastern(cur)) {
      const own = SEAT_MARKS[seat];
      const mark: Mark = rng() < 0.5 ? pick(rng, own) : pick(rng, MARKS);
      const shape: Shape = pick(rng, ['banner', 'banner', 'banner', 'rect', 'swallow'] as Shape[]);
      const base = cur.c[0];
      const edges = (isMetal(base) ? ['R', 'K', 'B', 'T', 'M'] : base === 'K' ? ['W', 'Y', 'R'] : ['Y', 'W']) as Tinct[];
      const edge = cur.trim ?? pick(rng, edges);
      spec = { shape, layout: 'plain', c: [base], edge, mark: mark === 'ri' && base === 'W' ? 'riyue' : mark, trim: cur.trim };
    } else if (cur.charge?.sym === 'tamga') {
      const layout: Layout = pick(rng, ['plain', 'hoist', 'plain', 'bi-h'] as Layout[]);
      const c = arrange(rng, layout, pal);
      const at: ChargeAt = layout === 'hoist' ? 'center' : 'hoist';
      spec = { shape: 'swallow', layout, c, charge: { sym: 'tamga', t: contrast(rng, underCharge({ layout, c }, at), pal), at, tamga: tamgaCode(rng) } };
    } else {
      // 先照本族常用的样式配;本族的样式太少、配不满一批,再从全部样式里挑
      const layouts = p.lineage === 'republic' ? REPUBLIC_LAYOUTS : taste.layouts;
      const layout = j < layouts.length ? layouts[j] : pick(rng, k < 40 ? layouts : EDIT_LAYOUTS);
      const c = arrange(rng, layout, pal);
      let syms = SEAT_SYMS[seat];
      if (p.lineage === 'republic') syms = syms.filter((s) => s !== 'crown' && s !== 'sword');
      const sym = pick(rng, syms);
      const at = chargeAt(layout);
      spec = { shape: 'rect', layout, c, charge: { sym, t: contrast(rng, underCharge({ layout, c }, at), pal), at } };
    }
    const sk = sameKey(spec);
    if (seen.has(sk)) continue;
    seen.add(sk);
    out.push(spec);
  }
  return out;
}

/** 两面旗看起来差不多(候选里不重复):样式 + 图案 + 旗形 */
function sameKey(s: FlagSpec): string {
  return isEastern(s) ? `e/${s.shape}/${s.mark ?? ''}/${s.edge}` : `${s.shape}/${s.layout}/${s.charge?.sym ?? ''}/${s.charge?.tamga ?? ''}`;
}

// ---------------------------------------------------------------------------
// 存档里的写法(WorldEdits.flags 的值):一面十几个字
//
//   形/样式/颜色[/c=图案.颜色.位置[.烙印]][/m=星的颜色几颗][/e=犬牙边][/k=神兽或纹样][/t=镶边]
//   形:r 方旗、s 燕尾旗、b 牙旗;位置:c 中间、h 旗杆边、k 左上角
//   例:"b/plain/W/e=R/k=long"(白底红犬牙边的龙旗)、"r/tri-h/RWB/c=leaf.R.c"(红白蓝三色横条,中间一片红叶子)

const SHAPE_CODE: Record<Shape, string> = { rect: 'r', swallow: 's', banner: 'b' };
const AT_CODE: Record<ChargeAt, string> = { center: 'c', hoist: 'h', canton: 'k' };
const ALL_LAYOUTS = Object.keys(LAYOUT_NAME) as Layout[];
const ALL_SYMS = Object.keys(SYM_NAME) as Sym[];
/** 存档里一面旗最长多少字 */
export const FLAG_CODE_MAX = 80;

export function encodeFlag(s: FlagSpec): string {
  const parts = [SHAPE_CODE[s.shape], s.layout, s.c.join('')];
  if (s.charge) parts.push(`c=${s.charge.sym}.${s.charge.t}.${AT_CODE[s.charge.at]}${s.charge.tamga !== undefined ? `.${s.charge.tamga}` : ''}`);
  if (s.mullet) parts.push(`m=${s.mullet}${s.mullets ?? 1}`);
  if (s.edge) parts.push(`e=${s.edge}`);
  if (s.mark) parts.push(`k=${s.mark}`);
  if (s.trim) parts.push(`t=${s.trim}`);
  return parts.join('/');
}

const isTinct = (x: string): x is Tinct => x.length === 1 && x in TINCT;
const keyOf = <T extends string>(rec: Record<T, string>, v: string): T | undefined => (Object.keys(rec) as T[]).find((k) => rec[k] === v);

/** 存档里的写法 → 旗;格式不对 = null */
export function decodeFlag(code: unknown): FlagSpec | null {
  if (typeof code !== 'string' || !code || code.length > FLAG_CODE_MAX) return null;
  const [sh, layout, cs, ...rest] = code.split('/');
  const shape = keyOf(SHAPE_CODE, sh);
  if (!shape || !ALL_LAYOUTS.includes(layout as Layout) || !cs || cs.length > 3) return null;
  const c = [...cs];
  if (!c.every(isTinct)) return null;
  const s: FlagSpec = { shape, layout: layout as Layout, c: c as Tinct[] };
  for (const part of rest) {
    const [k, v] = [part.slice(0, 2), part.slice(2)];
    if (k === 'c=') {
      const [sym, t, at, tg] = v.split('.');
      const a = keyOf(AT_CODE, at);
      if (!ALL_SYMS.includes(sym as Sym) || !isTinct(t) || !a) return null;
      s.charge = { sym: sym as Sym, t, at: a };
      if (tg !== undefined) {
        const n = Number(tg);
        if (!/^\d{1,3}$/.test(tg) || n > 0o777) return null;
        s.charge.tamga = n;
      }
    } else if (k === 'm=') {
      const n = Number(v.slice(1));
      if (!isTinct(v[0]) || !/^[1-3]$/.test(v.slice(1))) return null;
      s.mullet = v[0] as Tinct;
      s.mullets = n;
    } else if (k === 'e=' && isTinct(v)) s.edge = v;
    else if (k === 'k=' && (MARKS as string[]).includes(v)) s.mark = v as Mark;
    else if (k === 't=' && isTinct(v)) s.trim = v;
    else return null;
  }
  return s;
}

/** WorldEdits.flags(键 → 写法)→ 能用的(格式不对的跳过) */
export function flagOverrides(flags: Readonly<Record<string, string>> | undefined): Record<string, FlagSpec> {
  const out: Record<string, FlagSpec> = {};
  if (!flags) return out;
  for (const [k, v] of Object.entries(flags)) {
    const s = decodeFlag(v);
    if (s) out[k] = s;
  }
  return out;
}

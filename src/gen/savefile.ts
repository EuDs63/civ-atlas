/**
 * 存档文件(阶段 4):一个世界 = 种子 + 参数 + 用户的修改(gen/edits.ts 的 WorldEdits)。
 * 同种子 + 参数 = 同一个世界,所以不存地形、历史,文件只有几 KB;读档时先按参数重新生成,再套上修改。
 *
 * 文件是普通的 JSON(开放格式,不锁定数据),浏览器里的自动存档(ui/saveStore.ts)也用同一个格式:
 *
 * ```json
 * {
 *   "app": "文明与地图", "format": 1, "generator": 5,
 *   "seed": 7, "params": { "seed": 7, "cells": 36000, ... },
 *   "edits": { "names": { "settlement:c4567#0": "饕餮城", "region:c8123": "九嶷州" }, "interventions": [],
 *              "terrain": [{ "kind": "volcano", "pts": [812, 403], "r": 28, "s": 1.05 }] },
 *   "check": "3f9a0c1d7b2e", "savedAt": "2026-09-27T08:00:00.000Z",
 *   "title": "九州大陆", "view": { "projection": "robinson", "center": 120 }
 * }
 * ```
 *
 * - format:存档格式的版本(字段有不兼容的变化时加一;读到比自己新的格式就不读,提示更新页面)
 * - generator:生成器版本(edits.ts 的 GENERATOR_VERSION);和当前的不同 = 同样的参数可能生成不同的世界
 * - check:地形的短哈希(worldCheck);读档生成完再算一遍,对不上也说明地形变了。两种情况都照样打开,
 *   提示"改过的名字会尽量套上"(稳定键按州、地块定位,地形变化不大时大多还能对上)
 * - edits.interventions:干预(具体种类见 edits.ts 文件头"干预");这里当成不透明的数组原样存、原样读回
 * - edits.terrain:地形修改(edits.ts 文件头"地形修改");读档时逐处过 cleanTerrainOp,格式不对的跳过。
 *   旧存档没有这个字段 = 没改地形。check 是**改过地形以后**的地形哈希(读档时带着地形修改生成,再核对)
 * - view:看这个世界用的投影和中央经线(`{ "projection": "robinson", "center": 120 }`,可选)。
 *   投影名原样存(render/projection.ts 的 ProjectionId,或 "globe"),认不出的由界面当成等距圆柱;
 *   旧存档没有这个字段 = 等距圆柱、中央经线 0°
 *
 * 纯计算,不碰 DOM(Node 里可测)。
 */
import { DEFAULT_PARAMS, type World, type WorldParams } from './world';
import { GENERATOR_VERSION, NAME_MAX, type Intervention, type TerrainOp, type WorldEdits } from './edits';
import { TERRAIN_MAX_OPS, cleanTerrainOp } from './terrainEdits';

export const SAVE_APP = '文明与地图';
/** 存档格式版本 */
export const SAVE_FORMAT = 1;

export interface SaveFile {
  app: '文明与地图';
  format: 1;
  /** 生成器版本(GENERATOR_VERSION) */
  generator: number;
  seed: number;
  params: WorldParams;
  edits: WorldEdits;
  /** 地形的短哈希(worldCheck) */
  check: string;
  /** 用户给这个世界起的名字("九州大陆") */
  title?: string;
  /** 看这个世界用的投影和中央经线;没有 = 等距圆柱、0° */
  view?: SaveView;
  /** 存档时间(ISO 8601) */
  savedAt: string;
}

/** 投影 + 中央经线(存进存档、分享链接) */
export interface SaveView {
  /** 投影名:"equirect" 等距圆柱、"robinson" 罗宾森、"naturalEarth"、"mollweide"、"mercator"、"globe" 地球仪…… */
  projection: string;
  /** 中央经线(度,−180 … 180) */
  center: number;
}

/** 没存投影的存档(旧存档)按这个看 */
export const DEFAULT_VIEW: SaveView = { projection: 'equirect', center: 0 };

/** 整理投影设置:投影名只收短的字母串,中央经线挪到 [−180, 180)、保留两位小数;不像样的 = null */
export function cleanView(raw: unknown): SaveView | null {
  if (!isObj(raw)) return null;
  const p = raw.projection;
  const c = raw.center;
  if (typeof p !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(p)) return null;
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  const t = (c + 180) / 360;
  const lon = (t - Math.floor(t)) * 360 - 180;
  return { projection: p, center: Math.round(lon * 100) / 100 };
}

/** 两份投影设置是不是一样(中央经线差不到 0.01° 算一样) */
export function sameView(a: SaveView | null | undefined, b: SaveView | null | undefined): boolean {
  const x = a ?? DEFAULT_VIEW;
  const y = b ?? DEFAULT_VIEW;
  return x.projection === y.projection && Math.abs(x.center - y.center) < 0.005;
}

export type ParseResult = { ok: true; save: SaveFile; warnings: string[] } | { ok: false; error: string };

/** 版本不同 / 地形对不上时的提示 */
export const STALE_WARNING = '这个存档来自旧版本,地形可能不同,改过的名字会尽量套上';
export const NEWER_WARNING = '这个存档来自更新的版本,地形可能不同,改过的名字会尽量套上(刷新页面可以换到最新版)';
export const CHECK_WARNING = '地形和存档时对不上(可能来自别的版本),改过的名字会尽量套上';

/** 世界名最长几个字 */
export const TITLE_MAX = 24;
/** 存档文件最大多少字节(再大就不像存档了) */
const MAX_BYTES = 8 * 1024 * 1024;
/** 改名最多多少条、键最长多少字 */
const MAX_NAMES = 20000;
const KEY_MAX = 64;

/** 参数的合理范围:存档里超出的调回范围内(比界面滑条宽;再大生成会慢到卡死) */
const PARAM_RANGE: Record<keyof WorldParams, [number, number]> = {
  seed: [-(2 ** 53), 2 ** 53],
  cells: [2000, 200000],
  landFraction: [0.02, 0.95],
  plates: [2, 64],
  mountains: [0, 5],
  temperature: [-40, 40],
  rainfall: [0, 5],
};

const PARAM_NAME: Record<keyof WorldParams, string> = {
  seed: '种子',
  cells: '精细度',
  landFraction: '陆地比例',
  plates: '板块数量',
  mountains: '造山强度',
  temperature: '气温',
  rainfall: '降水',
};

const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[];

/** 一个世界的身份(种子 + 全部参数,固定顺序):浏览器里按它存、按它找 */
export function worldKey(params: WorldParams): string {
  return PARAM_KEYS.map((k) => `${k}=${params[k] ?? DEFAULT_PARAMS[k]}`).join('&');
}

/** 改了几处:改名条数 + 干预条数 + 地形修改处数 */
export function editCount(edits: WorldEdits): number {
  return Object.keys(edits.names).length + edits.interventions.length + (edits.terrain?.length ?? 0);
}

/** 世界名:去掉控制字符、首尾空白,超长截断;空 = 没起名 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const cs = [...s];
  return cs.length > TITLE_MAX ? cs.slice(0, TITLE_MAX).join('') : s;
}

/** 生成一份存档(params 按固定顺序复制;修改复制一份,之后改原来的不影响存档)。view = 当前的投影和中央经线 */
export function makeSave(params: WorldParams, edits: WorldEdits, check: string, title?: string, savedAt = new Date().toISOString(), view?: SaveView | null): SaveFile {
  const p = {} as WorldParams;
  for (const k of PARAM_KEYS) p[k] = params[k] ?? DEFAULT_PARAMS[k];
  const save: SaveFile = {
    app: SAVE_APP,
    format: SAVE_FORMAT,
    generator: GENERATOR_VERSION,
    seed: p.seed,
    params: p,
    edits: {
      names: { ...edits.names },
      interventions: edits.interventions.map((x) => ({ ...x })),
      terrain: (edits.terrain ?? []).map((x) => ({ ...x, pts: x.pts.slice() })),
    },
    check,
    savedAt,
  };
  const t = cleanTitle(title);
  if (t) save.title = t;
  const v = view ? cleanView(view) : null;
  if (v) save.view = v;
  return save;
}

/** 存档 → 文件内容(缩进两格,人也能读) */
export function saveText(save: SaveFile): string {
  return JSON.stringify(save, null, 2) + '\n';
}

/** 下载的文件名开头(存档、导出的图片和编年史共用):文明与地图-九州大陆;没起名 = 文明与地图-种子7 */
export function fileBaseName(save: Pick<SaveFile, 'title' | 'seed'>): string {
  // eslint-disable-next-line no-control-regex
  const t = cleanTitle(save.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^\.+/, '').trim();
  return `${SAVE_APP}-${t || `种子${save.seed}`}`;
}

/** 下载用的文件名:文明与地图-九州大陆.json;没起名 = 文明与地图-种子7.json */
export function saveFileName(save: Pick<SaveFile, 'title' | 'seed'>): string {
  return `${fileBaseName(save)}.json`;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * 读存档:文件内容 → 存档。读不了(不是 JSON、不是本应用的存档、格式比自己新、没有种子)给中文错误;
 * 能读但有问题(生成器版本不同、参数超出范围、个别改名 / 干预格式不对)照样打开,附中文提示
 */
export function parseSave(text: string): ParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '文件是空的' };
  if (text.length > MAX_BYTES) return { ok: false, error: '文件太大,不像「文明与地图」的存档' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: '读不懂这个文件:它不是「文明与地图」的存档(.json)' };
  }
  if (!isObj(raw) || raw.app !== SAVE_APP) return { ok: false, error: '这不是「文明与地图」的存档文件' };
  const format = raw.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) return { ok: false, error: '存档文件坏了:缺少格式版本' };
  if (format > SAVE_FORMAT) return { ok: false, error: `这个存档来自更新版本的「文明与地图」(存档格式 ${format}),请刷新页面换到最新版再打开` };

  const warnings: string[] = [];
  const P = isObj(raw.params) ? raw.params : {};
  const seedRaw = typeof raw.seed === 'number' ? raw.seed : P.seed;
  if (typeof seedRaw !== 'number' || !Number.isFinite(seedRaw)) return { ok: false, error: '存档文件坏了:没有种子' };
  const params = { ...DEFAULT_PARAMS, seed: seedRaw } as WorldParams;
  const bad: string[] = [];
  for (const k of PARAM_KEYS) {
    if (k === 'seed') continue;
    const v = P[k];
    if (v === undefined) continue; // 老存档没有的参数用默认值
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      bad.push(PARAM_NAME[k]);
      continue;
    }
    const [lo, hi] = PARAM_RANGE[k];
    if (v < lo || v > hi) bad.push(PARAM_NAME[k]);
    params[k] = Math.min(hi, Math.max(lo, v));
  }
  if (bad.length) warnings.push(`存档里的${bad.join('、')}不对,已改成合理的值`);

  const generator = typeof raw.generator === 'number' && Number.isFinite(raw.generator) ? raw.generator : 0;
  if (generator < GENERATOR_VERSION) warnings.push(STALE_WARNING);
  else if (generator > GENERATOR_VERSION) warnings.push(NEWER_WARNING);

  // 修改:改名只收"字符串键 → 非空字符串";干预原样收(只跳过不是对象的)
  const E = isObj(raw.edits) ? raw.edits : {};
  const names: Record<string, string> = {};
  let dropped = 0;
  if (isObj(E.names)) {
    for (const [k, v] of Object.entries(E.names)) {
      if (Object.keys(names).length >= MAX_NAMES) {
        dropped++;
        continue;
      }
      if (typeof v !== 'string' || !v.trim() || k.length > KEY_MAX || !k.includes(':')) {
        dropped++;
        continue;
      }
      const cs = [...v];
      names[k] = cs.length > NAME_MAX ? cs.slice(0, NAME_MAX).join('') : v;
    }
  } else if (E.names !== undefined) dropped++;
  if (dropped) warnings.push(`有 ${dropped} 处改名格式不对,已跳过`);
  const interventions: Intervention[] = [];
  let droppedI = 0;
  if (Array.isArray(E.interventions)) {
    for (const x of E.interventions) {
      if (isObj(x)) interventions.push(x as Intervention);
      else droppedI++;
    }
  } else if (E.interventions !== undefined) droppedI++;
  if (droppedI) warnings.push(`有 ${droppedI} 条干预格式不对,已跳过`);
  // 地形修改:逐处清理(坐标夹回地图内),认不出的跳过;旧存档没有 = 没改地形
  const terrain: TerrainOp[] = [];
  let droppedT = 0;
  if (Array.isArray(E.terrain)) {
    for (const x of E.terrain) {
      const v = terrain.length < TERRAIN_MAX_OPS ? cleanTerrainOp(x) : null;
      if (v) terrain.push(v);
      else droppedT++;
    }
  } else if (E.terrain !== undefined) droppedT++;
  if (droppedT) warnings.push(`有 ${droppedT} 处地形修改格式不对,已跳过`);

  const save: SaveFile = {
    app: SAVE_APP,
    format: SAVE_FORMAT,
    generator,
    seed: params.seed,
    params,
    edits: { names, interventions, terrain },
    check: typeof raw.check === 'string' ? raw.check.slice(0, 64) : '',
    savedAt: typeof raw.savedAt === 'string' && !Number.isNaN(Date.parse(raw.savedAt)) ? raw.savedAt : '',
  };
  const title = cleanTitle(raw.title);
  if (title) save.title = title;
  // 投影和中央经线:格式不对就当没存(按等距圆柱、0° 看),不影响打开
  const view = cleanView(raw.view);
  if (view) save.view = view;
  return { ok: true, save, warnings };
}

/**
 * 按存档的参数生成完以后核对地形:生成器版本相同、地形哈希却对不上时给提示
 * (版本不同的 parseSave 已经提示过,这里不重复)。对得上 = null
 */
export function checkWarning(save: SaveFile, check: string): string | null {
  if (save.generator !== GENERATOR_VERSION) return null;
  if (!save.check || save.check === check) return null;
  return CHECK_WARNING;
}

// ---------------------------------------------------------------------------
// 地形校验

/** 32 位 FNV-1a 的一步(按 32 位整数喂) */
function mix(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
  return Math.imul(h ^ (v >>> 24), 16777619);
}

const hex = (h: number, n: number) => (h >>> 0).toString(16).padStart(8, '0').slice(0, n);

/**
 * 地形的短哈希(12 位十六进制):地块数、每个地块的海拔(Float32 的原始位)、水域、生物群落。
 * 同一版本下地形数据在各浏览器 / Node 里逐位一致,所以同种子 + 参数总得到同一个值;
 * 生成算法变了(地形哪怕差一点)就对不上
 */
export function worldCheck(world: World): string {
  const n = world.mesh.n;
  const e = world.elevation;
  const bits = new Uint32Array(e.buffer, e.byteOffset, e.length);
  const { water, biome } = world;
  let a = mix(0x811c9dc5, n);
  let b = mix(0x2166136b, n ^ 0x5bd1e995);
  for (let i = 0; i < n; i++) {
    a = mix(a, bits[i]);
    b = mix(b, (water[i] << 8) | biome[i] | ((i & 0xffff) << 16));
  }
  return hex(a, 8) + hex(b, 4);
}

// ---------------------------------------------------------------------------
// 分享链接:把整份存档塞进网址的 # 后面
//
//   https://…/?seed=7&style=fantasy#share=<base64url(deflate-raw(存档的 JSON))>
//
// - # 后面的东西浏览器不发给服务器,只在打开链接的人自己的页面里读
// - 编码的是**整个** SaveFile(JSON.stringify,不挑字段):存档以后加了字段(比如地形修改),链接自动带上
// - 压缩用浏览器自带的 CompressionStream('deflate-raw')(= zlib 的 raw deflate,Node 里 zlib.inflateRawSync 也能解),
//   再转成 base64url(只有 A–Z a–z 0–9 - _,放进网址不用转义)
// - 解开以后走和"从文件打开"同一个 parseSave:版本不同、参数超范围这些照样打开并提示

/** # 后面的键:#share=… */
export const SHARE_KEY = 'share';
/** 链接超过这么多字就提示"修改太多,链接可能打不开"(聊天软件、浏览器对网址长度各有上限) */
export const SHARE_WARN_LENGTH = 8000;
/** 链接里的数据最多多少字(再长就不像分享链接了) */
const SHARE_MAX_CHARS = 4 * 1024 * 1024;

export const SHARE_BROKEN = '链接不完整或被改动过(可能复制时少了一截),请让对方重新复制一次链接';
const SHARE_EMPTY = '链接里没有世界数据';
const SHARE_OLD_BROWSER = '这个浏览器太旧,打不开分享链接:请换个新版浏览器,或者让对方存成文件发给你';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** 字节 → base64url(不补 =) */
function toBase64Url(bytes: Uint8Array): string {
  const out: string[] = [];
  let s = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i];
    const b = i + 1 < n ? bytes[i + 1] : 0;
    const c = i + 2 < n ? bytes[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < n) s += B64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < n) s += B64[c & 63];
    if (s.length >= 4096) {
      out.push(s);
      s = '';
    }
  }
  out.push(s);
  return out.join('');
}

/** base64url → 字节;有不认识的字符、长度不对 = null */
function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  const v = [0, 0, 0, 0];
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = Math.min(4, s.length - i);
    v[2] = v[3] = 0;
    for (let j = 0; j < n; j++) {
      const code = s.charCodeAt(i + j);
      const x = code < 128 ? B64_INDEX[code] : -1;
      if (x < 0) return null;
      v[j] = x;
    }
    out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (n > 2) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (n > 3) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return out.subarray(0, o);
}

type Pipe = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** 让字节流过压缩 / 解压;解出来超过 limit 字节 = 'big',数据坏了 = 'bad' */
async function through(data: Uint8Array, ts: Pipe, limit = Infinity): Promise<Uint8Array | 'big' | 'bad'> {
  const w = ts.writable.getWriter();
  const fed = w
    .write(data)
    .then(() => w.close())
    .catch(() => {});
  const r = ts.readable.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      n += value.length;
      if (n > limit) {
        r.cancel().catch(() => {});
        return 'big';
      }
      parts.push(value);
    }
  } catch {
    return 'bad';
  }
  await fed;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 这个存档值得做成带数据的链接吗:有任何修改(改名、干预、以后的地形修改……)或者起了名字 */
export function hasShareData(save: SaveFile): boolean {
  if (save.title) return true;
  for (const v of Object.values(save.edits as unknown as Record<string, unknown>)) {
    if (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== false && v !== '') return true;
  }
  return false;
}

/** 网址的 # 那段是不是分享数据(#share=…) */
export function isShareHash(hash: string): boolean {
  return typeof hash === 'string' && new RegExp(`^#?${SHARE_KEY}=`).test(hash.trim());
}

/**
 * 存档 → 网址的 # 那段(`#share=…`,接在网址后面就是分享链接)。
 * 浏览器太旧(没有 CompressionStream)会抛错,调用方提示"存成文件发给对方"
 */
export async function encodeShare(save: SaveFile): Promise<string> {
  if (typeof CompressionStream === 'undefined') throw new Error('这个浏览器太旧,做不了分享链接');
  const bytes = new TextEncoder().encode(JSON.stringify(save));
  const packed = await through(bytes, new CompressionStream('deflate-raw'));
  if (typeof packed === 'string') throw new Error('压缩失败,做不了分享链接');
  return `#${SHARE_KEY}=${toBase64Url(packed)}`;
}

/**
 * 网址的 # 那段(`#share=…`;也认不带 # 的、只有数据的)→ 和 parseSave 一样的结果。
 * 链接坏了(少了一截、被改过、不是本应用的)给中文错误;能读但版本不同之类的照样打开,附提示
 */
export async function decodeShare(hash: string): Promise<ParseResult> {
  if (typeof hash !== 'string') return { ok: false, error: SHARE_EMPTY };
  let s = hash.trim().replace(/^#/, '');
  const m = new RegExp(`(?:^|[&;])${SHARE_KEY}=([^&;]*)`).exec(s);
  if (m) s = m[1];
  else if (/^\w+=/.test(s)) return { ok: false, error: SHARE_EMPTY };
  // 聊天软件折过行、转义过的也认:去掉空白、%编码、末尾的 =
  try {
    if (s.includes('%')) s = decodeURIComponent(s);
  } catch {
    return { ok: false, error: SHARE_BROKEN };
  }
  s = s.replace(/\s+/g, '').replace(/=+$/, '');
  if (!s) return { ok: false, error: SHARE_EMPTY };
  if (s.length > SHARE_MAX_CHARS) return { ok: false, error: '链接太长,不像「文明与地图」的分享链接' };
  const bytes = fromBase64Url(s);
  if (!bytes || !bytes.length) return { ok: false, error: SHARE_BROKEN };
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {
    return { ok: false, error: SHARE_OLD_BROWSER };
  }
  const raw = await through(bytes, ds, MAX_BYTES);
  if (raw === 'big') return { ok: false, error: '链接里的数据太大,不像「文明与地图」的分享链接' };
  if (raw === 'bad') return { ok: false, error: SHARE_BROKEN };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { ok: false, error: SHARE_BROKEN };
  }
  const r = parseSave(text);
  if (r.ok) return r;
  // 来自更新版本的:照原话提示;别的错(不是 JSON、不是本应用的)都算链接坏了
  if (r.error.startsWith('这个存档来自更新版本')) return { ok: false, error: r.error.replace('这个存档', '这个链接') };
  return { ok: false, error: '链接里的数据不是「文明与地图」的世界(可能被改动过),请让对方重新复制一次链接' };
}

/**
 * 换成 incoming 的修改,会丢掉 local 里的几处:改名(同一个键 incoming 没有或名字不同)、干预(incoming 里没有的)、
 * 世界名(两边都起了名、名字不同);以后加的字段(地形修改……)按"数组的项 / 对象的键"逐个比
 */
export function editsLost(local: SaveFile, incoming: SaveFile): number {
  const L = local.edits as unknown as Record<string, unknown>;
  const I = incoming.edits as unknown as Record<string, unknown>;
  let n = 0;
  for (const [k, lv] of Object.entries(L)) {
    const iv = I[k];
    if (Array.isArray(lv)) {
      const has = new Set(Array.isArray(iv) ? iv.map((x) => JSON.stringify(x)) : []);
      n += lv.filter((x) => !has.has(JSON.stringify(x))).length;
    } else if (isObj(lv)) {
      const io = isObj(iv) ? iv : {};
      n += Object.keys(lv).filter((key) => JSON.stringify(lv[key]) !== JSON.stringify(io[key])).length;
    } else if (lv !== undefined && lv !== null && JSON.stringify(lv) !== JSON.stringify(iv)) n++;
  }
  if (local.title && incoming.title && local.title !== incoming.title) n++;
  return n;
}

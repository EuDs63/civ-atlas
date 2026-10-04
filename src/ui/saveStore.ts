/**
 * 存档的浏览器存储(阶段 4):"我的世界"。
 *
 * - 自动存:App 生成完一个世界就 attachWorld(参数, 地形校验);之后修改(editsStore)一变,就把这个世界的
 *   存档(gen/savefile.ts 的 SaveFile,和"存成文件"同一个格式)写进 localStorage。下次打开同一个世界
 *   (同样的种子 + 参数)时 attachWorld 读回来,App 再 setEdits。换世界前 App 先 detachWorld,
 *   清空旧世界的修改就不会被当成"改回默认"存下去。
 * - 只存改过的(或起过名字的)世界:修改全改回默认、又没起名的,从列表里删掉。
 * - 改地形(阶段 4)以后世界按新地形重新生成,地形校验跟着变:App 生成完调 updateCheck 记下新的。
 * - 缩略图(256×128 JPEG dataURL)单独存一个键,第一次存这个世界时由 App 给的 thumbMaker 截一张。
 * - 存储有上限:最多存 MAX_WORLDS 个世界;写不下(配额满了)就删最旧的再试 —— 删了别的世界就在顶部提示一句;
 *   删光了也写不下:提示"浏览器存储已满",带"存成文件"(同一次满只提示一回,之后写成功了再重新算)。
 * - 浏览器不让用 localStorage(隐私模式、禁用了存储)时退回"只在内存里":这次打开的页面里照样能用,
 *   刷新就没了;第一次存的时候顶部提示一句(带"存成文件",10 秒后自己收起),菜单里一直写着。所有读写都 try/catch,从不往外抛错。
 * - 投影和中央经线(ui/projection.ts、mapWrap.ts)跟着世界存:存档时按当时的设置写进 view;
 *   已经存着的世界换了投影 / 中心,App 调 viewChanged 重写一次(没存过的世界不为这个占列表,刷新靠网址里的 proj / lon)。
 */
import { useSyncExternalStore } from 'react';
import type { WorldParams } from '../gen/world';
import { EMPTY_EDITS, type WorldEdits } from '../gen/edits';
import {
  CHECK_WARNING,
  NEWER_WARNING,
  SHARE_BROKEN,
  STALE_WARNING,
  cleanTitle,
  editCount,
  makeSave,
  parseSave,
  sameView,
  worldKey,
  type SaveFile,
  type SaveView,
} from '../gen/savefile';
import { getEdits, subscribeEdits } from './editsStore';
import { getProjection } from './projection';
import { getMapCenter } from './mapWrap';
import { clearToast, showToast, type ToastAction } from './toastStore';

/** 当前的投影和中央经线(存档时写进去) */
export function currentView(): SaveView {
  return { projection: getProjection(), center: Math.round(getMapCenter() * 100) / 100 };
}

const PREFIX = 'wenming-ditu:world:';
const THUMB = 'wenming-ditu:thumb:';
/** 最多存多少个世界(每个几 KB + 缩略图十几 KB) */
export const MAX_WORLDS = 60;

// ---------------------------------------------------------------------------
// 键值存储:localStorage,用不了就退回内存

interface KV {
  get(k: string): string | null;
  /** 写不下(配额满了)= false */
  set(k: string, v: string): boolean;
  remove(k: string): void;
  keys(): string[];
}

const mem = new Map<string, string>();
const memKV: KV = {
  get: (k) => mem.get(k) ?? null,
  set: (k, v) => (mem.set(k, v), true),
  remove: (k) => void mem.delete(k),
  keys: () => [...mem.keys()],
};

function isQuota(e: unknown): boolean {
  const x = e as { name?: string; code?: number } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014);
}

function openLocal(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) return null;
    const probe = 'wenming-ditu:probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

let local: Storage | null | undefined;
/** 浏览器存储能不能用(第一次用到时探测) */
function store(): KV {
  if (local === undefined) local = openLocal();
  const s = local;
  if (!s) return memKV;
  return {
    get: (k) => {
      try {
        return s.getItem(k);
      } catch {
        return mem.get(k) ?? null;
      }
    },
    set: (k, v) => {
      try {
        s.setItem(k, v);
        return true;
      } catch (e) {
        if (isQuota(e)) return false;
        // 别的错(存储突然不让用了):退回内存
        local = null;
        mem.set(k, v);
        return true;
      }
    },
    remove: (k) => {
      try {
        s.removeItem(k);
      } catch {
        /* 删不掉就算了 */
      }
      mem.delete(k);
    },
    keys: () => {
      try {
        const out: string[] = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      } catch {
        return [...mem.keys()];
      }
    },
  };
}

/** 存档能不能留到下次打开(false = 只在这次打开的页面里) */
export function persistent(): boolean {
  store();
  return !!local;
}

// ---------------------------------------------------------------------------
// 订阅(菜单里的列表、提示)

let version = 0;
const subs = new Set<() => void>();
function changed() {
  version++;
  for (const f of subs) f();
}
function subscribe(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

/** 存档有变化时重新渲染(返回一个递增的版本号) */
export function useSavesVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export interface SaveNotice {
  kind: 'ok' | 'warn' | 'error';
  /** 第一行 */
  text: string;
  /** 第二行小字(版本不同、找不到的改名……;几条连成一行) */
  more?: string[];
  /** 右侧的按钮 */
  action?: ToastAction;
  stamp: number;
}

let notice: SaveNotice | null = null;
/**
 * 存档的提示(读档结果、自动恢复、复制了分享链接……):显示在顶部的提示条上(toastStore,来源 'save');
 * 成功的 7 秒后收起,有警告 / 出错的留着等用户关。null = 收起
 */
export function notify(n: Omit<SaveNotice, 'stamp'> | null) {
  notice = n ? { ...n, stamp: performance.now() } : null;
  if (n) showToast({ id: 'save', kind: n.kind, text: n.text, more: n.more?.length ? n.more : undefined, action: n.action });
  else clearToast('save');
  changed();
}
export function useSaveNotice(): SaveNotice | null {
  useSavesVersion();
  return notice;
}

// ---------------------------------------------------------------------------
// 读档提示的短说法:gen/savefile.ts 的原话是完整的句子,提示条上只留一行小字里的几个短句

const BRIEF_WARNING: Record<string, string> = {
  [STALE_WARNING]: '来自旧版本,地形可能不同',
  [NEWER_WARNING]: '来自更新的版本,地形可能不同',
  [CHECK_WARNING]: '地形和存档时对不上',
};
/** 读档的警告(版本不同、地形对不上……)→ 短句;认不出的原样 */
export function briefWarning(w: string): string {
  return BRIEF_WARNING[w] ?? w;
}
/** 打不开存档 / 分享链接的原因 → 短句;认不出的原样 */
export function briefError(e: string): string {
  if (e === SHARE_BROKEN) return '链接不完整,请让对方重新复制';
  if (e.includes('来自更新版本')) return '来自更新的版本,刷新页面后再打开';
  if (e.includes('浏览器太旧')) return '浏览器版本太旧,请换新版浏览器或改用存档文件';
  if (e.includes('不是「文明与地图」')) return e.includes('链接') ? '链接被改动过,请让对方重新复制' : '不是「文明与地图」的存档';
  return e;
}

// ---------------------------------------------------------------------------
// 存不下时的提示(顶部提示条,来源 'storage':不和读档结果的 'save' 互相顶掉)

/**
 * "存成文件"(提示条上的按钮调它):每个挂着的 SaveMenu 登记一次、卸下时撤掉自己那一次,
 * 用最后登记的那个 —— 同时挂着几个存档菜单(手机的世界卡片和概览)时,卸下其中一个不影响别的
 */
const fileSavers: (() => void)[] = [];
export function addFileSaver(f: () => void): () => void {
  fileSavers.push(f);
  return () => {
    const i = fileSavers.lastIndexOf(f);
    if (i >= 0) fileSavers.splice(i, 1);
  };
}
function saveFileAction(): ToastAction | undefined {
  if (!fileSavers.length) return undefined;
  return {
    label: '存成文件',
    onClick: () => {
      clearToast('storage');
      fileSavers[fileSavers.length - 1]?.();
    },
  };
}

/** 自动存写不下(删光别的世界也腾不出地方);写成功一次就清掉 */
let storageFull = false;
/** 只在内存里存(浏览器不让存)的提示已经说过了 */
let memoryWarned = false;
/** 这一次写入为了腾地方删掉的世界(名字) */
let evicted: string[] = [];

/** 自动存是不是写不下了(菜单里的一行字用) */
export function storageIsFull(): boolean {
  return storageFull;
}

function reportFull() {
  if (storageFull) return;
  storageFull = true;
  showToast({ id: 'storage', kind: 'warn', text: '没能自动存档:浏览器存储已满', more: ['在「我的世界」里删掉几个,或存成文件'], action: saveFileAction() });
  changed();
}

function reportEvicted(why: 'quota' | 'count') {
  const names = evicted;
  evicted = [];
  if (!names.length) return;
  const list = names.length > 2 ? `「${names[0]}」等 ${names.length} 个` : names.map((n) => `「${n}」`).join('');
  showToast({
    id: 'storage',
    kind: 'warn',
    text: why === 'quota' ? '浏览器存储已满' : `「我的世界」最多存 ${MAX_WORLDS} 个`,
    more: [`已删掉最旧的存档${list}`],
  });
}

function reportMemoryOnly() {
  if (memoryWarned || local) return;
  memoryWarned = true;
  // 停 10 秒自己收起(存档菜单里当前世界那一行、菜单底部一直写着)
  showToast({ id: 'storage', kind: 'warn', text: '浏览器不让网页存数据', more: ['修改只留在这个页面里,关掉前请存成文件'], action: saveFileAction(), ttl: 10_000 });
}

// ---------------------------------------------------------------------------
// 存、读、列、删

export interface StoredWorld {
  id: string;
  save: SaveFile;
  /** 改了几处 */
  count: number;
  thumb: string | null;
}

function readSave(id: string): SaveFile | null {
  const text = store().get(PREFIX + id);
  if (!text) return null;
  const r = parseSave(text);
  return r.ok ? r.save : null;
}

/** 浏览器里存的一个世界;没有 = null */
export function loadWorld(id: string): StoredWorld | null {
  const save = readSave(id);
  if (!save) return null;
  return { id, save, count: editCount(save.edits), thumb: store().get(THUMB + id) };
}

/** 存过的世界,最近改的在前 */
export function listWorlds(): StoredWorld[] {
  const out: StoredWorld[] = [];
  for (const k of store().keys()) {
    if (!k.startsWith(PREFIX)) continue;
    const w = loadWorld(k.slice(PREFIX.length));
    if (w) out.push(w);
  }
  return out.sort((a, b) => (b.save.savedAt > a.save.savedAt ? 1 : b.save.savedAt < a.save.savedAt ? -1 : a.id < b.id ? -1 : 1));
}

const nameOf = (id: string) => {
  const s = readSave(id);
  return s ? s.title || `种子 ${s.seed}` : null;
};

function removeKeys(id: string) {
  const kv = store();
  kv.remove(PREFIX + id);
  kv.remove(THUMB + id);
}

/** 删掉最旧的一个世界(不删 keep;读不出来的坏条目、没有存档的缩略图最先删);没得删 = false */
function evictOldest(keep: string): boolean {
  const kv = store();
  const ids = new Set<string>();
  for (const k of kv.keys()) {
    if (k.startsWith(PREFIX)) ids.add(k.slice(PREFIX.length));
    else if (k.startsWith(THUMB)) ids.add(k.slice(THUMB.length));
  }
  ids.delete(keep);
  let oldest: string | null = null;
  let at = '\uffff';
  for (const id of ids) {
    const t = readSave(id)?.savedAt ?? '';
    if (t < at || (t === at && oldest !== null && id < oldest)) {
      oldest = id;
      at = t;
    }
  }
  if (oldest === null) return false;
  const name = nameOf(oldest);
  if (name) evicted.push(name);
  removeKeys(oldest);
  return true;
}

/** 写一个键;写不下就删最旧的世界再试 */
function put(key: string, value: string, keep: string): boolean {
  const kv = store();
  for (let i = 0; i < 8; i++) {
    if (kv.set(key, value)) return true;
    if (!evictOldest(keep)) return false;
  }
  return false;
}

function writeSave(save: SaveFile): boolean {
  const id = worldKey(save.params);
  const fresh = store().get(PREFIX + id) === null;
  evicted = [];
  const ok = put(PREFIX + id, JSON.stringify(save), id);
  reportEvicted('quota');
  // 新存一个世界:超过上限就删最旧的
  if (ok && fresh) {
    for (const w of listWorlds().slice(MAX_WORLDS))
      if (w.id !== id) {
        evicted.push(w.save.title || `种子 ${w.save.seed}`);
        removeKeys(w.id);
      }
    reportEvicted('count');
  }
  if (ok) {
    if (storageFull) {
      storageFull = false;
      clearToast('storage');
    }
    reportMemoryOnly();
  } else reportFull();
  return ok;
}

/** 删掉一个存档(当前世界的也可以删:修改还在页面上,下次再改会重新存) */
export function deleteWorld(id: string) {
  removeKeys(id);
  if (current?.id === id) current.title = undefined;
  changed();
}

/** 给存档起名(改名);当前世界还没存过的,顺手存下来(起了名字的世界没有修改也留在列表里) */
export function renameWorld(id: string, title: string) {
  const t = cleanTitle(title);
  if (current?.id === id) {
    current.title = t || undefined;
    saveCurrent(true);
    return;
  }
  const w = readSave(id);
  if (!w) return;
  const next: SaveFile = { ...w, savedAt: w.savedAt };
  if (t) next.title = t;
  else delete next.title;
  writeSave(next);
  changed();
}

// ---------------------------------------------------------------------------
// 当前世界 + 自动存

interface Current {
  id: string;
  params: WorldParams;
  check: string;
  title?: string;
  /** 最近一次存下的修改(同一个对象不重复存) */
  saved: WorldEdits | null;
  /** 最近一次存下的投影设置 */
  savedView?: SaveView;
}

let current: Current | null = null;
/** 截缩略图(App 给):画布还没画好这个世界 = null */
let thumbMaker: ((id: string) => string | null) | null = null;
let thumbTimer: ReturnType<typeof setTimeout> | undefined;

export function setThumbMaker(f: ((id: string) => string | null) | null) {
  thumbMaker = f;
}

/** 当前世界(自动存的对象);换世界途中 = null */
export function currentWorld(): Readonly<Omit<Current, 'saved'>> | null {
  return current;
}

/** 当前世界 → 存档(存成文件用) */
export function currentSave(): SaveFile | null {
  if (!current) return null;
  return makeSave(current.params, getEdits(), current.check, current.title, undefined, currentView());
}

/** 过一会儿截一张缩略图(画布这时可能还没画好这个世界,截不到就再等等,最多等十来次);已有的不重截 */
function scheduleThumb(id: string, tries = 0) {
  if (tries > 12) return;
  if (thumbTimer !== undefined) clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    thumbTimer = undefined;
    if (current?.id !== id || !store().get(PREFIX + id) || store().get(THUMB + id)) return;
    let url: string | null = null;
    try {
      url = thumbMaker?.(id) ?? null;
    } catch {
      url = null;
    }
    if (!url) return scheduleThumb(id, tries + 1);
    evicted = [];
    const ok = put(THUMB + id, url, id);
    reportEvicted('quota');
    if (ok) changed();
  }, 700);
}

/** 把当前世界存下来(修改没变就不存;force = 起名、删了又存) */
function saveCurrent(force = false) {
  const c = current;
  if (!c) return;
  const edits = getEdits();
  if (!force && edits === c.saved) return;
  c.saved = edits;
  if (!editCount(edits) && !c.title) {
    // 全改回默认、又没起名:不占列表
    removeKeys(c.id);
    changed();
    return;
  }
  const view = currentView();
  c.savedView = view;
  if (writeSave(makeSave(c.params, edits, c.check, c.title, undefined, view))) scheduleThumb(c.id);
  changed();
}

/**
 * 投影 / 中央经线变了(App 停下来以后调):当前世界已经存着的话重写一次(最后修改时间跟着变);
 * 没存过的世界不存(只改了看法、没改世界,不占"我的世界"列表)
 */
export function viewChanged() {
  const c = current;
  if (!c || sameView(c.savedView, currentView())) return;
  if (store().get(PREFIX + c.id) === null) return;
  saveCurrent(true);
}

/**
 * 生成完一个世界:以后它的修改自动存。
 * file = 读档(文件)带来的存档:用它的修改和名字(覆盖浏览器里这个世界原来存的);
 * 不给 = 浏览器里存过这个世界就读回来。返回要套上的存档(App 拿去 setEdits、核对地形);没有 = null
 */
export function attachWorld(params: WorldParams, check: string, file?: SaveFile): SaveFile | null {
  const id = worldKey(params);
  const prev = readSave(id);
  // 没有修改、也没起名的存档(只记了种子 + 参数)= 只是打开这个世界:浏览器里存过的修改照样读回来
  const incoming = file && (editCount(file.edits) > 0 || file.title) ? file : undefined;
  const stored = incoming ? null : prev;
  const from = incoming ?? stored;
  // 读回浏览器里存的:App 会 setEdits(stored.edits) —— 就是存着的那份,记成"已存",不重写(最后修改时间不变);
  // 读档(文件)带来的:App setEdits 之后自动存写下去(覆盖这个世界原来存的)
  // 文件里没起名、浏览器里给这个世界起过名的,名字留着
  const title = incoming?.title ?? prev?.title;
  current = { id, params: { ...params }, check, title, saved: stored ? stored.edits : null, savedView: from?.view };
  if (incoming && !editCount(incoming.edits) && title) saveCurrent(true);
  changed();
  return from;
}

/** 当前世界按新的地形修改重新生成完(阶段 4 改地形):记下新的地形校验,已经存着的存档跟着改 */
export function updateCheck(check: string) {
  const c = current;
  if (!c || c.check === check) return;
  c.check = check;
  if (store().get(PREFIX + c.id) !== null) saveCurrent(true);
}

/** 换世界(或读档)之前:之后的修改(clearEdits)不再算这个世界的 */
export function detachWorld() {
  current = null;
  if (thumbTimer !== undefined) clearTimeout(thumbTimer);
  thumbTimer = undefined;
  changed();
}

/** 开始自动存(App 挂载时调一次;返回取消函数) */
export function startAutoSave(): () => void {
  return subscribeEdits(() => saveCurrent());
}

/** 测试用:清空内存里的状态(不动浏览器存储) */
export function _resetForTest() {
  current = null;
  notice = null;
  local = undefined;
  storageFull = false;
  memoryWarned = false;
  evicted = [];
  mem.clear();
  if (thumbTimer !== undefined) clearTimeout(thumbTimer);
  thumbTimer = undefined;
}

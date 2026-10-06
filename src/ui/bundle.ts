/**
 * 「全部存成文件」:「我的世界」里的世界一起存成一个文件;「打开存档文件」选这个文件,全部放回「我的世界」。
 *
 * ```json
 * { "app": "文明与地图", "bundle": 1, "savedAt": "2026-10-05T08:00:00.000Z",
 *   "worlds": [ { "id": "wk3j9x2m1a", "save": { …和单个世界的存档文件一样… }, "meta": { "draft": true, "alive": 13 },
 *                 "opened": "2026-10-05T07:00:00.000Z", "thumb": "data:image/jpeg;base64,…", "notes": [ …AI 写的史书、名字由来… ] } ] }
 * ```
 *
 * - bundle:这种文件的格式版本(不兼容的变化时加一;比自己新的不读,提示刷新页面)
 * - id:存的时候这个世界的编号(放回来都换新编号;没建完的世界记着的底稿编号跟着换)。可以没有
 * - save:和单个世界的存档文件(gen/savefile.ts)一模一样,读的时候同样过 parseSave
 * - meta:卡片上的几样(还在新建、现存几国、新建时的底稿);opened:最近打开(比最后一次修改晚才有,卡片上的时间和排序按它);
 *   thumb:缩略图;notes:AI 写的东西(ai/library.ts)。都可以没有
 *
 * 存:「我的世界」里的全部世界;正在看的那个没能存进浏览器(存储满了)的,用页面里的那份,一次都没存进去的也放进去。
 * 一个文件放不下(MAX_LEN)的,先不带 AI 写的东西,还放不下再不带缩略图(存出来的文件总能放回来);都不带还放不下就不存。
 * 放回来:逐个放进「我的世界」(都是新编号;建好的先放,没建完的后放,好把底稿编号换成新的)。
 * 已经有一模一样的(参数、修改、名字、底稿出处、生成器版本、地形哈希都相同;没建完的和建好的分开算,没建完的还要底稿相同)不重复放,
 * 那边缺的投影、AI 写的东西、缩略图、现存几国、底稿补上,文件里"最近打开"更晚的用文件里的,
 * 上次没能写进浏览器(存储满了)的 AI 写的东西再写一次;
 * 放满了(MAX_WORLDS)、浏览器存不下就停,不为它删别的世界;浏览器不让存(只在内存里)的说一声。登录了的,放回来的世界照常同步进账号。
 */
import { SAVE_APP, fileBaseName, parseSave, type SaveFile } from '../gen/savefile';
import { exportNotes, notesSaved, replaceNotes, type AiNote } from '../ai/library';
import type { DraftBase } from './stageStore';
import {
  MAX_WORLDS,
  cleanSyncMeta,
  currentSave,
  currentUnsaved,
  currentWorld,
  fillMissing,
  listWorlds,
  newWorldId,
  notify,
  persistent,
  putSyncedWorld,
  sameSave,
  type SyncMeta,
} from './saveStore';

/** 这种文件的格式版本 */
export const BUNDLE_FORMAT = 1;
/**
 * 文件最长多少字(按读出来的文字长度算;缩略图、AI 写的东西都在里面,比单个世界的存档大得多)。
 * AI 写的东西不另限条数、长短;存的时候超了就少带一些(见 bundleText),存出来的都在这以内
 */
const MAX_LEN = 64 * 1024 * 1024;
/** 一条 AI 写的东西除了正文以外另记的字段(史书的书目等),最多这么长 */
const NOTE_EXTRA_MAX = 20_000;
/** 缩略图最长多少字(网页自己截的 480×240 只有几十 KB) */
const THUMB_MAX = 1_000_000;

export interface BundleWorld {
  /** 存的时候的编号(换底稿编号用);没有 = 不知道 */
  id?: string;
  save: SaveFile;
  meta: SyncMeta;
  /** 最近打开(比最后一次修改晚才有) */
  opened?: string;
  thumb: string | null;
  notes: AiNote[];
}

export interface Bundle {
  worlds: BundleWorld[];
  /** 读不出来、跳过了的世界 */
  bad: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** 文件名:文明与地图-全部世界-2026-10-05.json(按本地日期) */
export function bundleFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fileBaseName({ title: '全部世界', seed: 0 })}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}.json`;
}

export interface BundleOut {
  text: string;
  count: number;
  /** 一个文件放不下、没带上的:AI 写的东西;AI 写的东西和缩略图 */
  dropped?: 'notes' | 'notes+thumbs';
  /** 都不带也放不下:text 为空,存不成 */
  tooBig?: true;
}

/**
 * 「我的世界」里的全部世界 → 文件内容;一个都没有 = null。正在看的那个最新的改动没存进浏览器(存储满了)的,用页面里的。
 * 超过 max 的先不带 AI 写的东西,还超再不带缩略图(见文件头)
 */
export function bundleText(at = new Date(), max = MAX_LEN): BundleOut | null {
  const cur = currentWorld();
  const fresh = cur && currentUnsaved() ? currentSave() : null;
  const one = (id: string, save: SaveFile, w: { draft: boolean; alive?: number; base?: SyncMeta['base']; at?: string }, thumb: string | null) => {
    const meta: SyncMeta = {};
    if (w.draft) meta.draft = true;
    if (w.alive !== undefined) meta.alive = w.alive;
    if (w.draft && w.base) meta.base = w.base;
    return { id, save, meta, opened: w.at && w.at > save.savedAt ? w.at : undefined, thumb, notes: exportNotes(id) };
  };
  const list = listWorlds();
  const worlds = list.map((w) =>
    fresh && cur?.id === w.id
      ? // 卡片上的几样也按页面里的(比如刚点了「创建世界」,存档和"还在新建"都没能改写进浏览器)
        one(w.id, { ...fresh, savedAt: at.toISOString() }, { draft: cur.kind === 'draft', alive: cur.alive ?? w.alive, base: cur.base }, w.thumb)
      : one(w.id, w.save, w, w.thumb),
  );
  // 正在看的这个一次都没能存进浏览器(存储满了):页面里这份是唯一的一份,也放进去
  if (cur && fresh && !list.some((w) => w.id === cur.id)) {
    worlds.unshift(one(cur.id, { ...fresh, savedAt: at.toISOString() }, { draft: cur.kind === 'draft', alive: cur.alive, base: cur.base }, null));
  }
  if (!worlds.length) return null;
  const text = (notes: boolean, thumbs: boolean) =>
    JSON.stringify(
      {
        app: SAVE_APP,
        bundle: BUNDLE_FORMAT,
        savedAt: at.toISOString(),
        worlds: worlds.map((w) => ({
          id: w.id,
          save: w.save,
          meta: w.meta,
          ...(w.opened ? { opened: w.opened } : {}),
          ...(thumbs && w.thumb ? { thumb: w.thumb } : {}),
          ...(notes && w.notes.length ? { notes: w.notes } : {}),
        })),
      },
      null,
      2,
    ) + '\n';
  const count = worlds.length;
  const full = text(true, true);
  if (full.length <= max) return { text: full, count };
  const noNotes = text(false, true);
  if (noNotes.length <= max) return { text: noNotes, count, dropped: 'notes' };
  const bare = text(false, false);
  if (bare.length <= max) return { text: bare, count, dropped: 'notes+thumbs' };
  return { text: '', count, tooBig: true };
}

function cleanNotes(v: unknown): AiNote[] {
  if (!Array.isArray(v)) return [];
  const out: AiNote[] = [];
  const keys = new Set<string>();
  for (const x of v) {
    if (!isObj(x)) continue;
    const { key, kind, title, text, createdAt, provider, model, ...rest } = x;
    if (typeof key !== 'string' || !key || keys.has(key) || typeof kind !== 'string' || typeof text !== 'string') continue;
    keys.add(key);
    out.push({
      // 各功能自己另记的(史书的书目、释名写的时候的名字……)原样带上,用的时候各功能自己再检查;太大的不要
      ...(JSON.stringify(rest).length <= NOTE_EXTRA_MAX ? rest : {}),
      key: key.slice(0, 200),
      kind: kind.slice(0, 40),
      title: typeof title === 'string' ? title.slice(0, 200) : '',
      text,
      createdAt: typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : '',
      provider: typeof provider === 'string' ? provider.slice(0, 80) : '',
      model: typeof model === 'string' ? model.slice(0, 120) : '',
    });
  }
  return out;
}

/**
 * 读文件:不是「全部存成文件」存的(比如单个世界的存档)= null,交给 parseSave;
 * 是这种文件但读不了 = 中文错误;个别世界坏了的跳过、记个数
 */
export function parseBundle(text: string, max = MAX_LEN): { ok: true; bundle: Bundle } | { ok: false; error: string } | null {
  if (typeof text !== 'string' || text.length > max) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.app !== SAVE_APP || raw.bundle === undefined) return null;
  const f = raw.bundle;
  if (typeof f !== 'number' || !Number.isInteger(f) || f < 1) return { ok: false, error: '文件坏了:缺少格式版本' };
  if (f > BUNDLE_FORMAT) return { ok: false, error: '这个文件来自更新版本的「文明与地图」,请刷新页面换到最新版再打开' };
  if (!Array.isArray(raw.worlds)) return { ok: false, error: '文件坏了:里面没有世界' };
  const worlds: BundleWorld[] = [];
  let bad = 0;
  for (const x of raw.worlds) {
    const r = isObj(x) ? parseSave(JSON.stringify(x.save ?? null)) : null;
    if (!r?.ok || !isObj(x)) {
      bad++;
      continue;
    }
    const thumb = typeof x.thumb === 'string' && x.thumb.length <= THUMB_MAX && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x.thumb) ? x.thumb : null;
    const id = typeof x.id === 'string' && x.id.length <= 64 ? x.id : undefined;
    const opened = typeof x.opened === 'string' && x.opened.length <= 40 && !Number.isNaN(Date.parse(x.opened)) ? new Date(x.opened).toISOString() : undefined;
    worlds.push({ ...(id ? { id } : {}), save: r.save, meta: cleanSyncMeta(x.meta), ...(opened ? { opened } : {}), thumb, notes: cleanNotes(x.notes) });
  }
  return { ok: true, bundle: { worlds, bad } };
}

export interface ImportResult {
  /** 放进来的世界编号 */
  added: string[];
  /** 已经有一模一样的、没重复放的 */
  same: number;
  /** 其中补上了缺的 AI 写的东西、缩略图的 */
  filled: number;
  /** 没放进去的(放满了、存不下) */
  left: number;
  /** 为什么没放进去:"full" 放满了、"storage" 浏览器存不下 */
  why?: 'full' | 'storage';
  /** AI 写的东西有没能存进浏览器的 */
  notesLost: boolean;
}

/**
 * 已经有的同一个世界:文件里有、这边缺的投影、AI 写的东西(按条)、缩略图、现存几国、底稿补上,文件里"最近打开"更晚的用文件里的;
 * 返回补了没有(不算"最近打开")、AI 写的东西存进去没有
 */
function fillFrom(id: string, w: BundleWorld, base: DraftBase | undefined): { filled: boolean; notesOk: boolean } {
  let filled = fillMissing(id, { view: w.save.view, thumb: w.thumb, alive: w.meta.alive, base, opened: w.opened });
  let notesOk = true;
  const have = exportNotes(id);
  const keys = new Set(have.map((n) => n.key));
  const more = w.notes.filter((n) => !keys.has(n.key));
  // 上次没能写进浏览器(存储满了)、只在页面里的,这次再写一遍
  const unsaved = !notesSaved(id);
  if (more.length || unsaved) {
    notesOk = replaceNotes(id, [...have, ...more]);
    if (more.length || notesOk) filled = true;
  }
  return { filled, notesOk };
}

/** 同一个世界:存档一样(sameSave),生成器版本、地形哈希也一样(版本不同的同样参数可能是两个不同的世界) */
const sameWorld = (a: SaveFile, b: SaveFile) => sameSave(a, b) && a.generator === b.generator && a.check === b.check;

/** 放回「我的世界」(见文件头) */
export function importBundle(b: Bundle): ImportResult {
  const have = listWorlds().map((w) => ({ id: w.id, save: w.save, draft: w.draft, base: w.base }));
  let count = have.length;
  const res: ImportResult = { added: [], same: 0, filled: 0, left: 0, notesLost: false };
  /** 文件里的编号 → 现在的编号(放进来的、原来就有的) */
  const ids = new Map<string, string>();
  // 建好的先放:没建完的放的时候,它的底稿已经有了新编号
  const order = [...b.worlds.filter((w) => !w.meta.draft), ...b.worlds.filter((w) => w.meta.draft)];
  for (const w of order) {
    const draft = !!w.meta.draft;
    // 没建完的记着的底稿:文件里的编号换成现在的
    const old = w.meta.base;
    const base = old && ids.has(old.id) ? { ...old, id: ids.get(old.id)! } : old;
    // 没建完的还要底稿一样才算同一个(有一边不知道底稿的不算不一样,这边缺的用文件里的补上)
    const dup = have.find((h) => h.draft === draft && sameWorld(h.save, w.save) && (!draft || !h.base || !base || h.base.id === base.id));
    if (dup) {
      if (w.id) ids.set(w.id, dup.id);
      res.same++;
      const f = fillFrom(dup.id, w, draft && !dup.base ? base : undefined);
      if (f.filled) res.filled++;
      if (!f.notesOk) res.notesLost = true;
      continue;
    }
    if (res.why) {
      res.left++;
      continue;
    }
    if (count >= MAX_WORLDS) {
      res.why = 'full';
      res.left++;
      continue;
    }
    const id = newWorldId();
    const meta: SyncMeta = base !== old ? { ...w.meta, base } : w.meta;
    if (!putSyncedWorld(id, { save: JSON.stringify(w.save), meta, thumb: w.thumb }, w.opened)) {
      res.why = 'storage';
      res.left++;
      continue;
    }
    if (w.id) ids.set(w.id, id);
    if (w.notes.length && !replaceNotes(id, w.notes)) res.notesLost = true;
    have.push({ id, save: w.save, draft, base: draft ? base : undefined });
    count++;
    res.added.push(id);
  }
  return res;
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 「我的世界」里点「全部存成文件」 */
export function downloadAll() {
  const b = bundleText();
  if (!b) return notify({ kind: 'error', text: '「我的世界」里还没有世界' });
  if (b.tooBig) return notify({ kind: 'error', text: '没能存成文件', more: ['世界太多、太大，一个文件放不下'] });
  const name = bundleFileName();
  download(b.text, name);
  (window as unknown as { __wfBundle?: { name: string; count: number; bytes: number } }).__wfBundle = { name, count: b.count, bytes: new Blob([b.text]).size };
  const more = [`${name}；以后点「打开存档文件」选它，这些世界都会回来`];
  if (b.dropped) more.push(`${b.dropped === 'notes' ? 'AI 写的东西' : 'AI 写的东西和缩略图'}太多，一个文件放不下，没有带上`);
  notify({ kind: b.dropped ? 'warn' : 'ok', dot: !b.dropped, text: `${b.count} 个世界已存成一个文件`, more });
}

/** 「打开存档文件」选的是「全部存成文件」存的文件:放回来、说一声,返回 true;不是这种文件 = false(按单个世界的存档读) */
export function openBundleText(text: string, fileName?: string): boolean {
  const r = parseBundle(text);
  if (!r) return false;
  if (!r.ok) {
    notify({ kind: 'error', text: fileName ? `打不开 ${fileName}` : '打不开这个文件', more: [r.error] });
    return true;
  }
  const { worlds, bad } = r.bundle;
  if (!worlds.length) {
    notify({ kind: 'error', text: fileName ? `打不开 ${fileName}` : '打不开这个文件', more: [bad ? `里面的 ${bad} 个世界都读不出来` : '这个文件里没有世界'] });
    return true;
  }
  const res = importBundle(r.bundle);
  const more: string[] = [];
  if (res.same) more.push(res.added.length ? `${res.same} 个原来就有，没重复放` : '');
  if (res.filled) more.push(`${res.filled} 个原来就有的补上了缺的 AI 写的东西或缩略图`);
  if (res.left) more.push(`还有 ${res.left} 个没放进去：${res.why === 'full' ? `「我的世界」最多存 ${MAX_WORLDS} 个世界，先删掉几个再打开一次` : '浏览器存储已满，先删掉几个世界再打开一次'}`);
  if (bad) more.push(`${bad} 个世界读不出来，跳过了`);
  if (res.notesLost) more.push('有的 AI 写的东西没能放回来（浏览器存储已满）');
  // 浏览器不让存(隐私模式之类):放回来的只在内存里,关掉页面就没了
  const memOnly = res.added.length > 0 && !persistent();
  if (memOnly) more.unshift('浏览器不让网页存数据：放回来的世界只留在这个页面里，关掉就没了，这个文件先别删');
  const lines = more.filter(Boolean);
  if (res.added.length) {
    notify({ kind: res.left || bad || res.notesLost || memOnly ? 'warn' : 'ok', text: `已放回 ${res.added.length} 个世界`, more: lines });
  } else if (res.left) {
    notify({ kind: 'error', text: '没能放回来', more: lines });
  } else {
    notify({ kind: bad ? 'warn' : 'ok', text: '这些世界都已经在「我的世界」里了', more: lines });
  }
  return true;
}

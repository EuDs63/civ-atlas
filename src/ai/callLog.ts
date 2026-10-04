/**
 * AI 调用记录的本地存储(阶段 5):每次调用 aiChat(成功或失败)记一条,用户在"AI → 调用记录"里翻看。只存本地,不上传。
 *
 * - 存在浏览器的 IndexedDB('civ-atlas-ai' 库的 'calls' 表)里,容量比 localStorage 大得多;
 *   打不开(隐私模式、浏览器禁用)或存不下时退回内存(这次打开的页面里还能看,刷新就没了),界面上会说明
 * - 最多留最近 500 条;所有记录合计超过约 400 万字(≈8 MB)时从最旧的删起
 * - 记录里只有发出去的消息、收到的全文、用量、耗时、错误说明;不存请求头和密钥(见 client.ts 的 aiChat)
 */
import { useSyncExternalStore } from 'react';
import { setCallRecorder } from './client';
import { scrubSecrets } from './settings';
import type { AiCallRecord } from './types';

export const MAX_CALLS = 500;
export const MAX_CHARS = 4_000_000;

/** 存储后端(IndexedDB;单测里换成假的) */
export interface CallLogBackend {
  load(): Promise<AiCallRecord[]>;
  put(rec: AiCallRecord): Promise<void>;
  remove(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

let list: AiCallRecord[] = [];
const sizes = new Map<string, number>();
let total = 0;
let backend: CallLogBackend | null = null;
/** 记录是存进浏览器了(true),还是只在内存里(false) */
let persistent = false;
let loaded = false;
let ready: Promise<void> = Promise.resolve();

const subs = new Set<() => void>();
let snap: CallLogState | null = null;
const emit = () => {
  snap = null;
  for (const f of subs) f();
};

export interface CallLogState {
  /** 新的在前 */
  calls: readonly AiCallRecord[];
  /** 存进浏览器了;false = 只在内存里(隐私模式 / 存不下) */
  persistent: boolean;
  /** 已从浏览器里读出旧记录 */
  loaded: boolean;
}

const sizeOf = (r: AiCallRecord) => {
  try {
    return JSON.stringify(r).length;
  } catch {
    return 0;
  }
};

function valid(r: unknown): r is AiCallRecord {
  const o = r as AiCallRecord;
  return !!o && typeof o.id === 'string' && typeof o.at === 'string' && typeof o.feature === 'string' && Array.isArray(o.messages);
}

function index(r: AiCallRecord) {
  const s = sizeOf(r);
  sizes.set(r.id, s);
  total += s;
}

function unindex(id: string) {
  total -= sizes.get(id) ?? 0;
  sizes.delete(id);
}

/** 按条数和体积裁掉最旧的,返回裁掉的编号 */
function trim(maxChars = MAX_CHARS): string[] {
  const removed: string[] = [];
  while (list.length > MAX_CALLS || (total > maxChars && list.length > 1)) {
    const r = list.pop()!;
    unindex(r.id);
    removed.push(r.id);
  }
  return removed;
}

/** IndexedDB 后端;浏览器没有 IndexedDB 时返回 null */
export function indexedDbBackend(name = 'civ-atlas-ai'): CallLogBackend | null {
  let idb: IDBFactory;
  try {
    if (typeof indexedDB === 'undefined') return null;
    idb = indexedDB;
  } catch {
    return null;
  }
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains('calls')) r.result.createObjectStore('calls', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error('IndexedDB 打不开'));
      r.onblocked = () => reject(new Error('IndexedDB 被占用'));
    }));
  function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    return db().then(
      (d) =>
        new Promise<T | undefined>((resolve, reject) => {
          const t = d.transaction('calls', mode);
          const req = fn(t.objectStore('calls'));
          t.oncomplete = () => resolve(req ? req.result : undefined);
          t.onerror = () => reject(t.error ?? new Error('IndexedDB 写入失败'));
          t.onabort = () => reject(t.error ?? new Error('IndexedDB 写入中止'));
        }),
    );
  }
  return {
    load: async () => ((await tx<AiCallRecord[]>('readonly', (s) => s.getAll())) ?? []) as AiCallRecord[],
    put: async (rec) => {
      await tx('readwrite', (s) => {
        s.put(rec);
      });
    },
    remove: async (ids) => {
      if (!ids.length) return;
      await tx('readwrite', (s) => {
        for (const id of ids) s.delete(id);
      });
    },
    clear: async () => {
      await tx('readwrite', (s) => {
        s.clear();
      });
    },
  };
}

/**
 * 启动时调一次:读出存过的记录,并把 aiChat 的记录器换成"存本地"的。
 * b 不传 = 用 IndexedDB;传 null = 只在内存(单测)。
 */
export function initCallLog(b?: CallLogBackend | null): Promise<void> {
  backend = b === undefined ? indexedDbBackend() : b;
  persistent = false;
  loaded = false;
  setCallRecorder(recordCall);
  const be = backend;
  ready = (async () => {
    if (be) {
      try {
        const old = (await be.load()).filter(valid);
        // 读的时候可能已经记了新的:合并、去重、按时间新的在前
        const seen = new Set(list.map((r) => r.id));
        for (const r of old) {
          if (seen.has(r.id)) continue;
          list.push(r);
          index(r);
        }
        list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
        persistent = true;
        const removed = trim();
        if (removed.length) await be.remove(removed).catch(() => {});
        // 读之前就记下的几条补存进去
        for (const r of list) if (!old.some((o) => o.id === r.id)) await be.put(r).catch(() => {});
      } catch {
        backend = null;
        persistent = false;
      }
    }
    loaded = true;
    emit();
  })();
  return ready;
}

async function save(rec: AiCallRecord, removed: string[]) {
  await ready;
  const be = backend;
  if (!be) return;
  try {
    await be.put(rec);
    if (removed.length) await be.remove(removed);
  } catch {
    // 多半是存不下了:把最旧的一批删掉再试一次;还不行就只在内存里记
    const extra = trim(Math.floor(total * 0.6));
    try {
      await be.remove([...removed, ...extra]);
      await be.put(rec);
    } catch {
      backend = null;
      persistent = false;
    }
    emit();
  }
}

/** 记一条(aiChat 调用;密钥万一混进错误说明里也遮掉) */
export function recordCall(rec: AiCallRecord): void {
  const r: AiCallRecord = rec.error ? { ...rec, error: { ...rec.error, message: scrubSecrets(rec.error.message) } } : rec;
  const i = list.findIndex((x) => x.id === r.id);
  if (i >= 0) {
    unindex(r.id);
    list.splice(i, 1);
  }
  list.unshift(r);
  index(r);
  const removed = trim();
  emit();
  void save(r, removed);
}

export function deleteCall(id: string): void {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  list.splice(i, 1);
  unindex(id);
  emit();
  void ready.then(() => backend?.remove([id]).catch(() => {}));
}

export function clearCalls(): void {
  list = [];
  sizes.clear();
  total = 0;
  emit();
  void ready.then(() => backend?.clear().catch(() => {}));
}

export function getCallLog(): CallLogState {
  if (!snap) snap = { calls: list.slice(), persistent, loaded };
  return snap;
}

/** 等存储读写告一段落(单测用) */
export async function callLogSettled(): Promise<void> {
  await ready;
  await new Promise((r) => setTimeout(r, 0));
}

/** 导出成 JSON 文本(用户下载;不含任何密钥) */
export function exportCallsJson(): string {
  return JSON.stringify(
    { app: '文明与地图', kind: 'AI 调用记录', exportedAt: new Date().toISOString(), count: list.length, calls: list },
    null,
    2,
  );
}

/** React:调用记录变了就重渲染 */
export function useCallLog(): CallLogState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    getCallLog,
    getCallLog,
  );
}

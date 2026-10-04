/**
 * AI 写出来的东西(史书、释名……)按世界存在本地浏览器里(阶段 5)。只存本地,不上传。
 * 世界 = saveStore 的世界编号(种子 + 参数);浏览器存储不可用(隐私模式)时只在内存里。
 *
 * 各功能用自己的 kind 区分("史书""释名"……),key 由功能自己定(比如 "史书:polity:c4567#0" 或 "释名:settlement:c123#0")。
 */
import { useSyncExternalStore } from 'react';

export interface AiNote {
  /** 功能内唯一的键 */
  key: string;
  /** 哪个功能写的:"史书""释名"…… */
  kind: string;
  /** 显示用的标题 */
  title: string;
  text: string;
  /** ISO 时间 */
  createdAt: string;
  provider: string;
  model: string;
}

const PREFIX = 'civ-atlas:ai-notes:';
const mem = new Map<string, AiNote[]>();
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
};

function read(world: string): AiNote[] {
  const m = mem.get(world);
  if (m) return m;
  let list: AiNote[] = [];
  try {
    const raw = localStorage.getItem(PREFIX + world);
    if (raw) {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v.filter((x) => x && typeof x.key === 'string' && typeof x.text === 'string');
    }
  } catch {
    /* 隐私模式 / 坏数据:当作没有 */
  }
  mem.set(world, list);
  return list;
}

function write(world: string, list: AiNote[]) {
  mem.set(world, list);
  try {
    if (list.length) localStorage.setItem(PREFIX + world, JSON.stringify(list));
    else localStorage.removeItem(PREFIX + world);
  } catch {
    /* 存不下 / 隐私模式:只留在内存里 */
  }
  emit();
}

export function listNotes(world: string, kind?: string): AiNote[] {
  const list = read(world);
  return kind ? list.filter((n) => n.kind === kind) : list.slice();
}

export function getNote(world: string, key: string): AiNote | undefined {
  return read(world).find((n) => n.key === key);
}

/** 存一条(同 key 覆盖) */
export function putNote(world: string, note: AiNote): void {
  const list = read(world).filter((n) => n.key !== note.key);
  list.push(note);
  write(world, list);
}

export function deleteNote(world: string, key: string): void {
  const list = read(world);
  if (!list.some((n) => n.key === key)) return;
  write(
    world,
    list.filter((n) => n.key !== key),
  );
}

/** React:某个世界的笔记变了就重渲染(返回一个递增的版本号) */
export function useNotesVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
    () => version,
  );
}

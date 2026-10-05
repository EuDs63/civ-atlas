/**
 * 用 AI 执行 / 撤销一批修改以后,App 推完在提示条上说结果("已按你说的改写"并带撤销)。
 * 助手(assistantStore.ts)改修改之前用 noteRewrite 记下这一回;App 在修改变了、推完以后用 takeRewriteNote 取走。
 * 只改名的不用重推,助手当场说,不走这里。
 */
import type { WorldEdits } from '../gen/edits';

export interface RewriteNote {
  kind: 'apply' | 'undo';
  /** 哪一轮 */
  turn: number;
  before: WorldEdits;
  after: WorldEdits;
  /** 提示条上的"撤销"做什么(只有执行时给) */
  undo?: () => void;
}

let note: (RewriteNote & { edits: WorldEdits }) | null = null;

/** App 用:修改刚变成 e,是不是一次改写 / 撤销改写(取走;不是 = null) */
export function takeRewriteNote(e: WorldEdits): RewriteNote | null {
  if (!note || note.edits !== e) return null;
  const n = note;
  note = null;
  return { kind: n.kind, turn: n.turn, before: n.before, after: n.after, ...(n.undo ? { undo: n.undo } : {}) };
}

/** 执行 / 撤销一批修改之前调:修改变成 edits 以后,App 推完在提示条上说"已按你说的改写",撤销走 n.undo */
export function noteRewrite(n: RewriteNote & { edits: WorldEdits }) {
  note = n;
}

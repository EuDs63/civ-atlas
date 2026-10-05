/**
 * 撤销 / 重做最近一次修改(⌘Z / ⇧⌘Z):改名、干预、AI 改写;记录在 editsStore.ts(只记这次打开网页以后、这个世界上的)。
 *
 * - 干预:和点提示条上的"撤销"一样 —— 干预列表一变,App 在后台重推历史,推完提示"已撤销,从 N 年起重新推演"
 *   (重做 = 又下了这条令,提示"…,已从 N 年起重新推演"带撤销)
 * - 助手执行过的一轮:交给助手那边撤销 / 再做一遍(对话里的"已执行 / 已撤销"跟着变;提示和点"撤销"一样)
 * - 只改了名字:当场换回去,提示"已撤销改名" / "已重做改名"
 */
import { getEdits, replaceEdits, revertEdits, stepEdits, type EditStep } from './editsStore';
import { redoProposal, undoProposal } from './assistantStore';
import { showToast } from './toastStore';

/** 撤销最近一步;没有可撤销的 = false */
export function undoLastEdit(): boolean {
  return stepEdits('undo', (s) => run(s, 'undo'));
}

/** 重做刚撤销的一步;没有可重做的 = false */
export function redoLastEdit(): boolean {
  return stepEdits('redo', (s) => run(s, 'redo'));
}

function run(s: EditStep, dir: 'undo' | 'redo') {
  if (s.turn) {
    // 执行过的一轮:撤销 = 撤销这一轮,重做 = 再做一遍;记下的是"撤销了一轮"就反过来
    const again = (s.turn.kind === 'apply') === (dir === 'redo');
    return again ? redoProposal(s.turn.id) : undoProposal(s.turn.id);
  }
  const now = getEdits();
  const next = dir === 'undo' ? revertEdits(now, s.after, s.before) : revertEdits(now, s.before, s.after);
  if (next === now) return;
  replaceEdits(next);
  if (next.interventions === now.interventions && next.terrain === now.terrain) {
    showToast({ id: 'resim-done', kind: 'ok', text: dir === 'undo' ? '已撤销改名' : '已重做改名', ttl: 4000 });
  }
}

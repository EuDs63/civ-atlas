/**
 * 键盘快捷键:按键 → 动作(按物理键位认,⌘ / Ctrl 都认)、界面上怎么写这个键(苹果写 ⌘,别的写 Ctrl);
 * 撤销 / 重做的记录(改名、干预各记一步;读档清空;中间又改过别的只退这一步)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type Intervention, type WorldEdits } from '../src/gen/edits';
import { SHORTCUT_GROUPS, keyLabel, matchShortcut, type KeyLike } from '../src/ui/shortcuts';
import {
  HISTORY_MAX,
  addIntervention,
  addTerrainOp,
  canRedoEdit,
  canUndoEdit,
  clearEditHistory,
  clearEdits,
  getEdits,
  removeIntervention,
  revertEdits,
  setEdits,
  setName,
} from '../src/ui/editsStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { clearToast, getToast } from '../src/ui/toastStore';

const key = (code: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const P = (n: number) => `polity:r${n}#0`;
const protect = (n: number, from = 100): Intervention => ({ kind: 'protect', a: P(n), from });

afterEach(() => {
  clearEdits();
  clearToast();
});

describe('快捷键 · 按键', () => {
  it('不带修饰键:空格、← →(Shift 100 年)、+ −、1–4、/、?', () => {
    expect(matchShortcut(key('Space', ' '))).toBe('play');
    expect(matchShortcut(key('ArrowLeft', 'ArrowLeft'))).toBe('back');
    expect(matchShortcut(key('ArrowRight', 'ArrowRight'))).toBe('forward');
    expect(matchShortcut(key('ArrowLeft', 'ArrowLeft', { shiftKey: true }))).toBe('back100');
    expect(matchShortcut(key('ArrowRight', 'ArrowRight', { shiftKey: true }))).toBe('forward100');
    expect(matchShortcut(key('Equal', '='))).toBe('zoomIn');
    expect(matchShortcut(key('Equal', '+', { shiftKey: true }))).toBe('zoomIn');
    expect(matchShortcut(key('NumpadAdd', '+'))).toBe('zoomIn');
    expect(matchShortcut(key('Minus', '-'))).toBe('zoomOut');
    expect(matchShortcut(key('NumpadSubtract', '-'))).toBe('zoomOut');
    expect(['Digit1', 'Digit2', 'Digit3', 'Digit4'].map((c) => matchShortcut(key(c, c.slice(-1))))).toEqual(['layer1', 'layer2', 'layer3', 'layer4']);
    expect(matchShortcut(key('Numpad3', '3'))).toBe('layer3');
    expect(matchShortcut(key('Digit5', '5'))).toBeNull();
    expect(matchShortcut(key('Digit0', '0'))).toBeNull();
    expect(matchShortcut(key('Slash', '/'))).toBe('search');
    expect(matchShortcut(key('Slash', '?', { shiftKey: true }))).toBe('help');
    expect(matchShortcut(key('KeyA', 'a'))).toBeNull();
    expect(matchShortcut(key('Escape', 'Escape'))).toBeNull();
  });

  it('数字、空格按键位认(中文、日文输入法,法文键盘打出来的字不一样也照样认);+ − / ? 按键帽上的字认', () => {
    expect(matchShortcut(key('Digit2', 'ふ'))).toBe('layer2');
    expect(matchShortcut(key('Digit2', 'é'))).toBe('layer2');
    expect(matchShortcut(key('Space', ' '))).toBe('play');
    // 中文标点、全角符号、死键:按键位当美式键盘上的字
    expect(matchShortcut(key('Slash', '、'))).toBe('search');
    expect(matchShortcut(key('Slash', '？', { shiftKey: true }))).toBe('help');
    expect(matchShortcut(key('Equal', '＋', { shiftKey: true }))).toBe('zoomIn');
    expect(matchShortcut(key('Minus', 'Dead'))).toBe('zoomOut');
    // 德文键盘:+ 是单独一个键、− 在美式键盘 / 的位置、/ 是 Shift + 7、? 是 Shift + ß;ß 本身不管
    expect(matchShortcut(key('BracketRight', '+'))).toBe('zoomIn');
    expect(matchShortcut(key('Slash', '-'))).toBe('zoomOut');
    expect(matchShortcut(key('Digit7', '/', { shiftKey: true }))).toBe('search');
    expect(matchShortcut(key('Minus', '?', { shiftKey: true }))).toBe('help');
    expect(matchShortcut(key('Minus', 'ß'))).toBeNull();
    // 按着 Shift 的数字、空格、_ 不管
    expect(matchShortcut(key('Digit1', '!', { shiftKey: true }))).toBeNull();
    expect(matchShortcut(key('Space', ' ', { shiftKey: true }))).toBeNull();
    expect(matchShortcut(key('Minus', '_', { shiftKey: true }))).toBeNull();
  });

  it('带 ⌘ / Ctrl:Z 撤销、Shift+Z 重做(Windows 的 Ctrl+Y 也是重做)、S 存档、\\ 收起左边;别的组合留给浏览器', () => {
    for (const m of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(matchShortcut(key('KeyZ', 'z', m))).toBe('undo');
      expect(matchShortcut(key('KeyZ', 'Z', { ...m, shiftKey: true }))).toBe('redo');
      expect(matchShortcut(key('KeyS', 's', m))).toBe('save');
      expect(matchShortcut(key('Backslash', '\\', m))).toBe('side');
      // ⌘F 查找、⌘+ ⌘− 整页放大、⌘数字 切标签页、⌘Shift+S 都不占
      expect(matchShortcut(key('KeyF', 'f', m))).toBeNull();
      expect(matchShortcut(key('Equal', '=', m))).toBeNull();
      expect(matchShortcut(key('Minus', '-', m))).toBeNull();
      expect(matchShortcut(key('Digit1', '1', m))).toBeNull();
      expect(matchShortcut(key('Space', ' ', m))).toBeNull();
      expect(matchShortcut(key('ArrowLeft', 'ArrowLeft', m))).toBeNull();
      expect(matchShortcut(key('KeyS', 'S', { ...m, shiftKey: true }))).toBeNull();
    }
    expect(matchShortcut(key('KeyY', 'y', { ctrlKey: true }))).toBe('redo');
    expect(matchShortcut(key('KeyY', 'y', { metaKey: true }))).toBeNull();
    // ⌥ 一律不管(Mac 上 ⌥ 加字母是打特殊字符)
    expect(matchShortcut(key('Digit1', '¡', { altKey: true }))).toBeNull();
    expect(matchShortcut(key('KeyZ', 'Ω', { altKey: true, metaKey: true }))).toBeNull();
  });

  it('键怎么写:苹果写 ⌘ ⇧,别的写 Ctrl、Shift;一览里三组 11 行,每行的键都写得出来', () => {
    expect(keyLabel('undo', true)).toBe('⌘Z');
    expect(keyLabel('redo', true)).toBe('⇧⌘Z');
    expect(keyLabel('save', true)).toBe('⌘S');
    expect(keyLabel('side', true)).toBe('⌘\\');
    expect(keyLabel('back100', true)).toBe('⇧←');
    expect(keyLabel('undo', false)).toBe('Ctrl+Z');
    expect(keyLabel('redo', false)).toBe('Ctrl+Shift+Z');
    expect(keyLabel('save', false)).toBe('Ctrl+S');
    expect(keyLabel('side', false)).toBe('Ctrl+\\');
    expect(keyLabel('forward100', false)).toBe('Shift+→');
    expect(keyLabel('play', false)).toBe('空格');
    expect(keyLabel('zoomOut', true)).toBe('−');
    expect(keyLabel('esc', true)).toBe('Esc');
    expect(SHORTCUT_GROUPS.map((g) => g.title)).toEqual(['时间', '地图', '世界']);
    const rows = SHORTCUT_GROUPS.flatMap((g) => g.rows);
    expect(rows.length).toBe(11);
    for (const r of rows) for (const k of r.keys) for (const mac of [true, false]) expect(keyLabel(k, mac)).toMatch(/\S/);
  });
});

describe('快捷键 · 撤销 / 重做', () => {
  it('改名:一次一步;撤销回到改之前,重做回到改之后;提示条说"已撤销改名""已重做改名"', () => {
    expect(canUndoEdit()).toBe(false);
    expect(undoLastEdit()).toBe(false);
    setName('settlement:r1#0', '甲城');
    setName('settlement:r1#0', '乙城');
    setName('settlement:r2#0', '丙城');
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '乙城', 'settlement:r2#0': '丙城' });
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '乙城' });
    expect(getToast()?.text).toBe('已撤销改名');
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '甲城' });
    expect(canRedoEdit()).toBe(true);
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '乙城' });
    expect(getToast()?.text).toBe('已重做改名');
    // 撤销以后又改了别的:重做的那几步作废
    setName('settlement:r3#0', '丁城');
    expect(canRedoEdit()).toBe(false);
    expect(redoLastEdit()).toBe(false);
    expect(undoLastEdit()).toBe(true);
    expect(undoLastEdit()).toBe(true);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().names).toEqual({});
    expect(undoLastEdit()).toBe(false);
  });

  it('干预:撤销拿掉这一条(列表换成新数组,不当成读档恢复),重做放回原来的位置;不出改名的提示', () => {
    addIntervention(protect(1));
    addIntervention(protect(2));
    addIntervention(protect(3));
    const three = getEdits().interventions;
    removeIntervention(1);
    expect(getEdits().interventions).toEqual([protect(1), protect(3)]);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().interventions).toEqual(three);
    expect(getEdits().interventions).not.toBe(three);
    expect(getToast()).toBeNull();
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().interventions).toEqual([protect(1), protect(3)]);
  });

  it('中间又改过别的(比如点了提示条上的撤销以后又下了令):只退这一步碰过的,之后的修改留着', () => {
    addIntervention(protect(1));
    setName('region:r5', '东州');
    addIntervention(protect(2));
    // 撤销到下令"保护 1"之前,但名字和"保护 2"是之后的修改,要留着
    const now = getEdits();
    const before = { ...EMPTY_EDITS };
    const after: WorldEdits = { ...EMPTY_EDITS, interventions: [protect(1)] };
    expect(revertEdits(now, after, before)).toEqual({ names: { 'region:r5': '东州' }, interventions: [protect(2)], terrain: [] });
    // 改过的名字已经又被改掉:不换回去
    const named: WorldEdits = { ...EMPTY_EDITS, names: { 'region:r5': '东州' } };
    const renamed: WorldEdits = { ...EMPTY_EDITS, names: { 'region:r5': '北州' } };
    expect(revertEdits(renamed, named, EMPTY_EDITS)).toBe(renamed);
    // 放回去:插回它原来的位置;已经有一条一样的就不重复放
    const two = [protect(1), protect(2)];
    expect(revertEdits({ ...EMPTY_EDITS, interventions: [protect(2)] }, EMPTY_EDITS, { ...EMPTY_EDITS, interventions: two }).interventions).toEqual(two);
    const same = { ...EMPTY_EDITS, interventions: two };
    expect(revertEdits(same, EMPTY_EDITS, { ...EMPTY_EDITS, interventions: [protect(1)] })).toBe(same);
  });

  it('读档、换世界、创建世界清空记录;地形修改不记;最多记 100 步', () => {
    setName('region:r1', '甲');
    setEdits({ ...EMPTY_EDITS, names: { 'region:r1': '乙' } });
    expect(canUndoEdit()).toBe(false);
    setName('region:r1', '丙');
    clearEditHistory();
    expect(canUndoEdit()).toBe(false);
    expect(getEdits().names['region:r1']).toBe('丙');
    addTerrainOp({ kind: 'volcano', pts: [100, 100], r: 40, s: 1 });
    expect(getEdits().terrain.length).toBe(1);
    expect(canUndoEdit()).toBe(false);
    for (let i = 0; i < HISTORY_MAX + 20; i++) setName('region:r2', `名${i}`);
    let n = 0;
    while (undoLastEdit()) n++;
    expect(n).toBe(HISTORY_MAX);
    expect(getEdits().names['region:r2']).toBe('名19');
    clearEdits();
    expect(canRedoEdit()).toBe(false);
  });
});

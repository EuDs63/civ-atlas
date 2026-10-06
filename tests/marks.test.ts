/**
 * 作者标记:数据清理(gen/edits.ts)、存档和分享链接、修改和撤销(ui/editsStore.ts、undo.ts)、填写卡片的状态(ui/markStore.ts)、
 * 地图上的摆放(render/marks.ts:写不写名字、名字放哪边、合并、点到哪个)、在哪 / 归谁 / 那几年的事(ui/markInfo.ts)、搜索和飞过去。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { rasterize, type Raster } from '../src/gen/raster';
import {
  EMPTY_EDITS,
  INTERVENTION_YEAR_MAX,
  MARKS_MAX,
  MARK_ID_MAX,
  MARK_NOTE_MAX,
  MARK_REGIONS_MAX,
  MARK_REGIONS_TOTAL,
  MARK_TITLE_DEFAULT,
  MARK_TITLE_MAX,
  cleanMark,
  cleanMarks,
  markShownAt,
  nextMarkId,
  regionKey,
  type AuthorMark,
  type WorldEdits,
} from '../src/gen/edits';
import { decodeShare, editCount, encodeShare, makeSave, parseSave, saveText } from '../src/gen/savefile';
import { addMark, clearEdits, commitEdits, getEdits, removeMark, restoreMark, revertEdits, setName, updateMark } from '../src/ui/editsStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { clearToast, getToast } from '../src/ui/toastStore';
import { clearSelection, getSelection, setSelection } from '../src/ui/civView';
import { cancelDraft, draftProblem, editMarkDraft, finishDraft, getMarkUi, newMarkDraft, patchDraft, resetMarkUi, startPlacing, toggleDraftRegion, togglePlacing, type MarkDraft } from '../src/ui/markStore';
import { CLUSTER_PX, DIM_ALPHA, NAME_ZOOM, hitMark, layoutMarks, markAreaShape, type MarkFrame, type MarkItem } from '../src/render/marks';
import { markEvents, markOwners, markPlaceText, markShapeOf, markSpot, regionsText, spotText } from '../src/ui/markInfo';
import { searchCiv, searchMarks } from '../src/ui/searchIndex';
import { markFocus } from '../src/ui/flyTo';

const base = (over: Partial<AuthorMark> = {}): AuthorMark => ({ id: 1, title: '主角的故乡', color: 'red', from: 2490, at: [1852.4, 512], ...over });

afterEach(() => {
  resetMarkUi();
  clearSelection();
  clearEdits();
  clearToast();
});

describe('作者标记 · 数据清理', () => {
  it('本来就合格的原样返回(同一个对象),列表也是', () => {
    const a = base();
    const b = base({ id: 2, title: '第三卷', color: 'orange', from: 2506, to: 2515, at: undefined, regions: ['region:c123', 'region:c456'], note: '主战场\n林小满在楚尧帐下' });
    delete b.at;
    expect(cleanMark(a)).toBe(a);
    expect(cleanMark(b)).toBe(b);
    const list = [a, b];
    expect(cleanMarks(list)).toBe(list);
  });

  it('位置:x 绕回 [0, 2048)、y 夹回 [0, 1024],保留一位小数;几个州和点都给了按几个州', () => {
    expect(cleanMark(base({ at: [-10, 500] }))!.at).toEqual([2038, 500]);
    expect(cleanMark(base({ at: [2050.04, -3] }))!.at).toEqual([2, 0]);
    expect(cleanMark(base({ at: [2047.97, 2000] }))!.at).toEqual([0, 1024]);
    expect(cleanMark(base({ at: [100.123, 200.456] }))!.at).toEqual([100.1, 200.5]);
    const both = cleanMark(base({ regions: ['region:c1'] }))!;
    expect(both.regions).toEqual(['region:c1']);
    expect(both.at).toBeUndefined();
    // 州键格式不对的、重复的去掉;最多 MARK_REGIONS_MAX 个
    expect(cleanMark({ ...base(), at: undefined, regions: ['region:c1', 'x', 'region:c1', 'region:r5'] })!.regions).toEqual(['region:c1', 'region:r5']);
    const many = Array.from({ length: MARK_REGIONS_MAX + 20 }, (_, i) => `region:c${i}`);
    expect(cleanMark({ ...base(), at: undefined, regions: many })!.regions!.length).toBe(MARK_REGIONS_MAX);
  });

  it('不合格的丢掉:没有位置、编号不是正整数、年份不是数、坐标不是数', () => {
    expect(cleanMark({ ...base(), at: undefined })).toBeNull();
    expect(cleanMark({ ...base(), at: undefined, regions: ['bad'] })).toBeNull();
    expect(cleanMark(base({ id: 0 }))).toBeNull();
    expect(cleanMark(base({ id: 1.5 }))).toBeNull();
    expect(cleanMark({ ...base(), from: 'x' })).toBeNull();
    expect(cleanMark({ ...base(), at: [1, NaN] })).toBeNull();
    expect(cleanMark({ ...base(), at: [1] })).toBeNull();
    expect(cleanMark(null)).toBeNull();
    expect(cleanMark('mark')).toBeNull();
  });

  it('名字、说明、颜色、"到":空名字叫"新标记",控制字符去掉、超长截断;说明留着换行;认不出的颜色当红色;"到"早于"从"当没给', () => {
    expect(cleanMark(base({ title: '  ' }))!.title).toBe(MARK_TITLE_DEFAULT);
    expect(cleanMark(base({ title: '甲\u0000乙\n  丙' }))!.title).toBe('甲乙 丙');
    expect([...cleanMark(base({ title: '长'.repeat(MARK_TITLE_MAX + 5) }))!.title].length).toBe(MARK_TITLE_MAX);
    expect(cleanMark(base({ note: '第一行\r\n第二行\u0007 ' }))!.note).toBe('第一行\n第二行');
    expect([...cleanMark(base({ note: '字'.repeat(MARK_NOTE_MAX + 9) }))!.note!].length).toBe(MARK_NOTE_MAX);
    expect(cleanMark(base({ note: '   ' }))!.note).toBeUndefined();
    expect(cleanMark({ ...base(), color: 'pink' })!.color).toBe('red');
    expect(cleanMark(base({ to: 2480 }))!.to).toBeUndefined();
    expect(cleanMark(base({ to: 2490 }))!.to).toBe(2490);
  });

  it('列表:编号重复的换成新编号(现有最大的 + 1),不合格的丢掉', () => {
    const out = cleanMarks([base({ id: 3 }), base({ id: 3, title: '乙' }), { bad: true }, base({ id: 7, title: '丙' })]);
    expect(out.map((m) => [m.id, m.title])).toEqual([
      [3, '主角的故乡'],
      [8, '乙'],
      [7, '丙'],
    ]);
    expect(cleanMarks(null)).toEqual([]);
    expect(nextMarkId(out)).toBe(9);
    expect(nextMarkId(undefined)).toBe(1);
  });

  it(`编号到了 ${MARK_ID_MAX}:重号的、新建的用最小的没用过的编号`, () => {
    const list = [base({ id: MARK_ID_MAX }), base({ id: MARK_ID_MAX, title: '重号' }), base({ id: 1, title: '一号' })];
    expect(cleanMarks(list).map((m) => m.id)).toEqual([MARK_ID_MAX, 2, 1]);
    expect(nextMarkId([base({ id: MARK_ID_MAX }), base({ id: 1 })])).toBe(2);
    const raw = JSON.parse(saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, { ...EMPTY_EDITS, marks: list.slice(0, 1) }, 'abc')));
    raw.edits.marks = list;
    const r = parseSave(JSON.stringify(raw));
    expect(r.ok && r.save.edits.marks!.map((m) => m.id)).toEqual([MARK_ID_MAX, 2, 1]);
  });

  it('哪年有:[从, 到] 两头都算,没有"到" = 一直都在;年份带小数按取整算', () => {
    const m = { from: 2490, to: 2531 };
    expect(markShownAt(m, 2489)).toBe(false);
    expect(markShownAt(m, 2489.9)).toBe(false);
    expect(markShownAt(m, 2490)).toBe(true);
    expect(markShownAt(m, 2531.7)).toBe(true);
    expect(markShownAt(m, 2532)).toBe(false);
    expect(markShownAt({ from: 2498 }, 1e6)).toBe(true);
  });
});

describe('作者标记 · 存档和分享链接', () => {
  const marks: AuthorMark[] = [base(), { id: 2, title: '第三卷：西境之战', color: 'orange', from: 2506, to: 2515, regions: ['region:c730', 'region:c269'], note: '主战场。\n第二段' }];
  const edits: WorldEdits = { ...EMPTY_EDITS, marks };
  const params = { ...DEFAULT_PARAMS, seed: 7 };

  it('存进去、读回来一样;存档里是复制的一份;没有标记时不写这个字段', () => {
    const save = makeSave(params, edits, 'abc', '九州', '2026-10-06T00:00:00.000Z');
    expect(save.edits.marks).toEqual(marks);
    expect(save.edits.marks![0]).not.toBe(marks[0]);
    expect(save.edits.marks![0].at).not.toBe(marks[0].at);
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.edits.marks).toEqual(marks);
    expect(r.ok && r.warnings).toEqual([]);
    const none = makeSave(params, EMPTY_EDITS, 'abc');
    expect('marks' in none.edits).toBe(false);
    const r0 = parseSave(saveText(none));
    expect(r0.ok && 'marks' in r0.save.edits).toBe(false);
  });

  it('和改过的旗一起:存档两样都留着,"改了几处"两样都算;撤销标记的修改不动旗', () => {
    const flags = { 'polity:c12#0': 'b/plain/W/e=R/k=long' };
    const both: WorldEdits = { ...edits, flags };
    const r = parseSave(saveText(makeSave(params, both, 'abc')));
    expect(r.ok && r.save.edits.marks).toEqual(marks);
    expect(r.ok && r.save.edits.flags).toEqual(flags);
    expect(editCount(both)).toBe(marks.length + 1);
    commitEdits(both);
    updateMark({ ...marks[0], title: '改过的名字' });
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().marks).toEqual(marks);
    expect(getEdits().flags).toEqual(flags);
    expect(getToast()?.text).toBe('已撤销标记的修改');
  });

  it('读档:格式不对的跳过并提示,编号重复的换一个;算进"改了几处"', () => {
    const save = makeSave(params, edits, 'abc');
    const raw = JSON.parse(saveText(save));
    raw.edits.marks.push({ id: 2, title: '重号', color: 'blue', from: 1, at: [1, 1] }, { id: 9, title: '没位置', from: 1 }, 'x');
    const r = parseSave(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.marks!.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(r.warnings).toContain('有 2 个作者标记格式不对,已跳过');
    expect(editCount(r.save.edits)).toBe(3);
    raw.edits.marks = 'oops';
    const r2 = parseSave(JSON.stringify(raw));
    expect(r2.ok && r2.warnings).toContain('有 1 个作者标记格式不对,已跳过');
    expect(r2.ok && r2.save.edits.marks).toBeUndefined();
  });

  it(`读档:最多留 ${MARKS_MAX} 个标记,多出来的提示一句;列表清理也一样`, () => {
    const save = makeSave(params, EMPTY_EDITS, 'abc');
    const raw = JSON.parse(saveText(save));
    const many = Array.from({ length: MARKS_MAX + 5 }, (_, i) => ({ id: i + 1, title: `标记${i + 1}`, color: 'red', from: 1, at: [i % 2000, 10] }));
    raw.edits.marks = many;
    const r = parseSave(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.marks!.length).toBe(MARKS_MAX);
    expect(r.save.edits.marks![MARKS_MAX - 1].id).toBe(MARKS_MAX);
    expect(r.warnings).toContain(`作者标记最多 ${MARKS_MAX} 个,多出来的 5 个没有读进来`);
    expect(cleanMarks(many).length).toBe(MARKS_MAX);
  });

  it(`读档:所有标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州,超出的那个标记不读,提示一句;列表清理也一样`, () => {
    const save = makeSave(params, EMPTY_EDITS, 'abc');
    const raw = JSON.parse(saveText(save));
    const per = MARK_REGIONS_MAX;
    const n = MARK_REGIONS_TOTAL / per;
    const big = Array.from({ length: n + 1 }, (_, i) => ({ id: i + 1, title: `大片${i + 1}`, color: 'blue', from: 1, regions: Array.from({ length: per }, (_, j) => `region:c${i * per + j + 1}`) }));
    // 最后再放一个点的标记:不圈州,照常读进来
    raw.edits.marks = [...big, { id: n + 2, title: '一个点', color: 'red', from: 1, at: [5, 5] }];
    const r = parseSave(JSON.stringify(raw));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.marks!.map((m) => m.id)).toEqual([...Array.from({ length: n }, (_, i) => i + 1), n + 2]);
    expect(r.warnings).toContain(`作者标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州,多出来的 1 个标记没有读进来`);
    expect(cleanMarks(raw.edits.marks).map((m) => m.id)).toEqual([...Array.from({ length: n }, (_, i) => i + 1), n + 2]);
  });

  it('分享链接带着标记,打开后一样', async () => {
    const save = makeSave(params, edits, 'abc', '九州', '2026-10-06T00:00:00.000Z');
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok && r.save.edits.marks).toEqual(marks);
  });
});

describe('作者标记 · 修改和撤销', () => {
  const add = (title: string, over: Partial<AuthorMark> = {}) => addMark({ title, color: 'blue', from: 100, at: [10, 20], ...over });

  it('加、改、删:编号按现有最大的 + 1;改成一样的、找不到的不动', () => {
    expect(add('甲')).toBe(1);
    expect(add('乙')).toBe(2);
    expect(add('', { at: undefined })).toBe(-1);
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['甲', '乙']);
    expect(updateMark({ ...getEdits().marks![0], title: '甲改' })).toBe(true);
    expect(updateMark({ ...getEdits().marks![0] })).toBe(false);
    expect(updateMark({ ...getEdits().marks![0], id: 99 })).toBe(false);
    expect(removeMark(1)!.title).toBe('甲改');
    expect(removeMark(1)).toBeNull();
    expect(getEdits().marks!.map((m) => m.id)).toEqual([2]);
    expect(removeMark(2)).not.toBeNull();
    // 删光了不留空数组
    expect('marks' in getEdits()).toBe(false);
  });

  it('编辑了没改(字段先后不同):不算修改,不记撤销', () => {
    const id = add('甲', { at: [10.04, 20] });
    const m = getEdits().marks!.find((x) => x.id === id)!;
    const reordered = { at: m.at, from: m.from, color: m.color, title: m.title, id: m.id } as AuthorMark;
    const before = getEdits();
    expect(updateMark(reordered)).toBe(false);
    expect(getEdits()).toBe(before);
  });

  it('撤销 / 重做:新建、改、删各一步;提示条说"已撤销标记的修改"', () => {
    add('甲');
    add('乙');
    updateMark({ ...getEdits().marks![1], title: '乙改' });
    removeMark(1);
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['乙改']);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['甲', '乙改']);
    expect(getToast()?.text).toBe('已撤销标记的修改');
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['甲', '乙']);
    expect(undoLastEdit()).toBe(true);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().marks).toBeUndefined();
    expect(redoLastEdit()).toBe(true);
    expect(getToast()?.text).toBe('已重做标记的修改');
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['甲']);
    // 改名的撤销照旧说改名
    setName('settlement:r1#0', '甲城');
    expect(undoLastEdit()).toBe(true);
    expect(getToast()?.text).toBe('已撤销改名');
  });

  it('撤销只换回那一个标记:之后改过的别的标记不动', () => {
    add('甲');
    add('乙');
    const before = getEdits();
    updateMark({ ...before.marks![0], title: '甲改' });
    const after = getEdits();
    updateMark({ ...after.marks![1], title: '乙改' });
    const now = revertEdits(getEdits(), after, before);
    expect(now.marks!.map((m) => m.title)).toEqual(['甲', '乙改']);
  });

  it('删了再放回(提示条上的"撤销"):回到原来的位置;编号被占了换一个', () => {
    add('甲');
    add('乙');
    add('丙');
    const gone = removeMark(2)!;
    expect(restoreMark(gone, 1)).toBe(2);
    expect(getEdits().marks!.map((m) => m.title)).toEqual(['甲', '乙', '丙']);
    const again = removeMark(2)!;
    commitEdits({ ...getEdits(), marks: [...getEdits().marks!, { ...again, id: 2, title: '占位' }] });
    expect(restoreMark(again, 0)).toBe(4);
    expect(getEdits().marks!.map((m) => `${m.id}${m.title}`)).toEqual(['4乙', '1甲', '3丙', '2占位']);
    // 已经放回来了(先按了 Ctrl+Z)再点提示条上的"撤销":不再放一份
    const third = removeMark(1)!;
    expect(undoLastEdit()).toBe(true);
    const n = getEdits().marks!.length;
    expect(restoreMark(third, 0)).toBe(1);
    expect(getEdits().marks!.length).toBe(n);
    // 删了以后又加满了:放不回去
    commitEdits({ ...EMPTY_EDITS, marks: Array.from({ length: MARKS_MAX }, (_, i) => base({ id: i + 1 })) });
    expect(restoreMark(again, 0)).toBe(-1);
    expect(getEdits().marks!.length).toBe(MARKS_MAX);
  });
});

describe('作者标记 · 填写卡片', () => {
  const d = (over: Partial<MarkDraft>): MarkDraft => ({ id: 0, title: '', note: '', color: 'red', fromText: '2490', toText: '', scope: 'point', at: [1, 2], regions: [], ...over });

  it('哪里没填好:年份、"到"早于"从"、没放图钉、没圈州', () => {
    expect(draftProblem(d({}))).toBeNull();
    expect(draftProblem(d({ fromText: '' }))).toBe('填一下从哪年开始');
    expect(draftProblem(d({ fromText: '二四九零' }))).toBe('填一下从哪年开始');
    expect(draftProblem(d({ toText: 'x' }))).toBe('"到"要填年份,或者空着');
    expect(draftProblem(d({ toText: '2480' }))).toBe('"到"比"从"早了');
    expect(draftProblem(d({ at: null }))).toBe('在地图上点一下放图钉');
    expect(draftProblem(d({ scope: 'regions' }))).toBe('在地图上点几个州加进来');
    expect(draftProblem(d({ fromText: '70000' }))).toBe(`年份最大填到 ${INTERVENTION_YEAR_MAX}`);
    expect(draftProblem(d({ toText: '70000' }))).toBe(`年份最大填到 ${INTERVENTION_YEAR_MAX}`);
  });

  it('新建:选中"还没编号"的那个;完成 = 存进修改、选中新标记;空名字存成"新标记"', () => {
    newMarkDraft({ at: [100, 200], year: 2512 });
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 0 });
    expect(getMarkUi().draft!.fromText).toBe('2512');
    patchDraft({ toText: '2530', note: '说明' });
    expect(finishDraft()).toBe(1);
    expect(getMarkUi().draft).toBeNull();
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 1 });
    expect(getEdits().marks).toEqual([{ id: 1, title: MARK_TITLE_DEFAULT, color: 'red', from: 2512, to: 2530, note: '说明', at: [100, 200] }]);
  });

  it('编辑:完成 = 换掉原来的(编号不变);取消新建的连卡片一起关掉', () => {
    addMark({ title: '甲', color: 'blue', from: 1, at: [5, 5] });
    editMarkDraft(getEdits().marks![0]);
    patchDraft({ title: '甲改', scope: 'regions' });
    toggleDraftRegion('region:c1');
    toggleDraftRegion('region:c2');
    toggleDraftRegion('region:c1');
    expect(getMarkUi().draft!.regions).toEqual(['region:c2']);
    expect(finishDraft()).toBe(1);
    expect(getEdits().marks).toEqual([{ id: 1, title: '甲改', color: 'blue', from: 1, regions: ['region:c2'] }]);
    newMarkDraft({ at: [1, 1], year: 3 });
    cancelDraft();
    expect(getSelection().sel).toBeNull();
    expect(getEdits().marks!.length).toBe(1);
  });

  it('选中的标记没了(撤销了新建):卡片关掉;正在填的新标记不受影响', () => {
    newMarkDraft({ at: [100, 200], year: 2512 });
    addMark({ title: '别的', color: 'blue', from: 1, at: [5, 5] });
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 0 });
    expect(finishDraft()).toBe(2);
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 2 });
    expect(undoLastEdit()).toBe(true);
    expect(getSelection().sel).toBeNull();
    setSelection({ kind: 'mark', id: 1 });
    expect(redoLastEdit()).toBe(true);
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 1 });
  });

  it('正在编辑的标记被撤销没了:点取消,卡片也关掉', () => {
    newMarkDraft({ at: [100, 200], year: 2512 });
    expect(finishDraft()).toBe(1);
    editMarkDraft(getEdits().marks![0]);
    expect(undoLastEdit()).toBe(true);
    expect(getSelection().sel).toEqual({ kind: 'mark', id: 1 });
    cancelDraft();
    expect(getSelection().sel).toBeNull();
  });

  it(`圈满 ${MARK_REGIONS_MAX} 个州:再点别的州不加,提示一句;点已选的照样去掉`, () => {
    const keys = Array.from({ length: MARK_REGIONS_MAX }, (_, i) => `region:c${i + 1}`);
    addMark({ title: '大片', color: 'blue', from: 1, regions: keys });
    editMarkDraft(getEdits().marks![0]);
    toggleDraftRegion('region:c99999');
    expect(getMarkUi().draft!.regions.length).toBe(MARK_REGIONS_MAX);
    expect(getToast()?.text).toBe(`一个标记最多圈 ${MARK_REGIONS_MAX} 个州`);
    toggleDraftRegion('region:c1');
    expect(getMarkUi().draft!.regions.length).toBe(MARK_REGIONS_MAX - 1);
  });

  it(`已经有 ${MARKS_MAX} 个:新建的存不了,卡片上说一句;编辑原有的照常`, () => {
    commitEdits({ ...EMPTY_EDITS, marks: Array.from({ length: MARKS_MAX }, (_, i) => base({ id: i + 1 })) });
    expect(addMark({ title: '多一个', color: 'blue', from: 1, at: [5, 5] })).toBe(-1);
    expect(draftProblem(d({}))).toBe(`标记已经有 ${MARKS_MAX} 个了,删掉一些才能再加`);
    expect(draftProblem(d({ id: 3 }))).toBeNull();
  });

  it(`所有标记一共圈满 ${MARK_REGIONS_TOTAL} 个州:新的、改大的存不了,卡片上说一句;删了的放不回去`, () => {
    const per = MARK_REGIONS_MAX;
    const n = MARK_REGIONS_TOTAL / per;
    const keys = (i: number, k = per) => Array.from({ length: k }, (_, j) => `region:c${i * per + j + 1}`);
    commitEdits({ ...EMPTY_EDITS, marks: Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `大片${i + 1}`, color: 'blue' as const, from: 1, regions: keys(i) })) });
    expect(addMark({ title: '多一片', color: 'blue', from: 1, regions: ['region:c999999'] })).toBe(-1);
    expect(addMark({ title: '一个点', color: 'red', from: 1, at: [5, 5] })).toBeGreaterThan(0);
    expect(draftProblem(d({ scope: 'regions', regions: ['region:c999999'] }))).toBe(`所有标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州`);
    // 编辑原有的:换一批同样多的州照常,多一个不行
    const first = getEdits().marks![0];
    expect(draftProblem(d({ id: 1, scope: 'regions', regions: keys(n + 1) }))).toBeNull();
    expect(updateMark({ ...first, regions: keys(n + 1) })).toBe(true);
    expect(updateMark({ ...first, regions: [...keys(n + 1), 'region:c999999'] })).toBe(false);
    // 删一片,再加一片占满,原来那片就放不回去了
    const gone = removeMark(2)!;
    expect(addMark({ title: '新的一片', color: 'blue', from: 1, regions: keys(n + 2) })).toBeGreaterThan(0);
    expect(restoreMark(gone, 1)).toBe(-1);
  });

  it('概览的「加标记」:已经在放就接着放;换了世界:选中的标记收起', () => {
    togglePlacing();
    startPlacing();
    expect(getMarkUi().placing).toBe(true);
    addMark({ title: '甲', color: 'blue', from: 1, at: [5, 5] });
    setSelection({ kind: 'mark', id: 1 });
    resetMarkUi();
    expect(getMarkUi().placing).toBe(false);
    expect(getSelection().sel).toBeNull();
    newMarkDraft({ at: [1, 1], year: 3 });
    resetMarkUi();
    expect(getSelection().sel).toBeNull();
  });

  it('选中别的东西:正在填的扔掉;放标记时选了别的 = 不放了', () => {
    newMarkDraft({ at: [1, 1], year: 3 });
    setSelection({ kind: 'polity', id: 0 });
    expect(getMarkUi().draft).toBeNull();
    togglePlacing();
    expect(getMarkUi().placing).toBe(true);
    setSelection({ kind: 'settlement', id: 0 });
    expect(getMarkUi().placing).toBe(false);
  });
});

describe('作者标记 · 地图上的摆放', () => {
  /** 世界坐标就是画布坐标,1000×800,不左右相连 */
  const frame = (k: number): MarkFrame => ({ pt: (x, y) => [x, y], period: 0, win: [0, 1000], w: 1000, h: 800, k, cut: 0 });
  const pin = (id: number, x: number, y: number, over: Partial<MarkItem> = {}): MarkItem => ({ id, title: `标记${id}`, color: 'red', at: [x, y], ...over });

  it('放大了写名字:先放右边;右边压着别的名字换左边;压着地图上的城名也换,哪边都压就照常放右边', () => {
    const f = frame(NAME_ZOOM);
    const one = layoutMarks([pin(1, 500, 400)], f);
    expect(one.pins[0].label!.side).toBe('r');
    // 两个挨着的:后放的那个右边压着前一个的名字 → 换边
    const two = layoutMarks([pin(1, 500, 400), pin(2, 470, 400)], f);
    expect(two.pins.map((p) => p.label!.side)).toEqual(['r', 'l']);
    // 右边有城名
    const avoid = [[515, 370, 600, 400]];
    expect(layoutMarks([pin(1, 500, 400)], f, { avoid }).pins[0].label!.side).toBe('l');
    const all = [[300, 300, 700, 500]];
    expect(layoutMarks([pin(1, 500, 400)], f, { avoid: all }).pins[0].label!.side).toBe('r');
    // 出了右边界的放左边;贴着上边、左右都会出界的放到图钉下面
    expect(layoutMarks([pin(1, 990, 400)], f).pins[0].label!.side).toBe('l');
    expect(layoutMarks([pin(1, 500, 8)], f).pins[0].label!.side).toBe('b');
  });

  it('缩小了不写名字,挨得近的合成一个圆;选中的单独画、写名字', () => {
    const f = frame(1);
    const lay = layoutMarks([pin(1, 100, 100), pin(2, 100 + CLUSTER_PX / 2, 100), pin(3, 600, 600), pin(4, 300, 300, { selected: true })], f);
    expect(lay.clusters.length).toBe(1);
    expect(lay.clusters[0].ids.sort()).toEqual([1, 2]);
    expect(lay.clusters[0].alpha).toBe(1);
    // 选了别的标记、合进来的都变淡了:圆也变淡
    const dim = layoutMarks([pin(1, 100, 100, { dim: true }), pin(2, 100 + CLUSTER_PX / 2, 100, { dim: true })], f);
    expect(dim.clusters[0].alpha).toBe(DIM_ALPHA);
    const solo = lay.pins.find((p) => p.id === 3)!;
    expect(solo.label).toBeNull();
    const sel = lay.pins.find((p) => p.id === 4)!;
    expect(sel.label!.text).toBe('标记4');
    // 点到合并的圆 = 那两个;点到选中的图钉 = 它
    expect(hitMark(lay, lay.clusters[0].x, lay.clusters[0].y)!.ids.sort()).toEqual([1, 2]);
    expect(hitMark(lay, sel.x, sel.y - 10)!.ids).toEqual([4]);
    expect(hitMark(lay, 900, 100)).toBeNull();
  });

  it('缩小了选中的名字躲开小图钉;点得到的范围按画的先后排(名字在图钉后面)', () => {
    const lay = layoutMarks([pin(5, 335, 285), pin(4, 300, 300, { selected: true })], frame(1));
    const sel = lay.pins.find((p) => p.id === 4)!;
    expect(sel.label!.side).not.toBe('r');
    for (const k of [1, NAME_ZOOM]) {
      const l = layoutMarks([pin(1, 500, 400), pin(2, 470, 400), pin(3, 520, 380), pin(4, 300, 300, { selected: true })], frame(k));
      const lastPin = l.hits.map((h) => h.kind).lastIndexOf('pin');
      const firstLabel = l.hits.findIndex((h) => h.kind === 'label');
      expect(firstLabel < 0 || firstLabel > lastPin).toBe(true);
    }
  });

  it('几个州的标记:缩小了单独一个也点得到;放大了圈同一处的名字牌错开,各点各的', () => {
    const sq = (x: number, y: number) => Float32Array.from([x - 20, y - 20, x + 20, y - 20, x + 20, y + 20, x - 20, y + 20]);
    const area = (id: number, x: number, y: number): MarkItem => ({
      id,
      title: `州标记${id}`,
      color: 'orange',
      shape: { polys: [sq(x, y)], loops: [sq(x, y)], label: [x, y], box: [x - 20, y - 20, x + 20, y + 20] },
    });
    const far = layoutMarks([area(1, 500, 400)], frame(1));
    expect(far.clusters.length).toBe(0);
    expect(hitMark(far, 500, 400)!.ids).toEqual([1]);
    const near = layoutMarks([area(1, 500, 400), area(2, 500, 400)], frame(NAME_ZOOM));
    const [a, b] = near.areas.map((x) => x.pill!);
    expect(a.y).not.toBe(b.y);
    expect(hitMark(near, a.x, a.y)!.ids).toEqual([1]);
    expect(hitMark(near, b.x, b.y)!.ids).toEqual([2]);
    // 州的中心贴着画面上边、右边:名字牌往里挪,整个在画面里;选中的也一样
    for (const sel of [false, true]) {
      const edge = layoutMarks([{ ...area(3, 995, 2), selected: sel }], frame(sel ? 1 : NAME_ZOOM));
      const box = edge.hits.find((h) => h.kind === 'pill')!.box;
      expect(edge.areas[0].pill).toBeTruthy();
      expect(box[1]).toBeGreaterThanOrEqual(0);
      expect(box[2]).toBeLessThanOrEqual(1000);
    }
  });

  it('看不见的不摆;平面主图左右相连时挪到看得见的那一圈', () => {
    const f = frame(NAME_ZOOM);
    expect(layoutMarks([pin(1, 2000, 400)], f).pins.length).toBe(0);
    const wrap: MarkFrame = { ...f, period: 1000, win: [0, 1000] };
    const lay = layoutMarks([pin(1, 1500, 400)], wrap);
    expect(lay.pins.length).toBe(1);
    expect(lay.pins[0].x).toBeCloseTo(500);
  });

  it('一千个标记:摆一帧用不了多久', () => {
    const items = Array.from({ length: 1000 }, (_, i) => pin(i + 1, (i * 37) % 1000, (i * 91) % 800));
    for (const k of [1, NAME_ZOOM * 2]) {
      const t0 = performance.now();
      const lay = layoutMarks(items, frame(k));
      expect(performance.now() - t0).toBeLessThan(400);
      expect(lay.pins.length + lay.clusters.reduce((s, c) => s + c.ids.length, 0)).toBe(1000);
    }
  });
});

interface Case {
  world: World;
  raster: Raster;
  civ: Civ;
}
const cases = new Map<number, Case>();
function caseOf(seed: number): Case {
  let c = cases.get(seed);
  if (!c) {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed });
    cases.set(seed, (c = { world, raster: rasterize(world, 1), civ: generateCiv(world) }));
  }
  return c;
}

describe.each([7, 2024])('作者标记 · 在这个世界里 · seed=%i', (seed) => {
  it('一个点在哪:城旁边 = 城和州;海上 = 那片海或"海上";写成一句', () => {
    const { world, raster, civ } = caseOf(seed);
    const s = civ.settlements.find((x) => x.founded <= civ.endYear)!;
    const at: [number, number] = [world.mesh.x[s.cell], world.mesh.y[s.cell]];
    const spot = markSpot(civ, world, raster, at, civ.endYear);
    expect(spot.city).toBe(s.id);
    expect(spot.region).toBe(civ.regions.of[s.cell]);
    expect(spotText(civ, spot)).toMatch(new RegExp(`^${s.name}，`));
    // 找一块海
    let sea = -1;
    for (let i = 0; i < world.mesh.x.length && sea < 0; i++) if (civ.regions.of[i] < 0 && world.mesh.y[i] > 100 && world.mesh.y[i] < world.height - 100) sea = i;
    if (sea >= 0) {
      const ss = markSpot(civ, world, raster, [world.mesh.x[sea], world.mesh.y[sea]], civ.endYear);
      expect(ss.region).toBeUndefined();
      expect(spotText(civ, ss)).toMatch(/\S/);
      expect(spotText(civ, ss)).not.toMatch(/undefined/);
    }
  });

  it('同一处有毁掉的旧城和重建的新城:认这一年还在的那座', () => {
    const { world, raster, civ } = caseOf(seed);
    const s = civ.settlements.find((x) => x.founded >= 10 && x.founded < civ.endYear && (x.ended === undefined || x.ended > civ.endYear))!;
    // 旧城:早十年建、早五年毁,排在前面、离得一样近
    const old = { ...s, id: civ.settlements.length, founded: s.founded - 10, ended: s.founded - 5 };
    const civ2: Civ = { ...civ, settlements: [old, ...civ.settlements] };
    const at: [number, number] = [world.mesh.x[s.cell], world.mesh.y[s.cell]];
    expect(markSpot(civ2, world, raster, at, civ.endYear).city).toBe(s.id);
    // 旧城还在的那几年认旧城
    expect(markSpot(civ2, world, raster, at, s.founded - 7).city).toBe(old.id);
  });

  it('落在有名字的山上、旁边没有城:写山名', () => {
    const { world, raster, civ } = caseOf(seed);
    const mts = civ.places.filter((p) => p.kind === 'mountains' && p.path.length >= 4);
    let checked = 0;
    for (const p of mts) {
      const i = Math.floor(p.path.length / 4) * 2;
      const at: [number, number] = [p.path[i], p.path[i + 1]];
      const spot = markSpot(civ, world, raster, at, civ.endYear);
      if (spot.region === undefined || spot.city !== undefined) continue;
      expect(spot.place).toBeDefined();
      expect(spotText(civ, spot)).toBe(civ.places[spot.place!].name);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('几个州:写成一句、那年归谁(州数加起来不超过州数)、那几年那里的事(按年份、在那几州)', () => {
    const { world, raster, civ } = caseOf(seed);
    const ids = [0, 1, 2, 3, 4].filter((r) => r < civ.regions.count);
    expect(regionsText(civ, ids.slice(0, 2))).toMatch(/ 2 州$/);
    expect(regionsText(civ, ids)).toMatch(/等 5 州$/);
    const own = markOwners(civ, ids, civ.endYear);
    expect(own.reduce((s, o) => s + o.n, 0)).toBeLessThanOrEqual(ids.length);
    const m: AuthorMark = { id: 1, title: '某处', color: 'red', from: 0, regions: ids.map((r) => regionKey(civ, r)) };
    expect(markPlaceText(civ, world, raster, m, civ.endYear)).toBe(regionsText(civ, ids));
    const ev = markEvents(civ, ids, { from: 0, to: civ.endYear });
    const set = new Set(ids);
    let last = -Infinity;
    for (const e of ev) {
      expect(e.year).toBeGreaterThanOrEqual(last);
      last = e.year;
      expect(e.regions.some((r) => set.has(r))).toBe(true);
    }
    // 形状:有块、外接框包住名字牌的位置
    const sh = markShapeOf(world, civ, ids)!;
    expect(sh.polys.length).toBeGreaterThan(0);
    expect(markShapeOf(world, civ, ids)).toBe(sh);
    // 正在填的:只留最近一份,不进缓存(存好以后的照常缓存)
    const part = ids.slice(0, 1);
    const d1 = markShapeOf(world, civ, part, true);
    expect(markShapeOf(world, civ, part, true)).toBe(d1);
    const kept = markShapeOf(world, civ, part);
    expect(kept).not.toBe(d1);
    expect(markShapeOf(world, civ, part, true)).toBe(kept);
    const fresh = markAreaShape(world.mesh, civ.regions, ids)!;
    expect(fresh.label[0]).toBeGreaterThanOrEqual(fresh.box[0] - 1);
    expect(fresh.label[1]).toBeGreaterThanOrEqual(fresh.box[1] - 1);
    expect(fresh.label[1]).toBeLessThanOrEqual(fresh.box[3] + 1);
    // 飞过去:点 = 那一点,几个州 = 包住它们的框
    const fp = markFocus(world, civ, { at: [500, 300] })!;
    expect(fp.x).toBeCloseTo(500);
    expect(fp.box).toBeNull();
    const fr = markFocus(world, civ, { regions: m.regions })!;
    expect(fr.box).not.toBeNull();
    expect(markFocus(world, civ, { regions: ['region:r999999'] })).toBeNull();
  });

  it('搜索:按名字、说明都找得到,标记排在同样匹配的前面', () => {
    const { civ } = caseOf(seed);
    const name = civ.settlements[0].name;
    const marks: AuthorMark[] = [
      { id: 1, title: name, color: 'teal', from: 10, at: [1, 1] },
      { id: 2, title: '师父隐居的山', color: 'purple', from: 2460, to: 2520, note: '顾青的师父在这里隐居', at: [2, 2] },
    ];
    const hits = searchCiv(civ, name, civ.endYear, 20, marks);
    expect(hits[0]).toMatchObject({ kind: 'mark', id: 1, name });
    const byNote = searchCiv(civ, '顾青', civ.endYear, 20, marks);
    expect(byNote.some((h) => h.kind === 'mark' && h.id === 2 && h.sub === '标记，2460–2520 年')).toBe(true);
    expect(searchCiv(civ, '顾青', civ.endYear, 20).some((h) => h.kind === 'mark')).toBe(false);
    // 还没有国家的世界:只搜标记
    expect(searchMarks(' 顾青 ', marks).map((h) => h.id)).toEqual([2]);
    expect(searchMarks('', marks)).toEqual([]);
  });
});

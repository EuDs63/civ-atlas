/**
 * 作者的人物:数据清理(gen/characters.ts)、存档和分享链接、修改和撤销(ui/editsStore.ts、undo.ts)、填写卡片的状态(ui/characterStore.ts)、
 * 在这个世界里(ui/characterInfo.ts:地方、一行介绍、能勾的事和人、别的卡片上列出谁、地图上的足迹)、足迹的摆放(render/trail.ts)、搜索。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { rasterize, type Raster } from '../src/gen/raster';
import { EMPTY_EDITS, regionKey, settlementKey, type WorldEdits } from '../src/gen/edits';
import {
  CHARACTERS_MAX,
  CHAR_NAME_DEFAULT,
  KIN_MAX,
  LIFE_MAX,
  LINKS_MAX,
  characterAge,
  cleanCharacter,
  cleanCharacters,
  lifeStops,
  personKey,
  resolvePersonKey,
  stopAt,
  type AuthorCharacter,
} from '../src/gen/characters';
import { personName } from '../src/gen/civ/peopleText';
import { decodeShare, editCount, encodeShare, makeSave, parseSave, saveText } from '../src/gen/savefile';
import { addCharacter, clearEdits, commitEdits, getEdits, removeCharacter, restoreCharacter, updateCharacter } from '../src/ui/editsStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { clearToast, getToast } from '../src/ui/toastStore';
import { clearSelection, getSelection, setSelection } from '../src/ui/civView';
import {
  cancelDraft,
  draftProblem,
  escapeCharacter,
  finishDraft,
  finishKin,
  finishLife,
  getCharUi,
  lifeProblem,
  newCharacterDraft,
  patchDraft,
  patchLife,
  pickKin,
  pickPlace,
  resetCharacterUi,
  startKin,
  startLife,
  toggleLifeLink,
} from '../src/ui/characterStore';
import {
  characterLine,
  characterTrail,
  charactersAt,
  charactersOfPerson,
  eventIndex,
  eventOfKey,
  lifeEventChoices,
  lifePeopleChoices,
  placeOf,
  windowAround,
} from '../src/ui/characterInfo';
import { layoutTrail, type TrailInput } from '../src/render/trail';
import type { MarkFrame } from '../src/render/marks';
import { searchCiv, searchMarks } from '../src/ui/searchIndex';

const base = (over: Partial<AuthorCharacter> = {}): AuthorCharacter => ({ id: 1, name: '林小满', color: 'red', born: 2490, ...over });

afterEach(() => {
  resetCharacterUi();
  clearSelection();
  clearEdits();
  clearToast();
});

describe('作者的人物 · 数据清理', () => {
  it('本来就合格的原样返回(同一个对象),列表也是', () => {
    const a = base();
    const b = base({
      id: 2,
      name: '沈砚',
      color: 'blue',
      died: 2552,
      birthplace: 'settlement:c929#0',
      polity: 'polity:c818#0',
      role: '商人',
      note: '第一段\n第二段',
      life: [{ year: 2506, text: '随军西征', where: 'region:c282', events: ['event:2506|battle|region:c282|polity:c818#0,polity:c90#0#0'], people: ['person:polity:c818#0|general|楚尧|2443'] }],
      kin: [{ rel: '好友', char: 1 }],
    });
    expect(cleanCharacter(a)).toBe(a);
    expect(cleanCharacter(b)).toBe(b);
    const list = [a, b];
    expect(cleanCharacters(list)).toBe(list);
  });

  it('不合格的丢掉:编号不是正整数、生年不是数;名字空了叫"新人物";颜色认不出当红色;卒年早于生年当没给', () => {
    expect(cleanCharacter(base({ id: 0 }))).toBeNull();
    expect(cleanCharacter(base({ id: 1.5 }))).toBeNull();
    expect(cleanCharacter({ ...base(), born: 'x' })).toBeNull();
    expect(cleanCharacter(null)).toBeNull();
    expect(cleanCharacter(base({ name: '  ' }))!.name).toBe(CHAR_NAME_DEFAULT);
    expect(cleanCharacter({ ...base(), color: 'pink' })!.color).toBe('red');
    expect(cleanCharacter(base({ died: 2400 }))!.died).toBeUndefined();
    expect(cleanCharacter(base({ died: 2490 }))!.died).toBe(2490);
  });

  it('地方、亲友、勾的事和人:格式不对的去掉;亲友不能是自己,两样都没有的不要', () => {
    const c = cleanCharacter({
      ...base(),
      birthplace: 'x',
      life: [{ year: 2500, text: '甲', where: [-10, 500], events: ['bad', 'event:2500|war|-|-#0', 'event:2500|war|-#0'], people: ['nobody'] }, { text: '没年份' }],
      kin: [{ rel: '自己', char: 1 }, { rel: '空的' }, { rel: '父亲', char: 3 }, { rel: '上司', person: 'person:polity:c1#0|general|楚尧|2443' }],
    })!;
    expect(c.birthplace).toBeUndefined();
    expect(c.life).toEqual([{ year: 2500, text: '甲', where: [2038, 500], events: ['event:2500|war|-|-#0'] }]);
    expect(c.kin!.map((k) => k.rel)).toEqual(['父亲', '上司']);
  });

  it(`最多 ${LIFE_MAX} 段经历、${KIN_MAX} 个亲友;列表最多 ${CHARACTERS_MAX} 个,编号重复的换一个`, () => {
    const c = cleanCharacter({ ...base(), life: Array.from({ length: LIFE_MAX + 5 }, (_, i) => ({ year: 2490 + i, text: `${i}` })), kin: Array.from({ length: KIN_MAX + 5 }, (_, i) => ({ rel: '', char: i + 2 })) })!;
    expect(c.life!.length).toBe(LIFE_MAX);
    expect(c.kin!.length).toBe(KIN_MAX);
    const count = { dropped: 0, over: 0 };
    const list = cleanCharacters([base(), base({ name: '重号' }), null, ...Array.from({ length: CHARACTERS_MAX }, (_, i) => base({ id: i + 10 }))], count);
    expect(list.length).toBe(CHARACTERS_MAX);
    expect(list[1].name).toBe('重号');
    expect(list[1].id).not.toBe(1);
    expect(count).toEqual({ dropped: 1, over: 2 });
    // 换的新编号也不用别人亲友里记着的
    expect(cleanCharacters([base({ kin: [{ rel: '父亲', char: 5 }] }), base({ name: '重号' })]).map((x) => x.id)).toEqual([1, 6]);
  });

  it('年龄:那一年减生年;出生前 = 还没出生,去世后 = 已故(享年);卒年不填 = 一直活着', () => {
    const c = base({ died: 2561 });
    expect(characterAge(c, 2512.7)).toEqual({ state: 'alive', age: 22 });
    expect(characterAge(c, 2489)).toEqual({ state: 'unborn', age: 0 });
    expect(characterAge(c, 2561)).toEqual({ state: 'alive', age: 71 });
    expect(characterAge(c, 2562)).toEqual({ state: 'dead', age: 71 });
    expect(characterAge(base(), 3000).state).toBe('alive');
  });

  it('一生落脚的地方:出生地排在同一年的经历前面,没写地方的跳过;那一年在哪一站', () => {
    const c = base({
      died: 2561,
      birthplace: 'settlement:c1#0',
      life: [
        { year: 2506, text: '西征', where: 'region:c2' },
        { year: 2490, text: '出生', where: 'settlement:c1#0' },
        { year: 2500, text: '没写地方' },
      ],
    });
    const stops = lifeStops(c);
    expect(stops.map((s) => [s.year, s.life])).toEqual([
      [2490, -1],
      [2490, 1],
      [2506, 0],
    ]);
    expect(stopAt(c, stops, 2505)).toBe(1);
    expect(stopAt(c, stops, 2512)).toBe(2);
    expect(stopAt(c, stops, 2489)).toBe(-1);
    expect(stopAt(c, stops, 2600)).toBe(-1);
  });
});

describe('作者的人物 · 存档和分享链接', () => {
  const characters: AuthorCharacter[] = [base({ died: 2561, life: [{ year: 2506, text: '随军西征', where: [100, 200] }], kin: [{ rel: '好友', char: 2 }] }), base({ id: 2, name: '沈砚', color: 'blue', born: 2489 })];
  const edits: WorldEdits = { ...EMPTY_EDITS, characters };
  const params = { ...DEFAULT_PARAMS, seed: 7 };

  it('存进去、读回来一样;存档里是复制的一份;算进"改了几处";没有人物时不写这个字段', () => {
    const save = makeSave(params, edits, 'abc', '九州', '2026-10-06T00:00:00.000Z');
    expect(save.edits.characters).toEqual(characters);
    expect(save.edits.characters![0]).not.toBe(characters[0]);
    expect(editCount(save.edits)).toBe(2);
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.edits.characters).toEqual(characters);
    expect(r.ok && r.warnings).toEqual([]);
    const none = makeSave(params, EMPTY_EDITS, 'abc');
    expect('characters' in none.edits).toBe(false);
  });

  it('读档:格式不对的跳过并提示', () => {
    const save = makeSave(params, edits, 'abc');
    const text = saveText({ ...save, edits: { ...save.edits, characters: [...characters, { id: 'x' }] as AuthorCharacter[] } });
    const r = parseSave(text);
    expect(r.ok && r.save.edits.characters).toEqual(characters);
    expect(r.ok && r.warnings.length).toBe(1);
  });

  it('分享链接带着人物,打开后一样', async () => {
    const save = makeSave(params, edits, 'abc', '九州', '2026-10-06T00:00:00.000Z');
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok && r.save.edits.characters).toEqual(characters);
  });
});

describe('作者的人物 · 修改和撤销', () => {
  const add = (name: string, over: Partial<AuthorCharacter> = {}) => addCharacter({ name, color: 'blue', born: 2490, ...over });

  it('加、改、删:编号按现有最大的 + 1;改成一样的、找不到的不动;删光了不留空数组', () => {
    expect(add('甲')).toBe(1);
    expect(add('乙')).toBe(2);
    expect(updateCharacter({ ...getEdits().characters![0], name: '甲改' })).toBe(true);
    expect(updateCharacter({ ...getEdits().characters![0] })).toBe(false);
    expect(updateCharacter({ ...getEdits().characters![0], id: 99 })).toBe(false);
    expect(removeCharacter(1)!.name).toBe('甲改');
    expect(removeCharacter(1)).toBeNull();
    expect(removeCharacter(2)).not.toBeNull();
    expect('characters' in getEdits()).toBe(false);
  });

  it('撤销 / 重做:提示条说"已撤销人物的修改";删了再放回回到原来的位置', () => {
    add('甲');
    add('乙');
    updateCharacter({ ...getEdits().characters![1], name: '乙改' });
    expect(undoLastEdit()).toBe(true);
    expect(getToast()?.text).toBe('已撤销人物的修改');
    expect(getEdits().characters!.map((c) => c.name)).toEqual(['甲', '乙']);
    expect(redoLastEdit()).toBe(true);
    expect(getToast()?.text).toBe('已重做人物的修改');
    const gone = removeCharacter(1)!;
    expect(restoreCharacter(gone, 0)).toBe(1);
    expect(getEdits().characters!.map((c) => c.name)).toEqual(['甲', '乙改']);
    // 已经放回来了再点一次:不再放一份
    expect(restoreCharacter(gone, 0)).toBe(1);
    expect(getEdits().characters!.length).toBe(2);
  });

  it('删掉的人物的编号不给新人物(放回去还用原编号);别人亲友里记着的编号也不给', () => {
    add('甲');
    const b = add('乙');
    expect(add('丙', { kin: [{ rel: '好友', char: b }] })).toBe(3);
    const gone = removeCharacter(3)!;
    expect(add('丁')).toBe(4);
    expect(restoreCharacter(gone, 2)).toBe(3);
    expect(getEdits().characters!.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    // 读档来的:亲友里记着一个已经删掉的人物(编号 7),新人物不用 7
    clearEdits();
    commitEdits({ ...EMPTY_EDITS, characters: [base({ kin: [{ rel: '父亲', char: 7 }] })] });
    expect(add('戊')).toBe(8);
  });

  it('选中的人物被撤销没了:卡片关掉', () => {
    const id = add('甲');
    setSelection({ kind: 'character', id });
    expect(undoLastEdit()).toBe(true);
    expect(getSelection().sel).toBeNull();
  });
});

describe('作者的人物 · 填写卡片', () => {
  it('新建:没给出生地就先挑出生地;点地图挑好了停下;颜色挑没用过的', () => {
    addCharacter({ name: '甲', color: 'red', born: 2400 });
    newCharacterDraft({ year: 2512 });
    let ui = getCharUi();
    expect(ui.picking).toBe('birth');
    expect(ui.draft!.bornText).toBe('2512');
    expect(ui.draft!.color).toBe('orange');
    expect(getSelection().sel).toEqual({ kind: 'character', id: 0 });
    pickPlace('settlement:c1#0');
    ui = getCharUi();
    expect(ui.picking).toBeNull();
    expect(ui.draft!.birthplace).toBe('settlement:c1#0');
  });

  it('哪里没填好:生年、卒年不是数、卒年比生年早', () => {
    newCharacterDraft({ birthplace: [10, 20], year: 2512 });
    const d = () => getCharUi().draft!;
    patchDraft({ bornText: '' });
    expect(draftProblem(d())).toBe('填一下生年');
    patchDraft({ bornText: '2490', diedText: 'abc' });
    expect(draftProblem(d())).toMatch(/卒年要填年份/);
    patchDraft({ diedText: '2400' });
    expect(draftProblem(d())).toBe('卒年比生年早了');
    patchDraft({ diedText: '' });
    expect(draftProblem(d())).toBeNull();
  });

  it('加一段经历、加亲友,再完成:存进修改、选中新人物;空名字存成"新人物"', () => {
    const other = addCharacter({ name: '林大川', color: 'orange', born: 2462 });
    newCharacterDraft({ birthplace: [10, 20], year: 2512 });
    patchDraft({ bornText: '2490' });
    startLife(-1, 2400);
    expect(getCharUi().picking).toBe('life');
    // 新加的年份夹到生年以后
    expect(getCharUi().draft!.sub!.kind === 'life' && getCharUi().draft!.sub!.d).toMatchObject({ yearText: '2490' });
    pickPlace('region:c5');
    const sub = () => getCharUi().draft!.sub!;
    expect(sub().kind === 'life' && lifeProblem(getCharUi().draft!, sub().d as never)).toBe('写一句经历');
    patchLife({ yearText: '2506', text: '随军西征' });
    toggleLifeLink('events', 'event:2506|battle|region:c5|polity:c1#0#0');
    toggleLifeLink('people', 'person:polity:c1#0|general|楚尧|2443');
    toggleLifeLink('people', 'person:polity:c1#0|general|楚尧|2443');
    finishLife();
    startKin(-1);
    pickKin({ char: other });
    finishKin();
    const id = finishDraft();
    const c = getEdits().characters!.find((x) => x.id === id)!;
    expect(c.name).toBe(CHAR_NAME_DEFAULT);
    expect(c.life).toEqual([{ year: 2506, text: '随军西征', where: 'region:c5', events: ['event:2506|battle|region:c5|polity:c1#0#0'] }]);
    expect(c.kin).toEqual([{ rel: '', char: other }]);
    expect(getSelection().sel).toEqual({ kind: 'character', id });
    expect(getCharUi().draft).toBeNull();
  });

  it(`一段经历最多勾 ${LINKS_MAX} 件事:满了再勾提示一句、不勾上;去掉一件还能再勾`, () => {
    newCharacterDraft({ birthplace: [10, 20], year: 2512 });
    patchDraft({ bornText: '2490' });
    startLife(-1, 2500);
    const events = () => {
      const sub = getCharUi().draft!.sub!;
      return sub.kind === 'life' ? sub.d.events : [];
    };
    for (let i = 0; i < LINKS_MAX + 2; i++) toggleLifeLink('events', `event:2500|battle|region:c${i}|-#0`);
    expect(events().length).toBe(LINKS_MAX);
    expect(getToast()?.text).toBe(`一段经历最多勾 ${LINKS_MAX} 件事`);
    toggleLifeLink('events', 'event:2500|battle|region:c0|-#0');
    toggleLifeLink('events', 'event:2500|battle|region:c99|-#0');
    expect(events().length).toBe(LINKS_MAX);
    expect(events()).toContain('event:2500|battle|region:c99|-#0');
  });

  it('Esc:先停下挑地方,再关小表,再取消正在填的(新建的连卡片一起关掉)', () => {
    newCharacterDraft({ year: 2512 });
    startLife(-1, 2512);
    expect(escapeCharacter()).toBe(true);
    expect(getCharUi().picking).toBeNull();
    expect(getCharUi().draft!.sub).not.toBeNull();
    expect(escapeCharacter()).toBe(true);
    expect(getCharUi().draft!.sub).toBeNull();
    expect(escapeCharacter()).toBe(true);
    expect(getCharUi().draft).toBeNull();
    expect(getSelection().sel).toBeNull();
    expect(escapeCharacter()).toBe(false);
  });

  it('选中别的东西:正在填的扔掉', () => {
    newCharacterDraft({ birthplace: [10, 20], year: 2512 });
    setSelection({ kind: 'polity', id: 0 });
    expect(getCharUi().draft).toBeNull();
    newCharacterDraft({ birthplace: [10, 20], year: 2512 });
    cancelDraft();
    expect(getSelection().sel).toBeNull();
  });
});

describe('作者的人物 · 足迹的摆放', () => {
  const frame: MarkFrame = { pt: (x, y) => [x, y], period: 0, win: [0, 2048], w: 2048, h: 1024, k: 1, cut: 0 };
  const input = (over: Partial<TrailInput> = {}): TrailInput => ({
    color: '#e0443a',
    avatar: '林',
    stops: [
      { at: [100, 100], label: '2490', future: false },
      { at: [400, 120], label: '2506', future: false },
      { at: [700, 300], label: '2540', future: true },
    ],
    segs: [
      { a: 0, b: 1, future: false },
      { a: 1, b: 2, future: true },
    ],
    pin: 1,
    ...over,
  });

  it('线、圆点、年份、头像;走过的实线、还没走的虚线', () => {
    const t = layoutTrail(input(), frame);
    expect(t.segs.map((s) => s.future)).toEqual([false, true]);
    expect(t.dots.length).toBe(3);
    expect(t.labels.map((l) => l.text)).toEqual(['2490', '2506', '2540']);
    expect(t.pins).toEqual([{ x: 400, y: 120 }]);
  });

  it('年份先放右边,压着别的字换一边;紧挨着头像的那一站年份也能写在右边', () => {
    const t = layoutTrail(input(), frame, { measure: () => 30, avoid: [[105, 80, 160, 120]] });
    expect(t.labels.find((l) => l.text === '2490')!.side).not.toBe('r');
    expect(t.labels.find((l) => l.text === '2506')!.side).toBe('r');
  });

  it('看不见的不画;头像不画 = pin < 0', () => {
    const t = layoutTrail(input({ pin: -1 }), { ...frame, pt: (x, y) => (x > 500 ? null : [x, y]) });
    expect(t.dots.length).toBe(2);
    expect(t.segs.length).toBe(1);
    expect(t.pins.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 在推演出来的世界里

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

describe.each([7, 2024])('作者的人物 · 在这个世界里 · seed=%i', (seed) => {
  it('推演里的人的稳定键:找得回同一个人;找不到 = −1', () => {
    const { civ } = caseOf(seed);
    const x = civ.people!.find((p) => p.role === 'general')!;
    const k = personKey(civ, x.id);
    expect(resolvePersonKey(civ, k)).toBe(x.id);
    expect(resolvePersonKey(civ, k.replace(/\|\d+$/, '|1'))).toBe(-1);
    // 同一国、同身份、同名、同年生的两个人:第二个的键后面加 #1,各自找得回,存得进经历
    const twin = { ...x, id: civ.people!.length };
    const civ2: Civ = { ...civ, people: [...civ.people!, twin] };
    const k2 = personKey(civ2, twin.id);
    expect(k2).toBe(`${k}#1`);
    expect(resolvePersonKey(civ2, k)).toBe(x.id);
    expect(resolvePersonKey(civ2, k2)).toBe(twin.id);
    expect(cleanCharacter({ ...base(), life: [{ year: 2500, text: '甲', people: [k, k2] }] })!.life![0].people).toEqual([k, k2]);
  });

  it('推演里的事的稳定键:每件事一个、不重复,找得回同一件', () => {
    const { civ } = caseOf(seed);
    const idx = eventIndex(civ);
    expect(new Set(idx.keys).size).toBe(idx.keys.length);
    for (let i = 0; i < idx.list.length; i += 37) expect(eventOfKey(civ, idx.keys[i])).toBe(idx.list[i]);
    expect(eventOfKey(civ, 'event:1|war|-|-#99')).toBeNull();
  });

  it('地方:城键 = 那座城、州键 = 那一州的中间、一个点 = 那里;找不到的写明', () => {
    const { world, raster, civ } = caseOf(seed);
    const s = civ.settlements.find((x) => x.ended === undefined)!;
    const pc = placeOf(civ, world, raster, settlementKey(civ, s.id), civ.endYear);
    expect(pc.city).toBe(s.id);
    expect(pc.name).toBe(s.name);
    expect(pc.at).toEqual([world.mesh.x[s.cell], world.mesh.y[s.cell]]);
    const r = civ.regions.of[s.cell];
    const pr = placeOf(civ, world, raster, regionKey(civ, r), civ.endYear);
    expect(pr.region).toBe(r);
    expect(pr.at).not.toBeNull();
    expect(pr.at![0]).toBeGreaterThanOrEqual(0);
    expect(pr.at![1]).toBeGreaterThanOrEqual(0);
    expect(placeOf(civ, world, raster, 'settlement:c999999#9', civ.endYear).missing).toBe(true);
  });

  it('一行介绍、别的卡片上列出谁、能勾的事和人、足迹', () => {
    const { world, raster, civ } = caseOf(seed);
    // 一场有将领的仗:在那一州、那一年
    const idx = eventIndex(civ);
    const i = idx.list.findIndex((e) => e.kind === 'battle' && e.regions.length > 0 && (e.people?.length ?? 0) > 0);
    expect(i).toBeGreaterThanOrEqual(0);
    const ev = idx.list[i];
    const y = Math.floor(ev.year);
    const g = ev.people![0];
    const s = civ.settlements.find((x) => x.founded < y - 30 && (x.ended === undefined || x.ended > y))!;
    const where = regionKey(civ, ev.regions[0]);
    const kid: AuthorCharacter = { id: 2, name: '小女', color: 'teal', born: y + 10 };
    const c: AuthorCharacter = {
      id: 1,
      name: '林小满',
      color: 'red',
      born: y - 16,
      died: y + 40,
      birthplace: settlementKey(civ, s.id),
      role: '书记官',
      life: [
        { year: y, text: `随${personName(civ, civ.people![g])}出征`, where, events: [idx.keys[i]], people: [personKey(civ, g)] },
        { year: y + 40, text: '在故乡去世', where: settlementKey(civ, s.id) },
      ],
      kin: [{ rel: '女儿', char: 2 }],
    };
    const chars = [c, kid];
    // 一行介绍
    expect(characterLine(civ, world, raster, c, y, chars)).toMatch(/书记官，16 岁$/);
    expect(characterLine(civ, world, raster, kid, y, chars)).toMatch(/林小满的女儿，\d+ 年出生$/);
    expect(characterLine(civ, world, raster, c, y + 41, chars)).toMatch(/卒，享年 56 岁$/);
    // 推演人物的卡片:勾了他的,经历里他的名字换成"他"
    const refs = charactersOfPerson(civ, chars, g);
    expect(refs.map((r) => r.c.id)).toEqual([1]);
    expect(refs[0].text).toBe(`${y} 年随他出征`);
    // 城的卡片:生在这里、在这里去世
    const at = charactersAt(civ, world, raster, chars, { city: s.id });
    expect(at.map((r) => r.text)).toEqual([`${c.born} 年生在这里，${c.died} 年在这里去世`]);
    expect(charactersAt(civ, world, raster, chars, { region: ev.regions[0] })[0].text).toContain(`${y} 年随`);
    // 能勾的事:那一处前后几年的事里有这一件;能勾的人里有他
    const choices = lifeEventChoices(civ, world, raster, c, { year: y, where, events: [] });
    expect(choices.scope).toBe('place');
    expect(choices.list.some((x) => x.key === idx.keys[i])).toBe(true);
    const people = lifePeopleChoices(civ, world, raster, c, { year: y, where }, choices.list);
    expect(people.some((p) => p.key === personKey(civ, g))).toBe(true);
    // 足迹:看的时候按那一年分走过、没走过;头像在那一年的那一站
    const t = characterTrail(civ, world, raster, c, y + 1, { kind: 'view' });
    expect(t.stops.length).toBe(2);
    expect(t.segs.map((q) => q.future)).toEqual([false, true]);
    expect(t.pin).toBe(1);
    expect(characterTrail(civ, world, raster, c, y + 50, { kind: 'view' }).pin).toBe(-1);
    // 填的时候都算走过,头像在出生地
    const e = characterTrail(civ, world, raster, c, y + 1, { kind: 'edit' });
    expect(e.segs.every((q) => !q.future)).toBe(true);
    expect(e.pin).toBe(0);
    // 搜索:名字、经历都搜得到,自己的人物排前面
    const hits = searchCiv(civ, '林小满', y, 20, [], chars);
    expect(hits[0].kind).toBe('character');
    expect(searchCiv(civ, '出征', y, 20, [], chars).some((h) => h.kind === 'character')).toBe(true);
    // 没有国家的世界只搜作者自己放的:人物也在里面
    expect(searchMarks('林小满', [], undefined, chars).map((h) => h.kind)).toEqual(['character']);
  });

  it('身边的事只取当前那年前后:最多 n 条,按先后', () => {
    const list = Array.from({ length: 30 }, (_, i) => 2400 + i * 5);
    const w = windowAround(list, (x) => x, 2470, 8);
    expect(w.length).toBe(8);
    expect([...w].sort((a, b) => a - b)).toEqual(w);
    expect(w.some((x) => x <= 2470) && w.some((x) => x > 2470)).toBe(true);
  });
});

describe('作者的人物 · 和别的修改一起', () => {
  it('撤销人物的修改不动标记;读回来"改了几处"两样都算', () => {
    commitEdits({ ...EMPTY_EDITS, marks: [{ id: 1, title: '故乡', color: 'red', from: 2490, at: [10, 20] }] });
    addCharacter({ name: '甲', color: 'blue', born: 2490 });
    expect(editCount(getEdits())).toBe(2);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().marks!.length).toBe(1);
    expect(getEdits().characters).toBeUndefined();
  });
});

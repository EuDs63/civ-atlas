/**
 * 助手面板的状态(assistantStore):问答顺带在地图上打开、改世界(确认单 → 先在地图上看看 → 执行 → 撤销)、写史书、起名、停下、
 * 新建中只能改地形、按世界存进浏览器;试推演的结果整理成确认单下面那几行(trialView)。
 * 全程用测试用假 AI(网址带 ai=mock 时的固定步骤),不联网;试推演在 Node 里真的重推历史(种子 7)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { EMPTY_EDITS, GENERATOR_VERSION, polityKey, regionKey, type Intervention } from '../src/gen/edits';
import { setActiveProvider, setMockResponder } from '../src/ai/client';
import { AiError } from '../src/ai/types';
import { compareTrial, type Fate, type FateChange, type TrialDiff } from '../src/ai/agent/trial';
import { fateShort, stepsSummary, trialView } from '../src/ai/agent/assistant';
import { bordersAt, nameAt } from '../src/ai/prompts/rewrite';
import { ownersAt } from '../src/gen/civ/timeline';
import { addIntervention, clearEdits, getEdits, setEditGate, setEdits, setName } from '../src/ui/editsStore';
import { takeRewriteNote } from '../src/ui/rewriteStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { getCivTime, getSelection, resetCivTime, setSelection } from '../src/ui/civView';
import { _resetBook, getBook, setBookContext } from '../src/ui/bookStore';
import { _resetToasts, getToast } from '../src/ui/toastStore';
import * as saveStore from '../src/ui/saveStore';
import {
  PREVIEW_EDIT_BLOCK,
  _resetAssistant,
  applyBlock,
  applyProposal,
  dismissProposal,
  getAssistant,
  newConversation,
  pickName,
  previewBlock,
  sameInBoth,
  previewProposal,
  sendAsk,
  setTrialRunner,
  stopAsk,
  syncAssistantWorld,
  targetOf,
  toggleItem,
  undoProposal,
  type AskContext,
  type AsTurn,
} from '../src/ui/assistantStore';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const civ = generateCiv(world);
const END = Math.floor(civ.endYear);
const Y = 2000;
const ctx = (over: Partial<AskContext> = {}): AskContext => ({ world, civ, raw: civ, year: Y, lock: 'terrain', ...over });
const turn = (id: number): AsTurn => getAssistant().turns.find((t) => t.id === id)!;

/** 假 AI 改世界时挑的国家:亡了的国家里存在最久的那个(和 assistant.ts 的 mockAssistant 一样) */
const pick = civ.polities.filter((p) => p.ended !== undefined).sort((a, b) => b.ended! - b.founded - (a.ended! - a.founded) || a.id - b.id)[0];
const pickName0 = nameAt(pick, Y);
/** 改世界那一段用的国家:假 AI 能给它拉到一个盟友(亡国前 30 年时除了灭它的国家还有邻国) */
const ward = civ.polities.find((p) => {
  if (p.ended === undefined || p.ended - p.founded < 100) return false;
  const from = Math.max(Math.ceil(p.founded), Math.floor(p.ended) - 30);
  const fall = civ.annals.find((e) => e.kind === 'fall' && e.a === p.id);
  return [...bordersAt(civ, ownersAt(civ, from).polity, p.id)].some((q) => q !== fall?.b);
})!;
const wardName = nameAt(ward, Y);

/** 试推演:真的重推(和界面里交给 worker 的一样,返回没套改名的历史);记下推了几次 */
let runs = 0;
const runner = async (iv: Intervention[]): Promise<Civ> => {
  runs++;
  return generateCiv(world, iv.length ? { interventions: iv } : undefined);
};

/** 假的 localStorage */
class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}
const g = globalThis as { localStorage?: unknown };

/** 模拟 App 打开一个世界(助手的对话按世界编号存) */
function openWorld(id: string, kind: saveStore.WorldKind = 'created') {
  saveStore.detachWorld();
  clearEdits();
  saveStore.attachWorld({ id, params: world.params, check: 'check7', kind, saved: EMPTY_EDITS });
}

beforeEach(() => {
  setActiveProvider('mock');
  runs = 0;
});

afterEach(() => {
  _resetAssistant();
  _resetBook();
  _resetToasts();
  setMockResponder(null);
  setActiveProvider(null);
  setEditGate(null);
  saveStore.detachWorld();
  saveStore._resetForTest();
  delete g.localStorage;
  clearEdits();
  setSelection(null);
  resetCivTime();
});

describe('试推演结果的几行', () => {
  const fate = (size: number, end?: number): Fate => ({ size, ...(end !== undefined ? { end, way: 'fall' as const } : {}) });
  const ch = (id: number, name: string, before: Fate | null, after: Fate | null, born?: FateChange['born']): FateChange => ({
    who: { id, name },
    before,
    after,
    ...(born ? { born } : {}),
  });
  const diff = (focus: FateChange[], others: FateChange[], ev: [number, number] = [0, 0]): TrialDiff => ({
    from: 1200,
    endYear: 3000,
    focus,
    others,
    alive: [10, 10],
    added: [],
    removed: [],
    addedCount: ev[0],
    removedCount: ev[1],
  });

  it('关注的国家在前:现在 → 试推演;两边都到最后仍在只比州数;别的国家一句话', () => {
    const v = trialView(
      diff(
        [ch(3, '甲国', fate(40, 1800), fate(25))],
        [ch(5, '乙国', fate(30), fate(18)), ch(6, '丙国', fate(10, 1500), fate(12, 1700)), ch(7, '丁国', fate(9), fate(4, 2400)), ch(8, '戊国', fate(5), null)],
        [2, 3],
      ),
    );
    expect(v).toMatchObject({ from: 1200, endYear: 3000, focus: 1, addedCount: 2, removedCount: 3 });
    expect(v.rows).toEqual([
      { id: 3, name: '甲国', was: '1800 年亡', now: '存续，25 州' },
      { id: 5, name: '乙国', was: '30 州', now: '18 州' },
      { id: 6, name: '丙国', was: '1500 年亡', now: '1700 年亡' },
    ]);
    expect(v.rest.map((r) => r.name)).toEqual(['丁国', '戊国']);
    expect(v.rest[1].now).toBe('没有了');
    expect(v.others).toBe('乙国变小，丙国亡国的年份变了，丁国亡了，戊国没了');
    expect(fateShort(null)).toBe('没有这个国家');
  });

  it('试推演里新分出来的国家:母国列着就写在母国那一行的小字里,不另占一行;母国没列着才单列', () => {
    const v = trialView(
      diff(
        [ch(3, '甲国', fate(40, 1800), fate(25))],
        [ch(-1, '新甲', null, fate(6), { year: 1650, from: { id: 3, name: '甲国' } }), ch(-1, '远方', null, fate(3), { year: 2100, from: { id: 99, name: '某国' } })],
      ),
    );
    expect(v.rows[0]).toMatchObject({ id: 3, note: '1650 年新甲从它那里自立' });
    expect(v.rows.map((r) => r.name)).toEqual(['甲国', '远方']);
    expect(v.rows[1]).toEqual({ id: -1, name: '远方', now: '存续，3 州', note: '试推演里新出现的国家' });
    expect(v.others).toBe('多了新甲、远方');
  });

  it('关注的国家比 3 个多:变了的都列上,没变的(主角除外)不占一行;什么都没变 = "别的国家和大事没有变化"', () => {
    const f = [1, 2, 3, 4].map((i) => ch(i, `国${i}`, fate(10), fate(10 + i)));
    const v = trialView(diff([...f, ch(5, '盟友', fate(7), fate(7))], [ch(9, '外国', fate(5), fate(6))]));
    expect(v.rows.map((r) => r.name)).toEqual(['国1', '国2', '国3', '国4']);
    expect(v.focus).toBe(4);
    expect(v.rest.map((r) => r.name)).toEqual(['外国']);
    expect(trialView(diff([ch(1, '主角', fate(3), fate(3))], [])).rows.map((r) => r.name)).toEqual(['主角']);
    expect(trialView(diff(f.slice(0, 1), [])).others).toBe('别的国家和大事没有变化');
    expect(trialView(diff(f.slice(0, 1), [], [1, 0])).others).toBe('大事少了 0 件，多了 1 件');
  });

  it('真的试推演一次:保护一个原本被灭的国家,它那一行从"某年亡"变成"存续"', () => {
    const from = Math.floor(pick.ended!) - 30;
    const after = generateCiv(world, { interventions: [{ kind: 'protect', a: polityKey(civ, pick.id), from }] });
    const v = trialView(compareTrial(civ, after, [pick.id], from));
    expect(v.rows[0]).toMatchObject({ id: pick.id, was: `${Math.floor(pick.ended!)} 年亡`, now: expect.stringMatching(/^存续，\d+ 州$/) });
  });

  it('做完以后几步收成一句话', () => {
    const s = (tool: string, summary?: string, state: 'ok' | 'error' = 'ok') => ({ tool, label: tool, state, ...(summary ? { summary } : {}) });
    expect(stepsSummary([s('country'), s('situation'), s('try_edits'), s('try_edits', undefined, 'error'), s('propose_edits')])).toBe('查了 2 次，试推演 1 次');
    const q = (tool: string, label: string) => ({ tool, label, state: 'ok' as const });
    expect(stepsSummary([q('country', '查国家：甲国'), s('show', '在地图上打开了甲国')])).toBe('查了甲国，在地图上打开了它');
    expect(stepsSummary([q('country', '查国家：甲国'), s('show', '在地图上打开了乙国')])).toBe('查了甲国，在地图上打开了乙国');
    expect(stepsSummary([q('country', '查国家：甲国'), { ...q('chronicle', '查编年史：甲国'), summary: '26 件大事' }, s('show', '在地图上打开了甲国')])).toBe(
      '查了甲国和它的 26 件大事，在地图上打开了它',
    );
    expect(stepsSummary([q('situation', '查第 1200 年的格局'), s('try_edits')])).toBe('查了第 1200 年的格局，试推演 1 次');
    expect(stepsSummary([q('chronicle', '查编年史：甲国，第 100—200 年'), s('try_edits')])).toBe('查了甲国的编年史，试推演 1 次');
    expect(stepsSummary([s('propose_edits')])).toBe('做了 1 步');
  });
});

describe('助手面板', () => {
  it('问一句:查资料、在地图上打开它,回话;每一步一行、下面一句结果', async () => {
    const id = await sendAsk(ctx(), `${pickName0}为什么会亡？`);
    const t = turn(id);
    expect(t).toMatchObject({ status: 'done', ask: `${pickName0}为什么会亡？`, year: Y, lock: 'terrain' });
    expect(t.text).toMatch(/^【测试用假 AI】/);
    expect(t.steps.map((s) => s.label)).toEqual([`查国家：${pickName0}`, `在地图上打开${pickName0}`]);
    expect(t.steps.every((s) => s.state === 'ok')).toBe(true);
    expect(t.steps[0].summary).toMatch(new RegExp(`^第 ${Math.floor(pick.founded)} 年立国；`));
    expect(t.steps[1].summary).toBe(`在地图上打开了${pickName0}`);
    expect(t.proposal).toBeUndefined();
    // 真的选中了它
    expect(getSelection().sel).toEqual({ kind: 'polity', id: pick.id });
    // 空话不发
    expect(await sendAsk(ctx(), '   ')).toBe(-1);
  });

  it('改世界:查 → 试推演两次 → 列确认单,附上试推演的结果;勾选、先在地图上看看、执行、撤销', async () => {
    setTrialRunner(runner);
    const id = await sendAsk(ctx(), `让${wardName}多撑一阵`);
    let t = turn(id);
    expect(t.status).toBe('done');
    expect(t.steps.map((s) => s.tool)).toEqual(['country', 'situation', 'try_edits', 'try_edits', 'propose_edits']);
    expect(t.steps[0].label).toBe(`查国家：${wardName}`);
    expect(t.steps[2].label).toMatch(/^试推演：第 \d+ 年起保护$/);
    expect(t.steps[3].label).toMatch(/^试推演：保护，再和.+结盟$/);
    expect(t.steps[4].label).toBe('列出要改的 2 条');
    expect(runs).toBe(2);
    const p = t.proposal!;
    expect(p.items.map((x) => x.change?.kind)).toEqual(['intervention', 'intervention']);
    expect(p.cannot).toHaveLength(1);
    expect(p.trial!.rows[0]).toMatchObject({ id: ward.id, was: `${Math.floor(ward.ended!)} 年亡` });

    // 能执行;正在重推时不行
    expect(applyBlock(t, {})).toBeNull();
    expect(applyBlock(t, { busy: true })).toBe('世界正在重推，推完再执行');

    // 先在地图上看看:确认单附带的那一次就是这一批,不用再推
    expect(previewBlock(t, {})).toBeNull();
    expect(previewProposal(id, {})).toBeNull();
    expect(runs).toBe(2);
    const shown = getAssistant().preview!;
    expect(shown.turn).toBe(id);
    expect(shown.raw).not.toBe(civ);
    expect(shown.raw!.endYear).toBe(civ.endYear);
    // 勾掉一条:按剩下的那条在后台再推一遍
    toggleItem(id, 1);
    expect(getAssistant().preview).toMatchObject({ turn: id, raw: null });
    await vi.waitFor(() => expect(getAssistant().preview?.raw).toBeTruthy(), { timeout: 10000 });
    expect(runs).toBe(3);
    toggleItem(id, 1);
    // 再点一下回到现在
    expect(previewProposal(id, {})).toBeNull();
    expect(getAssistant().preview).toBeNull();

    // 执行:一次合进两条;App 推完在提示条上说(带撤销);地图回到现在
    previewProposal(id, {});
    const before = getEdits();
    expect(applyProposal(id, {})).toBeNull();
    expect(getAssistant().preview).toBeNull();
    const after = getEdits();
    expect(after.interventions).toHaveLength(2);
    expect(after.interventions[0]).toMatchObject({ kind: 'protect', a: polityKey(civ, ward.id) });
    const note = takeRewriteNote(after)!;
    expect(note).toMatchObject({ kind: 'apply', turn: id, before, after });
    expect(typeof note.undo).toBe('function');
    t = turn(id);
    expect(t.applied).toMatchObject({ before, after });
    expect(applyProposal(id, {})).toBe('这一轮执行过了');
    // 提示条上的撤销 = 撤销这一轮
    note.undo!();
    expect(getEdits()).toBe(before);
    expect(takeRewriteNote(getEdits())).toMatchObject({ kind: 'undo', turn: id });
    expect(turn(id).applied).toMatchObject({ undone: true });
  });

  it('⌘Z / ⇧⌘Z:执行过的一轮也能撤销、再做一遍(对话里的"已执行 / 已撤销"跟着变,推完的提示和点撤销一样)', async () => {
    setTrialRunner(runner);
    const start = getEdits();
    const id = await sendAsk(ctx(), `让${wardName}多撑一阵`);
    expect(applyProposal(id, {})).toBeNull();
    const after = getEdits();
    takeRewriteNote(after);
    const applied = () => turn(id).applied;
    expect(undoLastEdit()).toBe(true);
    expect(getEdits()).toBe(start);
    expect(applied()).toMatchObject({ undone: true });
    expect(takeRewriteNote(getEdits())).toMatchObject({ kind: 'undo', turn: id });
    expect(redoLastEdit()).toBe(true);
    expect(getEdits()).toEqual(after);
    expect(applied()).toMatchObject({ undone: false });
    const again = takeRewriteNote(getEdits())!;
    expect(again).toMatchObject({ kind: 'apply', turn: id });
    expect(typeof again.undo).toBe('function');
    // 点了提示条上的"撤销"也记一步:⌘Z 把它退回去 = 又执行了,⇧⌘Z 再撤销
    again.undo!();
    expect(getEdits().interventions).toEqual([]);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits()).toEqual(after);
    expect(applied()).toMatchObject({ undone: false });
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().interventions).toEqual([]);
    expect(applied()).toMatchObject({ undone: true });
  });

  it('执行过以后点了新对话:提示条上的"撤销"、⌘Z / ⇧⌘Z 照样撤得了、再做得了', async () => {
    setTrialRunner(runner);
    const start = getEdits();
    const id = await sendAsk(ctx(), `让${wardName}多撑一阵`);
    expect(applyProposal(id, {})).toBeNull();
    const after = getEdits();
    const note = takeRewriteNote(after)!;
    newConversation();
    expect(getAssistant().turns).toEqual([]);
    note.undo!();
    expect(getEdits()).toBe(start);
    expect(redoLastEdit()).toBe(false);
    expect(undoLastEdit()).toBe(true);
    expect(getEdits()).toEqual(after);
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().interventions).toEqual([]);
  });

  it('确认单列好以后,最后那句话出错、停下:确认单留着,照样能先看、执行', async () => {
    setTrialRunner(runner);
    const from = Math.max(Math.ceil(ward.founded), Math.floor(ward.ended!) - 30);
    let round = 0;
    setMockResponder(() => {
      if (round++ === 0) return { toolCalls: [{ id: 'c0', name: 'propose_edits', args: JSON.stringify({ edits: [{ op: 'protect', country: `P${ward.id}`, from, why: '…' }] }) }] };
      throw new AiError('network', '连不上');
    });
    const id = await sendAsk(ctx(), `让${wardName}多撑一阵`);
    const t = turn(id);
    expect(t.status).toBe('done');
    expect(t.error).toBeUndefined();
    expect(t.proposal!.items.map((x) => x.change?.kind)).toEqual(['intervention']);
    expect(t.proposal!.trial).toBeTruthy();
    expect(previewBlock(t, {})).toBeNull();
    expect(applyBlock(t, {})).toBeNull();
  });

  it('在地图上看试推演时:两份历史里是同一个的国家能改,试推演里才有的(或对不上的)不能改,提示条说原因', async () => {
    // 试推演:第 2000 年在一州立一个新国家(它只在试推演里有)
    const from = 2000;
    const r = ownersAt(civ, from).culture.findIndex((c, i) => c >= 0 && ownersAt(civ, from).polity[i] >= 0);
    const sim = await runner([{ kind: 'found', region: regionKey(civ, r), from }]);
    const old = civ.polities.find((p) => p.founded < from - 50)!;
    const fresh = sim.polities.find((p) => !sameInBoth(civ, sim, polityKey(sim, p.id)))!;
    expect(fresh.founded).toBeGreaterThanOrEqual(from);
    expect(sameInBoth(civ, sim, polityKey(sim, old.id))).toBe(true);
    setEditGate((keys) => (keys.every((k) => sameInBoth(civ, sim, k)) ? null : PREVIEW_EDIT_BLOCK));
    setName(polityKey(sim, fresh.id), '阿尔瑟');
    expect(getEdits().names).toEqual({});
    expect(getToast()).toMatchObject({ kind: 'warn', text: PREVIEW_EDIT_BLOCK });
    expect(addIntervention({ kind: 'protect', a: polityKey(sim, fresh.id), from: Math.ceil(fresh.founded) })).toBe(false);
    expect(getEdits().interventions).toEqual([]);
    setName(polityKey(sim, old.id), '阿尔瑟');
    expect(getEdits().names).toEqual({ [polityKey(civ, old.id)]: '阿尔瑟' });
  });

  it('世界在这之后改过:不能执行、不能先看;不要的确认单不能再执行', async () => {
    setTrialRunner(runner);
    const id = await sendAsk(ctx(), '让它多撑一阵');
    setEdits({ ...getEdits(), names: { x: '某' } });
    expect(applyBlock(turn(id), {})).toMatch(/^世界在这之后改过/);
    expect(previewProposal(id, {})).toMatch(/^世界在这之后改过/);
    // 改回去(内容一样)又能执行
    setEdits(EMPTY_EDITS);
    expect(applyBlock(turn(id), {})).toBeNull();
    // 正在看试推演时世界改了:回到现在
    previewProposal(id, {});
    expect(getAssistant().preview?.turn).toBe(id);
    setEdits({ ...getEdits(), names: { y: '某' } });
    expect(getAssistant().preview).toBeNull();
    setEdits(EMPTY_EDITS);
    dismissProposal(id);
    expect(turn(id).dismissed).toBe(true);
    expect(applyProposal(id, {})).toBe('这一轮执行过了');
  });

  it('没有试推演(App 没给):确认单不附结果,也不能先看', async () => {
    const id = await sendAsk(ctx(), '让它多撑一阵');
    const t = turn(id);
    expect(t.steps.filter((s) => s.tool === 'try_edits').every((s) => s.state === 'error')).toBe(true);
    expect(t.proposal!.trial).toBeUndefined();
    expect(previewBlock(t, {})).toBe('这里不能试推演');
  });

  it('写史书:在后台开写,这一步记下写的是哪一部', async () => {
    setBookContext(civ, 'w-ast-book');
    const id = await sendAsk(ctx(), `给${pickName0}写一部国史`);
    const t = turn(id);
    const job = getBook().job!;
    // 开写以后这一行换成书名
    expect(t.steps.map((s) => s.label)).toEqual([`写史书：《${job.title}》`]);
    expect(t.steps[0].book).toEqual({ id: job.id, key: job.key, title: job.title });
    expect(t.steps[0].summary).toMatch(job.chars === 10000 ? /^纪传体，约一万字/ : new RegExp(`^纪传体，约 ${job.chars} 字`));
    expect(job.opts).toMatchObject({ scope: { kind: 'polity', polity: pick.id }, style: 'biography', length: 'k10' });
  });

  it('起名:列出候选,挑一个就改名;新建中不能挑', async () => {
    const cap = civ.settlements.find((s) => [...s.name].length >= 2 && s.founded <= Y)!;
    const id = await sendAsk(ctx(), `把${cap.name}换个名字`);
    const t = turn(id);
    expect(t.steps[0]).toMatchObject({ tool: 'suggest_names', label: `给${cap.name}起名`, state: 'ok' });
    expect(t.steps[0].summary).toMatch(/起了 \d+ 个$/);
    expect(t.names!.shown).toBe(cap.name);
    expect(t.names!.list.length).toBeGreaterThan(0);
    const c = t.names!.list[0];
    pickName(id, 0);
    expect(getEdits().names[c.key]).toBe(c.value);
    expect(turn(id).names!.used).toBe(c.name);
  });

  it('停下:正在做的那一步算没做成,这一轮写"已停下"', async () => {
    let release: () => void = () => {};
    setTrialRunner(
      (iv, signal) =>
        new Promise<Civ>((ok, no) => {
          release = () => ok(generateCiv(world, { interventions: iv }));
          signal?.addEventListener('abort', () => no(new Error('已停下')));
        }),
    );
    const p = sendAsk(ctx(), '让它多撑一阵');
    await vi.waitFor(() => expect(getAssistant().turns[0]?.steps.some((s) => s.tool === 'try_edits' && s.state === 'run')).toBe(true));
    stopAsk();
    const id = await p;
    release();
    const t = turn(id);
    expect(t.status).toBe('error');
    expect(t.error).toMatchObject({ code: 'aborted', message: '已停下' });
    expect(t.steps.some((s) => s.state === 'run')).toBe(false);
    expect(t.steps[t.steps.length - 1].state).toBe('error');
  });

  it('新建中:不给要碰界面的工具;列的改地形创建世界以后不能再执行、撤销', async () => {
    const id = await sendAsk(ctx({ lock: 'history' }), `${pickName0}为什么会亡？`);
    expect(turn(id).steps.map((s) => s.tool)).toEqual(['country']);
    expect(getAssistant().lock).toBe('history');
    // 假 AI 不会改地形:换成真 AI 的回复,一轮列一座火山
    let round = 0;
    setMockResponder(() =>
      round++ === 0
        ? { toolCalls: [{ id: 'c0', name: 'propose_edits', args: JSON.stringify({ edits: [{ op: 'volcano', at: [10, 10], size: '中', why: '…' }] }) }] }
        : '列好了。',
    );
    const v = await sendAsk(ctx({ lock: 'history' }), '在海上放一座火山');
    expect(turn(v).proposal!.items.map((x) => x.change?.kind)).toEqual(['terrain']);
    expect(previewBlock(turn(v), {})).toBe('含改地形：整个世界要重新生成，不能先看');
    expect(applyProposal(v, {})).toBeNull();
    expect(getEdits().terrain).toHaveLength(1);
    takeRewriteNote(getEdits());
    // 点了"创建世界"
    syncAssistantWorld('terrain');
    expect(getAssistant().turns).toHaveLength(2);
    const after = getEdits();
    undoProposal(v);
    expect(getEdits()).toBe(after);
    expect(turn(v).applied!.undone).toBeFalsy();
  });

  it('按世界存进浏览器:换世界换对话、换回来还在;新对话清掉;生成算法换过的不读', async () => {
    const store = new FakeStorage();
    g.localStorage = store;
    saveStore._resetForTest();
    openWorld('wast1');
    syncAssistantWorld('terrain');
    const a = await sendAsk(ctx(), `${pickName0}为什么会亡？`);
    expect(store.getItem('wenming-ditu:assistant:wast1')).toContain(`${pickName0}为什么会亡？`);
    openWorld('wast2');
    syncAssistantWorld('terrain');
    expect(getAssistant()).toMatchObject({ world: 'wast2', turns: [] });
    openWorld('wast1');
    syncAssistantWorld('terrain');
    expect(getAssistant().turns.map((t) => t.id)).toEqual([a]);
    expect(turn(a).steps).toHaveLength(2);
    // 接着说:编号接着往下排
    const b = await sendAsk(ctx(), `${pickName0}在哪？`);
    expect(b).toBeGreaterThan(a);
    newConversation();
    expect(getAssistant().turns).toEqual([]);
    expect(store.getItem('wenming-ditu:assistant:wast1')).toBeNull();
    // 生成算法换过:同一个种子的历史不一样了,原来的对话不读
    store.setItem('wenming-ditu:assistant:wast3', JSON.stringify({ gen: GENERATOR_VERSION - 1, turns: [{ id: 1, ask: '旧的' }] }));
    openWorld('wast3');
    syncAssistantWorld('terrain');
    expect(getAssistant().turns).toEqual([]);
  });

  it('对象的叫法:编号和名字都认', () => {
    const cap = civ.settlements[0];
    expect(targetOf(civ, `P${pick.id}`)).toEqual({ kind: 'polity', id: pick.id });
    expect(targetOf(civ, `c${cap.id}`)).toEqual({ kind: 'settlement', id: cap.id });
    expect(targetOf(civ, cap.name)).toEqual({ kind: 'settlement', id: cap.id });
    expect(targetOf(civ, pickName0)).toEqual({ kind: 'polity', id: pick.id });
    expect(targetOf(civ, 'R0')).toEqual({ kind: 'region', id: 0 });
    expect(targetOf(civ, 'P99999')).toBeNull();
    expect(targetOf(civ, null)).toBeNull();
  });

  it('时间轴:打开时给了年份就拨过去', async () => {
    let round = 0;
    setMockResponder(() => (round++ === 0 ? { toolCalls: [{ id: 'c0', name: 'show', args: JSON.stringify({ target: `P${pick.id}`, year: 99999 }) }] } : '在这里。'));
    await sendAsk(ctx(), `${pickName0}在哪`);
    expect(getCivTime().year).toBe(END);
    expect(getToast()).toBeNull();
  });
});

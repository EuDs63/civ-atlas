/**
 * 「使用 AI 功能」总开关(默认开;关着时 aiChat 不调、界面上的 AI 入口不显示)和"AI 写"的记号:
 * 从 AI 起名里挑的名字记一笔(之后自己改、恢复默认、撤销都不算了),存档 / 分享链接里带上,导出时可以换回原名。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { aiChat, aiOn, recentCallsInMemory, setActiveProvider } from '../src/ai/client';
import { AiError } from '../src/ai/types';
import { DEFAULT_AI_SETTINGS, getAiSettings, sanitizeSettings, setAiEnabled } from '../src/ai/settings';
import { EMPTY_EDITS, aiNameKeys, isAiName, markAiName, namesWithoutAi, type WorldEdits } from '../src/gen/edits';
import { DEFAULT_PARAMS } from '../src/gen/world';
import { editsLost, makeSave, parseSave, saveText } from '../src/gen/savefile';
import { mergeRewrite, unmergeRewrite } from '../src/ai/prompts/rewrite';
import { clearEdits, getEdits, setName } from '../src/ui/editsStore';
import { redoLastEdit, undoLastEdit } from '../src/ui/undo';
import { clearToast } from '../src/ui/toastStore';

const K = 'polity:c4567#0';
const CITY = 'settlement:c890#0';

afterEach(() => {
  clearEdits();
  clearToast();
  setAiEnabled(true);
  setActiveProvider(null);
});

describe('「使用 AI 功能」总开关', () => {
  it('默认开;旧设置没有这一项 = 开;关掉以后 aiChat 不调(记一条失败),再打开照常', async () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(true);
    expect(sanitizeSettings({ provider: 'deepseek' }).enabled).toBe(true);
    expect(sanitizeSettings({ enabled: false }).enabled).toBe(false);
    expect(sanitizeSettings({ enabled: 'no' }).enabled).toBe(true);
    expect(aiOn()).toBe(true);

    setActiveProvider('mock');
    setAiEnabled(false);
    expect(getAiSettings().enabled).toBe(false);
    expect(aiOn()).toBe(false);
    const err = await aiChat({ feature: 'test', messages: [{ role: 'user', content: '你好' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('not-configured');
    expect((err as AiError).message).toMatch(/AI 功能已关/);
    expect(recentCallsInMemory()[0]).toMatchObject({ feature: 'test', ok: false });

    setAiEnabled(true);
    expect(aiOn()).toBe(true);
    const r = await aiChat({ feature: 'test', messages: [{ role: 'user', content: '你好' }] });
    expect(r.provider).toBe('mock');
  });
});

describe('"AI 写"的记号', () => {
  it('从 AI 起名里挑的记一笔;自己再改、恢复默认就不算了;挑之前的名字留着(连挑两次留最早的)', () => {
    setName(K, '渊');
    setName(K, '青渊', 'ai');
    expect(isAiName(getEdits(), K)).toBe(true);
    expect(getEdits().aiNames).toEqual({ [K]: { name: '青渊', was: '渊' } });
    // 又挑了一个:挑之前的名字还是自己起的那个
    setName(K, '沧渊', 'ai');
    expect(getEdits().aiNames).toEqual({ [K]: { name: '沧渊', was: '渊' } });
    // 自己改:记号去掉
    setName(K, '玄');
    expect(isAiName(getEdits(), K)).toBe(false);
    expect(getEdits().aiNames).toBeUndefined();
    // 没改过的直接挑:没有 was;恢复默认去掉记号
    setName(CITY, '揽月城', 'ai');
    expect(getEdits().aiNames).toEqual({ [CITY]: { name: '揽月城' } });
    setName(CITY, null);
    expect(getEdits().aiNames).toBeUndefined();
    expect(getEdits().names).toEqual({ [K]: '玄' });
  });

  it('自己改过名、又从 AI 候选里挑回生成时的名字:照样算 AI 起的,换回原名回到自己改的;没改过的挑回 = 不动', () => {
    setName(K, '渊');
    setName(K, null, 'ai', '昌');
    expect(getEdits().names[K]).toBe('昌');
    expect(getEdits().aiNames).toEqual({ [K]: { name: '昌', was: '渊' } });
    expect(namesWithoutAi(getEdits())[K]).toBe('渊');
    // 没给 fallback(旧对话里的候选)、或者不是 AI:照旧恢复默认
    setName(CITY, '揽月城');
    setName(CITY, null, 'ai');
    expect(getEdits().names[CITY]).toBeUndefined();
    // 本来就是生成时的名字:什么都不改
    const before = getEdits();
    setName(CITY, null, 'ai', '揽霞城');
    expect(getEdits()).toBe(before);
  });

  it('撤销挑名字:名字和记号一起回去;重做又回来', () => {
    setName(K, '渊');
    setName(K, '青渊', 'ai');
    expect(undoLastEdit()).toBe(true);
    expect(getEdits().names[K]).toBe('渊');
    expect(isAiName(getEdits(), K)).toBe(false);
    expect(getEdits().aiNames).toBeUndefined();
    expect(redoLastEdit()).toBe(true);
    expect(getEdits().names[K]).toBe('青渊');
    expect(isAiName(getEdits(), K)).toBe(true);
  });

  it('导出"换回原名":AI 起的换回挑之前的(没改过 = 用生成时的),别的改名照旧;没有 AI 起的名字 = 原表', () => {
    const e: WorldEdits = {
      ...EMPTY_EDITS,
      names: { [K]: '青渊', [CITY]: '揽月城', 'region:c1': '九嶷州', 'place:river@c2#0': '自己改的' },
      aiNames: { [K]: { name: '青渊', was: '渊' }, [CITY]: { name: '揽月城' }, 'place:river@c2#0': { name: '弱水' } },
    };
    // 最后一个已经被自己改掉了:不算
    expect(aiNameKeys(e).sort()).toEqual([CITY, K].sort());
    expect(namesWithoutAi(e)).toEqual({ [K]: '渊', 'region:c1': '九嶷州', 'place:river@c2#0': '自己改的' });
    const plain = { ...EMPTY_EDITS, names: { [K]: '渊' } };
    expect(namesWithoutAi(plain)).toBe(plain.names);
    // markAiName 是纯函数:不改原来的
    expect(markAiName(plain, K, '青渊', true)).toEqual({ [K]: { name: '青渊', was: '渊' } });
    expect(plain).toEqual({ ...EMPTY_EDITS, names: { [K]: '渊' } });
  });

  it('存档、分享链接:只存还用着的记号;读档时和改名对不上的、格式不对的跳过;"会丢掉几处"不重复算', () => {
    const e: WorldEdits = {
      ...EMPTY_EDITS,
      names: { [K]: '青渊', [CITY]: '自己改的' },
      aiNames: { [K]: { name: '青渊', was: '渊' }, [CITY]: { name: '揽月城' } },
    };
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, e, 'abc', undefined, '2026-10-05T08:00:00.000Z');
    expect(save.edits.aiNames).toEqual({ [K]: { name: '青渊', was: '渊' } });
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.edits).toEqual({ names: e.names, aiNames: { [K]: { name: '青渊', was: '渊' } }, interventions: [], terrain: [] });
    // 没有 AI 起的名字:不写这个字段(旧版本读得懂)
    expect('aiNames' in makeSave({ ...DEFAULT_PARAMS, seed: 7 }, { ...EMPTY_EDITS, names: { [K]: '渊' } }, 'abc').edits).toBe(false);
    // 坏的、对不上的跳过,不提示
    const raw = JSON.parse(saveText(save));
    raw.edits.aiNames = { [K]: { name: '别的' }, [CITY]: 5, x: { name: '青渊' } };
    const bad = parseSave(JSON.stringify(raw));
    expect(bad.ok && bad.save.edits.aiNames).toBeUndefined();
    expect(bad.ok && bad.warnings).toEqual([]);
    // 换成别人的世界会丢掉几处:按改名算,记号不另算
    const other = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'abc');
    expect(editsLost(save, other)).toBe(2);
  });

  it('助手执行的修改合进来、撤销:记号留着(被助手改掉的名字自然不再算 AI 起的)', () => {
    const e: WorldEdits = { ...EMPTY_EDITS, names: { [K]: '青渊' }, aiNames: { [K]: { name: '青渊' } } };
    const merged = mergeRewrite(e, [{ kind: 'name', key: CITY, name: '揽月城' } as never]);
    expect(merged.aiNames).toBe(e.aiNames);
    expect(isAiName(merged, K)).toBe(true);
    const renamed = mergeRewrite(e, [{ kind: 'name', key: K, name: '玄' } as never]);
    expect(isAiName(renamed, K)).toBe(false);
    expect(unmergeRewrite(renamed, e, renamed)).toBe(e);
    expect(isAiName(unmergeRewrite({ ...renamed, interventions: [] }, e, renamed), K)).toBe(true);
  });
});

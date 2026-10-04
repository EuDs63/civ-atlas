/**
 * 我的世界、新建世界、世界设定页用到的几个小说法:最近打开的时间、世界参数的一行简写、改过的地形。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../src/gen/world';
import { when } from '../src/ui/worldParts';
import { paramsSide, terrainBrief } from '../src/ui/WorldOverviewGenesis';

describe('我的世界 · 小说法', () => {
  it('最近打开:刚刚 / 几分钟前 / 几小时前 / 今天 / 昨天 / 几月几日(跨年带年份)', () => {
    const now = new Date(2026, 9, 4, 20, 0, 0).getTime();
    const at = (d: Date) => d.toISOString();
    expect(when(at(new Date(now - 20e3)), now)).toBe('刚刚');
    expect(when(at(new Date(now - 5 * 60e3)), now)).toBe('5 分钟前');
    expect(when(at(new Date(now - 3 * 3600e3)), now)).toBe('3 小时前');
    expect(when(at(new Date(2026, 9, 4, 9, 5)), now)).toBe('今天 9:05');
    expect(when(at(new Date(2026, 9, 3, 22, 10)), now)).toBe('昨天 22:10');
    expect(when(at(new Date(2026, 8, 27, 10, 0)), now)).toBe('9月27日');
    expect(when(at(new Date(2025, 11, 31, 10, 0)), now)).toBe('2025年12月31日');
    expect(when('不是时间', now)).toBe('');
  });

  it('世界参数一行简写;改过的地形按种类数', () => {
    expect(paramsSide(DEFAULT_PARAMS)).toBe(`陆地 ${Math.round(DEFAULT_PARAMS.landFraction * 100)}%，${DEFAULT_PARAMS.plates} 个板块`);
    expect(terrainBrief([])).toBe('没有');
    expect(terrainBrief([{ kind: 'volcano' }, { kind: 'range' }])).toBe('2 处：火山 1、山脉 1');
    expect(terrainBrief([{ kind: 'lake' }, { kind: 'lake' }, { kind: 'sink' }])).toBe('3 处：湖 2、沉成海 1');
  });
});

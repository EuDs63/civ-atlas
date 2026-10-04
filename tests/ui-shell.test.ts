/**
 * 界面骨架的纯逻辑:图层 ↔ (画风, 数据图层, 国家 / 民族开关) 的换算、网址里的图层、深浅主题;顶部提示条的 store。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAP_LAYERS, layerDark, layerDef, layerFromUrl, layerOf } from '../src/ui/mapLayers';
import { _resetToasts, clearToast, getToast, peekToast, showToast } from '../src/ui/toastStore';

describe('图层换算', () => {
  it('每个图层换成设置再换回来还是它自己', () => {
    for (const l of MAP_LAYERS) {
      expect(layerOf(l.style, l.data ?? 'biomes', { polities: l.polities, cultures: l.cultures })).toBe(l.id);
    }
  });
  it('旧的组合也认得出:写实 + 国家算实景;手绘 + 国家 + 民族算政区;没有数据图层名的算生态', () => {
    expect(layerOf('realistic', 'biomes', { polities: true, cultures: false })).toBe('realistic');
    expect(layerOf('fantasy', 'biomes', { polities: true, cultures: true })).toBe('political');
    expect(layerOf('fantasy', 'biomes', { polities: false, cultures: false })).toBe('terrain');
    expect(layerOf('data', 'temperature', { polities: true, cultures: false })).toBe('temperature');
  });
  it('深色主题:高程、实景、降水', () => {
    expect(MAP_LAYERS.filter((l) => layerDark(l.id)).map((l) => l.id)).toEqual(['elevation', 'realistic', 'precipitation']);
    expect(layerDef('political').main && layerDef('cultures').main && !layerDef('plates').main).toBe(true);
  });
  it('网址:带 style= 的旧链接照旧;没有 style= 时 layer= 是新图层名;都没有默认政区(有 civ= 就按 civ=)', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(layerFromUrl(q('seed=7&style=fantasy'))).toBe(null);
    expect(layerFromUrl(q('seed=7&style=data&layer=plates'))).toBe(null);
    expect(layerFromUrl(q('seed=7&layer=realistic'))).toBe('realistic');
    expect(layerFromUrl(q('seed=7&layer=elevation'))).toBe('elevation');
    expect(layerFromUrl(q('seed=7&civ=cultures'))).toBe(null);
    expect(layerFromUrl(q('seed=7'))).toBe('political');
    expect(layerFromUrl(q('seed=7&layer=nonsense'))).toBe('political');
  });
});

describe('顶部提示条', () => {
  afterEach(() => {
    _resetToasts();
    vi.useRealTimers();
  });
  it('同一时间只显示最近的一条;它收起后露出下面还在的那条', () => {
    showToast({ id: 'pick', kind: 'info', text: '在地图上点结盟的对象' });
    showToast({ id: 'save', kind: 'warn', text: '已打开存档' });
    expect(getToast()?.id).toBe('save');
    clearToast('save');
    expect(getToast()?.text).toBe('在地图上点结盟的对象');
    // 收起别的来源不影响正在显示的
    clearToast('progress');
    expect(getToast()?.id).toBe('pick');
    clearToast();
    expect(getToast()).toBe(null);
  });
  it('"已完成"不盖住还没关的警告:排在它下面,警告关了再露出来', () => {
    showToast({ id: 'save', kind: 'warn', text: '这个存档来自旧版本' });
    showToast({ id: 'terrain', kind: 'ok', text: '已按新地形重新生成' });
    expect(getToast()?.id).toBe('save');
    showToast({ id: 'pick', kind: 'info', text: '在地图上点结盟的对象' });
    expect(getToast()?.id).toBe('pick');
    clearToast('pick');
    clearToast('save');
    expect(getToast()?.id).toBe('terrain');
  });
  it('两个按钮(二选一):按顺序排,只给 action 的老调用照旧', () => {
    const picked: string[] = [];
    showToast({
      id: 'share-ask',
      kind: 'warn',
      text: '这个世界本地也改过,有 1 处和链接不同',
      dismissible: false,
      actions: [
        { label: '用链接里的', primary: true, act: 'share-use', onClick: () => picked.push('use') },
        { label: '保留本地', act: 'share-keep', onClick: () => picked.push('keep') },
      ],
    });
    const t = getToast()!;
    expect(t.actions?.map((a) => a.label)).toEqual(['用链接里的', '保留本地']);
    t.actions!.forEach((a) => a.onClick());
    expect(picked).toEqual(['use', 'keep']);
    showToast({ id: 'resim-done', kind: 'ok', text: '已撤销', action: { label: '撤销', onClick: () => {} } });
    expect(peekToast('resim-done')?.action?.label).toBe('撤销');
    expect(peekToast('resim-done')?.actions).toBeUndefined();
  });
  it('同一来源再 show 是更新;ok 默认 7 秒收起,ttl 可以改,0 = 一直留着', () => {
    vi.useFakeTimers();
    showToast({ id: 'progress', kind: 'progress', text: '生成', progress: 0.2 });
    showToast({ id: 'progress', kind: 'progress', text: '生成', progress: 0.6 });
    expect(peekToast('progress')?.progress).toBe(0.6);
    showToast({ id: 'done', kind: 'ok', text: '已生效' });
    showToast({ id: 'undo', kind: 'ok', text: '已撤销', ttl: 4000 });
    showToast({ id: 'keep', kind: 'ok', text: '已导出', ttl: 0 });
    vi.advanceTimersByTime(4100);
    expect(peekToast('undo')).toBe(null);
    expect(peekToast('done')).not.toBe(null);
    vi.advanceTimersByTime(3000);
    expect(peekToast('done')).toBe(null);
    expect(peekToast('keep')).not.toBe(null);
    expect(getToast()?.id).toBe('keep');
  });
});

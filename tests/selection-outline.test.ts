/**
 * 选中国家时的记号:国土描边是连着的(没有连错、跨到别处的一段),名字旁边不画线。
 * 国名的字距拉得很开,竖排时从北到南跨过整片国土;以前名字左边画一道专名号似的细线,看上去像一条画错的国界。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { ownersAt } from '../src/gen/civ/timeline';
import { drawSelectionLabels, selectionLines } from '../src/render/civ/highlight';
import { PROJECTION_IDS, mapProj, projectLinePts, projector } from '../src/render/projection';
import type { LabelView, Placement } from '../src/render/labels/draw';

/** 记下画了什么:几次描线、几次填充 */
function recorder() {
  const calls = { stroke: 0, fill: 0 };
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'stroke') return () => calls.stroke++;
        if (k === 'fill') return () => calls.fill++;
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('选中国家:名字旁边不画线', () => {
  beforeAll(() => {
    // Node 里没有 Path2D:只要能加点就行
    (globalThis as { Path2D?: unknown }).Path2D ??= class {
      moveTo() {}
      lineTo() {}
      arc() {}
    };
  });
  // 竖排、字距拉开的国名(伦 / 萨 / 斯,从上到下)
  const glyphs = [0, 1, 2].map((i) => ({ ch: '伦萨斯'[i], x: 400, y: 300 + i * 120, a: 0 }));
  const placed = {
    labels: [{ item: { pick: { kind: 'polity', id: 2 } }, glyphs, px: 40, alpha: 1 }],
    marks: [],
  } as unknown as Placement;
  const view = { dpr: 2 } as LabelView;

  for (const style of ['fantasy', 'realistic'] as const) {
    it(`${style === 'fantasy' ? '手绘' : '写实'}:选中的国名底下只垫一层光晕,不描线`, () => {
      const { ctx, calls } = recorder();
      drawSelectionLabels(ctx, placed, view, { kind: 'polity', id: 2 }, style);
      expect(calls.fill).toBe(1);
      expect(calls.stroke).toBe(0);
    });
  }
  it('没选中这一国:什么都不画', () => {
    const { ctx, calls } = recorder();
    drawSelectionLabels(ctx, placed, view, { kind: 'polity', id: 3 }, 'fantasy');
    expect(calls.fill + calls.stroke).toBe(0);
  });
});

describe('选中国家:国土描边连着走,没有连错的一段', () => {
  const worlds: { seed: number; world: World; civ: Civ }[] = [];
  beforeAll(() => {
    for (const seed of [7, 2024]) {
      const world = generateWorld({ ...DEFAULT_PARAMS, seed, cells: 12000 });
      worlds.push({ seed, world, civ: generateCiv(world) });
    }
  });
  /** 第 3000 年还在的每个国家的描边 */
  const outlines = (world: World, civ: Civ) => {
    const own = ownersAt(civ, 3000);
    const ids = new Set<number>();
    for (let r = 0; r < own.polity.length; r++) if (own.polity[r] >= 0) ids.add(own.polity[r]);
    return [...ids].map((id) => selectionLines(world, civ, { kind: 'polity', id }, 3000)).filter((o) => o?.kind === 'outline');
  };

  it('每条描边相邻两点都挨着(含跨 180° 经线、飞地和岛上的国土);环首尾对上', () => {
    for (const { seed, world, civ } of worlds) {
      const list = outlines(world, civ);
      expect(list.length, `seed ${seed}`).toBeGreaterThan(3);
      let seam = 0;
      for (const o of list) {
        for (const l of o!.lines) {
          const p = l.pts;
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 0; i < p.length; i += 2) {
            lo = Math.min(lo, p[i]);
            hi = Math.max(hi, p[i]);
            if (i) expect(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]), `seed ${seed}`).toBeLessThan(8);
          }
          if (lo < 0 || hi > world.width) seam++;
          if (l.closed) {
            // 环:最后一点 = 第一点(绕极点一圈的环差一整圈)
            const dx = Math.abs(p[p.length - 2] - p[0]);
            expect(Math.min(dx, Math.abs(dx - world.width))).toBeLessThan(0.01);
            expect(Math.abs(p[p.length - 1] - p[1])).toBeLessThan(0.01);
          }
        }
      }
      // 两个种子里都有跨 180° 经线的国界(这条检查真的覆盖到了接缝)
      expect(seam, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('投影到各种平面地图上(中央经线 0°、180°)也是连着的', () => {
    for (const { world, civ } of worlds) {
      const list = outlines(world, civ);
      for (const id of PROJECTION_IDS) {
        for (const lon0 of [0, 180]) {
          const pj = projector(mapProj(id, lon0, world.width, world.height));
          for (const o of list)
            for (const l of o!.lines)
              for (const q of projectLinePts(l.pts, 2, pj, { s: 1, ox: 0, oy: 0 }))
                for (let i = 2; i < q.length; i += 2) expect(Math.hypot(q[i] - q[i - 2], q[i + 1] - q[i - 1]), `${id} ${lon0}`).toBeLessThan(10);
        }
      }
    }
  });
});

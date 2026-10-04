/**
 * 视窗装饰(手绘风):纸边做旧、图框、左下角的罗盘画在视窗上,不随地图左右平移 ——
 * 拖动时地图从下面滑过去,外框和罗盘不动(主图是一整圈星球,这些不烤进地形图)。
 *
 * 外框缩放 1 倍时就是地图框;放大后按同样的比例变大、上下跟着地图走(拖到两极能看到上下边),
 * 左右始终居中在舞台上(见 mapWrap.ts 的 frameSpan)。
 * 画布只盖住看得见的那一块(和文字层一样,按屏幕像素画,放在屏幕层里 —— 见 mapWrap.ts 的"屏幕层"),在地形之上、文明层之下。
 *
 * 弯边投影(mp,见 ui/projection.ts):图框换成投影的外轮廓(椭圆、桶形)双线,罗盘挪到轮廓外的左下角;
 * 写实风 / 数据图层沿轮廓描一道细线(盖住轮廓边缘的锯齿)。
 * 经纬网("图层与投影"弹层里的"经纬网"开着时):每 30° 一条经线、纬线,赤道稍粗 —— 等距圆柱时跟着地图平移,弯边投影按投影画。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { World } from '../gen/world';
import { drawFrame, drawPaperVignette, drawProjFrame } from '../render/fantasy';
import { drawGraticule, drawNeatOutline, type MapProj } from '../render/projection';
import { mapBoxOf, placeOnScreen, visibleBox } from './mapWrap';
import { useGraticule } from './projection';

export function MapDecor({ world, style, view, mp = null }: { world: World; style: string; view: { k: number; x: number; y: number }; mp?: MapProj | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const grat = useGraticule();

  // 地图框大小变了(窗口缩放)也要重画
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const box = mapBoxOf(ref.current);
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const cv = ref.current;
    const box = mapBoxOf(cv);
    if (!cv || !box) return;
    const hide = () => {
      if (cv.style.display !== 'none') cv.style.display = 'none';
      if (cv.width) cv.width = cv.height = 0;
    };
    if (style !== 'fantasy' && !mp && !grat) return hide();
    const vis = visibleBox(box);
    if (!vis) return hide();
    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round((vis.x1 - vis.x0) * vis.k * dpr));
    const H = Math.max(1, Math.round((vis.y1 - vis.y0) * vis.k * dpr));
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    Object.assign(cv.style, { display: '', width: `${W / dpr}px`, height: `${H / dpr}px` });
    placeOnScreen(cv, vis, vis.x0, vis.y0, vis.k);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 世界坐标(外框 = [0, 宽] × [0, 高])→ 画布像素
    const s = (vis.bw / world.width) * vis.k * dpr;
    const v = { s, ox: (vis.frameX - vis.x0) * vis.k * dpr, oy: -vis.y0 * vis.k * dpr, k: vis.k };
    // 经纬网:等距圆柱时跟着地图(世界坐标,地图框左边起算),弯边投影时在地图平面上(地图框就是外框)
    if (grat) drawGraticule(ctx, mp, world.width, world.height, { s, ox: -vis.x0 * vis.k * dpr, oy: v.oy }, style, vis.bw * 2, dpr);
    if (style === 'fantasy') {
      drawPaperVignette(ctx, world.width, world.height, v);
      if (mp) drawProjFrame(ctx, mp, v);
      else drawFrame(ctx, world.width, world.height, v);
    } else if (mp) drawNeatOutline(ctx, mp, v, style, dpr);
    (window as unknown as { __wfDecor?: unknown }).__wfDecor = { ms: performance.now() - t0, w: W, h: H, proj: mp?.def.id ?? 'equirect', grat };
  }, [world, style, view, tick, mp, grat]);

  return <canvas ref={ref} className="decor" style={{ pointerEvents: 'none', display: 'none' }} />;
}

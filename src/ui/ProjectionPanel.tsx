/**
 * 投影的界面:"图层与投影"弹层里的投影部分(投影切换、中央经线滑条、经纬网开关;LayerPopover.tsx 挂它),
 * 以及"选中的东西在哪条经线上"(国家面板的"设为中心"用)。状态在 ui/projection.ts(投影、经纬网)和 mapWrap.ts(中心经度)里。
 * 只用左键:没有右键菜单,把某处转到正中用国家面板的"设为中心"。
 */
import { useState } from 'react';
import type { World } from '../gen/world';
import type { Civ } from '../gen/civ/types';
import { capitalAt } from '../gen/civ/growth';
import { PROJECTIONS, PROJECTION_IDS, type ProjectionId } from '../render/projection';
import { formatLon, lonOfX, requestMapCenter, useMapCenter } from './mapWrap';
import { GLOBE_READY, setGraticule, setMapMoving, setProjection, useGraticule, useProjection, type MapProjection } from './projection';
import type { MapSelection } from './civView';
import { mapTarget } from './flyTo';

/** 悬停时的一句用途(弹层里地方小,比 render/projection.ts 的说明短) */
const SHORT_HINT: Partial<Record<ProjectionId, string>> = {
  equirect: '默认的平铺地图,经纬线横平竖直',
  robinson: '地图集常用,整体观感好',
  naturalEarth: '介于罗宾森和等距圆柱之间',
  mollweide: '等面积,各地大小可比',
  mercator: '航海图;高纬度放大',
};

/** 轮廓小图标:宽、高、圆角(CSS border-radius) */
const ICON: Record<ProjectionId, [number, number, string]> = {
  equirect: [34, 17, '1px'],
  robinson: [34, 18, '40% / 50%'],
  naturalEarth: [34, 18, '28% / 45%'],
  mollweide: [34, 17, '50%'],
  mercator: [24, 22, '1px'],
};

/** 投影选项:名字、一句用途(悬停显示)、轮廓小图标(宽、高、圆角) */
const OPTIONS: { id: MapProjection; name: string; hint: string; icon: [number, number, string] }[] = [
  ...PROJECTION_IDS.map((id) => ({ id, name: PROJECTIONS[id].name, hint: SHORT_HINT[id] ?? PROJECTIONS[id].hint, icon: ICON[id] })),
  ...(GLOBE_READY ? [{ id: 'globe' as const, name: '地球仪', hint: '3D 地球仪,拖动转动', icon: [22, 22, '50%'] as [number, number, string] }] : []),
];

/** 投影的名字(图层按钮上"政区 · 等距圆柱"用) */
export function projectionName(p: MapProjection): string {
  return OPTIONS.find((o) => o.id === p)?.name ?? PROJECTIONS.equirect.name;
}

/**
 * "图层与投影"弹层的投影部分:六种投影(轮廓小图标,悬停显示一句用途)、
 * 中央经线滑条(所有投影共用)、经纬网开关
 */
export function ProjectionSection() {
  const proj = useProjection();
  const center = useMapCenter();
  const grat = useGraticule();
  // 拖滑条时显示的值(松手前地图已经跟着转了)
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? Math.round(center);
  // 悬停的那个投影的用途(没悬停 = 当前投影的)
  const [hover, setHover] = useState<MapProjection | null>(null);
  const hint = OPTIONS.find((o) => o.id === (hover ?? proj))?.hint ?? '';
  return (
    <>
      <div className="lp-sec">投影</div>
      <div className="lp-projs" role="radiogroup" aria-label="地图投影">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            className={`lp-proj${proj === o.id ? ' on' : ''}`}
            role="radio"
            aria-checked={proj === o.id}
            data-proj={o.id}
            title={o.hint}
            onClick={() => setProjection(o.id)}
            onPointerEnter={() => setHover(o.id)}
            onPointerLeave={() => setHover((h) => (h === o.id ? null : h))}
          >
            <span className="lp-proj-icon" aria-hidden="true">
              <i style={{ width: o.icon[0], height: o.icon[1], borderRadius: o.icon[2] }} />
            </span>
            {o.name}
          </button>
        ))}
      </div>
      <div className="lp-hint">{hint}</div>
      <label className="lp-center proj-center" title="地图正中是哪条经线;所有投影共用">
        <span className="lp-row">
          <span>中央经线</span>
          <b>{formatLon(shown)}</b>
        </span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={shown}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDrag(v);
            requestMapCenter(v);
          }}
          // 拖滑条时和拖地图一样:国名先按原来的摆法投过去,松手再按新中心拟合
          onPointerDown={() => setMapMoving(true)}
          onPointerUp={() => {
            setDrag(null);
            setMapMoving(false);
          }}
          onKeyUp={() => setDrag(null)}
          onBlur={() => {
            setDrag(null);
            setMapMoving(false);
          }}
        />
      </label>
      <button className={`lp-check${grat ? ' on' : ''}`} role="checkbox" aria-checked={grat} data-act="graticule" onClick={() => setGraticule(!grat)}>
        <span className="lp-box" aria-hidden="true">
          {grat ? '✓' : ''}
        </span>
        经纬网<span className="lp-sub">每 30°</span>
      </button>
    </>
  );
}

/**
 * 选中的东西在哪条经线上(人物按他的国家;国家 = 当年的国都;城 = 城址;地理实体 = 路径中点;州 = 州府;
 * 信仰 = 圣城 / 教派分出时的国都 / 民间信仰的民族发源州);找不到 = null
 */
export function selectionLon(world: World, civ: Civ, selIn: MapSelection, year: number): number | null {
  const sel = mapTarget(civ, selIn);
  if (!sel) return null;
  const { x } = world.mesh;
  const W = world.width;
  if (sel.kind === 'settlement') {
    const s = civ.settlements[sel.id];
    return s ? lonOfX(x[s.cell], W) : null;
  }
  if (sel.kind === 'polity') {
    const p = civ.polities[sel.id];
    const s = p ? civ.settlements[capitalAt(p, year)] : undefined;
    return s ? lonOfX(x[s.cell], W) : null;
  }
  if (sel.kind === 'place') {
    const path = civ.places[sel.id]?.path;
    if (!path || path.length < 2) return null;
    // 路径的 x 是展开的(可以超出地图):按相邻两点接着走,取首尾中点
    let lo = Infinity;
    let hi = -Infinity;
    let prev = path[0];
    for (let i = 0; i + 1 < path.length; i += 2) {
      const v = path[i] - W * Math.round((path[i] - prev) / W);
      prev = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return lonOfX((lo + hi) / 2, W);
  }
  if (sel.kind === 'region') {
    const c = civ.regions.seat[sel.id];
    return c !== undefined && c >= 0 ? lonOfX(x[c], W) : null;
  }
  if (sel.kind === 'faith') {
    const f = civ.religion?.faiths[sel.id];
    if (!f) return null;
    const city = f.kind === 'great' ? f.holy : f.kind === 'sect' ? f.seat : undefined;
    const s = city !== undefined ? civ.settlements[city] : undefined;
    if (s) return lonOfX(x[s.cell], W);
    const hearth = f.kind === 'folk' ? civ.cultures[f.culture ?? f.id]?.hearth : undefined;
    const c = hearth !== undefined && hearth >= 0 ? civ.regions.seat[hearth] : undefined;
    return c !== undefined && c >= 0 ? lonOfX(x[c], W) : null;
  }
  return null;
}

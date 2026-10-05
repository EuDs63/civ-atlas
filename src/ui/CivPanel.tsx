/**
 * 图层弹层(LayerPopover.tsx)里的文明开关和图例:
 *
 *   CivToggles     图层大图下面一行小字开关:地名、宜居度、州、城址、道路、战事(可以同时开几个,再点一次关闭);
 *                  开着宜居度 / 道路 / 战事时下面一行小图例(贫瘠 → 富饶的色带;大路 / 小路 / 航线;战线 / 战时易手 / 交战处)
 *   CultureLegend  选中"民族"图层时:这一年还在的民族,按地盘大小排的紧凑色块列表(族名 + 州数)
 *   FaithLegend    选中"信仰"图层时:这一年的信仰,和侧栏「信仰」一组同样的顺序(大教、跟着它的教派、最后民间信仰)
 *
 * 国家的图例不再单独放:世界概览的"国家"页就是(WorldOverviewCountries.tsx)。
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import type { CivShow } from '../render/civ/overlay';
import { HABITAT_RAMP } from '../render/civ/debug';
import { KIND_INFO, cultureLabel } from '../gen/civ/display';
import { ownersAt, type Owners } from '../gen/civ/timeline';
import { faithRows } from '../gen/civ/religionText';
import { getCivTime, setCivShow, subscribeCivTime, useCivShow } from './civView';

const TOGGLES: { key: Exclude<keyof CivShow, 'polities' | 'cultures' | 'faiths'>; name: string; hint: string }[] = [
  { key: 'labels', name: '地名', hint: '海洋、山脉、大河、湖泊、大岛、荒漠的名字;放大地图显示更多' },
  { key: 'habitat', name: '宜居度', hint: '哪里适合住人:颜色越深越宜居;不上色的是冰原等不可居之地' },
  { key: 'regions', name: '州', hint: '按山脊、大河自然划分的地区,是文明扩张的基本单位' },
  { key: 'sites', name: '城址', hint: '每州最宜居的一块地;圆点越大,这一州能养活的人越多' },
  { key: 'routes', name: '道路', hint: '实线是大城之间的大路,虚线是小路;海上的点线是港口之间的航线' },
  { key: 'wars', name: '战事', hint: '正在打的仗(开着国家时画):红线是战线,斜线是这场仗里易手的州,双剑是打过仗的地方' },
];

/** "道路"图例:实线大路、虚线小路、点线航线 */
const ROUTE_LEGEND: { name: string; dash?: string; width: number }[] = [
  { name: '大路', width: 2 },
  { name: '小路', dash: '3 2.5', width: 1.3 },
  { name: '航线', dash: '0.1 3.5', width: 2 },
];

export function CivToggles() {
  const show = useCivShow();
  const g = HABITAT_RAMP.realistic.map((c, i, a) => `rgb(${c.join(',')}) ${(i / (a.length - 1)) * 100}%`).join(',');
  return (
    <>
      <div className="lp-toggles" role="group" aria-label="叠加显示">
        {TOGGLES.map((t) => (
          <button
            key={t.key}
            className={`lp-tog${show[t.key] ? ' on' : ''}`}
            role="checkbox"
            aria-checked={show[t.key]}
            data-civ={t.key}
            title={t.hint}
            onClick={() => setCivShow({ [t.key]: !show[t.key] })}
          >
            <span className="lp-box" aria-hidden="true">
              {show[t.key] ? '✓' : ''}
            </span>
            {t.name}
          </button>
        ))}
      </div>
      {show.habitat && (
        <div className="lp-key lp-ramp">
          <span>贫瘠</span>
          <i style={{ background: `linear-gradient(90deg, ${g})` }} />
          <span>富饶</span>
        </div>
      )}
      {show.routes && (
        <div className="lp-key">
          {ROUTE_LEGEND.map((l) => (
            <span key={l.name} className="lp-route">
              <svg width="22" height="6" aria-hidden="true">
                <line x1="1.5" y1="3" x2="20.5" y2="3" stroke="currentColor" strokeWidth={l.width} strokeDasharray={l.dash} strokeLinecap="round" />
              </svg>
              {l.name}
            </span>
          ))}
        </div>
      )}
      {show.wars && show.polities && (
        <div className="lp-key lp-war">
          {/* 和地图上画的一样:战线(短齿朝守方)、易手的州(斜线)、交战处(双剑) */}
          <span className="lp-route">
            <svg width="22" height="10" aria-hidden="true">
              <line x1="1.5" y1="3" x2="20.5" y2="3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
              {[4, 9, 14, 19].map((x) => (
                <line key={x} x1={x} y1="3" x2={x} y2="7.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
              ))}
            </svg>
            战线
          </span>
          <span className="lp-route">
            <svg width="14" height="12" aria-hidden="true">
              <rect x="0.5" y="0.5" width="13" height="11" rx="2" fill="currentColor" fillOpacity={0.08} stroke="currentColor" strokeOpacity={0.35} />
              {[-6, -1, 4, 9, 14].map((x) => (
                <line key={x} x1={x} y1="12" x2={x + 12} y2="0" stroke="currentColor" strokeWidth={1} opacity={0.7} />
              ))}
            </svg>
            战时易手
          </span>
          <span className="lp-route">
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
              <path d="M-5 5L5 -5M5 5L-5 -5M-4.2 1.4L-1.4 4.2M4.2 1.4L1.4 4.2" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
            </svg>
            交战处
          </span>
        </div>
      )}
    </>
  );
}

let cultureOwners: Owners | undefined;

/** 时间轴当前年份(取整;回放时一年只重算一次) */
const subscribeYear = (f: () => void) => subscribeCivTime(() => f());

/**
 * 民族图例:跟着时间轴走(民族会同化、迁徙、消亡)—— 这一年还在的民族按地盘大小排:色块 + 族名 + 州数;
 * 悬停看类型、出现年份
 */
export function CultureLegend({ civ }: { civ: Civ | null }) {
  const end = civ?.endYear ?? 0;
  const y = useSyncExternalStore(subscribeYear, () => Math.floor(Math.min(end, Math.max(0, getCivTime().year ?? end))));
  const rows = useMemo(() => {
    if (!civ || !civ.cultures.length) return null;
    cultureOwners = ownersAt(civ, y, cultureOwners);
    const own = cultureOwners.culture;
    const count = new Array<number>(civ.cultures.length).fill(0);
    for (let r = 0; r < civ.regions.count; r++) if (own[r] >= 0) count[own[r]]++;
    return civ.cultures
      .filter((cu) => count[cu.id] > 0)
      .map((cu) => ({ cu, n: count[cu.id] }))
      .sort((a, b) => b.n - a.n || a.cu.id - b.cu.id);
  }, [civ, y]);
  if (!civ) return null;
  return (
    <div className="lp-cultures" aria-label={`第 ${y} 年的民族`}>
      {rows && rows.length ? (
        rows.map(({ cu, n }) => (
          <span key={cu.id} className="lp-cu" title={`${KIND_INFO[cu.kind].name}民族 · 第 ${cu.born} 年出现 · ${n} 州`}>
            <i style={{ background: `rgb(${cu.color.join(',')})` }} />
            <b>{cultureLabel(cu)}</b>
            <em>{n}</em>
          </span>
        ))
      ) : (
        <span className="lp-none">第 {y} 年还没有民族</span>
      )}
    </div>
  );
}

/** 信仰图例:跟着时间轴走 —— 这一年的大教(按信众多少)、跟在后面的教派,最后一行民间信仰:色块 + 教名 + 州数 */
export function FaithLegend({ civ }: { civ: Civ | null }) {
  const end = civ?.endYear ?? 0;
  const y = useSyncExternalStore(subscribeYear, () => Math.floor(Math.min(end, Math.max(0, getCivTime().year ?? end))));
  const rows = useMemo(() => (civ ? faithRows(civ, y) : []), [civ, y]);
  if (!civ) return null;
  return (
    <div className="lp-cultures" aria-label={`第 ${y} 年的信仰`}>
      {rows.length ? (
        rows.map((r) => (
          <span key={r.id} className="lp-cu" title={`${r.sub} · ${r.n} 州`}>
            <i style={{ background: `rgb(${r.color.join(',')})` }} />
            <b>{r.name}</b>
            <em>{r.n}</em>
          </span>
        ))
      ) : (
        <span className="lp-none">第 {y} 年还没有人住</span>
      )}
    </div>
  );
}

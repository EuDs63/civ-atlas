/**
 * 改地形(阶段 4)的界面:顶部的工具条(TerrainBar,从世界概览的"创世"页进入)、地图上的覆盖层(画的线、光标圈、改过的地方)。
 *
 * - 进入改地形后:火山 / 湖 = 点一下放一处(拖动照样平移);山脉 / 抬起陆地 / 沉成海 = 按住拖出一条线(按住空格拖动 = 平移)。
 *   单击不再看详情;点工具条上的"完成"恢复。每种工具三档大小(火山、湖、画笔 = 大小,山脉 = 高低),对应的 r / s 见 gen/terrainEdits.ts 的 TERRAIN_PRESETS(AI 改写也按这三档)。
 * - 加一处修改 = editsStore.addTerrainOp;撤销 = undoTerrainOp(Ctrl / ⌘ + Z);全部清除 = clearTerrain(点两下确认)。
 *   App 看到地形修改变了就在后台带着新地形重新生成世界、重推文明(见 App.tsx)。
 * - 地图事件由 App 转给这里:terrainDown / terrainMove / terrainUp(画线)、terrainClick(放点);返回 true = 这一下归改地形管。
 * - 覆盖层(TerrainOverlay)用 SVG,坐标就是世界坐标(viewBox = 地图原图大小),随地图一起缩放平移。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TerrainKind, TerrainOp } from '../gen/edits';
import { TERRAIN_PRESETS as PRESETS, isPointKind, sameTerrain } from '../gen/terrainEdits';
import { addTerrainOp, clearTerrain, undoTerrainOp, useEdits } from './editsStore';
import './overview.css';

// ---------------------------------------------------------------------------
// 工具状态

export interface TerrainToolState {
  on: boolean;
  tool: TerrainKind;
  /** 0 小 / 1 中 / 2 大 */
  size: 0 | 1 | 2;
}

let tool: TerrainToolState = { on: false, tool: 'volcano', size: 1 };
const toolSubs = new Set<() => void>();
const emitTool = () => toolSubs.forEach((f) => f());

export function getTerrainTool(): TerrainToolState {
  return tool;
}
export function setTerrainTool(p: Partial<TerrainToolState>) {
  const next = { ...tool, ...p };
  if (next.on === tool.on && next.tool === tool.tool && next.size === tool.size) return;
  tool = next;
  if (!tool.on) setSketch({ draft: null, cursor: null });
  emitTool();
}
export function useTerrainTool(): TerrainToolState {
  return useSyncExternalStore(
    (f) => (toolSubs.add(f), () => toolSubs.delete(f)),
    () => tool,
    () => tool,
  );
}

const TOOLS: { id: TerrainKind; name: string; sizeName: string; sizes: [string, string, string]; hint: string }[] = [
  { id: 'volcano', name: '火山', sizeName: '大小', sizes: ['小', '中', '大'], hint: '点一下放一座火山;点在海里 = 火山岛' },
  { id: 'range', name: '山脉', sizeName: '高低', sizes: ['低', '中', '高'], hint: '按住拖出一条线,沿线抬起一道山脉;按住空格拖动 = 平移' },
  { id: 'lake', name: '湖', sizeName: '大小', sizes: ['小', '中', '大'], hint: '点一下挖一个湖(点在陆地上)' },
  { id: 'raise', name: '抬起陆地', sizeName: '笔刷', sizes: ['细', '中', '粗'], hint: '按住拖动,把海抬成陆地;按住空格拖动 = 平移' },
  { id: 'sink', name: '沉成海', sizeName: '笔刷', sizes: ['细', '中', '粗'], hint: '按住拖动,把陆地沉成海;按住空格拖动 = 平移' },
];

// ---------------------------------------------------------------------------
// 正在画的线、光标(世界坐标),给覆盖层画

interface Sketch {
  draft: number[] | null;
  cursor: [number, number] | null;
}
let sketch: Sketch = { draft: null, cursor: null };
const sketchSubs = new Set<() => void>();
function setSketch(s: Sketch) {
  sketch = s;
  sketchSubs.forEach((f) => f());
}
function useSketch(): Sketch {
  return useSyncExternalStore(
    (f) => (sketchSubs.add(f), () => sketchSubs.delete(f)),
    () => sketch,
    () => sketch,
  );
}

/** 按住空格 = 平移(画线的工具里拖动本来是画线) */
let space = false;

/**
 * 世界东西相连的一整圈宽度(世界单位);还没有世界时 0。App 设。
 * 地图给的点 x 在 [0, 宽) 里;画线时每个新点按上一个点展开,跨 180° 经线的线是连着的一笔,原样存下
 * (x 可以超出 [0, 宽);存档、生成都按经纬度解释,见 gen/terrainEdits.ts 的 cleanTerrainOp)
 */
let wrapW = 0;
export function setTerrainWrap(w: number) {
  wrapW = w;
}
const near = (x: number, ref: number) => (wrapW ? x - wrapW * Math.round((x - ref) / wrapW) : x);
/** 画在覆盖层上的点:按上一个点展开(旧存档里跨接缝的线是一个个取模存的,这样也不横穿整张图) */
function displayPts(pts: readonly number[], wrap: number): number[] {
  if (!wrap) return pts as number[];
  const out = [...pts];
  for (let i = 2; i < out.length; i += 2) out[i] = out[i - 2] + (out[i] - out[i - 2]) - wrap * Math.round((out[i] - out[i - 2]) / wrap);
  return out;
}

const presetOf = (t: TerrainToolState) => PRESETS[t.tool][t.size];

/** 地图上按下:画线的工具开始画一条线(返回 true = 这一下归改地形管,不平移) */
export function terrainDown(w: [number, number] | null, button: number): boolean {
  if (!tool.on || !w || button !== 0 || space || isPointKind(tool.tool)) return false;
  setSketch({ draft: [Math.round(w[0]), Math.round(w[1])], cursor: w });
  return true;
}

/** 地图上移动:更新光标;正在画线就把线接长(返回 true = 正在画线) */
export function terrainMove(w: [number, number] | null): boolean {
  if (!tool.on) return false;
  const d = sketch.draft;
  if (!d) {
    if (w !== sketch.cursor) setSketch({ draft: null, cursor: w });
    return false;
  }
  if (!w) return true;
  const [r] = presetOf(tool);
  const lx = d[d.length - 2];
  const ly = d[d.length - 1];
  // 点和点至少隔开小半个半径:手抖的小折弯不算,线也不会太长
  const step = Math.max(4, r * 0.4);
  // 按上一个点展开(跨 180° 经线接着画,不跳到地图另一头)
  const wx = near(w[0], lx);
  const next = (wx - lx) ** 2 + (w[1] - ly) ** 2 >= step * step ? [...d, Math.round(wx), Math.round(w[1])] : d;
  setSketch({ draft: next, cursor: [wx, w[1]] });
  return true;
}

/** 松开:画完的线加成一处地形修改 */
export function terrainUp() {
  const d = sketch.draft;
  if (!d) return;
  const c0 = sketch.cursor;
  setSketch({ draft: null, cursor: c0 });
  const c: [number, number] | null = c0 && [near(c0[0], d[d.length - 2]), c0[1]];
  // 松开的地方离最后一个点还差一小段(不到一步):补上,线画到哪儿就到哪儿
  const pts = c && (c[0] - d[d.length - 2]) ** 2 + (c[1] - d[d.length - 1]) ** 2 >= 4 ? [...d, Math.round(c[0]), Math.round(c[1])] : d;
  const [r, s] = presetOf(tool);
  addTerrainOp({ kind: tool.tool, pts, r, s });
}

/** 单击地图:放点的工具(火山、湖)在这里放一处(返回 true = 这一下归改地形管,不看详情) */
export function terrainClick(w: [number, number] | null): boolean {
  if (!tool.on) return false;
  if (!w || !isPointKind(tool.tool)) return true;
  const [r, s] = presetOf(tool);
  addTerrainOp({ kind: tool.tool, pts: [Math.round(w[0]), Math.round(w[1])], r, s });
  return true;
}

// ---------------------------------------------------------------------------
// 工具面板

/** App 给的状态:重新生成中、上一次重新生成的结果 */
export interface TerrainStatus {
  /** 正在按新地形重新生成 */
  busy: boolean;
  /** 上一次重新生成:花了多久(毫秒)、多少处改名在新历史里对不上、多少条干预没生效(和世界概览"我的干预"页一个口径) */
  last?: { ms: number; lostNames: number; lostInterventions: number } | null;
}

/**
 * 改地形的工具条(开着改地形时显示在顶部居中,样子和"选择目标"的提示条一样):
 * 工具(火山 / 山脉 / 湖 / 抬起陆地 / 沉成海)、大小三档、撤销、清除、改了几处、"完成"(退出改地形)。
 * 只有一行:工具的用法在悬停提示里;世界还在生成时"改了几处"那里写"生成中"。
 * 重新生成的进度、结果照旧走顶部提示条(App 把提示条挪到工具条下面)。
 * 入口在世界概览的"创世"页。
 */
export function TerrainBar({ disabled }: { disabled: boolean }) {
  const t = useTerrainTool();
  const edits = useEdits();
  const [confirm, setConfirm] = useState(false);
  const n = edits.terrain.length;
  const barRef = useRef<HTMLDivElement>(null);

  // 工具条的下沿记在 --tbar-bottom 上:提示条挪到它下面(窄屏时工具条会折成两行)
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const put = () => root.style.setProperty('--tbar-bottom', `${Math.round(el.getBoundingClientRect().bottom)}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--tbar-bottom');
    };
  }, [t.on]);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  // 键盘(熟手的加速,功能都有按钮):Esc 退出,Ctrl / ⌘ + Z 撤销,按住空格拖动 = 平移
  useEffect(() => {
    if (!t.on) return;
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === 'Escape') setTerrainTool({ on: false });
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoTerrainOp();
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (!space) {
          space = true;
          document.body.classList.add('terrain-pan');
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (!typing(e)) e.preventDefault(); // 焦点停在按钮上时,空格不去按那个按钮
      space = false;
      document.body.classList.remove('terrain-pan');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      space = false;
      document.body.classList.remove('terrain-pan');
    };
  }, [t.on]);

  if (!t.on) return null;
  const cur = TOOLS.find((x) => x.id === t.tool)!;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div ref={barRef} className="terrain-bar" role="toolbar" aria-label="改地形" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <div className="tbar-row">
        <i className="tbar-mark" aria-hidden="true" />
        <span className="tbar-title">改地形</span>
        <span className="tbar-group tbar-tools" role="radiogroup" aria-label="工具">
          {TOOLS.map((x) => (
            <button key={x.id} role="radio" aria-checked={t.tool === x.id} data-tool={x.id} className={t.tool === x.id ? 'on' : ''} onClick={() => setTerrainTool({ tool: x.id })} title={x.hint}>
              {x.name}
            </button>
          ))}
        </span>
        <span className="tbar-group tbar-size" role="radiogroup" aria-label={cur.sizeName}>
          <span className="tbar-label">{cur.sizeName}</span>
          {cur.sizes.map((label, i) => (
            <button key={i} role="radio" aria-checked={t.size === i} className={t.size === i ? 'on' : ''} onClick={() => setTerrainTool({ size: i as 0 | 1 | 2 })}>
              {label}
            </button>
          ))}
        </span>
        <span className="tbar-group tbar-actions">
          <button data-act="terrain-undo" disabled={!n} onClick={undoTerrainOp} title="撤销最后一处(Ctrl / ⌘ + Z)">
            撤销
          </button>
          <button
            data-act="terrain-clear"
            className={confirm ? 'danger' : ''}
            disabled={!n}
            onClick={() => {
              if (!confirm) return setConfirm(true);
              setConfirm(false);
              clearTerrain();
            }}
          >
            {confirm ? '确认清除' : '全部清除'}
          </button>
          <span className="tbar-count">{disabled ? '生成中…' : n ? `改了 ${n} 处` : '还没改'}</span>
        </span>
        <button className="tbar-done" data-act="terrain-done" onClick={() => setTerrainTool({ on: false })}>
          完成
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 地图覆盖层

const pathOf = (pts: readonly number[]) => {
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  // 只有一个点:画一个零长度的线段,圆头笔画成一个点
  if (pts.length === 2) d += `L${pts[0] + 0.01} ${pts[1]}`;
  return d;
};

/** 一处修改在地图上的记号:圈(火山、湖)、带子 + 中线(山脉)、带子(画笔);线都描一道暗边,浅色、深色的底上都看得清 */
function OpMark({ op, pending }: { op: TerrainOp; pending: boolean }) {
  const cls = `tt-mark k-${op.kind}${pending ? ' pending' : ''}`;
  if (isPointKind(op.kind))
    return (
      <g className={cls}>
        <circle className="tt-halo" cx={op.pts[0]} cy={op.pts[1]} r={op.r} vectorEffect="non-scaling-stroke" />
        <circle className="tt-line" cx={op.pts[0]} cy={op.pts[1]} r={op.r} vectorEffect="non-scaling-stroke" />
      </g>
    );
  const d = pathOf(op.pts);
  return (
    <g className={cls}>
      <path className="tt-band" d={d} strokeWidth={op.r * (op.kind === 'range' ? 1.6 : 2)} />
      <path className="tt-halo" d={d} vectorEffect="non-scaling-stroke" />
      <path className="tt-line" d={d} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/**
 * 地图上的覆盖层:开着改地形时画出改过的地方(虚线圈 / 线)、正在画的线、跟着鼠标的大小圈;
 * shown = 地图上现在这个世界是带着哪些地形修改生成的(之后加的、还在重新生成的那几处闪着)
 */
export function TerrainOverlay({ width, height, shown, wrap = 0 }: { width: number; height: number; shown: readonly TerrainOp[]; wrap?: number }) {
  const uid = useId();
  const t = useTerrainTool();
  const edits = useEdits();
  const sk = useSketch();
  const ops = edits.terrain;
  // 从第几处开始地图上还没有(按先后比;撤销的不算)
  let same = 0;
  while (same < ops.length && same < shown.length && sameTerrain([ops[same]], [shown[same]])) same++;
  if (!t.on) return null;
  const [r] = presetOf(t);
  return (
    <svg className="terrain-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <g id={uid}>
        {ops.map((op, i) => (
          <OpMark key={i} op={wrap ? { ...op, pts: displayPts(op.pts, wrap) } : op} pending={i >= same} />
        ))}
        {sk.draft && <OpMark op={{ kind: t.tool, pts: sk.draft, r, s: 1 }} pending />}
        {sk.cursor && !sk.draft && (
          <g className={`tt-cursor k-${t.tool}`}>
            <circle className="tt-halo" cx={sk.cursor[0]} cy={sk.cursor[1]} r={r} vectorEffect="non-scaling-stroke" />
            <circle className="tt-line" cx={sk.cursor[0]} cy={sk.cursor[1]} r={r} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </g>
      {/* 左右各挪一圈再画几份(主图右边还接着一份;跨 180° 经线的线两边都看得到) */}
      {!!wrap && [-wrap, wrap, 2 * wrap].map((dx) => <use key={dx} href={`#${uid}`} x={dx} />)}
    </svg>
  );
}

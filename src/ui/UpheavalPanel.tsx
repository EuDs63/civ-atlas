/**
 * 地形大事的卡片(侧栏「这颗星球」→「地形大事」打开;宽屏在侧栏里,手机是底部卡片)和地图上那一层。
 *
 * 卡片:哪一年(和时间轴连着:拖时间轴跟着变,改这里时间轴跟着跳)、发生什么(火山喷发 / 地震抬升 / 海水漫进来)、大小、
 * 会怎么样(后台照"那一年的地形 + 这几笔"真生成一遍,和那一年的地形、州逐地块比:整州沉没、沉掉一块、山体压到的州按国家数,
 * 沉没 / 被毁的城列出来,国都在前)、放了几座 / 涂了几笔(撤销、全部清除)、取消 / 让它发生。
 * 涂了却没有一块会变:橙色提醒说原因,「让它发生」是灰的。手机上年份并进"发生什么"那一块,会怎么样只写两行。
 *
 * 地图上那一层(UpheavalOverlay,世界坐标的 SVG,和编辑地形的覆盖层叠在同一处):真会沉进海里 / 抬出水面的地块涂深色描边,
 * 涂的那几笔浅浅一层 + 白虚线外轮廓,火山 = 山体虚线圈 + 毁城范围红圈 + 中间一个火山记号,会沉没的城画红圈,鼠标下一个大小圈。
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Civ } from '../gen/civ/types';
import type { World } from '../gen/world';
import type { TerrainOp } from '../gen/edits';
import { UPHEAVALS_MAX } from '../gen/terrainEdits';
import { mergeUpheavals, previewVictims, type UpheavalPreview, type UpheavalVictim } from '../gen/civ/upheaval';
import { ownersAt } from '../gen/civ/timeline';
import { polityName } from '../gen/civ/growth';
import { Icon } from './icons';
import { pausePlayback, setCivTime, useCivTime } from './civView';
import { addUpheaval, useEdits } from './editsStore';
import { UP_KINDS, UP_SIZE, clearUpOps, closeUpheaval, requestUpPreview, setUpKind, setUpSize, undoUpOp, upKind, upYear, useUpDraft, useUpPreview, useUpUi, type UpKind } from './upheavalStore';
import { bandOutline, cellShapes } from './upheavalShapes';
import './upheaval.css';

/** 地图上的颜色:海、陆地、火山、城 */
const C_SEA = '#3f8fe0';
const C_LAND = '#5fae45';
const C_VOLC = '#d9622b';
const C_RED = '#e0443a';
const rgba = (c: string, a: number) => {
  const v = parseInt(c.slice(1), 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
};
/** 毁城范围:火山山体半径的这么多倍以内(和推演里一样,gen/civ/upheaval.ts) */
const BLAST = 0.5;

const digits = (s: string) => s.replace(/[^\d]/g, '').slice(0, 4);

// ---------------------------------------------------------------------------
// 会怎么样

/** 预览的键:这几笔 + 那一年已经有的大事(那一年的地形由它们定) */
function previewSig(ops: readonly TerrainOp[], ups: Parameters<typeof mergeUpheavals>[0] | undefined, year: number): string {
  const before = mergeUpheavals(ups ?? []).filter((m) => m.year <= year);
  return JSON.stringify([ops, before.map((m) => [m.year, m.ops])]);
}

/** 会没了的城(按这份历史、那一年;同一份结果同一年只算一次) */
let victimMemo: { civ: Civ; preview: UpheavalPreview; year: number; out: UpheavalVictim[] } | null = null;
function victimsOf(civ: Civ, world: World, r: { preview: UpheavalPreview; water: Uint8Array }, year: number, ops: readonly TerrainOp[]): UpheavalVictim[] {
  const m = victimMemo;
  if (m && m.civ === civ && m.preview === r.preview && m.year === year) return m.out;
  const out = previewVictims(civ, world, r.water, year, ops);
  victimMemo = { civ, preview: r.preview, year, out };
  return out;
}

interface Summary {
  legend: { style: CSSProperties; text: string }[];
  rows: { k: string; v: ReactNode }[];
  note?: string;
  /** 没有一块会变:原因 */
  warn?: string;
}

const swatch = (c: string, a: number, dashed = false): CSSProperties => ({
  background: rgba(c, a),
  ...(dashed ? { outline: '1.5px dashed #fff', outlineOffset: -1.5, boxShadow: '0 0 0 0.5px rgba(0,0,0,.35)' } : {}),
});
const RING: CSSProperties = { border: `2px solid ${C_RED}`, borderRadius: '50%', width: 10, height: 10, background: 'none' };

/** 名字列成一行:超过 max 个写"等 N 座" */
const listNames = (a: string[], max: number) => (a.length <= max ? a.join('、') : `${a.slice(0, max).join('、')} 等 ${a.length} 座`);

/** 离 (x, y) 最近的地块(左右接着的世界按近的那一边算) */
function nearestCell(world: World, x: number, y: number): number {
  const { x: X, y: Y, n } = world.mesh;
  const W = world.width;
  let best = -1;
  let bd = Infinity;
  for (let c = 0; c < n; c++) {
    let dx = Math.abs(X[c] - x) % W;
    if (dx > W / 2) dx = W - dx;
    const d = dx * dx + (Y[c] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** 冒出来的陆地算不算这几笔的:地震抬升算;火山只有放在海里(冒出一座岛)才算,放在陆上填掉的湖、沿岸一点海不算 */
function countsRisen(world: World, ops: readonly TerrainOp[]): boolean {
  return ops.some((o) => o.kind === 'raise' || (o.kind === 'volcano' && world.water[nearestCell(world, o.pts[0], o.pts[1])] === 1));
}

function summarize(civ: Civ, world: World, r: { preview: UpheavalPreview; water: Uint8Array }, year: number, ops: readonly TerrainOp[]): Summary {
  const p = r.preview;
  const kinds = new Set(ops.map((o) => o.kind as UpKind));
  const victims = victimsOf(civ, world, r, year, ops);
  // 只看这几种笔本来要改的:海水漫进来看沉下去的,抬升、海里的火山看冒出来的(远处跟着变了一点海陆的不算)
  const risen = countsRisen(world, ops) ? p.risen : 0;
  const sunk = kinds.has('sink') ? p.sunk : 0;
  const changed = sunk > 0 || risen > 0 || p.cone.length > 0 || victims.length > 0;
  if (!changed) {
    const only = kinds.size === 1 ? [...kinds][0] : null;
    const warn =
      only === 'raise'
        ? '涂到的地方本来就是陆地，没有海底会抬出水面。'
        : only === 'sink'
          ? '涂到的地方本来就是海，没有陆地会沉进海里。'
          : only === 'volcano'
            ? '这里的山已经很高，火山喷发看不出变化。'
            : '这几笔不会让地形有看得出来的变化。';
    return { legend: [], rows: [], warn };
  }
  const t = year - 1 / 256;
  const own = ownersAt(civ, t).polity;
  const pn = (q: number) => (q >= 0 && civ.polities[q] ? polityName(civ.polities[q], t) : '无主之地');
  const byOwner = (regs: readonly number[]) => {
    const m = new Map<string, number>();
    for (const g of regs) {
      const k = pn(g < own.length ? own[g] : -1);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n} 州`)
      .join('、');
  };
  const cityName = (v: UpheavalVictim) => `${civ.settlements[v.id].name}${v.capital ? '（国都）' : ''}`;
  const drowned = victims.filter((v) => v.drowned);
  const burnt = victims.filter((v) => !v.drowned);
  const legend: Summary['legend'] = [];
  const rows: Summary['rows'] = [];
  if (kinds.has('volcano')) legend.push({ style: swatch(C_VOLC, 0.16, true), text: '山体' }, { style: swatch(C_RED, 0.3), text: '山脚下的城会被毁' });
  if (kinds.has('raise')) legend.push({ style: swatch(C_LAND, 0.16, true), text: '涂的地方' }, { style: swatch(C_LAND, 0.65), text: '会抬出水面' });
  if (kinds.has('sink')) legend.push({ style: swatch(C_SEA, 0.16, true), text: '涂的地方' }, { style: swatch(C_SEA, 0.6), text: '会沉进海里' }, { style: RING, text: '会沉没的城' });
  if (sunk && p.drowned.length) rows.push({ k: '整州沉没', v: byOwner(p.drowned) });
  if (sunk && p.shrunk.length) rows.push({ k: '沉掉一块', v: byOwner(p.shrunk) });
  if (kinds.has('volcano') && p.cone.length) rows.push({ k: '山体压到', v: byOwner(p.cone) });
  let note: string | undefined;
  if (risen > 0) {
    if (p.joined) {
      const [a, b] = p.joined.map((g) => pn(g < own.length ? own[g] : -1));
      rows.push({
        k: '抬出陆地',
        v:
          a === b ? (
            <>
              一条，把<b>{a}</b>隔海的两块地连起来
            </>
          ) : (
            <>
              一条，连起<b>{a}</b>和<b>{b}</b>
            </>
          ),
      });
      note = '两边从此走得过去：迁徙、打仗都不用再渡海。';
    } else rows.push({ k: '抬出陆地', v: kinds.size === 1 && kinds.has('volcano') ? '海里冒出一座岛' : '一块新陆地' });
  }
  if (kinds.has('sink') || kinds.has('raise')) rows.push({ k: '沉没的城', v: drowned.length ? <b>{listNames(drowned.map(cityName), 3)}</b> : '没有' });
  if (kinds.has('volcano')) rows.push({ k: '被毁的城', v: burnt.length ? <b>{listNames(burnt.map(cityName), 3)}</b> : '没有' });
  // 国都没了:另选国都;一座城也不剩就亡国
  const cap = victims.find((v) => v.capital);
  if (cap) {
    const s = civ.settlements[cap.id];
    const q = own[s.region];
    const owner = pn(q);
    const gone = new Set(victims.map((v) => v.id));
    const sunkRegions = new Set(p.drowned);
    const others = civ.settlements.some((x) => x.founded < year && (x.ended === undefined || x.ended >= year) && !gone.has(x.id) && own[x.region] === q && !sunkRegions.has(x.region));
    const what = cap.drowned ? `${owner}的国都${s.name}沉没` : `${owner}的国都被毁`;
    note = others ? `${what}，${cap.drowned ? `${owner}` : ''}会另选国都。` : `${what}，${owner}再没有别的城，会就此亡国。`;
  }
  return { legend, rows, note };
}

// ---------------------------------------------------------------------------
// 卡片

export function UpheavalPanel({ civ, world, phone }: { civ: Civ; world: World; phone: boolean }) {
  const ui = useUpUi();
  const pv = useUpPreview();
  const edits = useEdits();
  const t = useCivTime();
  const year = upYear(t.year, civ.endYear);
  const [lo, hi] = [1, upYear(Infinity, civ.endYear)];
  const kind = upKind(ui.kind);
  const r = ui.size[ui.kind];
  const [rlo, rhi] = UP_SIZE[ui.kind];
  // 打开时停下播放(卡片上的年份 = 时间轴停的那一年)
  useEffect(() => pausePlayback(), []);
  // 年份输入框:时间轴动了跟着换;正在输的时候不打断
  const [text, setText] = useState(String(year));
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setText(String(year));
  }, [year, typing]);
  const goYear = (y: number) => setCivTime({ year: Math.min(hi, Math.max(lo, Math.round(y))), playing: false, story: false });
  // 预览:这几笔、那一年的地形一变就让后台算一遍(已有 / 正在算的不再发)
  const sig = previewSig(ui.ops, edits.upheavals, year);
  useEffect(() => {
    const h = setTimeout(() => requestUpPreview(sig, year, ui.ops), 120);
    return () => clearTimeout(h);
  }, [sig, year, ui.ops]);
  const result = pv.result && pv.result.sig === sig ? pv.result : null;
  const sum = useMemo(() => (result && ui.ops.length ? summarize(civ, world, result, year, ui.ops) : null), [result, civ, world, year, ui.ops]);
  const full = (edits.upheavals?.length ?? 0) >= UPHEAVALS_MAX;
  const ready = !!sum && !sum.warn && !full && !pv.busy;
  const happen = () => {
    if (!ready) return;
    if (addUpheaval({ year, ops: ui.ops })) closeUpheaval();
  };
  const nV = ui.ops.filter((o) => o.kind === 'volcano').length;
  const nP = ui.ops.length - nV;
  const count = nV && nP ? `放了 ${nV} 座、涂了 ${nP} 笔` : nV ? `放了 ${nV} 座` : `涂了 ${nP} 笔`;

  const stepper = (d: number, label: string) => (
    <button className="cp-step" onClick={() => goYear(year + d)} disabled={d < 0 ? year <= lo : year >= hi}>
      {label}
    </button>
  );
  const yearBox = (
    <label className="cp-year">
      <input
        value={text}
        inputMode="numeric"
        aria-label="哪一年"
        data-act="up-year"
        onFocus={() => setTyping(true)}
        onChange={(e) => {
          const s = digits(e.target.value);
          setText(s);
          const v = Number(s);
          if (s && v >= lo && v <= hi) goYear(v);
        }}
        onBlur={() => {
          setTyping(false);
          setText(String(year));
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        style={{ width: `${Math.max(2, text.length) + 0.6}ch` }}
      />
      年
    </label>
  );
  const tiles = (
    <div className="up-tiles" role="radiogroup" aria-label="发生什么">
      {UP_KINDS.map((k) => (
        <button key={k.id} className={`up-tile${k.id === ui.kind ? ' on' : ''}`} data-kind={k.id} role="radio" aria-checked={k.id === ui.kind} onClick={() => setUpKind(k.id)}>
          <Icon name={k.icon} size={20} />
          <span>{k.name}</span>
        </button>
      ))}
    </div>
  );
  const fill = ((r - rlo) / (rhi - rlo)) * 100;
  const size = (
    <div className="up-lbl">
      <b>大小</b>
      <span className="tp-range">
        <i className="tp-dot s" />
        <input
          type="range"
          aria-label="大小"
          data-act="up-size"
          min={rlo}
          max={rhi}
          value={r}
          style={{ '--fill': `${fill}%` } as CSSProperties}
          onChange={(e) => setUpSize(ui.kind, Number(e.target.value))}
        />
        <i className="tp-dot l" />
        <em>{r}</em>
      </span>
    </div>
  );
  const busy = pv.busy && (
    <span className="up-busy">
      <i className="spin" aria-hidden="true" />
      正在算…
    </span>
  );
  const countRow = ui.ops.length > 0 && (
    <div className="up-count">
      <span>{count}</span>
      <button className="lk" data-act="up-undo" onClick={undoUpOp}>
        撤销
      </button>
      <button className="lk" data-act="up-clear" onClick={clearUpOps}>
        全部清除
      </button>
    </div>
  );
  const warn = (text: string) => (
    <span className="cp-note up-warn">
      <Icon name="warn" size={14} />
      {text}
    </span>
  );
  const rows = (list: Summary['rows']) => (
    <div className="up-rows">
      {list.map((x) => (
        <Row key={x.k} k={x.k} v={x.v} />
      ))}
    </div>
  );

  let summary: ReactNode;
  if (phone) {
    // 手机:放了 / 涂了以后才有这一块;会怎么样只写头一行和城那一行
    const list = sum && !sum.warn ? (sum.rows.length > 2 ? [sum.rows[0], sum.rows[sum.rows.length - 1]] : sum.rows) : [];
    summary = ui.ops.length > 0 && (
      <div className="up-sum">
        {!sum && busy}
        {sum?.warn && warn(sum.warn)}
        {list.length > 0 && rows(list)}
        {full && warn(`每个世界最多 ${UPHEAVALS_MAX} 件地形大事。要再加，先在概览「我的干预」里撤销一件。`)}
        {countRow}
      </div>
    );
  } else
    summary = (
      <div className="up-sum">
        <span className="cp-form-title">
          会怎么样
          {busy}
        </span>
        {!ui.ops.length ? (
          <span className="cp-note">{ui.kind === 'volcano' ? '还没放。' : '还没涂。'}放好以后这里写会沉没、会被毁的城和州，地图上标出会变的地方。</span>
        ) : sum?.warn ? (
          warn(sum.warn)
        ) : sum ? (
          <>
            <div className="up-legend">
              {sum.legend.map((l, i) => (
                <span key={i}>
                  <i className="up-sw" style={l.style} />
                  {l.text}
                </span>
              ))}
            </div>
            {rows(sum.rows)}
            {sum.note && <span className="cp-note">{sum.note}</span>}
          </>
        ) : null}
        {full && warn(`每个世界最多 ${UPHEAVALS_MAX} 件地形大事。要再加，先在概览「我的干预」里撤销一件。`)}
        {countRow}
      </div>
    );

  return (
    <>
      <div className="cp-head">
        <i className="up-head-ic">
          <Icon name="terrain" size={16} />
        </i>
        <div className="cp-title">
          <div className="ins-name-row big">
            <span className="ins-name">地形大事</span>
          </div>
          <div className="cp-sub">
            <span>{phone ? '这一年以前的历史一字不差' : `这颗星球，第 ${year} 年`}</span>
          </div>
        </div>
        <button className="cp-x ins-close" onClick={closeUpheaval} title="关闭(Esc)" aria-label="关闭">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="cp-body">
        {!phone && (
          <div className="cp-from">
            <span className="cp-k">哪一年</span>
            <div className="cp-from-row">
              {stepper(-100, '−100')}
              {stepper(-10, '−10')}
              {yearBox}
              {stepper(10, '+10')}
              {stepper(100, '+100')}
            </div>
            <span className="cp-note">这一年以前的历史一字不差，之后照新地形重新推演。拖时间轴也能换年份。</span>
          </div>
        )}
        <div className="up-kinds">
          {phone ? (
            <div className="cp-from-row up-yr">
              <span className="cp-k">哪一年</span>
              {stepper(-10, '−10')}
              {yearBox}
              {stepper(10, '+10')}
            </div>
          ) : (
            <span className="cp-form-title">发生什么</span>
          )}
          {tiles}
          {size}
          {!phone && <span className="cp-note">{kind.hint}</span>}
        </div>
        {summary}
      </div>
      <div className="cp-foot cp-grid2">
        <button className="cp-btn" data-act="up-cancel" onClick={closeUpheaval}>
          取消
        </button>
        <button className="cp-btn primary" data-act="up-happen" disabled={!ready} onClick={happen}>
          让它发生
        </button>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </>
  );
}

/** 地图下边的提示(跟着种类换) */
export function UpheavalHint() {
  const ui = useUpUi();
  if (!ui.on) return null;
  return <div className="first-hint up-hint">{upKind(ui.kind).map}</div>;
}

// ---------------------------------------------------------------------------
// 地图上那一层

const pathOf = (pts: readonly number[], close = false) => {
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  if (pts.length === 2) d += `L${pts[0] + 0.01} ${pts[1]}`;
  return close ? `${d}Z` : d;
};

const VOLCANO_ICON = 'M3 20l6-9h6l6 9zM10 8c-.8-1.6.8-2.4 0-4M14 8c-.8-1.4.8-2.2 0-3.6';

/**
 * 地图上那一层(卡片开着时):世界坐标,左右各挪一圈再画几份(主图右边还接着一份)。
 * scale = 屏幕上一个世界单位多少像素(火山记号、城的红圈按屏幕大小画)
 */
export function UpheavalOverlay({ civ, world, wrap = 0, scale = 1 }: { civ: Civ | null; world: World; wrap?: number; scale?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const ui = useUpUi();
  const dr = useUpDraft();
  const pv = useUpPreview();
  const edits = useEdits();
  const t = useCivTime();
  const year = civ ? upYear(t.year, civ.endYear) : 0;
  const sig = ui.on ? previewSig(ui.ops, edits.upheavals, year) : '';
  const result = ui.on && pv.result && pv.result.sig === sig && ui.ops.length ? pv.result : null;
  // 真会变的地块:沉进海里的蓝、抬出水面的绿
  const cells = useMemo(() => {
    if (!result) return null;
    const kinds = new Set(ui.ops.map((o) => o.kind));
    const sunk = cellShapes(world.mesh, kinds.has('sink') ? result.preview.sunkCells : []);
    const risen = cellShapes(world.mesh, countsRisen(world, ui.ops) ? result.preview.risenCells : []);
    return { sunk, risen };
  }, [result, world, ui.ops]);
  // 涂的几笔(连正在涂的那一笔)合起来的外轮廓,按种类分开
  const strokes = useMemo(() => {
    if (!ui.on) return [];
    const out: { kind: 'raise' | 'sink'; list: { pts: readonly number[]; r: number }[] }[] = [];
    for (const k of ['raise', 'sink'] as const) {
      const list: { pts: readonly number[]; r: number }[] = ui.ops.filter((o) => o.kind === k);
      if (dr.pts && ui.kind === k) list.push({ pts: dr.pts, r: ui.size[k] });
      if (list.length) out.push({ kind: k, list });
    }
    return out.map((s) => ({ ...s, outline: bandOutline(s.list) }));
  }, [ui.on, ui.ops, ui.kind, ui.size, dr.pts]);
  const rings = useMemo(() => {
    if (!result || !civ) return [];
    return victimsOf(civ, world, result, year, ui.ops)
      .filter((v) => v.drowned)
      .map((v) => civ.settlements[v.id].cell);
  }, [result, civ, world, year, ui.ops]);
  if (!ui.on) return null;
  const px = 1 / Math.max(1e-6, scale);
  const r = ui.size[ui.kind];
  const shape = (s: ReturnType<typeof cellShapes>, color: string, a: number) => {
    let d = '';
    for (const p of s.polys) d += pathOf(p, true);
    let e = '';
    for (let i = 0; i < s.edges.length; i += 4) e += `M${s.edges[i]} ${s.edges[i + 1]}L${s.edges[i + 2]} ${s.edges[i + 3]}`;
    return (
      <g>
        {d && <path d={d} fill={rgba(color, a)} />}
        {e && <path d={e} fill="none" stroke={rgba(color, 0.95)} strokeWidth={1.4 * px} />}
      </g>
    );
  };
  return (
    <svg className="up-overlay" viewBox={`0 0 ${world.width} ${world.height}`} preserveAspectRatio="none" aria-hidden="true">
      <g id={uid}>
        {cells && shape(cells.sunk, C_SEA, 0.55)}
        {cells && shape(cells.risen, C_LAND, 0.6)}
        {strokes.map((s) => {
          const color = s.kind === 'sink' ? C_SEA : C_LAND;
          const outline = s.outline.map((l) => pathOf(l, true)).join('');
          return (
            <g key={s.kind}>
              <g opacity={0.16}>
                {s.list.map((b, i) => (
                  <path key={i} d={pathOf(b.pts)} fill="none" stroke={color} strokeWidth={b.r * 2} strokeLinecap="round" strokeLinejoin="round" />
                ))}
              </g>
              {outline && (
                <>
                  <path d={outline} fill="none" stroke="rgba(255,255,255,0.95)" strokeWidth={1.6 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
                  <path d={outline} fill="none" stroke={rgba(color, 0.9)} strokeWidth={0.8 * px} />
                </>
              )}
            </g>
          );
        })}
        {ui.ops
          .filter((o) => o.kind === 'volcano')
          .map((o, i) => {
            const [x, y] = o.pts;
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={o.r} fill={rgba(C_VOLC, 0.1)} stroke="rgba(255,255,255,0.95)" strokeWidth={1.6 * px} strokeDasharray={`${6 * px} ${4 * px}`} />
                <circle cx={x} cy={y} r={o.r * BLAST} fill={rgba(C_RED, 0.16)} stroke={rgba(C_RED, 0.9)} strokeWidth={1.4 * px} />
                <g className="up-pin" transform={`translate(${x} ${y}) scale(${px})`}>
                  <circle r={15} fill="#fff" />
                  <path d={VOLCANO_ICON} transform="translate(-9 -9) scale(0.75)" fill="none" stroke={C_VOLC} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              </g>
            );
          })}
        {rings.map((c) => (
          <circle key={c} cx={world.mesh.x[c]} cy={world.mesh.y[c]} r={9 * px} fill="none" stroke={rgba(C_RED, 0.95)} strokeWidth={2 * px} />
        ))}
        {dr.cursor && !dr.pts && (
          <g>
            <circle cx={dr.cursor[0]} cy={dr.cursor[1]} r={r} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={3 * px} />
            <circle cx={dr.cursor[0]} cy={dr.cursor[1]} r={r} fill="none" stroke="#fff" strokeWidth={1.5 * px} />
          </g>
        )}
      </g>
      {!!wrap && [-wrap, wrap, 2 * wrap].map((dx) => <use key={dx} href={`#${uid}`} x={dx} />)}
    </svg>
  );
}

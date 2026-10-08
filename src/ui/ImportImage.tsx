/**
 * 编辑地形里的「导入图片」:选一张图(「整张草图」第一行,或者把图片拖到地图上),在这台设备上认出哪是海、哪是陆地
 * (gen/sketchImage.ts),看着地图上的预览调好,点「用这张图」变成草图的底子。图片不上传,用了以后也只记下认出来的格子。
 *
 * - 导入时左边编辑地形的面板整块换成 ImportPanel(取消 = 回到原来的样子);地图上画 ImportLayer(在 TerrainOverlay 里):
 *   图铺在它放的地方,认出来的涂上颜色、海岸描一道白线,点过的地方标 1 2 3;保持比例时画出图的范围,没盖到的地方压暗。
 * - 认法:点一下海(在地图上点图里的海;撤销一下 / 重新点)/ 按深浅(海平面、亮暗反过来;灰度图还能「高低也照图」)。
 *   放法:铺满整张 / 保持比例(拖动图片挪位置,「大小」缩放)。地图上看认出来的还是原图。
 * - 认得不像样(importWarning)出一条橙色提醒,「用这张图」变灰。
 * - 地图事件由 TerrainTools 转过来:importDown / importMove / importUp / importClick(世界坐标)。
 * - 用了以后草图里那一层在地图上的样子(陆地淡淡涂绿、海岸描线)是 LayerMark,也画在 TerrainOverlay 里。
 */
import { useMemo, useSyncExternalStore } from 'react';
import { LAYER_H, LAYER_W, SKETCH_HILLS, SKETCH_LAND, SKETCH_MOUNTAIN, SKETCH_PLATEAU, SKETCH_SEA, SKETCH_SHELF, decodeLayer, type SketchImage } from '../gen/sketch';
import {
  WAND_RANGE,
  WAND_RANGE_MAX,
  WAND_RANGE_MIN,
  PLACE_SCALE,
  autoSeaLevel,
  importWarning,
  layerStats,
  layerTrouble,
  levelsFrom,
  placeOnLayer,
  placeRect,
  preparePicture,
  seaFromClicks,
  type ImportWarning,
  type LayerStats,
  type Picture,
  type Placement,
} from '../gen/sketchImage';
import { TERRAIN_H, TERRAIN_W } from '../gen/terrainEdits';
import { clamp } from '../gen/util';
import { Icon } from './icons';
import { showToast } from './toastStore';
import { Seg, Slider } from './tpControls';

// ---------------------------------------------------------------------------
// 状态

export type ImportMode = 'wand' | 'level';

interface ImportState {
  /** 图片的文件名 */
  name: string;
  /** 图片(本机的 blob 网址,面板的缩略图、地图上的预览用;取消、用了以后收回) */
  url: string;
  /** 原图多大(像素) */
  w: number;
  h: number;
  pic: Picture;
  mode: ImportMode;
  /** 点过的地方(图上的比例 0–1),按先后 */
  clicks: readonly (readonly [number, number])[];
  /** 点一下海的范围 */
  range: number;
  /** 按深浅的海平面(灰度 0–255)、暗的是陆地、高低也照图 */
  sea: number;
  dark: boolean;
  heights: boolean;
  /** 放法:铺满整张 / 保持比例(x、y = 图中心在整张图上的位置 0–1,scale = 大小) */
  fit: 'fill' | 'keep';
  x: number;
  y: number;
  scale: number;
  /** 地图上看认出来的还是原图 */
  view: 'result' | 'original';
}

let imp: ImportState | null = null;
const subs = new Set<() => void>();
function setImp(next: ImportState | null) {
  imp = next;
  if (!next) document.body.classList.remove('imp-move');
  subs.forEach((f) => f());
}
const patch = (p: Partial<ImportState>) => imp && setImp({ ...imp, ...p });

export function useImport(): ImportState | null {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => imp,
    () => imp,
  );
}
export const importOn = () => !!imp;
export const useImportOn = () => !!useImport();

/** 最多点几处 */
const MAX_CLICKS = 60;
/** 原图宽或高超过这么多就不认了(太大的图解码很占内存) */
const MAX_SIDE = 8000;
/** 认之前先把图缩到长边不超过这么多(找线还用得上细节,又不至于太慢) */
const DECODE_SIDE = 2560;

/** 选一张图(点「导入图片」「换一张」时) */
export function pickImage() {
  // 选文件框放进页面里再点(不在页面里的,有的浏览器选好了也不发 change);选好了拿掉,取消了留到下次再拿掉
  document.querySelector('input.imp-pick')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.className = 'imp-pick';
  input.hidden = true;
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.remove();
    if (f) void startImport(f);
  });
  document.body.append(input);
  input.click();
}

/** 拖进来的是不是图片 */
export const isImageFile = (f: File) => f.type.startsWith('image/');

/** 第几次读图:读完发现已经不是最新的一次(又选了一张,或者取消了)就扔掉 */
let loading = 0;

/** 读这张图、准备好认,打开导入面板(已经开着的换成这张);读不出来出一条提示 */
export async function startImport(file: File) {
  const req = ++loading;
  const url = URL.createObjectURL(file);
  const fail = (text: string, more: string) => {
    URL.revokeObjectURL(url);
    showToast({ id: 'import', kind: 'error', text, more: [more] });
  };
  // 先只读出图有多大(浏览器到画的时候才整张解码),太大的不解码
  const img = new Image();
  const ok = await new Promise<boolean>((done) => {
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
  });
  if (req !== loading) return URL.revokeObjectURL(url);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!ok || !w || !h) return fail('没能读出这张图', `${file.name} 不是能打开的图片`);
  if (w > MAX_SIDE || h > MAX_SIDE) return fail('这张图太大了', `换一张宽、高都不超过 ${MAX_SIDE} 像素的图`);
  const k = Math.min(1, DECODE_SIDE / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let pic: Picture;
  try {
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(img, 0, 0, cw, ch);
    pic = preparePicture(ctx.getImageData(0, 0, cw, ch));
  } catch {
    return fail('没能读出这张图', `${file.name} 不是能打开的图片`);
  }
  if (imp) URL.revokeObjectURL(imp.url);
  setImp({
    name: file.name,
    url,
    w,
    h,
    pic,
    mode: 'wand',
    clicks: [],
    range: WAND_RANGE,
    sea: autoSeaLevel(pic),
    dark: false,
    heights: true,
    fit: 'fill',
    x: 0.5,
    y: 0.5,
    scale: 1,
    view: 'result',
  });
}

/** 取消导入(收起面板,图片不留) */
export function cancelImport() {
  drag = null;
  loading++;
  if (!imp) return;
  URL.revokeObjectURL(imp.url);
  setImp(null);
}

/** 撤销最后点的一下 */
export function importUndoClick() {
  if (imp?.clicks.length) patch({ clicks: imp.clicks.slice(0, -1) });
}

// ---------------------------------------------------------------------------
// 认出来的(按状态缓存:拖滑条、点一下只重算变了的那一步)

interface Recognized {
  /** 图上每格(pic.w × pic.h)的草图值 */
  values: Uint8Array;
  /** 铺到整张图上的格子图(LAYER_W × LAYER_H) */
  layer: Uint8Array;
  stats: LayerStats;
  /** 认出来东西了(点一下海:点过至少一下) */
  ready: boolean;
  warn: ImportWarning;
}

/** 高低也照图:只有灰度图才有(彩色的图深浅不代表高低) */
const heightsOn = (s: ImportState) => s.heights && !s.pic.colorful;
const placementOf = (s: ImportState): Placement => (s.fit === 'fill' ? { fit: 'fill' } : { fit: 'keep', x: s.x, y: s.y, scale: s.scale });

let lastValues: { pic: Picture; key: string; values: Uint8Array } | null = null;
let lastRec: { s: ImportState; values: Uint8Array; place: string; rec: Recognized } | null = null;

function recognize(s: ImportState): Recognized {
  if (lastRec?.s === s) return lastRec.rec;
  const key = s.mode === 'wand' ? `w|${s.range}|${s.clicks.map((c) => c.join(',')).join(';')}` : `l|${s.sea}|${s.dark}|${heightsOn(s)}`;
  if (lastValues?.pic !== s.pic || lastValues.key !== key) {
    const values = s.mode === 'wand' ? seaFromClicks(s.pic, s.clicks, s.range) : levelsFrom(s.pic, { sea: s.sea, dark: s.dark, heights: heightsOn(s) });
    lastValues = { pic: s.pic, key, values };
  }
  const values = lastValues.values;
  const p = placementOf(s);
  const place = JSON.stringify(p);
  if (lastRec && lastRec.values === values && lastRec.place === place) {
    lastRec = { ...lastRec, s };
    return lastRec.rec;
  }
  const layer = placeOnLayer(values, s.pic.w, s.pic.h, p);
  const stats = layerStats(layer);
  const ready = s.mode === 'level' || s.clicks.length > 0;
  const rec = { values, layer, stats, ready, warn: ready ? importWarning(stats, s.mode, s.pic.colorful) : null };
  lastRec = { s, values, place, rec };
  return rec;
}

/** 现在认出来的,点「用这张图」时用;还没认出东西、认得不像样 = null */
export function importResult(): { name: string; layer: Uint8Array } | null {
  if (!imp) return null;
  const r = recognize(imp);
  return r.ready && !r.warn ? { name: imp.name, layer: r.layer } : null;
}

/** 图在地图上的哪一块(世界坐标) */
function worldRect(s: ImportState, width = TERRAIN_W) {
  const r = placeRect(s.pic.w, s.pic.h, placementOf(s));
  const k = width / LAYER_W;
  return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
}

/** 世界坐标落在图上的哪儿(图上的比例 0–1;不在图上 = null)。图左右超出地图的部分绕到另一边,点在那儿也算 */
function onPicture(s: ImportState, w: readonly [number, number]): [number, number] | null {
  const r = worldRect(s);
  const fx = ((((w[0] - r.x) % TERRAIN_W) + TERRAIN_W) % TERRAIN_W) / r.w;
  const fy = (w[1] - r.y) / r.h;
  return fx >= 0 && fx < 1 && fy >= 0 && fy < 1 ? [fx, fy] : null;
}

// ---------------------------------------------------------------------------
// 地图事件(TerrainTools 转过来的;世界坐标)

/** 保持比例时正在拖图片:按下的地方、那时图的中心、拖开了没有 */
let drag: { x0: number; y0: number; cx: number; cy: number; moved: boolean } | null = null;

function addClick(w: readonly [number, number]) {
  if (!imp || imp.mode !== 'wand' || imp.clicks.length >= MAX_CLICKS) return;
  const f = onPicture(imp, w);
  if (f) patch({ clicks: [...imp.clicks, f] });
}

/** 按下:保持比例时按在图上 = 开始拖图片(返回 true = 这一下归导入管,地图不平移) */
export function importDown(w: [number, number] | null, button: number): boolean {
  if (!imp || !w || button !== 0 || imp.fit !== 'keep' || !onPicture(imp, w)) return false;
  drag = { x0: w[0], y0: w[1], cx: imp.x, cy: imp.y, moved: false };
  return true;
}

/** 移动:拖着图片就挪;没拖时在图上光标变成挪动的样子(返回 true = 正在拖) */
export function importMove(w: [number, number] | null): boolean {
  if (!imp) return false;
  if (!drag) {
    document.body.classList.toggle('imp-move', !!w && imp.fit === 'keep' && !!onPicture(imp, w));
    return false;
  }
  if (!w) return true;
  // 跨 180° 经线拖:按离按下的地方近的那一圈算
  let dx = w[0] - drag.x0;
  dx -= TERRAIN_W * Math.round(dx / TERRAIN_W);
  const dy = w[1] - drag.y0;
  if (!drag.moved && dx * dx + dy * dy < 16) return true;
  drag.moved = true;
  // 左右可以一直拖(星球东西相连),上下到地图边为止
  patch({ x: (((drag.cx + dx / TERRAIN_W) % 1) + 1) % 1, y: clamp(drag.cy + dy / TERRAIN_H, 0, 1) });
  return true;
}

/** 松开:没拖开的那一下当作点了一下(点一下海时加一处) */
export function importUp() {
  const d = drag;
  drag = null;
  if (d && !d.moved) addClick([d.x0, d.y0]);
}

/** 单击地图(铺满整张时,或者点在保持比例的图外面):点一下海时加一处 */
export function importClick(w: [number, number] | null) {
  if (w) addClick(w);
}

/** 第二根手指按下:不拖了 */
export function importCancel() {
  drag = null;
}

/** 地图下边的一句提示(不用提示 = null) */
export function importCaption(s: ImportState | null): string | null {
  if (!s) return null;
  const pick = s.mode === 'wand' && !s.clicks.length;
  if (s.fit === 'keep') return pick ? '点一下图里的海；拖动图片挪位置' : '拖动图片挪位置';
  return pick ? '点一下图里的海' : null;
}

// ---------------------------------------------------------------------------
// 面板

const pct = (v: number) => `${Math.round(v * 100)}%`;
const DOT = {
  land: '#7cc860',
  sea: '#3f8fe0',
  shelf: '#74d0e8',
  hills: '#c4cf5a',
  mountain: '#e0a050',
};

function warnText(w: Exclude<ImportWarning, null>, mode: ImportMode, stats: LayerStats): string {
  const t = layerTrouble(stats);
  const lead = t === 'specks' ? '认出来是碎的。' : t === 'sea' ? '认出来几乎全是海。' : '认出来几乎全是陆地。';
  if (w === 'colorful') return `${lead}这张像是彩色的手画图，深浅分不出海和陆地，试试「点一下海」。`;
  if (mode === 'level') return lead + (t === 'specks' ? '拖一下「海平面」试试。' : t === 'sea' ? '把「海平面」往左拖一点。' : '把「海平面」往右拖一点。');
  return lead + (t === 'specks' ? '把「范围」调大一点试试。' : t === 'sea' ? '看看海岸线有没有断口，或把「范围」调小。' : '点的可能是陆地，撤销一下再点海。');
}

/**
 * 导入面板(编辑地形的面板导入时整块换成它):图片那一行(换一张)、怎么认、放法 / 地图上、认出来多少,最下面「用这张图」和一句不上传。
 * 手机上同一套,点了几处那一行连着写陆地占多少,不另起一行
 */
export function ImportPanel({ phone, onUse }: { phone: boolean; onUse: () => void }) {
  const s = useImport();
  if (!s) return null;
  const r = recognize(s);
  const box = phone ? [48, 32] : [64, 40];
  const tw = Math.round(Math.min(box[0], (box[1] * s.w) / s.h));
  const th = Math.round((tw * s.h) / s.w);
  const land = r.stats.land;
  const hasHeights = s.mode === 'level' && !s.pic.colorful;
  const hint =
    s.mode === 'wand'
      ? phone
        ? '点一下图里的海；被陆地围住的内海、湖，再各点一下。'
        : '在地图上点一下图里的海。颜色相近、连成一片的都算海；被陆地围住的内海、湖，再各点一下。'
      : `${s.dark ? '暗的是陆地、亮的是海' : '亮的是陆地、暗的是海'}；拖「海平面」定多高以下算海。`;
  const n = s.clicks.length;
  const result =
    r.ready && !r.warn && (!phone || s.mode === 'level') ? (
      heightsOn(s) ? (
        <div className="imp-result">
          <span className="imp-result-n">
            认出来陆地 <b>{pct(land)}</b>
          </span>
          <span className="imp-legend">
            {(
              [
                ['浅海', DOT.shelf],
                ['陆地', DOT.land],
                ['丘陵', DOT.hills],
                ['山地', DOT.mountain],
              ] as const
            ).map(([name, c]) => (
              <span key={name}>
                <i style={{ background: c }} />
                {name}
              </span>
            ))}
          </span>
        </div>
      ) : (
        <div className="imp-result">
          <span>认出来</span>
          <span className="imp-legend">
            <span>
              <i style={{ background: DOT.land }} />
              陆地 <b>{pct(land)}</b>
            </span>
            <span>
              <i style={{ background: DOT.sea }} />海 <b>{pct(1 - land)}</b>
            </span>
          </span>
        </div>
      )
    ) : null;

  return (
    <div className="tp imp" role="region" aria-label="导入图片">
      <section className="sb-sec">
        <div className="sb-sec-head">
          <span>导入图片</span>
          <button className="sb-link tp-done" data-act="import-cancel" onClick={cancelImport}>
            取消
          </button>
        </div>
        <div className="sb-group">
          <div className="imp-file">
            <img src={s.url} width={tw} height={th} alt="" />
            <span className="imp-file-tx">
              <b>{s.name}</b>
              <span>
                {s.w} × {s.h}
                {s.pic.colorful ? '' : '，灰度'}
              </span>
            </span>
            <button className="sb-link" data-act="import-repick" onClick={pickImage}>
              换一张
            </button>
          </div>
        </div>
      </section>
      <div className="sb-group">
        <div className="tp-opts">
          <Seg
            label="怎么认"
            act="import-mode"
            items={[
              { v: 'wand' as const, name: '点一下海' },
              { v: 'level' as const, name: '按深浅' },
            ]}
            value={s.mode}
            onPick={(v) => patch({ mode: v })}
          />
          <div className="imp-hint">{hint}</div>
          {s.mode === 'wand' ? (
            <Slider label="范围" act="import-range" min={WAND_RANGE_MIN} max={WAND_RANGE_MAX} step={0.5} value={s.range} onChange={(v) => patch({ range: v })} />
          ) : (
            <>
              <Slider label="海平面" act="import-sea" min={1} max={254} value={s.sea} onChange={(v) => patch({ sea: v })} />
              <Seg
                label="深浅"
                act="import-dark"
                items={[
                  { v: 0, name: '亮的是陆地' },
                  { v: 1, name: '暗的是陆地' },
                ]}
                value={s.dark ? 1 : 0}
                onPick={(v) => patch({ dark: v === 1, sea: autoSeaLevel(s.pic, v === 1) })}
              />
            </>
          )}
        </div>
        {s.mode === 'wand' && (
          <div className="tp-count">
            <b className="tp-n">{n ? (phone && r.ready ? `点了 ${n} 处，陆地 ${pct(land)}` : `点了 ${n} 处`) : '还没点'}</b>
            <button className="sb-link" data-act="import-undo" disabled={!n} onClick={importUndoClick}>
              撤销一下
            </button>
            <button className="sb-link" data-act="import-reset" disabled={!n} onClick={() => patch({ clicks: [] })}>
              重新点
            </button>
          </div>
        )}
        {hasHeights && (
          <button className="sb-row tp-show imp-heights" role="switch" aria-checked={s.heights} data-act="import-heights" onClick={() => patch({ heights: !s.heights })}>
            <span className="sb-row-main">
              <b>高低也照图</b>
              <small>{s.dark ? '越暗越高' : '越亮越高'}，长成丘陵、山地；关掉就只分海陆，山由程序定</small>
            </span>
            <span className={`ai-switch${s.heights ? ' on' : ''}`} aria-hidden="true" />
          </button>
        )}
        {r.warn && (
          <div className="imp-warn" role="status">
            <Icon name="warn" size={16} />
            <span>
              {warnText(r.warn, s.mode, r.stats)}
              {r.warn === 'colorful' && (
                <>
                  <br />
                  <button className="sb-link" data-act="import-use-wand" onClick={() => patch({ mode: 'wand' })}>
                    改用点一下海
                  </button>
                </>
              )}
            </span>
          </div>
        )}
      </div>
      <div className="sb-group">
        <div className="tp-opts">
          <Seg
            label="放法"
            act="import-fit"
            items={[
              { v: 'fill' as const, name: '铺满整张' },
              { v: 'keep' as const, name: '保持比例' },
            ]}
            value={s.fit}
            onPick={(v) => patch({ fit: v })}
          />
          {s.fit === 'keep' && <Slider label="大小" act="import-scale" min={PLACE_SCALE[0]} max={PLACE_SCALE[1]} step={0.01} value={s.scale} onChange={(v) => patch({ scale: v })} />}
          <Seg
            label="地图上"
            act="import-view"
            items={[
              { v: 'result' as const, name: '认出来的' },
              { v: 'original' as const, name: '原图' },
            ]}
            value={s.view}
            onPick={(v) => patch({ view: v })}
          />
        </div>
        {result}
      </div>
      <button className="imp-use" data-act="import-use" disabled={!r.ready || !!r.warn} onClick={onUse}>
        用这张图
      </button>
      <div className="tp-fine">{phone ? '图片只在这台手机上认，不上传，也不存原图。' : '图片只在这台电脑上认，不会上传。用了以后只记下认出来的海陆和高低，不存原图。'}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 地图上

type RGBA = readonly [number, number, number, number];
/** 导入时预览的颜色:点一下海 / 只分海陆 —— 海涂蓝、陆地涂绿;高低也照图 —— 和各支笔一样的颜色,海不涂(高度图本来就暗) */
const PREVIEW_PLAIN: Record<number, RGBA> = { [SKETCH_SEA]: [40, 110, 205, 0.5], [SKETCH_SHELF]: [40, 110, 205, 0.5], [SKETCH_LAND]: [124, 200, 96, 0.3] };
const PREVIEW_HEIGHTS: Record<number, RGBA> = {
  [SKETCH_SHELF]: [116, 208, 232, 0.3],
  [SKETCH_LAND]: [124, 200, 96, 0.55],
  [SKETCH_HILLS]: [196, 207, 90, 0.55],
  [SKETCH_MOUNTAIN]: [224, 160, 80, 0.55],
  [SKETCH_MOUNTAIN + 1]: [224, 160, 80, 0.55],
  [SKETCH_MOUNTAIN + 2]: [224, 160, 80, 0.55],
};
/** 用了以后草图里那一层:陆地淡淡涂绿,丘陵、山地、浅海和笔一样的颜色,海不涂(下面的地图看得见) */
const LAYER_COLORS: Record<number, RGBA> = {
  [SKETCH_SHELF]: [116, 208, 232, 0.3],
  [SKETCH_LAND]: [124, 200, 96, 0.28],
  [SKETCH_HILLS]: [196, 207, 90, 0.32],
  [SKETCH_PLATEAU]: [201, 140, 102, 0.38],
  [SKETCH_MOUNTAIN]: [224, 160, 80, 0.4],
  [SKETCH_MOUNTAIN + 1]: [224, 160, 80, 0.4],
  [SKETCH_MOUNTAIN + 2]: [224, 160, 80, 0.4],
};

/** 每格按颜色表涂成一张小图(w × h,PNG 的 data 网址);表里没有的格子透明 */
function tintUrl(values: Uint8Array, w: number, h: number, colors: Record<number, RGBA>): string {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  const im = ctx.createImageData(w, h);
  for (let i = 0; i < values.length; i++) {
    const c = colors[values[i]];
    if (!c) continue;
    im.data[4 * i] = c[0];
    im.data[4 * i + 1] = c[1];
    im.data[4 * i + 2] = c[2];
    im.data[4 * i + 3] = Math.round(c[3] * 255);
  }
  ctx.putImageData(im, 0, 0);
  return cv.toDataURL();
}

/**
 * 海岸线(陆地和别的分界)的路径,格子坐标(一格 = 1,图的左上角是原点):陆地 = 1、别的 = 0,先 3 × 3 糊一下,
 * 再取 0.5 的等值线(一格一格看四个角,线一段一段画),比直接描格子边顺
 */
function coastPath(values: Uint8Array, w: number, h: number): string {
  const f = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          n++;
          if (values[yy * w + xx] >= SKETCH_LAND) s++;
        }
      }
      f[y * w + x] = s / n;
    }
  }
  const out: string[] = [];
  const r = (v: number) => Math.round(v * 10) / 10;
  const seg = (ax: number, ay: number, bx: number, by: number) => out.push(`M${r(ax)} ${r(ay)}L${r(bx)} ${r(by)}`);
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = f[y * w + x];
      const b = f[y * w + x + 1];
      const c = f[(y + 1) * w + x + 1];
      const d = f[(y + 1) * w + x];
      const k = (a > 0.5 ? 8 : 0) | (b > 0.5 ? 4 : 0) | (c > 0.5 ? 2 : 0) | (d > 0.5 ? 1 : 0);
      if (k === 0 || k === 15) continue;
      // 格子中心在 +0.5;四条边上 0.5 的位置
      const cx = x + 0.5;
      const cy = y + 0.5;
      const T = (): [number, number] => [cx + (0.5 - a) / (b - a), cy];
      const R = (): [number, number] => [cx + 1, cy + (0.5 - b) / (c - b)];
      const B = (): [number, number] => [cx + (0.5 - d) / (c - d), cy + 1];
      const L = (): [number, number] => [cx, cy + (0.5 - a) / (d - a)];
      const line = (p: [number, number], q: [number, number]) => seg(p[0], p[1], q[0], q[1]);
      switch (k) {
        case 1:
        case 14:
          line(L(), B());
          break;
        case 2:
        case 13:
          line(B(), R());
          break;
        case 3:
        case 12:
          line(L(), R());
          break;
        case 4:
        case 11:
          line(T(), R());
          break;
        case 6:
        case 9:
          line(T(), B());
          break;
        case 7:
        case 8:
          line(L(), T());
          break;
        case 5:
          line(L(), T());
          line(B(), R());
          break;
        case 10:
          line(T(), R());
          line(L(), B());
          break;
      }
    }
  }
  return out.join('');
}

/**
 * 导入时地图上的预览(TerrainOverlay 里,世界坐标):图铺在它放的地方;「认出来的」时涂色、描海岸线(认得不像样时不描);点过的地方标序号;
 * 保持比例时画出图的范围(虚线框、四角小方块),没盖到的地方压暗并写上照什么走。
 * scale = 屏幕上一个世界单位多少像素(序号、小方块、字按屏幕大小画);rest = 没涂的地方交给程序还是都是海
 */
export function ImportLayer({ width, height, scale, rest }: { width: number; height: number; scale: number; rest: 'auto' | 'sea' }) {
  const s = useImport();
  return s ? <ImportPreview s={s} width={width} height={height} scale={scale > 0 ? scale : 1} rest={rest} /> : null;
}

function ImportPreview({ s, width, height, scale, rest }: { s: ImportState; width: number; height: number; scale: number; rest: 'auto' | 'sea' }) {
  const r = recognize(s);
  const heights = s.mode === 'level' && heightsOn(s);
  const tint = useMemo(() => tintUrl(r.values, s.pic.w, s.pic.h, heights ? PREVIEW_HEIGHTS : PREVIEW_PLAIN), [r.values, s.pic, heights]);
  const box = worldRect(s, width);
  const px = (v: number) => v / scale;
  const keep = s.fit === 'keep';
  const shown = s.view === 'result' && r.ready;
  // 认不准时不描海岸线(碎的时候线特别多,也不用算)
  const coastOn = shown && !r.warn;
  const coast = useMemo(() => (coastOn ? coastPath(r.values, s.pic.w, s.pic.h) : ''), [coastOn, r.values, s.pic]);
  // 没盖到的地方:图左右两边(整个高度)、图上下(图那几列)。图左右超出地图的部分绕到另一边,地图上图占的几段按这个算
  const y0 = clamp(box.y, 0, height);
  const y1 = clamp(box.y + box.h, 0, height);
  const spans = [-width, 0, width]
    .map((dx) => [clamp(box.x + dx, 0, width), clamp(box.x + box.w + dx, 0, width)])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const dims: number[][] = [];
  if (keep) {
    let at = 0;
    for (const [a, b] of spans) {
      dims.push([at, 0, a - at, height], [a, 0, b - a, y0], [a, y1, b - a, height - y1]);
      at = b;
    }
    dims.push([at, 0, width - at, height]);
  }
  const shade = dims.filter(([, , w, h]) => w > 0 && h > 0);
  const tag = rest === 'sea' ? '都是海' : '交给程序';
  const tags = shade.filter(([, , w, h]) => w * scale >= 64 && h * scale >= 24);
  const corners = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  const sq = px(9);
  return (
    <g className="imp-layer">
      {shade.map(([x, y, w, h], i) => (
        <rect key={i} className="imp-dim" x={x} y={y} width={w} height={h} />
      ))}
      <image href={s.url} x={box.x} y={box.y} width={box.w} height={box.h} preserveAspectRatio="none" />
      {shown && (
        <>
          <image href={tint} x={box.x} y={box.y} width={box.w} height={box.h} preserveAspectRatio="none" />
          {coastOn && (
            <g transform={`translate(${box.x} ${box.y}) scale(${box.w / s.pic.w} ${box.h / s.pic.h})`}>
              <path className={`imp-coast${s.mode === 'level' ? ' thin' : ''}`} d={coast} vectorEffect="non-scaling-stroke" />
            </g>
          )}
        </>
      )}
      {keep && (
        <>
          <rect className="imp-box-halo" x={box.x} y={box.y} width={box.w} height={box.h} vectorEffect="non-scaling-stroke" />
          <rect className="imp-box" x={box.x} y={box.y} width={box.w} height={box.h} vectorEffect="non-scaling-stroke" />
          {corners.map(([x, y], i) => (
            // 地图上下边以外看不见:贴着上下边的小方块往里挪到整个露出来
            <rect key={i} className="imp-corner" x={x - sq / 2} y={clamp(y - sq / 2, 0, height - sq)} width={sq} height={sq} rx={px(2)} vectorEffect="non-scaling-stroke" />
          ))}
          {tags.map(([x, y, w, h], i) => (
            <text key={i} className="imp-tag" x={x + w / 2} y={y + h / 2} fontSize={px(12)} dy="0.35em" textAnchor="middle">
              {tag}
            </text>
          ))}
        </>
      )}
      {s.mode === 'wand' &&
        s.clicks.map(([fx, fy], i) => (
          <g key={i} className="imp-pin" transform={`translate(${box.x + fx * box.w} ${box.y + fy * box.h})`}>
            <circle className="imp-pin-shade" r={px(11.5)} />
            <circle className="imp-pin-dot" r={px(10)} vectorEffect="non-scaling-stroke" />
            <text fontSize={px(11.5)} dy="0.36em" textAnchor="middle">
              {i + 1}
            </text>
          </g>
        ))}
    </g>
  );
}

/** 导入的那一层盖住了哪些格子(海也算):盖住的不透明黑、没盖住的透明,PNG 的 data 网址。草图层拿它当遮罩,把这一层前面的笔挖掉 */
let lastCover: { cells: string; url: string } | null = null;
export function coverMaskUrl(cells: string): string {
  if (lastCover?.cells === cells) return lastCover.url;
  const layer = decodeLayer(cells);
  const black: Record<number, RGBA> = {};
  for (let v = SKETCH_SEA; v <= SKETCH_MOUNTAIN + 2; v++) black[v] = [0, 0, 0, 1];
  const url = layer ? tintUrl(layer, LAYER_W, LAYER_H, black) : '';
  lastCover = { cells, url };
  return url;
}

/** 用了以后,草图里导入的那一层在地图上的样子:陆地淡淡涂绿(丘陵、山地、浅海照笔的颜色)、海岸描一道浅绿的线。pending = 地图上还没照它生成好 */
export function LayerMark({ image, width, height, pending }: { image: SketchImage; width: number; height: number; pending: boolean }) {
  const layer = useMemo(() => decodeLayer(image.cells), [image.cells]);
  const tint = useMemo(() => (layer ? tintUrl(layer, LAYER_W, LAYER_H, LAYER_COLORS) : ''), [layer]);
  const coast = useMemo(() => (layer ? coastPath(layer, LAYER_W, LAYER_H) : ''), [layer]);
  if (!layer) return null;
  return (
    <g className={`sk-image${pending ? ' pending' : ''}`}>
      <image href={tint} x={0} y={0} width={width} height={height} preserveAspectRatio="none" />
      <g transform={`scale(${width / LAYER_W} ${height / LAYER_H})`}>
        <path className="sk-image-coast" d={coast} vectorEffect="non-scaling-stroke" />
      </g>
    </g>
  );
}

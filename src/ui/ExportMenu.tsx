/**
 * 世界概览头部的"导出"菜单(阶段 4):把世界带出这个网页。
 *
 *   地图图片(PNG / JPEG):整张地图(不是当前视口),当前画风、当前时间轴年份的文明层(和屏幕上开着的一样),
 *                  文字按整图排版;1× = 2048×1024,2× = 4096×2048(重新铺两倍像素,文字按两倍密度重画,不是放大);
 *                  JPEG 质量 0.9,文件小好几倍(手绘 2× PNG 约 16 MB → JPEG 约 1.9 MB),方便贴帖子;
 *                  按屏幕上当前的投影和中央经线画(罗宾森、摩尔威德……外框是投影的外轮廓),经纬网开着也带上
 *   高度图(PNG):16 位(游戏引擎)/ 8 位(Azgaar);海平面在哪个灰度写在菜单里,导出后还能下载同名 .txt 说明
 *   编年史:Markdown / 纯文本(按时代分节,大事在前、全部附后)
 *   图例(PNG):国家 / 民族 + 颜色、城镇符号、道路,配地图用
 *   地球仪这一面(PNG,只在地球仪开着时有):现在看到的样子,见 Globe.tsx 的 exportGlobeView
 *
 * 重活在后台线程(src/exportWorker.ts,每次导出临时开一个)里做,界面不卡;主线程只画文字(要用页面里加载好的字体)、编码 PNG。
 * 用的是 App 当前显示的 civ(套过改名等修改的那份),不重新生成。
 * 文件名带种子、年份、画风:文明与地图-种子7-第3000年-手绘.png(JPEG 是 .jpg)
 */
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../gen/world';
import { rasterize, type Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { chronicleDocument } from '../gen/civ/chronicle';
import { AZGAAR_SEA_GRAY, heightmapNote, type HeightmapBits } from '../gen/heightmap';
import { LAYERS, type LayerId } from '../render/layers';
import type { CivShow, CivStyle } from '../render/civ/overlay';
import { IMAGE_FORMATS, drawLegend, drawMapBase, drawMapLabels, type ExportScale, type ImageFormat } from '../render/export';
import type { ExportRequest, ExportResponse } from '../exportWorker';
import { getCivShow, getCivTime, useCivTime } from './civView';
import { getMapCenter, xOfLon } from './mapWrap';
import { flatProjection, getGraticule, getProjection } from './projection';
import type { ProjectionId } from '../render/projection';
import { wrapOf } from '../render/common';
import { clearToast, showToast } from './toastStore';
import { exportGlobeView, useGlobeOn } from './Globe';

type Job = 'map' | 'mapjpg' | 'height16' | 'height8' | 'md' | 'txt' | 'legend' | 'globe';

const APP = '文明与地图';

interface Status {
  kind: 'busy' | 'ok' | 'error';
  text: string;
  /** 提示条的第二行小字(尺寸、大小、海平面灰度、出错原因) */
  more?: string;
  /** 高度图的 .txt 说明:导出后点一下再下载(一次点击连下两个文件,浏览器会拦) */
  note?: { name: string; text: string };
}

/** 调试 / 冒烟测试用:最近一次导出的结果 */
interface ExportDebug {
  job: Job;
  name: string;
  bytes: number;
  w?: number;
  h?: number;
  ms: number;
  detail?: Record<string, number>;
  seaLevel?: number;
}

function styleName(style: CivStyle, layer: LayerId): string {
  if (style === 'realistic') return '写实';
  if (style === 'fantasy') return '手绘';
  return LAYERS.find((l) => l.id === layer)?.name ?? '数据图层';
}

/** 和默认值不同的世界参数,写进编年史 / 高度图说明(同一种子 + 参数 = 同一个世界) */
function paramsText(p: WorldParams): string | undefined {
  const d = DEFAULT_PARAMS;
  const out: string[] = [];
  if (p.landFraction !== d.landFraction) out.push(`陆地比例 ${Math.round(p.landFraction * 100)}%`);
  if (p.plates !== d.plates) out.push(`板块数量 ${p.plates}`);
  if (p.mountains !== d.mountains) out.push(`造山强度 ${p.mountains.toFixed(2)}×`);
  if (p.temperature !== d.temperature) out.push(`气温 ${p.temperature > 0 ? '+' : ''}${p.temperature}°C`);
  if (p.rainfall !== d.rainfall) out.push(`降水 ${p.rainfall.toFixed(2)}×`);
  if (p.cells !== d.cells) out.push(`精细度 ${Math.round(p.cells / 1000)}k 地块`);
  return out.length ? out.join('、') : undefined;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 开一个导出线程做一件事,做完就关 */
function runWorker(req: ExportRequest): Promise<ExportResponse> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../exportWorker.ts', import.meta.url), { type: 'module' });
    const done = () => w.terminate();
    w.onmessage = (e: MessageEvent<ExportResponse>) => {
      done();
      resolve(e.data);
    };
    w.onerror = (e) => {
      done();
      reject(new Error(e.message || '后台线程出错'));
    };
    w.onmessageerror = () => {
      done();
      reject(new Error('后台线程传回的数据读不了'));
    };
    w.postMessage(req);
  });
}

function toBlob(cv: HTMLCanvasElement, format: ImageFormat = 'png'): Promise<Blob> {
  const f = IMAGE_FORMATS[format];
  return new Promise((resolve, reject) =>
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('图片太大,浏览器编码不了'))), f.mime, f.quality),
  );
}

/** 让"正在导出…"先显示出来,再开始干活 */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 错误说明翻成中文;内存不够的提示换 1× */
function explain(e: unknown, scale: ExportScale): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/memory|allocation|too large|太大|内存/i.test(msg)) return scale === 2 ? `${msg};换 1× 试试` : msg;
  return /[一-鿿]/.test(msg) ? msg : `出错了(${msg})`;
}

interface MapInput {
  world: World;
  raster: Raster;
  civ: Civ | null;
  style: CivStyle;
  layer: LayerId;
  year: number;
  show: CivShow;
  /** 球面世界:图片正中的世界 x(= 屏幕上当前视图的中心) */
  center?: number;
  /** 投影、经纬网(和屏幕上一样) */
  projection?: ProjectionId;
  graticule?: boolean;
}

/** 地图图片:后台线程画地形和文明底图,主线程叠文字、编码 PNG / JPEG */
async function exportMap(m: MapInput, scale: ExportScale, format: ImageFormat): Promise<{ blob: Blob; w: number; h: number; detail: Record<string, number> }> {
  const t0 = performance.now();
  const req: ExportRequest = {
    job: 'map',
    world: m.world,
    raster: scale === 1 ? m.raster : undefined,
    scale,
    civ: m.civ,
    style: m.style,
    layer: m.layer,
    year: m.year,
    show: m.show,
    center: m.center,
    projection: m.projection,
    graticule: m.graticule,
  };
  const res = await runWorker(req);
  const t1 = performance.now();
  const W = m.world.width * scale;
  const H = m.world.height * scale;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('开不了这么大的画布(内存不够)');
  const detail: Record<string, number> = {};
  if (res.ok && res.job === 'map') {
    ctx.drawImage(res.bitmap, 0, 0);
    res.bitmap.close();
    detail.raster = res.ms.raster;
    detail.draw = res.ms.draw;
  } else if (!res.ok && res.code === 'no-offscreen') {
    // 老浏览器:线程里画不了,只好在主线程画(会卡一下)
    const raster = scale === 1 ? m.raster : rasterize(m.world, scale);
    drawMapBase(ctx, { ...m, raster }, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  } else throw new Error(res.ok ? '后台线程回错了东西' : res.error);
  detail.worker = t1 - t0;
  const t2 = performance.now();
  const n = await drawMapLabels(ctx, { ...m }, scale);
  const t3 = performance.now();
  detail.labels = t3 - t2;
  detail.labelCount = n.labels;
  const blob = await toBlob(cv, format);
  detail.png = performance.now() - t3;
  cv.width = cv.height = 0;
  return { blob, w: W, h: H, detail };
}

export interface ExportMenuProps {
  data: { world: World; raster: Raster } | null;
  /** App 当前显示的文明(套过用户的修改) */
  civ: Civ | null;
  style: CivStyle;
  layer: LayerId;
}

export function ExportMenu({ data, civ, style, layer }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState<ExportScale>(1);
  const [status, setStatus] = useState<Status | null>(null);
  const time = useCivTime();
  const globeOn = useGlobeOn();
  const rootRef = useRef<HTMLDivElement>(null);
  const busy = status?.kind === 'busy';

  // 点菜单外面就收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 成功的提示过一会儿自己消失(带"下载说明"的留着,等用户点)
  useEffect(() => {
    if (status?.kind !== 'ok' || status.note) return;
    const t = setTimeout(() => setStatus(null), 7000);
    return () => clearTimeout(t);
  }, [status]);
  // 导出的进度、结果显示在顶部的提示条上(菜单在世界概览的头部;概览收起了也看得到)
  useEffect(() => {
    if (!status) return clearToast('export');
    const note = status.note;
    showToast({
      id: 'export',
      kind: status.kind === 'busy' ? 'progress' : status.kind,
      text: status.text,
      more: status.more ? [status.more] : undefined,
      action: note ? { label: '下载说明', onClick: () => download(new Blob([note.text], { type: 'text/plain;charset=utf-8' }), note.name) } : undefined,
      ttl: status.kind === 'ok' && !note ? 7000 : 0,
      dismissible: status.kind !== 'busy',
    });
  }, [status]);

  const ok = !!data && !!civ && civ.habitat.suitability.length === data.world.mesh.n;
  const endYear = civ ? Math.floor(civ.endYear) : 0;
  const year = Math.max(0, Math.min(endYear, Math.floor(time.year ?? endYear)));
  const W = (data?.world.width ?? 2048) * scale;
  const H = (data?.world.height ?? 1024) * scale;
  const seed = data?.world.params.seed ?? 0;
  const x2 = scale === 2 ? '-2x' : '';

  const run = async (job: Job) => {
    if (!data || busy) return;
    setOpen(false);
    const { world, raster } = data;
    const seedN = world.params.seed;
    // 点下去那一刻的年份和开关(导出过程中拖时间轴不影响这一张)
    const t = getCivTime();
    const y = civ ? Math.max(0, Math.min(civ.endYear, t.year ?? civ.endYear)) : 0;
    const yi = Math.floor(y);
    const show = { ...getCivShow() };
    const params = paramsText(world.params);
    const what: Record<Job, string> = {
      map: `地图图片(${scale}×)`,
      mapjpg: `地图图片 JPEG(${scale}×)`,
      height16: `16 位高度图(${scale}×)`,
      height8: `8 位高度图(${scale}×)`,
      md: '编年史(Markdown)',
      txt: '编年史(纯文本)',
      legend: `图例(${scale}×)`,
      globe: '地球仪这一面',
    };
    setStatus({ kind: 'busy', text: `正在导出${what[job]}` });
    await nextFrame();
    const t0 = performance.now();
    try {
      let dbg: ExportDebug;
      if (job === 'globe') {
        const r = await exportGlobeView();
        if (!r) throw new Error('地球仪没有打开');
        download(r.blob, r.name);
        dbg = { job, name: r.name, bytes: r.blob.size, w: r.w, h: r.h, ms: performance.now() - t0 };
        const gmb = r.blob.size >= 1e6 ? `${(r.blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.blob.size / 1e3))} KB`;
        setStatus({ kind: 'ok', text: `已导出 ${r.name}`, more: `${r.w}×${r.h} · ${gmb} · 用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      } else if (job === 'map' || job === 'mapjpg') {
        const format: ImageFormat = job === 'map' ? 'png' : 'jpeg';
        const name = `${APP}-种子${seedN}-第${yi}年-${styleName(style, layer)}${x2}.${IMAGE_FORMATS[format].ext}`;
        // 球面世界:按当前视图的中心展开(左右边 = 中心 ± 180°);投影、经纬网和屏幕上一样
        const center = wrapOf(world) ? xOfLon(getMapCenter(), world.width) : undefined;
        const projection = flatProjection(getProjection());
        const graticule = getGraticule();
        const r = await exportMap({ world, raster, civ: ok ? civ : null, style, layer, year: y, show, center, projection, graticule }, scale, format);
        download(r.blob, name);
        dbg = { job, name, bytes: r.blob.size, w: r.w, h: r.h, ms: performance.now() - t0, detail: r.detail };
        const mb = r.blob.size >= 1e6 ? `${(r.blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.blob.size / 1e3))} KB`;
        setStatus({ kind: 'ok', text: `已导出 ${name}`, more: `${r.w}×${r.h} · ${mb} · 用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      } else if (job === 'height16' || job === 'height8') {
        const bits: HeightmapBits = job === 'height16' ? 16 : 8;
        const name = `${APP}-种子${seedN}-高度图-${bits}位${x2}.png`;
        const req: ExportRequest =
          scale === 1
            ? { job: 'heightmap', seed: seedN, scale, bits, raster: { w: raster.w, h: raster.h, elev: raster.elev, water: raster.water } }
            : { job: 'heightmap', seed: seedN, scale, bits, world };
        const res = await runWorker(req);
        if (!res.ok) throw new Error(res.error);
        if (res.job !== 'heightmap') throw new Error('后台线程回错了东西');
        const blob = new Blob([res.png], { type: 'image/png' });
        download(blob, name);
        const noteName = name.replace(/\.png$/, '-说明.txt');
        const noteText = heightmapNote(res.info, { seed: seedN, file: name, params });
        dbg = { job, name, bytes: blob.size, w: res.info.width, h: res.info.height, ms: performance.now() - t0, detail: res.ms, seaLevel: res.info.seaLevel };
        setStatus({
          kind: 'ok',
          text: `已导出 ${name}`,
          more:
            bits === 16
              ? `海平面 = 灰度 ${res.info.seaLevel}(0 = ${Math.round(res.info.lo)} 米,65535 = ${Math.round(res.info.hi)} 米)`
              : `海平面 = 灰度 ${AZGAAR_SEA_GRAY}(Azgaar 的高度 20)`,
          note: { name: noteName, text: noteText },
        });
      } else if (job === 'md' || job === 'txt') {
        if (!civ) throw new Error('文明还没推演完');
        const name = `${APP}-种子${seedN}-编年史.${job === 'md' ? 'md' : 'txt'}`;
        const text = chronicleDocument(civ, { format: job, seed: seedN, params });
        const blob = new Blob([text], { type: job === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
        download(blob, name);
        dbg = { job, name, bytes: blob.size, ms: performance.now() - t0 };
        setStatus({ kind: 'ok', text: `已导出 ${name}` });
      } else {
        if (!ok || !civ) throw new Error('文明还没推演完');
        const name = `${APP}-种子${seedN}-第${yi}年-图例${x2}.png`;
        const cv = await drawLegend({ civ, style, year: y, show, seed: seedN }, scale);
        const blob = await toBlob(cv);
        download(blob, name);
        dbg = { job, name, bytes: blob.size, w: cv.width, h: cv.height, ms: performance.now() - t0 };
        setStatus({ kind: 'ok', text: `已导出 ${name}` });
      }
      (window as unknown as { __wfExport?: ExportDebug }).__wfExport = dbg;
    } catch (e) {
      console.error('导出失败', e);
      setStatus({ kind: 'error', text: '导出失败', more: explain(e, scale) });
    }
  };

  const items: { job: Job; title: string; sub: string; need?: boolean }[] = [
    ...(globeOn ? [{ job: 'globe' as const, title: '导出地球仪这一面', sub: '现在看到的样子 · PNG' }] : []),
    { job: 'map', title: '地图图片(PNG)', sub: `整张地图 · ${styleName(style, layer)} · 第 ${year} 年 · ${W}×${H}`, need: true },
    { job: 'mapjpg', title: '地图图片(JPEG)', sub: `同上,文件小好几倍(质量 ${Math.round(IMAGE_FORMATS.jpeg.quality! * 100)}%)`, need: true },
    { job: 'legend', title: '图例(PNG)', sub: `第 ${year} 年的国家 / 民族 + 颜色、城镇符号、道路`, need: true },
    { job: 'height16', title: '高度图 · 16 位(PNG)', sub: `游戏引擎、World Machine 用 · ${W}×${H}` },
    { job: 'height8', title: '高度图 · 8 位(PNG)', sub: `Azgaar 导入用 · 海平面 = 灰度 ${AZGAAR_SEA_GRAY}(Azgaar 的 20)` },
    { job: 'md', title: '编年史(Markdown)', sub: '按时代分节,大事在前、全部附后', need: true },
    { job: 'txt', title: '编年史(纯文本)', sub: '同上,不带 Markdown 记号', need: true },
  ];

  return (
    <div className="export" ref={rootRef}>
      <button
        className={`export-btn${open ? ' on' : ''}`}
        disabled={!data}
        onClick={() => setOpen((o) => !o)}
        title="导出地图图片、高度图、编年史、图例"
      >
        {busy ? (
          <>
            <span className="spin" /> 正在导出…
          </>
        ) : (
          '导出'
        )}
      </button>
      {open && (
        <div className="export-menu" role="menu">
          <div className="export-scale">
            <span>清晰度</span>
            <div className="seg">
              {([1, 2] as const).map((s) => (
                <button key={s} className={scale === s ? 'on' : ''} onClick={() => setScale(s)} title={s === 2 ? '重新铺两倍像素,文字按两倍密度重画;适合打印、放大看' : undefined}>
                  {s}× · {(data?.world.width ?? 2048) * s}×{(data?.world.height ?? 1024) * s}
                </button>
              ))}
            </div>
          </div>
          {items.map((it) => (
            <button key={it.job} className="export-item" role="menuitem" data-job={it.job} disabled={busy || (it.need && !ok)} onClick={() => void run(it.job)}>
              <b>{it.title}</b>
              <span>{it.sub}</span>
            </button>
          ))}
          <div className="export-foot">种子 {seed}:同一种子 + 参数永远得到同一个世界</div>
        </div>
      )}
    </div>
  );
}

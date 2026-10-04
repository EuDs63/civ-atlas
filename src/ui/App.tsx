import './theme.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import { renderRealistic } from '../render/realistic';
import { renderFantasy } from '../render/fantasy';
import { TerrainDetail } from './TerrainDetail';
import { MapDecor } from './MapDecor';
import { nearX, wrapOf } from '../render/common';
import {
  centerX,
  clampCurved,
  clampSphere,
  getMapCenter,
  handleMapCenterRequests,
  lonOfX,
  mirrorCanvas,
  publishMapCenter,
  requestMapCenter,
  stageToWorld,
  useMapCenter,
  viewCentredAt,
  worldToStage,
  windowSpan,
  xOfLon,
  type StageBox,
} from './mapWrap';
import { projectWorld, projectWorldNear, unprojectRel, unprojectWorld, wrapLon, type MapProj } from '../render/projection';
import {
  GLOBE_READY,
  ProjLayer,
  curvedProj,
  getProjection,
  isCurved,
  isMapProjection,
  pageColor,
  presentTerrain,
  setGraticule,
  setMapMoving,
  setProjection,
  useGraticule,
  useMapMoving,
  useProjection,
  type MapProjection,
} from './projection';
import { LAYERS, renderLayer, type LayerId } from '../render/layers';
import { Legend } from './Legend';
import type { WorkerRequest, WorkerResponse } from '../worker';
import type { Civ } from '../gen/civ/types';
import { CivLayer } from './CivLayer';
import { CivTimeline } from './CivTimeline';
import { EventPins, type WorldToClient } from './EventPins';
import { HistoryBook } from './HistoryBook';
import { AiSettingsHost } from './AiSettings';
import { highlightBox, highlightMarks } from '../render/civ/highlight';
import {
  clearChroniclePick,
  clearSelection,
  getChronicle,
  getCivShow,
  getCivTime,
  getSelection,
  pausePlayback,
  playFrom,
  prepareCivReplay,
  resetCivTime,
  setChronicle,
  takeAutoplay,
  setCivShow,
  setSelection,
  startCivReplay,
  useChronicle,
  useCivHighlight,
  useChroniclePick,
  useCivShow,
  useSelection,
  type MapSelection,
} from './civView';
import {
  EMPTY_EDITS,
  GENERATOR_VERSION,
  applyNames,
  placeKeyOf,
  polityKey,
  resolveKey,
  sameInterventions,
  settlementKey,
  upgradeLegacyKeys,
  type Intervention,
  type TerrainOp,
  type WorldEdits,
} from '../gen/edits';
import { sameTerrain } from '../gen/terrainEdits';
import { clearEdits, getEdits, removeIntervention, setEdits, useEdits } from './editsStore';
import {
  NEWER_WARNING,
  STALE_WARNING,
  checkWarning,
  cleanTitle,
  decodeShare,
  editCount,
  isShareHash,
  parseSave,
  worldCheck,
  worldKey,
  type ParseResult,
  type SaveFile,
  type SaveView,
} from '../gen/savefile';
import {
  THUMB_H,
  THUMB_W,
  attachWorld,
  briefError,
  briefWarning,
  currentWorld,
  deleteWorld,
  detachWorld,
  importSave,
  isStored,
  isWorldId,
  legacyWorld,
  listWorlds,
  loadWorld,
  markCreated,
  markOpened,
  newWorldId,
  nextTitle,
  notify,
  persistent,
  refreshThumb,
  renameWorld,
  setThumbMaker,
  setWorldStats,
  startAutoSave,
  updateCheck,
  useSavesVersion,
  viewChanged,
  type StoredWorld,
  type WorldKind,
} from './saveStore';
import { getStage, setStage, useStage, type DraftBase, type Stage } from './stageStore';
import { polityAlive } from '../gen/civ/growth';
import { CIV_SHOW_OFF, drawCivOverlay } from '../render/civ/overlay';
import { getPolityPick, interventionText, setPickHover, setPolityPick, usePolityPick } from './Interventions';
import { Inspector } from './Inspector';
import { TargetLayer } from './TargetPlates';
import { FLY_MS, curvedFly, easeOutCubic, flatFly, selectionFocus, selectionKey, sideRoom, phoneFree, type FlyGoal } from './flyTo';
import { setWorldSheet, usePanel } from './panelStore';
import { closeOverview } from './overviewStore';
import { NewWorld } from './NewWorld';
import { MyWorlds } from './MyWorlds';
import { useCoarse, useNarrow } from './device';
import { isDoubleTap, pinchStep, type Pt, type Tap } from './gestures';
import { pickLabelAt } from './mapPick';
import { ownersAt } from '../gen/civ/timeline';
import { interventionOutcome } from '../gen/civ/chronicle';
import { syncRewriteWorld, takeRewriteNote, undoTurn, type RewriteNote } from './rewriteStore';
import { Globe, getGlobeOn, setGlobeOn, useGlobeOn, type GlobeApi } from './Globe';
import { setupAi } from '../ai/setup';
import { ToastBar, clearToast, showToast } from './Toast';
import { FirstHint, HoverCard, MapBar, MapControls, PhoneButtons, hintSeen, markHintSeen } from './Corners';
import { Sidebar } from './Sidebar';
import { PhoneSheet } from './PhoneSheet';
import { useLayerThumbs } from './LayerPopover';
import { WorldOverview } from './WorldOverview';
import { hoverInfo, probeLines, type HoverInfo } from './hoverInfo';
import { layerDark, layerDef, layerFromUrl, layerOf, type MapLayer, type Style } from './mapLayers';
import {
  TerrainOverlay,
  getTerrainTool,
  setTerrainTool,
  setTerrainWrap,
  terrainClick,
  terrainDown,
  terrainMove,
  terrainUp,
  useTerrainTool,
  type TerrainStatus,
} from './TerrainTools';

type Replay = { w: number; h: number; frames: Uint8ClampedArray[]; mya: number[]; idx: number };

function readUrl() {
  const q = new URLSearchParams(location.search);
  const params: WorldParams = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = q.get(k);
    if (v !== null && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  // 画风 / 数据图层:旧链接的 style=、layer= 照旧;没有 style= 时 layer= 是新的图层名(政区、民族……,见 mapLayers.ts)
  const qs = q.get('style');
  const ql = q.get('layer');
  const mapLayer = layerFromUrl(q);
  let style: Style = qs === 'realistic' || qs === 'data' ? qs : 'fantasy';
  let layer: LayerId = LAYERS.some((l) => l.id === ql) ? (ql as LayerId) : 'biomes';
  if (mapLayer) {
    const d = layerDef(mapLayer);
    style = d.style;
    if (d.data) layer = d.data;
  }
  // 分享链接:# 后面是整份存档(gen/savefile.ts 的 encodeShare)
  const share = isShareHash(location.hash) ? location.hash : null;
  // 投影、中央经线(改了就写进网址,刷新、复制网址都还在)
  // 地球仪以前写的是 view=globe,照样认
  const pq = q.get('proj') ?? (q.get('view') === 'globe' ? 'globe' : null);
  const proj: MapProjection = isMapProjection(pq) && (pq !== 'globe' || GLOBE_READY) ? pq : 'equirect';
  const lq = Number(q.get('lon'));
  const lon = q.get('lon') !== null && Number.isFinite(lq) ? wrapLon(lq) : null;
  const grat = q.get('grat') === '1';
  return { params, style, layer, mapLayer, share, proj, lon, grat };
}

/**
 * 换了图层:写进网址(layer= 新的图层名;去掉旧的 style=,civ= 里的国家 / 民族开关交给图层管),刷新、复制网址都还在
 */
function writeLayerUrl(id: MapLayer) {
  const q = new URLSearchParams(location.search);
  q.delete('style');
  const civ = q.get('civ');
  if (civ !== null) {
    const rest = civ.split(/[,+ ]/).filter((k) => k && !/^-?(polities|cultures)$/.test(k));
    if (rest.length) q.set('civ', rest.join(','));
    else q.delete('civ');
  }
  // 默认的"政区"可以省掉(没有 civ= 时才省:有 civ= 的旧链接按它认图层)
  if (id === 'political' && !q.has('civ')) q.delete('layer');
  else q.set('layer', id);
  const next = `?${q}`;
  if (next !== location.search) history.replaceState(null, '', next);
}

/** 一个要打开的世界:生成(或直接用正在看的这一个)→ 套上修改 → 交给 saveStore 自动存 */
interface Target {
  id: string;
  kind: WorldKind;
  params: WorldParams;
  edits: WorldEdits;
  /** 已经存下的修改(套上的和它是同一个对象就不重写) */
  saved?: WorldEdits;
  title?: string;
  /** 新建中、作者还没动过(不存) */
  pristine?: boolean;
  /** 以某个世界为底稿新建 */
  base?: DraftBase | null;
  /** 换成存档里的投影和中央经线(undefined = 不动;null = 等距圆柱、0°) */
  view?: SaveView | null;
  /** 从哪打开的(生成完的提示按它说) */
  from?: 'file' | 'link' | 'stored' | 'restore';
  /** 打开的存档(核对版本、地形) */
  save?: SaveFile;
  /** 读档时的警告 */
  warnings?: string[];
}

/** 随机一个种子(新建世界、"换一颗") */
function randomSeedValue(): number {
  return Math.floor(Math.random() * 999999) + 1;
}

/** 新建中的世界现在的样子(参数、修改、名字),比较动没动过用 */
function draftSig(params: WorldParams, edits: WorldEdits, title?: string): string {
  return JSON.stringify([worldKey(params), edits, title ?? '']);
}

/** 一个新建中的世界(还没动过) */
function draftTarget(params: WorldParams, base: DraftBase | null = null, edits: WorldEdits = EMPTY_EDITS, title?: string): Target {
  return { id: newWorldId(), kind: 'draft', params, edits, pristine: true, base, title };
}

/** 存着的一个世界(刷新页面回到它时投影照网址,不换) */
function storedTarget(w: StoredWorld, from: 'stored' | 'restore'): Target {
  return {
    id: w.id,
    kind: w.draft ? 'draft' : 'created',
    params: w.save.params,
    edits: w.save.edits,
    saved: w.save.edits,
    title: w.save.title,
    base: w.base ?? null,
    pristine: false,
    view: from === 'restore' ? undefined : (w.save.view ?? null),
    from,
    save: w.save,
  };
}

/** 网址里带种子的(别人发的网址、截图脚本):直接看这个世界,先不存,改了才存 */
function visitTarget(params: WorldParams): Target {
  return { id: newWorldId(), kind: 'visit', params, edits: EMPTY_EDITS };
}

/**
 * 打开网页时去哪(只算一次):
 *   分享链接(#)       → 那个世界(先按网址生成,解开以后套上修改)
 *   w=世界编号(存着)   → 这个世界(没建完的回到新建)
 *   new=1             → 新建(网址里的种子、参数)
 *   带种子的网址       → 直接看这个世界(改版前存过的就回到那个存档)
 *   都没有             → 有存档就到"我的世界";第一次来直接新建(随机一颗星球)
 */
function firstRoute(init: ReturnType<typeof readUrl>): { stage: Stage; target: Target | null } {
  const q = new URLSearchParams(location.search);
  if (init.share) return { stage: 'world', target: visitTarget(init.params) };
  const w = q.get('w');
  const stored = isWorldId(w) ? loadWorld(w) : null;
  if (stored) return { stage: stored.draft ? 'draft' : 'world', target: storedTarget(stored, 'restore') };
  if (q.get('new') === '1') return { stage: 'draft', target: draftTarget(init.params) };
  if (q.has('seed')) {
    // 改版前自动存的世界:那时的网址只带种子、参数,刷新照旧回到它
    const old = legacyWorld(init.params);
    if (old) return { stage: old.draft ? 'draft' : 'world', target: storedTarget(old, 'restore') };
    return { stage: 'world', target: visitTarget(init.params) };
  }
  if (listWorlds().length) return { stage: 'home', target: null };
  return { stage: 'draft', target: draftTarget({ ...init.params, seed: randomSeedValue() }) };
}

/** 新建时列不出来的图层(要有历史):进新建时换成"地形",建好以后换回来 */
const HISTORY_LAYERS: MapLayer[] = ['political', 'cultures'];

/** 把世界写进网址:种子 + 参数(和默认值相同的省略,别人打开是同一颗星球);存着的加 w=编号,新建中还没存的加 new=1 */
function writeWorldUrl(t: Target) {
  const q = new URLSearchParams(location.search);
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    if (k === 'seed' || t.params[k] !== DEFAULT_PARAMS[k]) q.set(k, String(t.params[k]));
    else q.delete(k);
  }
  q.delete('w');
  q.delete('new');
  // 存着的记录还是换参数之前的(新建中换了种子、参数,正在生成):先不指向它,存好了再换成 w=
  const w = isStored(t.id) ? loadWorld(t.id) : null;
  if (w && worldKey(w.save.params) === worldKey(t.params)) q.set('w', t.id);
  else if (t.kind === 'draft') q.set('new', '1');
  const next = `?${q}`;
  if (next !== location.search) history.replaceState(null, '', next);
}

/** 回到"我的世界":网址里去掉这个世界(种子、参数、编号、年份……),留着图层、投影这些看法 */
function writeHomeUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of [...Object.keys(DEFAULT_PARAMS), 'w', 'new', 'civYear', 'play', 'chron']) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, '', rest ? `?${rest}` : location.pathname);
}

/** 创建完要不要从第 0 年起放一遍历史(网址给了 play=0、无头浏览器里不放;play=1 一定放) */
function storyOk(): boolean {
  const play = new URLSearchParams(location.search).get('play');
  if (play === '0') return false;
  if (play === '1') return true;
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

/** 结束那一年现存几国(我的世界的卡片上写;没长出文明 = 0) */
function aliveAtEnd(civ: Civ): number {
  return civ.viable ? civ.polities.filter((x) => polityAlive(x, civ.endYear)).length : 0;
}

export function App() {
  const init = useMemo(readUrl, []);
  /** 打开网页时去哪:我的世界 / 新建 / 某个世界(见 firstRoute) */
  const route = useMemo(() => firstRoute(init), [init]);
  /** 进新建时换掉的图层(政区、民族要有历史);建好 / 打开别的世界时换回来 */
  const draftLayerRef = useRef<MapLayer | null>(null);
  // 网址里的投影、中央经线、经纬网:第一次渲染之前放进 store(等距圆柱的视图在世界出来以后再转过去,见 pendingLon)
  const start = useState(() => {
    setProjection(init.proj);
    if (init.lon !== null) publishMapCenter(init.lon);
    setGraticule(init.grat);
    setStage(route.stage, route.target?.base ?? null);
    // 网址里给的(或默认的)图层:国家 / 民族开不开跟着它;新建时只看地形
    let ml = init.mapLayer;
    let { style, layer } = init;
    if (route.stage === 'draft') {
      const now = ml ?? layerOf(style, layer, getCivShow());
      if (HISTORY_LAYERS.includes(now)) {
        draftLayerRef.current = now;
        ml = 'terrain';
        style = 'fantasy';
        writeLayerUrl(ml);
      }
    }
    if (ml) {
      const d = layerDef(ml);
      setCivShow({ polities: d.polities, cultures: d.cultures });
    }
    return { style, layer };
  })[0];
  const graticule = useGraticule();
  const projection = useProjection();
  const curved = isCurved(projection);
  const mapCenter = useMapCenter();
  const projMoving = useMapMoving() && curved;
  const [params, setParams] = useState<WorldParams>(route.target?.params ?? init.params);
  const [style, setStyle] = useState<Style>(start.style);
  const [layer, setLayer] = useState<LayerId>(start.layer);
  const { stage, base: stageBase } = useStage();
  const draft = stage === 'draft';
  const home = stage === 'home';
  /** 正在打开 / 已经打开的世界(生成完按它套上修改、交给自动存) */
  const targetRef = useRef<Target | null>(route.target);
  /** 新建中的名字(卡片上的输入框;打开没建完的世界时是它存的名字) */
  const [draftTitle, setDraftTitle] = useState(route.target?.kind === 'draft' ? (route.target.title ?? '') : '');
  const [data, setData] = useState<{ world: World; raster: Raster } | null>(null);
  // 生成出来的文明("原始 civ")+ 用户的改名(editsStore)= 界面用的 civ。改名只重算这一步,不发给后台线程
  const [rawCiv, setRawCiv] = useState<Civ | null>(null);
  const edits = useEdits();
  const civ = useMemo(() => (rawCiv ? applyNames(rawCiv, edits.names) : null), [rawCiv, edits.names]);
  /** 右侧详情面板开着(右下角的地球仪 / 缩放按钮让开它) */
  const selState = useSelection();
  // 右侧面板开着(选目标、下了令正在推演时面板藏起来,右下按钮回到原位)
  const panelUi = usePanel();
  const pickNow = usePolityPick();
  const panelOpen = !!selState.sel && !!civ && !pickNow && !panelUi.run;
  /** 窄屏(手机):底部的世界 / 详情卡片、时间轴胶囊、右上竖排按钮(phone.css);触屏:没有悬停卡片、右下不放 + −(用双指捏合) */
  const narrow = useNarrow();
  const coarse = useCoarse();
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  /** 生成进度(提示条"正在生成世界"):regen = 按新地形重新生成;seed = 正在生成的种子 */
  const [progress, setProgress] = useState<{ stage: string; pct: number; regen?: boolean; seed?: number } | null>(null);
  /** 悬停小卡片:内容 + 鼠标位置(视口坐标) */
  const [hover, setHoverState] = useState<{ info: HoverInfo; x: number; y: number } | null>(null);
  // 选目标时鼠标下的可选对象:名牌反色(TargetPlates)
  const setHover = (h: { info: HoverInfo; x: number; y: number } | null) => {
    setPickHover(h?.info.pick ?? -1);
    setHoverState(h);
  };
  // ---- 图层(政区 / 民族 / 地形 / 生态 / 高程 / 实景 / 板块 / 气温 / 降水)= 画风 + 数据图层 + 国家 / 民族开关 ----
  const civShow = useCivShow();
  const mapLayer = layerOf(style, layer, civShow);
  const mapLayerRef = useRef(mapLayer);
  mapLayerRef.current = mapLayer;
  const theme = layerDark(mapLayer) ? 'dark' : 'light';
  // 挂在 body 下的弹窗(AI 设置、史书)也跟着换主题;画第一帧之前就换好(首次打开深色图层时不先闪一下浅色底)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const applyLayer = useCallback((id: MapLayer) => {
    const d = layerDef(id);
    setStyle(d.style);
    if (d.data) setLayer(d.data);
    setCivShow({ polities: d.polities, cultures: d.cultures });
    writeLayerUrl(id);
  }, []);
  /** 第一次打开的操作提示(第一次拖动 / 缩放 / 点击之后不再出现) */
  const [hintOn, setHintOn] = useState(() => !hintSeen());
  /** 新建时地图底部的一句"拖动地图看看这颗星球"(第一次拖动 / 缩放 / 换一颗之后收起) */
  const [draftTip, setDraftTip] = useState(true);
  const touchRef = useRef(() => {});
  touchRef.current = () => {
    if (getStage().stage === 'draft') return setDraftTip(false);
    if (!hintOn) return;
    setHintOn(false);
    markHintSeen();
  };
  /** 鼠标最近在哪(视口坐标;地球仪的悬停只给像素,卡片位置用它) */
  const mouseAt = useRef<[number, number]>([0, 0]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  /** 最上面的屏幕层(文字层放在这里,见 CivLayer 的 labelsHost) */
  const [labelsHost, setLabelsHost] = useState<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** 地形图、回放帧在右边接的那一份(左右无限拖动,见 mapWrap.ts) */
  const canvasCopyRef = useRef<HTMLCanvasElement>(null);
  const overlayCopyRef = useRef<HTMLCanvasElement>(null);

  const workerRef = useRef<Worker | null>(null);
  /** 发给当前线程、还没回音的活(生成世界 / 回放帧 / 重推文明)有几件 */
  const busyRef = useRef(0);
  const reqId = useRef(0);
  // ---- 阶段 4 干预:带着干预在后台重推文明 ----
  /** 最近一次请求的文明是带着哪些干预推的(生成新世界时 = 没有) */
  const civEdits = useRef<readonly Intervention[]>(EMPTY_EDITS.interventions);
  /** 第几次重推(只认最新的一次);这次重推从哪一年起变、什么时候发出去的 */
  const resimSeq = useRef(0);
  /** 读档 / 自动恢复套上的干预列表(按它重推完不提示"已生效"、不打断自动播放) */
  const restoredIv = useRef<readonly Intervention[] | null>(null);
  const resimInfo = useRef<{
    seq: number;
    year: number;
    t0: number;
    workerMs?: number;
    arrived?: number;
    /** 这次重推是新加了一条干预 / 撤销了一条(推完在顶部提示"已从第 N 年重新推演""已撤销") */
    added?: Intervention;
    removed?: Intervention;
    left?: number;
    /** 读档 / 自动恢复套上的干预:推完不提示、不打断自动播放 */
    quiet?: boolean;
    /** 这次重推是一次 AI 改写 / 撤销改写(推完说"已按你说的改写",带撤销) */
    note?: RewriteNote;
  } | null>(null);
  const [resim, setResim] = useState<{ year: number } | null>(null);
  /** 正在按新的干预重推历史(缩略图等推完再截) */
  const resimRef = useRef(false);
  resimRef.current = !!resim;
  const rawRef = useRef<Civ | null>(null);
  rawRef.current = rawCiv;
  /** 当前这个世界(编号 reqId.current)的参数;回放时带给线程,线程重开过也能按参数重算 */
  const genParams = useRef<WorldParams | null>(null);
  // ---- 阶段 4 改地形:世界 = 参数 + 地形修改 ----
  /** 最近一次请求的世界带着哪些地形修改(回放、重推时带给线程) */
  const genTerrain = useRef<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  /** 换了新世界、还没套上它的修改(自动恢复 / 读档)之前:这时的修改不属于这个世界,不按它重新生成 */
  const fresh = useRef(false);
  /** 正在进行的"按新地形重新生成"(编号 = 那次生成的请求编号);t0 = 发出去的时刻 */
  const regenRef = useRef<{ id: number; t0: number; terrain: readonly TerrainOp[]; workerMs?: number; arrived?: number } | null>(null);
  /** 正在进行的"按新地形重新生成"是一次 AI 改写 / 撤销改写(生成完说"已按你说的改写",带撤销) */
  const regenNote = useRef<RewriteNote | null>(null);
  /** 地图上现在这个世界带着的地形修改(覆盖层据此标出还在生成的那几处) */
  const [shownTerrain, setShownTerrain] = useState<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>({ busy: false });
  const terrainTool = useTerrainTool();
  // 手机:改地形、回放世界形成都要看地图 —— 拉到顶的世界卡片先收起来(两样都是从卡片里的"地形"那一组点开的)
  useEffect(() => {
    if (terrainTool.on || replayOn) setWorldSheet('peek');
  }, [terrainTool.on, replayOn]);
  // 点了一条大事(卡片里的"最近大事"、编年史):时间轴跳过去、地图上标出来 —— 世界卡片也先收起
  const chronPick = useChroniclePick();
  useEffect(() => {
    if (chronPick.entry) setWorldSheet('peek');
  }, [chronPick]);
  // 3D 地球仪(网址 proj=globe,旧链接的 view=globe 也认 / 地图右下角的按钮):主图藏起来,同一套时间轴、详情面板、选中逻辑
  const globeOn = useGlobeOn();
  const globeApi = useRef<GlobeApi | null>(null);
  /** 世界坐标 → 屏幕坐标(地图上的事件标签、截图脚本用;下面 __wfWorldToClient 那里定义) */
  const worldToClient = useRef<WorldToClient | null>(null);
  /** 地球仪上的世界坐标 → 屏幕坐标(转到背面 = null),地球仪打开时给事件标签用 */
  const globeToClient = useRef<WorldToClient>((wx, wy) => globeApi.current?.worldToClient(wx, wy) ?? null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** 最近生成完的世界(打开的世界就是正在看的这一个时,不用重新生成) */
  const lastReady = useRef<{ world: World; civ: Civ } | null>(null);
  /** 打不开的分享链接(世界还在生成时解开的):生成完再提示 */
  const shareErr = useRef<string | null>(null);
  /** 世界生成完的处理(存档:自动恢复 / 读档套修改);线程回调里经 ref 调,拿到的总是最新的 */
  const readyRef = useRef<(world: World, civ: Civ) => void>(() => {});
  const dataRef = useRef(data);
  dataRef.current = data;
  /** 弯边投影:当前投影 + 中心放进地图平面(等距圆柱 = null,照原来的办法画) */
  const mp = useMemo(() => (data ? curvedProj(projection, mapCenter, data.world.width, data.world.height) : null), [data, projection, mapCenter]);
  const mpRef = useRef<MapProj | null>(mp);
  mpRef.current = mp;

  // ---- 后台线程 ----
  // 线程一次只能算一个世界。连续改参数时,与其排队把每个中间世界都算完,
  // 不如直接终止还在忙的旧线程、另开一个(启动只要几十毫秒),只算最后一次。
  // 回放帧、重推文明这些短活不打断线程,排在后面(打断了,线程手上的世界就没了,得按参数重新生成,反而更慢)。
  const idleWorker = useCallback((abort: boolean) => {
    if (abort && workerRef.current && busyRef.current > 0) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (!workerRef.current) {
      const w = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (workerRef.current !== w) return; // 已被换掉的线程
        if (m.type !== 'progress') busyRef.current = Math.max(0, busyRef.current - 1);
        if (m.id !== reqId.current) return; // 过时的请求(上一个世界的)
        if (m.type === 'progress') setProgress((s) => ({ stage: m.stage, pct: m.pct, regen: regenRef.current?.id === m.id, seed: s?.seed }));
        else if (m.type === 'done') {
          setData({ world: m.world, raster: m.raster });
          setRawCiv(m.civ);
          setProgress(null);
          const rg = regenRef.current;
          if (rg && rg.id === m.id) terrainDoneRef.current(m.world, m.civ, m.ms);
          else {
            fresh.current = false;
            readyRef.current(m.world, m.civ);
          }
        } else if (m.type === 'history') {
          setReplay({ w: m.w, h: m.h, frames: m.frames, mya: m.mya, idx: 0 });
        } else if (m.type === 'civ') {
          if (m.seq !== resimSeq.current) return; // 又下了新的干预,等最新的那一次
          applyResimRef.current(m.civ, m.ms);
        }
      };
      workerRef.current = w;
      busyRef.current = 0;
    }
    return workerRef.current;
  }, []);
  const send = useCallback(
    (req: WorkerRequest) => {
      const w = idleWorker(req.type === 'generate');
      busyRef.current++;
      w.postMessage(req);
    },
    [idleWorker],
  );

  /**
   * 重推好的文明换上去(阶段 4 干预):州、宜居度沿用原来那一份(地理没变;时间轴、地图按它认"还是同一个世界"),
   * 选中的东西、编年史的国家筛选按稳定键换成新历史里的编号(指不到就取消),时间轴停在干预那一年
   */
  const applyResim = (next: Civ, workerMs: number) => {
    const old = rawRef.current;
    const civ: Civ = old && old.regions.count === next.regions.count ? { ...next, regions: old.regions, habitat: old.habitat } : next;
    if (old) {
      const { sel } = getSelection();
      if (sel) {
        const key =
          sel.kind === 'polity' && old.polities[sel.id]
            ? polityKey(old, sel.id)
            : sel.kind === 'settlement' && old.settlements[sel.id]
              ? settlementKey(old, sel.id)
              : sel.kind === 'place' && old.places[sel.id]
                ? placeKeyOf(old, sel.id)
                : null;
        if (key) {
          const r = resolveKey(civ, key);
          if (r && r.kind === sel.kind) setSelection({ kind: sel.kind, id: r.id } as MapSelection);
          else clearSelection();
        }
      }
      const cp = getChronicle().polity;
      if (cp !== null) {
        const r = old.polities[cp] ? resolveKey(civ, polityKey(old, cp)) : null;
        setChronicle({ polity: r && r.kind === 'polity' ? r.id : null });
      }
    }
    clearChroniclePick();
    setPolityPick(null);
    const info = resimInfo.current;
    if (info) {
      info.workerMs = workerMs;
      info.arrived = performance.now() - info.t0;
      if (!info.quiet) playFrom(Math.min(civ.endYear, Math.max(0, info.year)));
      // 已生效(停 7 秒,带撤销)/ 已撤销(停 4 秒)
      const y = Math.max(0, Math.floor(info.year));
      if (info.note) {
        const n = info.note;
        if (n.kind === 'apply') {
          // 这一批新加的命令里有几条没生效(两国不接壤、州里没人住……;原因在概览"我的干预"页)
          const ks = (l: readonly Intervention[]) => l.map((v) => JSON.stringify(v));
          const had = ks(n.before.interventions);
          const done = ks(civ.interventions ?? []);
          const failed = ks(n.after.interventions)
            .filter((k) => !had.includes(k))
            .map((k) => done.indexOf(k))
            .filter((i) => i >= 0 && !interventionOutcome(civ, i).ok).length;
          showToast({
            id: 'resim-done',
            kind: failed ? 'warn' : 'ok',
            text: `已按你说的改写 · 从 ${y} 年重新推演`,
            more: failed ? [`${failed} 条命令没生效,原因见概览的"我的干预"`] : undefined,
            action: {
              label: '撤销',
              act: 'rw-undo',
              onClick: () => {
                undoTurn(n.turn);
                clearToast('resim-done');
              },
            },
            ttl: 7000,
          });
        } else {
          showToast({ id: 'resim-done', kind: 'ok', text: info.left ? `已撤销改写,从 ${y} 年起重新推演` : `已撤销改写,${y} 年之后恢复原历史`, ttl: 4000 });
        }
      } else if (info.added) {
        const v = info.added;
        const named = applyNames(civ, getEdits().names);
        const idx = (civ.interventions ?? []).findIndex((x) => JSON.stringify(x) === JSON.stringify(v));
        showToast({
          id: 'resim-done',
          kind: 'ok',
          text: `已从 ${y} 年重新推演 · ${interventionText(named, v, idx)}`,
          action: {
            label: '撤销',
            onClick: () => {
              const i = getEdits().interventions.findIndex((x) => JSON.stringify(x) === JSON.stringify(v));
              if (i >= 0) removeIntervention(i);
              clearToast('resim-done');
            },
          },
          ttl: 7000,
        });
      } else if (info.removed) {
        showToast({ id: 'resim-done', kind: 'ok', text: info.left ? `已撤销,从 ${y} 年起重新推演` : `已撤销,${y} 年之后恢复原历史`, ttl: 4000 });
      }
    }
    setRawCiv(civ);
    setResim(null);
  };
  const applyResimRef = useRef(applyResim);
  applyResimRef.current = applyResim;

  // ---- 生成 ----
  /** 按 t 的参数、地形修改生成世界;生成完(readyRef)套上 t 的修改 */
  const generate = useCallback(
    (t: Target) => {
      targetRef.current = t;
      const p = t.params;
      const id = ++reqId.current;
      genParams.current = p;
      setParams(p);
      setProgress({ stage: '准备', pct: 0, seed: p.seed });
      // 手机:新世界、打开存档都要看地图 —— 拉到顶的世界卡片先收起来
      setWorldSheet('peek');
      // 改过地形的世界直接带着地形修改生成,不用先生成原样再重新生成一遍
      const terrain = t.edits.terrain;
      genTerrain.current = terrain;
      fresh.current = true;
      regenRef.current = null;
      setTerrainStatus({ busy: false });
      setShownTerrain(terrain);
      setTerrainTool({ on: false });
      send({ type: 'generate', id, params: p, scale: 1, terrain: [...terrain] });
      // 换世界:改名、干预、选中都属于旧世界,一起作废(先停掉旧世界的自动存,清空不算"改回默认";新世界先按"没有干预"生成)
      detachWorld();
      civEdits.current = EMPTY_EDITS.interventions;
      resimSeq.current++;
      resimInfo.current = null;
      setResim(null);
      setPolityPick(null);
      clearEdits();
      clearSelection();
      // 正在进行 / 已算好的回放都属于旧世界,一起作废
      setReplay(null);
      setReplayOn(false);
      // 种子、参数写进网址(分享链接时对方看到的是同一个世界);存着的世界带上编号
      writeWorldUrl(t);
    },
    [send],
  );

  useEffect(() => {
    // 分享链接:先把 # 那段从地址栏去掉(刷新不会重复导入),解开以后走读档流程;
    // 链接里的种子、参数和网址上的一样,所以照常先按网址生成,不用等
    if (init.share) {
      history.replaceState(null, '', location.pathname + location.search);
      decodeShare(init.share).then((r) => openShareRef.current(r));
    }
    if (route.target) generate(route.target);
    else writeHomeUrl();
    // 页面开着时又粘贴了一个只有 # 不同的分享链接(浏览器不刷新页面)
    const onHash = () => {
      const h = location.hash;
      if (!isShareHash(h)) return;
      history.replaceState(null, '', location.pathname + location.search);
      decodeShare(h).then((r) => openShareRef.current(r));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
    // 只在首次挂载时自动生成;之后由操作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 改地形(阶段 4):地形修改一变,就在后台带着新地形重新生成世界(连同当时的干预重推文明;
  // 州、历史整个重来,改名和干预按稳定键尽量套上)。写在干预的前面:同时变了的话,干预跟着这次生成一起推 ----
  useEffect(() => {
    const t = edits.terrain;
    if (!data || !genParams.current || fresh.current || sameTerrain(t, genTerrain.current)) return;
    const id = ++reqId.current;
    const interventions = getEdits().interventions;
    genTerrain.current = t;
    civEdits.current = interventions;
    resimSeq.current++;
    resimInfo.current = null;
    setResim(null);
    regenRef.current = { id, t0: performance.now(), terrain: t };
    regenNote.current = takeRewriteNote(getEdits());
    setTerrainStatus((s) => ({ ...s, busy: true }));
    setProgress({ stage: '准备', pct: 0, regen: true });
    // 回放、选中、编年史的国家筛选都属于旧地形上的历史
    setReplay(null);
    setReplayOn(false);
    clearSelection();
    setPolityPick(null);
    clearChroniclePick();
    if (getChronicle().polity !== null) setChronicle({ polity: null });
    send({ type: 'generate', id, params: genParams.current, scale: 1, terrain: [...t], interventions: [...interventions] });
  }, [edits.terrain, data, send]);

  // ---- 干预(阶段 4):干预列表一变,就在后台带着新的干预从第 0 年重推文明(地形不动) ----
  useEffect(() => {
    const list = edits.interventions;
    if (!data || !genParams.current || sameInterventions(list, civEdits.current)) return;
    if (!sameTerrain(getEdits().terrain, genTerrain.current)) return; // 等改地形那次生成一起推
    // 从哪一年起变:新加的 / 删掉的干预里最早的那一年(重推完时间轴停在这里)
    const before = civEdits.current;
    const ks = (l: readonly Intervention[]) => l.map((v) => JSON.stringify(v));
    const [a, b] = [ks(list), ks(before)];
    const changed = [...list.filter((_, i) => !b.includes(a[i])), ...before.filter((_, i) => !a.includes(b[i]))];
    const years = (changed.length ? changed : list).map((v) => Math.floor(v.from)).filter((y) => Number.isFinite(y));
    const year = years.length ? Math.max(0, Math.min(...years)) : 0;
    civEdits.current = list;
    const seq = ++resimSeq.current;
    // 只多了一条 = 新下的干预;只少了一条 = 撤销(读档、自动恢复套上的不算,不提示)
    const quiet = list === restoredIv.current;
    const added = !quiet && list.length === before.length + 1 && changed.length === 1 ? changed[0] : undefined;
    const removed = !quiet && list.length === before.length - 1 && changed.length === 1 ? changed[0] : undefined;
    const note = takeRewriteNote(getEdits()) ?? undefined;
    resimInfo.current = { seq, year, t0: performance.now(), added, removed, left: list.length, quiet, note };
    setResim({ year });
    send({ type: 'resim', id: reqId.current, seq, params: genParams.current, terrain: [...genTerrain.current], interventions: list });
  }, [edits.interventions, data, send]);
  // 重推的文明画到地图上以后,记下"从下命令到地图更新"用了多久(冒烟检查用)
  useEffect(() => {
    const info = resimInfo.current;
    if (!info || info.arrived === undefined || !rawCiv) return;
    const drawn = performance.now() - info.t0;
    requestAnimationFrame(() => {
      (window as unknown as { __wfResim: unknown }).__wfResim = {
        seq: info.seq,
        year: info.year,
        workerMs: info.workerMs,
        arrivedMs: info.arrived,
        drawnMs: drawn,
        paintedMs: performance.now() - info.t0,
      };
    });
    resimInfo.current = null;
  }, [rawCiv]);

  /**
   * 按新地形重新生成完(阶段 4 改地形):记下新的地形校验(自动存的存档跟着改);
   * 数一数改名、干预有几处在新历史里对不上(面板里提示"暂未生效")
   */
  const terrainDoneRef = useRef<(world: World, civ: Civ, ms: number) => void>(() => {});
  terrainDoneRef.current = (world: World, rc: Civ, ms: number) => {
    const rg = regenRef.current;
    if (!rg) return;
    rg.workerMs = ms;
    rg.arrived = performance.now() - rg.t0;
    lastReady.current = { world, civ: rc };
    setShownTerrain(rg.terrain);
    const e = getEdits();
    if (sameTerrain(e.terrain, rg.terrain)) updateCheck(worldCheck(world));
    const lostNames = Object.keys(e.names).filter((k) => !resolveKey(rc, k)).length;
    // 干预:和世界概览"我的干预"页一个口径(这份历史带着哪些干预推的、哪几条没生效,见 chronicle.ts 的 interventionOutcome)
    const lostInterventions = (rc.interventions ?? []).filter((_, i) => !interventionOutcome(rc, i).ok).length;
    setTerrainStatus({ busy: false, last: { ms: rg.arrived, lostNames, lostInterventions } });
  };
  // 重新生成的世界画到地图上以后,记下"从改地形到地图更新"用了多久(冒烟检查用)
  useEffect(() => {
    const rg = regenRef.current;
    if (!rg || rg.arrived === undefined || !data) return;
    const drawn = performance.now() - rg.t0;
    requestAnimationFrame(() => {
      (window as unknown as { __wfTerrain: unknown }).__wfTerrain = {
        id: rg.id,
        ops: rg.terrain.length,
        workerMs: rg.workerMs,
        arrivedMs: rg.arrived,
        drawnMs: drawn,
        paintedMs: performance.now() - rg.t0,
      };
    });
    regenRef.current = null;
  }, [data]);

  // ---- 存档(阶段 4):自动存、自动恢复、读档 ----
  useEffect(() => startAutoSave(), []);
  // AI(阶段 5):登记服务商、恢复设置、调用记录存本地
  useEffect(() => setupAi(), []);
  // 缩略图("我的世界"的卡片、存档菜单):手绘风的地形 480×240;建好的世界叠上结束那一年的国家色块(和正在看哪个图层、哪一年无关)。
  // 世界还在生成、按新地形重新生成、按新的干预重推历史时 = null,saveStore 过一会儿再来要
  useEffect(() => {
    setThumbMaker((id) => {
      const d = dataRef.current;
      const t = targetRef.current;
      if (!d || fresh.current || regenRef.current || resimRef.current || !t || t.id !== id) return null;
      const base = baseCanvas('fantasy');
      if (!base) return null;
      const cv = document.createElement('canvas');
      cv.width = THUMB_W;
      cv.height = THUMB_H;
      const x = cv.getContext('2d');
      if (!x) return null;
      x.imageSmoothingQuality = 'high';
      x.drawImage(base, 0, 0, cv.width, cv.height);
      const rc = rawRef.current;
      const kind = currentWorld()?.kind;
      if (kind !== 'draft' && rc && rc.viable && rc.habitat.suitability.length === d.world.mesh.n) {
        const ov = document.createElement('canvas');
        ov.width = d.raster.w;
        ov.height = d.raster.h;
        const octx = ov.getContext('2d');
        if (octx) {
          drawCivOverlay(octx, { world: d.world, raster: d.raster, civ: rc, style: 'fantasy', year: rc.endYear, show: { ...CIV_SHOW_OFF, polities: true } });
          x.drawImage(ov, 0, 0, cv.width, cv.height);
        }
        ov.width = ov.height = 0;
      }
      const url = cv.toDataURL('image/jpeg', 0.8);
      cv.width = cv.height = 0;
      return url;
    });
    return () => setThumbMaker(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 推演完(重推历史以后也是):结束那一年现存几国记下来,我的世界的卡片上写
  useEffect(() => {
    const cur = currentWorld();
    if (!rawCiv || !cur || cur.kind === 'draft' || cur.id !== targetRef.current?.id || fresh.current) return;
    setWorldStats(aliveAtEnd(rawCiv));
  }, [rawCiv]);
  /**
   * 世界生成完(或要打开的就是正在看的这一个):套上 targetRef 的修改,交给 saveStore 自动存;
   * 核对版本和地形,有问题就提示
   */
  readyRef.current = (world: World, rc: Civ) => {
    lastReady.current = { world, civ: rc };
    const t = targetRef.current;
    if (!t || currentWorld()?.id === t.id) return;
    // 打不开的分享链接(世界还在生成时解开的):现在提示(单独一条,"已恢复"之类的排在它下面,关掉它再露出来)
    const err = shareErr.current;
    shareErr.current = null;
    if (err) showToast({ id: 'share', kind: 'error', text: '打不开这个分享链接', more: [err] });
    const say = (n: Parameters<typeof notify>[0]) => n && notify({ ...n, more: n.more?.map(briefWarning) });
    const check = worldCheck(world);
    // 投影和中央经线跟着世界存:换成存档里的(旧存档没有 = 等距圆柱、0°)
    if (t.view !== undefined) applyView(t.view ?? undefined);
    // 旧格式的键(r + 州号:GENERATOR_VERSION 2 以前的存档、链接)就地换成按地块的 c 格式,按这一刻的世界解析;
    // 换过的话自动存会写回去(套上的修改和存下的不是同一个对象就会重写)
    const sameT = sameTerrain(t.edits.terrain, genTerrain.current);
    const edits = sameT ? upgradeLegacyKeys(t.edits, rc.regions.seat) : t.edits;
    restoredIv.current = edits.interventions;
    setEdits(edits);
    attachWorld({ id: t.id, params: world.params, check, kind: t.kind, title: t.title, saved: t.saved ?? edits, view: t.view ?? undefined, pristine: t.pristine, base: t.base });
    if (t.kind !== 'draft') setWorldStats(aliveAtEnd(rc));
    const save = t.save;
    if (!save || !t.from) return;
    const more: string[] = [...(t.warnings ?? [])];
    if ((t.from === 'stored' || t.from === 'restore') && save.generator !== GENERATOR_VERSION) more.push(save.generator < GENERATOR_VERSION ? STALE_WARNING : NEWER_WARNING);
    // 地形校验只在"生成时带的地形修改就是存档里的"时才核对
    const cw = sameT ? checkWarning(save, check) : null;
    if (cw) more.push(cw);
    const lost = Object.keys(edits.names).filter((k) => !resolveKey(rc, k)).length;
    if (lost) more.push(`${lost} 处改名没对上,先保留`);
    const n = editCount(save.edits);
    const name = save.title || `种子 ${world.params.seed}`;
    // 没建完的世界接着建:不用提示
    if (t.kind === 'draft') return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    let text: string;
    if (t.from === 'file') text = `已打开存档「${name}」${n ? `(改了 ${n} 处)` : ''}`;
    else if (t.from === 'link') text = `已打开分享的世界「${name}」`;
    // 从我的世界点开的:看到的就是它,没有要说的就不提示
    else if (t.from === 'stored') return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    else if (n) text = `已恢复上次的修改(${n} 处)`;
    else return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    say({ kind: more.length ? 'warn' : 'ok', text, more });
  };
  /** 换成存档里的投影和中央经线(没有 = 等距圆柱、0°;认不出的投影、还没做好的地球仪 = 等距圆柱) */
  const applyView = (v: SaveView | undefined) => {
    const want = v?.projection;
    const p: MapProjection = isMapProjection(want) && (want !== 'globe' || GLOBE_READY) ? want : 'equirect';
    const lon = v && Number.isFinite(v.center) ? wrapLon(v.center) : 0;
    // 先放中心(换投影时按它摆视图),再换投影;等距圆柱再把视图转过去
    publishMapCenter(lon);
    setProjection(p);
    if (!isCurved(p)) requestMapCenter(lon);
  };
  // 投影 / 中心 / 经纬网停下来约半秒:写进网址(刷新、复制网址都还在),已经存着的世界跟着重存一次
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams(location.search);
      if (projection !== 'equirect') q.set('proj', projection);
      else q.delete('proj');
      q.delete('view'); // 旧的地球仪开关,换成 proj=globe
      if (graticule) q.set('grat', '1');
      else q.delete('grat');
      const lon = Math.round(mapCenter * 100) / 100;
      if (Math.abs(lon) >= 0.005) q.set('lon', String(lon));
      else q.delete('lon');
      const next = `?${q}`;
      if (next !== location.search) history.replaceState(null, '', next);
      viewChanged();
    }, 450);
    return () => clearTimeout(t);
  }, [projection, mapCenter, graticule]);
  /** 现在这张图(或正在生成的)就是这组参数 + 地形修改 */
  const sameGen = (p: WorldParams, terrain: readonly TerrainOp[]) =>
    !!genParams.current && worldKey(genParams.current) === worldKey(p) && sameTerrain(terrain, genTerrain.current);
  /**
   * 换到哪一步:新建 / 世界 / 我的世界。进新建时政区、民族换成地形(还没有历史),
   * 离开新建时换回来;选中、概览、改地形属于上一步的,一起收起
   */
  const enterStage = (next: Stage, base: DraftBase | null = null) => {
    const was = getStage().stage;
    if (next !== was) {
      clearSelection();
      setPolityPick(null);
      closeOverview();
      setTerrainTool({ on: false });
      setHover(null);
      clearToast('created');
    }
    if (next === 'draft' && was !== 'draft') {
      pausePlayback();
      setDraftTip(true);
      const now = mapLayerRef.current;
      if (HISTORY_LAYERS.includes(now)) {
        draftLayerRef.current = now;
        applyLayer('terrain');
      }
    }
    if (next === 'world' && draftLayerRef.current) {
      applyLayer(draftLayerRef.current);
      draftLayerRef.current = null;
    }
    setStage(next, base);
  };
  /**
   * 打开一个世界:要的就是正在看的这一张图(参数、地形都一样,比如从我的世界打开同一个种子的另一份、以它为底稿新建)就不重新生成,
   * 直接换上它的修改;正在生成的就是它:等生成完;否则按它的参数生成
   */
  const openTarget = (t: Target) => {
    setWorldSheet('peek');
    enterStage(t.kind === 'draft' ? 'draft' : 'world', t.kind === 'draft' ? (t.base ?? null) : null);
    if (t.kind === 'draft') setDraftTitle(t.title ?? '');
    setParams(t.params);
    if (sameGen(t.params, t.edits.terrain)) {
      if (fresh.current) {
        targetRef.current = t;
        writeWorldUrl(t);
        return;
      }
      const last = lastReady.current;
      if (!regenRef.current && last && rawRef.current) {
        detachWorld();
        targetRef.current = t;
        readyRef.current(last.world, rawRef.current);
        writeWorldUrl(t);
        return;
      }
    }
    generate(t);
  };
  /** 打开"我的世界"里的一个(没建完的回到新建) */
  const openStored = (id: string) => {
    const w = loadWorld(id);
    if (!w) return notify({ kind: 'error', text: '打不开这个存档', more: ['可能已在别的页面里删掉了'] });
    // 下面一直开着的就是它、存的和开着的一样(没在别的页面里改过):不用重新打开
    const cur = currentWorld();
    const same =
      !!cur &&
      (cur.kind === 'draft') === w.draft &&
      worldKey(cur.params) === worldKey(w.save.params) &&
      (cur.title ?? '') === (w.save.title ?? '') &&
      JSON.stringify(getEdits()) === JSON.stringify(w.save.edits);
    if (cur?.id === id && targetRef.current?.id === id && same) {
      markOpened(id);
      enterStage(w.draft ? 'draft' : 'world', w.draft ? (w.base ?? null) : null);
      if (w.draft) setDraftTitle(w.save.title ?? '');
      writeWorldUrl(targetRef.current);
      return;
    }
    openTarget(storedTarget(w, 'stored'));
  };
  /** 从文件打开:存进"我的世界"(算建好的),再打开它;存不下就只打开、不存 */
  const openText = (text: string, fileName?: string) => {
    const r = parseSave(text);
    if (!r.ok) {
      notify({ kind: 'error', text: fileName ? `打不开 ${fileName}` : '打不开这个存档', more: [briefError(r.error)] });
      return;
    }
    const id = importSave(r.save);
    const w = id ? loadWorld(id) : null;
    const t: Target = w
      ? { ...storedTarget(w, 'stored'), view: r.save.view ?? null }
      : { id: newWorldId(), kind: 'visit', params: r.save.params, edits: r.save.edits, title: r.save.title, view: r.save.view ?? null, save: r.save };
    openTarget({ ...t, from: 'file', save: r.save, warnings: r.warnings });
  };
  /** 打开分享链接(解开以后):别人的世界,先不存;改了(或起了名)才存进"我的世界" */
  const openShare = (r: ParseResult) => {
    if (!r.ok) {
      const msg = briefError(r.error);
      // 世界还在生成:等生成完再说(生成时提示条上是进度)
      if (currentWorld()) showToast({ id: 'share', kind: 'error', text: '打不开这个分享链接', more: [msg] });
      else shareErr.current = msg;
      return;
    }
    const sv = r.save;
    openTarget({ id: newWorldId(), kind: 'visit', params: sv.params, edits: sv.edits, saved: sv.edits, title: sv.title, view: sv.view ?? null, from: 'link', save: sv, warnings: r.warnings });
  };
  const openShareRef = useRef(openShare);
  openShareRef.current = openShare;
  /** 新建世界(我的世界右上、第一次来):随机一颗星球 */
  const startDraft = () => openTarget(draftTarget({ ...DEFAULT_PARAMS, seed: randomSeedValue() }));
  /** 新建中的世界(在看的就是它)*/
  const draftNow = (): Target | null => {
    const t = targetRef.current;
    return t && t.kind === 'draft' && getStage().stage === 'draft' ? t : null;
  };
  /** 新建中:最新的名字、动没动过(存在 saveStore 里;还在生成时看 targetRef) */
  const draftState = (t: Target) => {
    const cur = currentWorld();
    const attached = cur?.id === t.id;
    return { title: attached ? cur.title : t.title, pristine: attached ? cur.pristine : t.pristine, edits: attached ? getEdits() : t.edits };
  };
  /** 新建中换种子:另一颗星球,改过的地形作废;没起名、参数也是默认的 = 又算没动过(不存) */
  const draftSeed = (seed: number) => {
    const t = draftNow();
    if (!t || t.base) return;
    const st = draftState(t);
    const plain = !st.title && worldKey({ ...t.params, seed: 0 }) === worldKey({ ...DEFAULT_PARAMS, seed: 0 });
    setDraftTip(false);
    generate({ ...t, params: { ...t.params, seed }, edits: EMPTY_EDITS, saved: undefined, title: st.title, pristine: st.pristine || plain, view: undefined, from: undefined, save: undefined });
  };
  /** 新建中调参数:改过的地形留着(按新参数重新生成) */
  const draftParams = (p: WorldParams) => {
    const t = draftNow();
    if (!t) return;
    const st = draftState(t);
    generate({ ...t, params: { ...p, seed: t.base ? t.params.seed : p.seed }, edits: st.edits, saved: undefined, title: st.title, pristine: false, view: undefined, from: undefined, save: undefined });
  };
  /** 新建中起名(点别处 / 回车):起了名就算动过,存进我的世界("没建完") */
  const draftRename = (title: string) => {
    const t = draftNow();
    if (!t) return;
    const clean = cleanTitle(title) || undefined;
    t.title = clean;
    setDraftTitle(clean ?? '');
    if (currentWorld()?.id === t.id) renameWorld(t.id, clean ?? '');
  };
  /** 创建世界:从此种子、参数、地形锁住;一直存着。从第 0 年起放一遍历史 */
  const createWorld = (title: string) => {
    const t = draftNow();
    const cur = currentWorld();
    // 还在生成、在重推带过来的干预、在放这颗星球的形成:等它完
    if (!t || !cur || cur.id !== t.id || fresh.current || regenRef.current || resim || replayOn) return;
    const clean = cleanTitle(title) || undefined;
    if ((clean ?? '') !== (cur.title ?? '')) renameWorld(t.id, clean ?? '');
    // 说存住了,要真的写进了浏览器(存储满了、删了旧的也写不下,或者浏览器不让存 = 只在这一页里)
    const stored = markCreated() && persistent();
    // 新建时 AI 提的改地形(执行过的也一样)从此不能再执行、撤销:对话清空
    syncRewriteWorld('terrain');
    targetRef.current = { ...t, kind: 'created', base: null, pristine: false, title: clean, from: undefined, save: undefined };
    setDraftTip(false);
    enterStage('world');
    // 建好的世界看政区
    draftLayerRef.current = null;
    applyLayer('political');
    writeWorldUrl(targetRef.current);
    if (rawRef.current) setWorldStats(aliveAtEnd(rawRef.current));
    refreshThumb();
    const keep = persistent();
    showToast({
      id: 'created',
      kind: stored ? 'ok' : 'warn',
      dot: stored,
      text: `${clean ?? '新世界'}已创建`,
      more: [stored ? '自动存在这个浏览器里，在「我的世界」里随时能找到' : keep ? '浏览器存储已满，没能存下；关掉页面前请存成文件' : '浏览器不让网页存数据，关掉页面前请存成文件'],
      ttl: 7000,
    });
    // 历史从第 0 年起放一遍(这次打开网页不再另外自动播放);不放(play=0、无头浏览器)时,
    // 新建时放过"这颗星球的形成"、时间停在第 0 年的,回到结束那一年
    takeAutoplay();
    if (storyOk()) startCivReplay();
    else if (getCivTime().year === 0) resetCivTime();
  };
  /**
   * 以正在看的世界为底稿新建:设定、改名、干预都带过去(还是这张图,不用重新生成);存成另一个世界。
   * 带着东西、起好了名,一开始就存(作为没建完的,刷新不丢);什么都没动就点返回,这一份删掉
   */
  const draftFromCurrent = () => {
    const t = targetRef.current;
    const cur = currentWorld();
    if (!t || !cur || cur.id !== t.id || fresh.current) return;
    const e = getEdits();
    const base: DraftBase = { id: cur.id, title: cur.title || '未命名世界', names: Object.keys(e.names).length, interventions: e.interventions.length };
    backRef.current = { ...t, kind: cur.kind, edits: e, saved: undefined, title: cur.title, from: undefined, save: undefined, view: undefined };
    const d = draftTarget(t.params, base, e, nextTitle(base.title));
    derivedRef.current = { id: d.id, sig: draftSig(d.params, d.edits, d.title) };
    openTarget({ ...d, pristine: false, view: undefined });
  };
  /** 以别的世界为底稿新建时,那个世界(没存过的也回得去) */
  const backRef = useRef<Target | null>(null);
  /** 以别的世界为底稿新建的那一份:编号和一开始的样子(返回时没动过就删掉) */
  const derivedRef = useRef<{ id: string; sig: string } | null>(null);
  /** 以底稿新建的那一份还是一开始的样子(参数、修改、名字都没动) */
  const derivedUntouched = (): string | null => {
    const d = derivedRef.current;
    const t = targetRef.current;
    const cur = currentWorld();
    if (!d || !t || !cur || t.id !== d.id || cur.id !== d.id) return null;
    return draftSig(t.params, getEdits(), cur.title) === d.sig ? d.id : null;
  };
  /** 回到"我的世界"(一个都没有就直接新建) */
  const goHome = () => {
    if (!listWorlds().length) return startDraft();
    pausePlayback();
    setReplayOn(false);
    setDraftTip(false);
    enterStage('home');
    writeHomeUrl();
  };
  /** 新建卡片左上的返回:底稿那个世界 / 我的世界;第一次来(没有别的世界)不显示 */
  const v = useSavesVersion();
  const draftBack = useMemo(() => {
    if (!draft) return null;
    if (stageBase) {
      return {
        label: stageBase.title,
        onClick: () => {
          const b = backRef.current;
          const left = derivedUntouched();
          if (left) deleteWorld(left);
          if (isStored(stageBase.id)) openStored(stageBase.id);
          else if (b && b.id === stageBase.id) openTarget(b);
          else goHome();
        },
      };
    }
    const id = targetRef.current?.id;
    return listWorlds().some((w) => w.id !== id) ? { label: '我的世界', onClick: goHome } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, stageBase, v]);
  // 只是看看的世界改了第一笔、新建中的动了第一下,就存下了:网址换成 w=编号,刷新还回到它
  useEffect(() => {
    const t = targetRef.current;
    const cur = currentWorld();
    if (home || !t || !cur || cur.id !== t.id) return;
    if (isStored(t.id) && new URLSearchParams(location.search).get('w') !== t.id) writeWorldUrl(t);
  }, [v, home]);
  // 我的世界里一个都不剩了(删光了、别的页面里删掉了):直接新建
  useEffect(() => {
    if (home && !listWorlds().length) startDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, v]);
  // 把 .json 拖进页面 = 从文件打开
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.relatedTarget || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropping(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    f.text().then(
      (t) => openText(t, f.name),
      () => notify({ kind: 'error', text: `打不开 ${f.name}`, more: ['读不了这个文件'] }),
    );
  };

  // ---- 渲染 ----
  // 画好的整张图按「画风 / 图层」各存一份(离屏画布),同一个世界里切回去直接贴上;
  // 世界一换就清空。用画布对画布复制而不是 getImageData,不从显卡读回像素,
  // 免得浏览器把主画布降级成软件渲染(那样河流、墨线的抗锯齿会变样)。
  // 用 useLayoutEffect:地形先于文明层(CivLayer 里的 useEffect)画好 —— 手绘风的文明层要借地形的符号层给水彩"让位"。
  const cacheRef = useRef<{ data: unknown; maps: Map<string, HTMLCanvasElement> }>({ data: null, maps: new Map() });
  /** 弯边投影:地形图(缓存里的等距圆柱原图)按投影铺到屏幕上 */
  const terrainProj = useRef(new ProjLayer());
  /** 上次画的是哪个世界、哪种画风 / 图层(弯边投影下只改中心时只重铺,不算"画了新的一张") */
  const drawnKey = useRef<{ data: unknown; key: string } | null>(null);
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const { world, raster } = data;
    const cache = cacheRef.current;
    if (cache.data !== data) {
      for (const c of cache.maps.values()) c.width = c.height = 0; // 尽快释放显存
      cache.maps.clear();
      cache.data = data;
    }
    const key = style === 'data' ? `data:${layer}` : style;
    const render = (ctx: CanvasRenderingContext2D) => {
      if (style === 'realistic') renderRealistic(ctx, world, raster);
      else if (style === 'fantasy') renderFantasy(ctx, world, raster);
      else renderLayer(ctx, world, raster, layer);
    };
    const t0 = performance.now();
    const hit = cache.maps.get(key);
    const fresh = drawnKey.current?.data !== data || drawnKey.current.key !== key;
    drawnKey.current = { data, key };
    if (mp) {
      // 弯边投影:原图画在离屏画布上(和等距圆柱共用缓存),按投影铺到屏幕上;不接右边那一份
      let src = hit;
      if (!src) {
        src = document.createElement('canvas');
        src.width = raster.w;
        src.height = raster.h;
        render(src.getContext('2d')!);
        cache.maps.set(key, src);
      }
      const t1 = performance.now();
      const proj = terrainProj.current;
      presentTerrain(cv, mp, { world, raster, style, src, layer: proj, moving: projMoving });
      mirrorCanvas(canvasCopyRef.current, null, false);
      const w = window as unknown as { __wf: unknown; __wfProj: unknown };
      w.__wfProj = { proj: mp.def.id, lon: mp.lon0, ms: performance.now() - t1 };
      if (fresh) w.__wf = { ready: true, renderMs: performance.now() - t0, style, layer, proj: mp.def.id };
      return;
    }
    terrainProj.current.release();
    cv.width = raster.w;
    cv.height = raster.h;
    const ctx = cv.getContext('2d')!;
    if (hit) ctx.drawImage(hit, 0, 0);
    else render(ctx);
    const renderMs = performance.now() - t0;
    if (!hit) {
      const copy = document.createElement('canvas');
      copy.width = raster.w;
      copy.height = raster.h;
      copy.getContext('2d')!.drawImage(cv, 0, 0);
      cache.maps.set(key, copy);
    }
    // 右边再接一份(左右无限拖动)
    mirrorCanvas(canvasCopyRef.current, cv, true);
    (window as unknown as { __wf: unknown }).__wf = { ready: true, renderMs, style, layer };
  }, [data, style, layer, mp, projMoving]);

  /** 某画风的整张底图(等距圆柱,和 raster 一样大):缓存里有就直接给,没有就画一张放进缓存(图层缩略图用;之后切过去也不用再画) */
  const baseCanvas = useCallback((key: string): HTMLCanvasElement | null => {
    const d = dataRef.current;
    const cache = cacheRef.current;
    if (!d || cache.data !== d) return null;
    let c = cache.maps.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = d.raster.w;
      c.height = d.raster.h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      if (key === 'realistic') renderRealistic(ctx, d.world, d.raster);
      else if (key === 'fantasy') renderFantasy(ctx, d.world, d.raster);
      else renderLayer(ctx, d.world, d.raster, key.slice(5) as LayerId);
      cache.maps.set(key, c);
    }
    return c;
  }, []);
  const { thumbs, request: requestThumbs } = useLayerThumbs({ data, civ: rawCiv, baseCanvas }, mapLayer);

  // ---- 回放:看世界长出来 ----
  const startReplay = () => {
    if (!data || !genParams.current) return;
    setTerrainTool({ on: false });
    prepareCivReplay(); // 文明层先退回第 0 年,等地质放完再接着放文明
    setReplayOn(true);
    if (replay) setReplay({ ...replay, idx: 0 });
    else send({ type: 'history', id: reqId.current, params: genParams.current, terrain: [...genTerrain.current] });
  };
  /** 弯边投影:回放帧先放在离屏的等距圆柱原图上,再按投影铺到屏幕上 */
  const overlayProj = useRef(new ProjLayer());
  useEffect(() => {
    if (!replayOn || !replay) return;
    const cv = overlayRef.current;
    if (!cv) return;
    const frame = new ImageData(new Uint8ClampedArray(replay.frames[replay.idx]), replay.w, replay.h);
    const m = mpRef.current;
    if (m) {
      overlayProj.current.source(replay.w, replay.h).getContext('2d')!.putImageData(frame, 0, 0);
      overlayProj.current.present(cv, m, pageColor(style));
      mirrorCanvas(overlayCopyRef.current, null, false);
    } else {
      cv.width = replay.w;
      cv.height = replay.h;
      cv.getContext('2d')!.putImageData(frame, 0, 0);
      mirrorCanvas(overlayCopyRef.current, cv, !!data);
    }
    const last = replay.idx >= replay.frames.length - 1;
    const t = setTimeout(
      () => (last ? (setReplayOn(false), getStage().stage === 'world' && startCivReplay()) : setReplay((r) => (r ? { ...r, idx: r.idx + 1 } : r))),
      last ? 1400 : replay.idx === 0 ? 900 : 260,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayOn, replay]);
  // 回放时改了投影 / 中心:这一帧按新的重铺(不打断回放的节奏)
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv || !replayOn || !replay) return;
    if (mp && overlayProj.current.has()) overlayProj.current.present(cv, mp, pageColor(style));
    else if (!mp) overlayProj.current.release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp]);

  // ---- 地图铺满全屏:2:1 的地图框按舞台"盖满"(舞台比 2:1 窄时上下正好顶到边、左右接着转;比 2:1 宽时左右顶到边) ----
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** 舞台(视口)的大小:视窗、平移范围按它算 */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const W = e.contentRect.width;
      const H = e.contentRect.height;
      const w = Math.max(100, W, H * 2);
      setBox({ w, h: w / 2 });
      setStageSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 缩放 / 平移 ----
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  /** 按下时的位置、视图(弯边投影:还有当时的中央经线;拖动改的是它) */
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; lon: number; touch?: boolean } | null>(null);
  // 世界东西相连:左右无限拖动(见 mapWrap.ts)。wrapW = 一整圈的世界宽度,还没有世界时 0
  const wrapW = data ? wrapOf(data.world) : 0;
  setTerrainWrap(wrapW);
  /**
   * 窄屏底部被卡片和时间轴胶囊盖住的那一截:没选东西时是收起的世界卡片 + 胶囊,详情卡片开着时是半高的卡片 + 胶囊。
   * 地图可以往上推进这一截(见 mapWrap.ts 的 StageBox.padB),下半截的国家也能飞到上方看得见的地方;卡片收回去后慢慢回到原来的范围
   */
  const padB = !narrow || !stageSize.h ? 0 : Math.max(0, stageSize.h - phoneFree(stageSize.h, panelOpen)[1]);
  const geo = useRef<{ wrap: number; bw: number; bh: number; W: number; H: number; padB: number }>({ wrap: 0, bw: 0, bh: 0, W: 1, H: 1, padB: 0 });
  geo.current = { wrap: wrapW, bw: box.w, bh: box.h, W: data?.world.width ?? 1, H: data?.world.height ?? 1, padB };
  const curvedRef = useRef(curved);
  curvedRef.current = curved;
  /**
   * 平移范围:上下夹在两极以内;等距圆柱左右不限(挪整数圈),
   * 弯边投影横向正对外框(左右拖动改中央经线,见 mapWrap.ts 的 clampCurved)
   */
  const clampAny = (v: { k: number; x: number; y: number }, w: number, h: number) => {
    const g = geo.current;
    if (!g.bw) return v;
    const b = { sw: w, sh: h, bw: g.bw, bh: g.bh, padB: g.padB };
    return curvedRef.current ? clampCurved(v, b) : clampSphere(v, b);
  };
  const clampRef = useRef(clampAny);
  clampRef.current = clampAny;
  const sb: StageBox = { sw: stageSize.w, sh: stageSize.h, bw: box.w, bh: box.h, padB };
  /** 视窗中心的世界 x(舞台、地图框大小变了按它保持中心不动) */
  const centerRef = useRef<number | null>(null);
  /** 网址里带的中央经线:世界、舞台都出来以后把等距圆柱的视图转过去(只一次) */
  const pendingLon = useRef<number | null>(init.lon);
  // 换投影:缩放复位,中心不变(等距圆柱把视图转到这条经线;弯边投影横向正对外框)。
  // 在渲染时就换好视图,不会有一帧"新投影 + 旧视图"把中心记错
  const [viewProj, setViewProj] = useState<MapProjection>(projection);
  /** 从地球仪切出来时它正对着的经度:这一次提交后记进中心(渲染时只读、不改 store) */
  const handoffLon = useRef<number | null>(null);
  if (viewProj !== projection) {
    const fromGlobe = viewProj === 'globe' ? globeApi.current?.centerLon() : undefined;
    const lonNow = fromGlobe !== undefined ? wrapLon(fromGlobe) : getMapCenter();
    if (fromGlobe !== undefined) handoffLon.current = lonNow;
    setViewProj(projection);
    const base = { k: 1, x: 0, y: 0 };
    if (sb.sw && sb.bw) setView(curved || !wrapW ? clampCurved(base, sb) : viewCentredAt(base, sb, wrapW, xOfLon(lonNow, wrapW)));
    else setView(base);
  }
  useLayoutEffect(() => {
    if (handoffLon.current === null) return;
    publishMapCenter(handoffLon.current);
    handoffLon.current = null;
  });
  /** 这一次提交里视图刚被换掉(还是旧的):先不按它记中心,等下一次 */
  const settling = useRef(false);
  // 世界出来了、或者舞台大小变了,重新夹一下(保持中心经线不动)
  useEffect(() => {
    if (!sb.sw || !sb.bw || !wrapW) return;
    if (curvedRef.current) {
      pendingLon.current = null;
      setView((v) => clampCurved(v, sb));
      return;
    }
    let c = centerRef.current;
    if (pendingLon.current !== null) {
      c = xOfLon(pendingLon.current, wrapW);
      pendingLon.current = null;
      settling.current = true;
    }
    setView((v) => (c === null ? clampSphere(v, sb) : viewCentredAt(v, sb, wrapW, c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapW, sb.sw, sb.sh, sb.bw, sb.bh]);
  // 窄屏详情卡片关上(地图不能再往上推进卡片那一截了):推上去的地图约 0.3 秒回到范围里
  const lastPadB = useRef(padB);
  useEffect(() => {
    const was = lastPadB.current;
    lastPadB.current = padB;
    if (padB >= was || !sb.sw || !sb.bw || flyRaf.current) return;
    const v0 = viewRef.current;
    const clamp = (v: { k: number; x: number; y: number }) => (curvedRef.current ? clampCurved(v, sb) : clampSphere(v, sb));
    const y1 = clamp(v0).y;
    if (Math.abs(y1 - v0.y) < 0.5) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 300);
      // 用户按下地图 / 又飞走了:让给它们
      if (flyRaf.current || drag.current) return;
      const v = { k: v0.k, x: v0.x, y: v0.y + (y1 - v0.y) * easeOutCubic(t) };
      viewRef.current = v;
      setView(t < 1 ? v : clamp(v));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padB]);
  // 当前中心经度:等距圆柱时视图一变就记下(之后的"中央经线"设置、导出读它);
  // 弯边投影和地球仪时中心就在 store 里,由它们自己改,不从平面视图推
  useEffect(() => {
    const ready = !!wrapW && !!sb.sw && !!sb.bw;
    if (projection !== 'equirect') {
      const lon = getMapCenter();
      centerRef.current = ready ? xOfLon(lon, wrapW) : null;
      (window as unknown as { __wfView: unknown }).__wfView = { ...view, wrap: wrapW, lon, bw: sb.bw, sw: sb.sw, proj: projection };
      return;
    }
    // 网址里带的中心还没转过去(世界还没出来),或者视图刚被换掉:先别把旧视图的中心记下
    if (pendingLon.current !== null) return;
    if (settling.current) {
      settling.current = false;
      return;
    }
    const cx = ready ? centerX(view, sb, wrapW) : null;
    centerRef.current = cx;
    const lon = cx === null ? getMapCenter() : lonOfX(cx, wrapW);
    publishMapCenter(lon);
    (window as unknown as { __wfView: unknown }).__wfView = { ...view, wrap: wrapW, lon, bw: sb.bw, sw: sb.sw, proj: projection };
  });
  useEffect(() => {
    handleMapCenterRequests((lon) => {
      stopFly(); // "设为中心"等:正在飞的停下,别再盖掉它
      if (getGlobeOn()) return globeApi.current?.flyTo(lon);
      const g = geo.current;
      const el = stageRef.current;
      // 弯边投影:中心就是中央经线,直接改(整图按它重投影)
      if (getProjection() !== 'equirect') {
        publishMapCenter(wrapLon(lon));
        return;
      }
      if (!g.wrap || !el || !g.bw) {
        publishMapCenter(wrapLon(lon));
        pendingLon.current = wrapLon(lon);
        return;
      }
      const b = { sw: el.clientWidth, sh: el.clientHeight, bw: g.bw, bh: g.bh };
      setView((v) => viewCentredAt(v, b, g.wrap, xOfLon(lon, g.wrap)));
    });
    // 截图脚本、冒烟检查用:转到某经度;世界坐标 ↔ 屏幕坐标(取视窗里的那一份;弯边投影按投影)
    const w = window as unknown as Record<string, unknown>;
    w.__wfSetCenter = (lon: number) => requestMapCenter(lon);
    // 冒烟检查用:把视图放回某个样子(点选会让地图飞走;要在同一个视图下接着点时先放回来)
    w.__wfSetView = (v: { k: number; x: number; y: number }) => {
      stopFly();
      viewRef.current = v;
      setView(v);
    };
    w.__wfSetProjection = (p: MapProjection) => setProjection(p);
    w.__wfWorldToClient = worldToClient.current = (wx: number, wy: number): [number, number] | null => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const v = viewRef.current;
      const m = mpRef.current;
      let x = wx;
      let y = wy;
      if (m) [x, y] = projectWorld(m, wx, wy);
      else if (g.wrap) x = nearX(wx, stageToWorld(r.width / 2, 0, v, b, g.W, g.H)[0], g.wrap);
      const [X, Y] = worldToStage(x, y, v, b, g.W, g.H);
      return [r.left + X, r.top + Y];
    };
    // 某一点的完整读数(群落、海拔、国家、最近城市……;悬停卡片只露一两行,冒烟检查读这个)
    w.__wfProbe = (cx: number, cy: number): string[] | null => probeRef.current(cx, cy);
    w.__wfClientToWorld = (cx: number, cy: number): [number, number] | null => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const [x, y] = stageToWorld(cx - r.left, cy - r.top, viewRef.current, b, g.W, g.H);
      const m = mpRef.current;
      if (m) return unprojectWorld(m, x, y);
      return [x - g.W * Math.floor(x / g.W), y];
    };
    return () => handleMapCenterRequests(null);
  }, []);
  // 弯边投影里拖动改中心:一帧最多改一次(每次改都要整图重铺)
  const centerFrame = useRef<{ raf: number; lon: number | null }>({ raf: 0, lon: null });
  const scheduleCenter = (lon: number) => {
    const c = centerFrame.current;
    c.lon = lon;
    if (c.raf) return;
    c.raf = requestAnimationFrame(() => {
      c.raf = 0;
      if (c.lon !== null) publishMapCenter(wrapLon(c.lon));
      c.lon = null;
    });
  };
  useEffect(() => () => cancelAnimationFrame(centerFrame.current.raf), []);
  /** 选中后地图正在飞过去(见下面"选中 → 暂停 + 地图飞过去");用户自己拖动、缩放就停下 */
  const flyRaf = useRef(0);
  const stopFly = () => {
    if (!flyRaf.current) return;
    cancelAnimationFrame(flyRaf.current);
    flyRaf.current = 0;
    if (curvedRef.current) setMapMoving(false);
  };
  /**
   * 以舞台上的 (mx, my) 为中心缩放 f 倍(滚轮、右下角的 + −)。
   * 弯边投影:上下照常以这一点为中心缩放;横向转中央经线,让这一点下的地方还在这一点下
   */
  const zoomAt = (mx: number, my: number, f: number) => {
    stopFly();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const m = mpRef.current;
    const g = geo.current;
    if (m && g.bw) {
      const v = viewRef.current;
      const k = Math.min(12, Math.max(1, v.k * f));
      const b = { sw: rect.width, sh: rect.height, bw: g.bw, bh: g.bh, padB: g.padB };
      const nv = clampCurved({ k, x: v.x, y: my - (my - v.y) * (k / v.k) }, b);
      const [px, py] = stageToWorld(mx, my, v, b, g.W, g.H);
      const r = unprojectRel(m, px, py);
      if (r) {
        const kx = m.def.kx(r[1]);
        const [px2] = stageToWorld(mx, my, nv, b, g.W, g.H);
        if (kx > 1e-6) {
          const rel2 = Math.max(-Math.PI, Math.min(Math.PI, (px2 - g.W / 2) / (m.s * kx)));
          publishMapCenter(wrapLon(m.lon0 + ((r[0] - rel2) * 180) / Math.PI));
        }
      }
      viewRef.current = nv;
      setView(nv);
      return;
    }
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * f));
      const q = k / v.k;
      const nx = mx - (mx - v.x) * q;
      const ny = my - (my - v.y) * q;
      return clampRef.current({ k, x: nx, y: ny }, rect.width, rect.height);
    });
  };
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      touchRef.current();
      // 详情面板里滚动 = 滚面板,不缩放地图;地球仪自己管缩放
      if ((e.target as HTMLElement | null)?.closest?.('.inspector') || getGlobeOn()) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomRef.current(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  /** 右下角的 + −:以看得见的地图中间为中心(宽屏让出左边的侧栏卡片);地球仪里交给地球仪自己的滚轮缩放 */
  const zoomButton = (f: number) => {
    touchRef.current();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = (sideRoom(rect.width) + rect.width) / 2;
    const cy = rect.height / 2;
    if (getGlobeOn()) {
      const g = el.querySelector('.globe');
      g?.dispatchEvent(new WheelEvent('wheel', { deltaY: -Math.log(f) / 0.0015, clientX: rect.left + cx, clientY: rect.top + cy, bubbles: true, cancelable: true }));
      return;
    }
    zoomAt(cx, cy, f);
  };

  // ---- 编年史点一条:事发地不在视野里,就把地图平移过去(不改缩放,约 0.4 秒滑过去) ----
  const chron = useChronicle();
  const hl = useCivHighlight();
  const picking = usePolityPick();
  const viewRef = useRef(view);
  viewRef.current = view;
  const hlStamp = hl?.stamp;
  /**
   * 编年史跳转时"看得见的地方"的上、下和目标放在哪个高度(舞台坐标):上面留出世界名、提示条,下面留出时间轴;
   * 窄屏:让出底部的卡片和时间轴胶囊(详情卡片开着时是它上方那一截)
   */
  const jumpBand = (H: number): [number, number, number] => {
    if (!narrow) return [80, H - 110, (H - 16) / 2];
    const [t, b] = phoneFree(H, panelOpen);
    return [t + 8, b - 16, (t + b) / 2];
  };
  /**
   * 弯边投影里的编年史跳转:事发地横向不在视野里就转中央经线过去(走短边),纵向不在就上下平移;约 0.4 秒转过去。
   * b = 事发地的外接框(世界坐标)
   */
  const curvedJump = (b: [number, number, number, number], m: MapProj, W: number, H: number) => {
    const g = geo.current;
    const v0 = viewRef.current;
    const sbx = { sw: W, sh: H, bw: box.w, bh: box.h };
    const bx = (b[0] + b[2]) / 2;
    const by = (b[1] + b[3]) / 2;
    const corners: [number, number][] = [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
      [bx, by],
      [bx, b[1]],
      [bx, b[3]],
    ];
    const pts = corners.map(([x, y]) => {
      const [mx, my] = projectWorldNear(m, x, y, bx);
      return worldToStage(mx, my, v0, sbx, g.W, g.H);
    });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [bandT, bandB, midY] = jumpBand(H);
    // 宽屏左边被侧栏卡片挡住的那一截不算看得见;转过去以后事发地落在卡片右边那一块的正中(按赤道上每度多少像素估)
    const L = sideRoom(W);
    const inX = Math.min(...xs) >= L + 30 && Math.max(...xs) <= W - 30;
    const inY = Math.min(...ys) >= bandT && Math.max(...ys) <= bandB;
    if (inX && inY) return;
    const pxPerDeg = v0.k * (box.w / m.W) * m.s * m.def.kx(0) * (Math.PI / 180);
    const dLon = inX ? 0 : wrapLon(lonOfX(bx, g.W) - m.lon0 - (pxPerDeg > 0 ? L / 2 / pxPerDeg : 0));
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const toY = inY ? v0.y : Math.min(0, Math.max(H - H * v0.k, v0.y + midY - cy));
    if (Math.abs(dLon) < 0.5 && Math.abs(toY - v0.y) < 1) return;
    (window as unknown as { __wfPan: unknown }).__wfPan = { dLon, dy: toY - v0.y, stamp: hlStamp };
    const lon0 = m.lon0;
    const t0 = performance.now();
    let raf = 0;
    setMapMoving(true);
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 400);
      const e = 1 - (1 - t) ** 3;
      if (dLon) publishMapCenter(wrapLon(lon0 + dLon * e));
      setView(clampRef.current({ k: v0.k, x: v0.x, y: v0.y + (toY - v0.y) * e }, W, H));
      if (t < 1) raf = requestAnimationFrame(step);
      else setMapMoving(false);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setMapMoving(false);
    };
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!hl || !data || !civ || !el || civ.regions.of.length !== data.world.mesh.n || getGlobeOn()) return;
    let b = highlightBox(data.world, civ, highlightMarks(civ, hl));
    if (!b) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const v0 = viewRef.current;
    const ww = wrapOf(data.world);
    const m = mpRef.current;
    if (m && box.w) return curvedJump(b, m, W, H);
    if (box.w) {
      // 事发地取离视窗中心最近的那一份 —— 平移走短边(不会绕地球大半圈)
      // 视窗中心(展开的世界坐标,和 sx 同一套:主图那一份左边起算)
      const c = stageToWorld(W / 2, 0, v0, { sw: W, sh: H, bw: box.w, bh: box.h }, ww, 1)[0];
      const bc = (b[0] + b[2]) / 2;
      const sh = nearX(bc, c, ww) - bc;
      b = [b[0] + sh, b[1], b[2] + sh, b[3]];
    }
    // 世界坐标 → 舞台上的屏幕坐标(地图框在舞台里居中,再整体平移 x/y、放大 k)
    const sx = (wx: number) => v0.x + ((W - box.w) / 2 + (wx / data.world.width) * box.w) * v0.k;
    const sy = (wy: number) => v0.y + ((H - box.h) / 2 + (wy / data.world.height) * box.h) * v0.k;
    const x0 = sx(b[0]);
    const x1 = sx(b[2]);
    const y0 = sy(b[1]);
    const y1 = sy(b[3]);
    // 上面留出提示条,下面留出时间轴(窄屏:底部卡片和时间轴胶囊上方)
    const [bandT, bandB, midY] = jumpBand(H);
    // 宽屏左边被侧栏卡片挡住的那一截不算看得见,平移到卡片右边那一块的正中
    const L = sideRoom(W);
    if (x0 >= L + 30 && x1 <= W - 30 && y0 >= bandT && y1 <= bandB) return;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // 左右不夹(每一帧再挪整数圈,画面是连着的);上下夹在两极以内
    const to = { k: v0.k, x: v0.x + (L + W) / 2 - cx, y: Math.min(0, Math.max(H - H * v0.k, v0.y + midY - cy)) };
    if (Math.abs(to.x - v0.x) < 1 && Math.abs(to.y - v0.y) < 1) return;
    (window as unknown as { __wfPan: unknown }).__wfPan = { dx: to.x - v0.x, dy: to.y - v0.y, stamp: hlStamp };
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 400);
      const e = 1 - (1 - t) ** 3;
      const v = { k: v0.k, x: v0.x + (to.x - v0.x) * e, y: v0.y + (to.y - v0.y) * e };
      setView(clampRef.current(v, W, H));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // 只在点了新的一条时平移
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlStamp]);

  // ---- 选中 → 暂停 + 地图飞过去(国家面板):不管选中来自点地图、面板里的链接、概览还是搜索 ----
  // 国家:平移缩放到能看全当年的疆域,右边让出面板;城 / 州 / 地理实体:平移过去,缩放不变或适度放大;0.6 秒,ease-out 三次方。
  // 地球仪用它自己的 flyTo。选目标时 / 下了令之后缩回整张图('home')
  const flyNow = (to: 'sel' | 'home') => {
    stopFly();
    const el = stageRef.current;
    if (!data || !el || !box.w || replayOn || getTerrainTool().on) return;
    const sel = getSelection().sel;
    const year = civ ? Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear)) : 0;
    const focus = to === 'sel' && sel && civ ? selectionFocus(data.world, civ, sel, year) : null;
    if (to === 'sel' && (!focus || !sel)) return;
    const goal: FlyGoal = { focus, kind: to === 'sel' && sel ? sel.kind : 'home' };
    if (getGlobeOn()) {
      if (focus) globeApi.current?.flyTo(focus.lon, focus.lat);
      return;
    }
    const b: StageBox = { sw: el.clientWidth, sh: el.clientHeight, bw: box.w, bh: box.h, padB: geo.current.padB };
    const W = data.world.width;
    const H = data.world.height;
    const m = mpRef.current;
    const flat = m ? null : flatFly(viewRef.current, b, W, H, goal);
    const step = m ? curvedFly(viewRef.current, b, m, (lon) => curvedProj(getProjection(), lon, W, H) ?? m, goal) : flat && ((e: number) => ({ v: flat(e), lon: null }));
    if (!step) return;
    const t0 = performance.now();
    if (m) setMapMoving(true);
    // 用户自己拖动 / 缩放时 stopFly 让给用户(按下地图、滚轮、右下的 + −)
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / FLY_MS);
      const r = step(easeOutCubic(t));
      if (r.lon !== null) publishMapCenter(wrapLon(r.lon));
      viewRef.current = r.v;
      setView(r.v);
      if (t < 1) flyRaf.current = requestAnimationFrame(frame);
      else stopFly();
    };
    flyRaf.current = requestAnimationFrame(frame);
  };
  const flyRef = useRef(flyNow);
  flyRef.current = flyNow;
  useEffect(() => () => stopFly(), []);
  // 按稳定键认"选中的是不是换了":重推历史后编号变了、还是同一个东西,不再飞
  const selStable = rawCiv && selState.sel ? selectionKey(rawCiv, selState.sel) : '';
  useEffect(() => {
    if (!selStable) return;
    pausePlayback();
    flyRef.current('sel');
  }, [selStable]);
  const flyReq = panelUi.fly;
  useEffect(() => {
    if (flyReq) flyRef.current(flyReq.to);
  }, [flyReq]);

  /** 这次按下以后拖动过(拖过就不算单击,不选中) */
  const moved = useRef(false);
  // ---- 手指(触屏):单指拖动平移、双指捏合缩放(以两指中点为中心)、点一下 = 单击、点两下 = 回正 ----
  /** 按在地图上的手指(id → 屏幕坐标;地球仪上的也记,双击回正用) */
  const touches = useRef(new Map<number, Pt>());
  /** 双指捏合:上一次用到的两指位置;手指移动先记下,下一帧一起缩放 / 平移(一帧最多一次) */
  const pinch = useRef<{ a: Pt; b: Pt; raf: number } | null>(null);
  /** 改地形正用手指画线(这时第二根手指不捏合) */
  const terrainStroke = useRef(false);
  /** 这一下手指按下的位置、时刻(松手时判断是不是"点一下");中途多了一根手指就不算 */
  const tapStart = useRef<(Tap & { id: number; multi: boolean }) | null>(null);
  /** 上一下"点一下"(和这一下够近就是双击) */
  const lastTap = useRef<Tap | null>(null);
  /** 刚被手指双击过(时刻):紧跟着的 click 按双击的第二下处理(恢复原来的选中) */
  const dblTapAt = useRef(-1e9);
  /** 平移(屏幕像素);弯边投影左右 = 转中央经线 */
  const panBy = (dx: number, dy: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const m = mpRef.current;
    const g = geo.current;
    if (m && g.bw) {
      const v = viewRef.current;
      const pxPerDeg = v.k * (g.bw / m.W) * m.s * m.def.kx(0) * (Math.PI / 180);
      if (pxPerDeg > 0 && dx) publishMapCenter(wrapLon(getMapCenter() - dx / pxPerDeg));
      const nv = clampRef.current({ k: v.k, x: v.x, y: v.y + dy }, rect.width, rect.height);
      viewRef.current = nv;
      setView(nv);
      return;
    }
    setView((v) => clampRef.current({ k: v.k, x: v.x + dx, y: v.y + dy }, rect.width, rect.height));
  };
  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    if (!a || !b) return;
    drag.current = null;
    moved.current = true;
    setHover(null);
    // 单指拖动时排着的"转中央经线"作废(不然下一帧把捏合的结果盖掉)
    const c = centerFrame.current;
    cancelAnimationFrame(c.raf);
    c.raf = 0;
    c.lon = null;
    if (pinch.current) cancelAnimationFrame(pinch.current.raf);
    pinch.current = { a: { ...a }, b: { ...b }, raf: 0 };
    if (curvedRef.current) setMapMoving(true);
  };
  const schedulePinch = () => {
    const p = pinch.current;
    if (!p || p.raf) return;
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      if (pinch.current !== p) return;
      const [a, b] = [...touches.current.values()];
      const el = stageRef.current;
      if (!a || !b || !el) return;
      const st = pinchStep(p.a, p.b, a, b);
      p.a = { ...a };
      p.b = { ...b };
      const r = el.getBoundingClientRect();
      // 先以上一帧的中点为中心缩放,再跟着中点平移:两指下面的地方一直在两指下面
      if (Math.abs(st.f - 1) > 1e-4) zoomRef.current(st.mx - st.dx - r.left, st.my - st.dy - r.top, st.f);
      if (st.dx || st.dy) panBy(st.dx, st.dy);
    });
  };
  /** 捏合结束:还剩一根手指就接着单指拖动 */
  const endPinch = () => {
    const p = pinch.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    pinch.current = null;
    const [rest] = [...touches.current.values()];
    if (rest) {
      const v = viewRef.current;
      drag.current = { x: rest.x, y: rest.y, vx: v.x, vy: v.y, lon: getMapCenter(), touch: true };
      return;
    }
    drag.current = null;
    setMapMoving(false);
  };
  // 手指的登记放在捕获阶段(地球仪自己的处理会拦住冒泡):哪几根手指按着、是不是"点一下"、双击回正
  const onTouchDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 1) tapStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
    else if (tapStart.current) tapStart.current.multi = true;
  };
  const onTouchMoveCapture = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onTouchUpCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.delete(e.pointerId);
    const ts = tapStart.current;
    if (!ts || ts.id !== e.pointerId) return;
    tapStart.current = null;
    const now = performance.now();
    const onMap = !!(e.target as HTMLElement | null)?.closest?.('.canvas-wrap, .globe');
    if (e.type !== 'pointerup' || ts.multi || !onMap || now - ts.t > 500 || Math.hypot(e.clientX - ts.x, e.clientY - ts.y) > TOUCH_SLOP) {
      lastTap.current = null;
      return;
    }
    const tap: Tap = { x: e.clientX, y: e.clientY, t: now };
    if (!isDoubleTap(lastTap.current, tap)) {
      lastTap.current = tap;
      return;
    }
    // 点两下:回正(和鼠标双击一样;浏览器自己也发了 dblclick 的话再回正一次也不要紧)
    lastTap.current = null;
    dblTapAt.current = now;
    if (getGlobeOn()) globeApi.current?.reset();
    else resetView();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    touchRef.current();
    stopFly();
    if (getGlobeOn()) return; // 地球仪自己管拖动
    const touch = e.pointerType === 'touch';
    // 第二根手指:开始捏合(改地形正在画线时不管)
    if (touch && touches.current.size >= 2) {
      if (terrainStroke.current) return;
      if (touches.current.size === 2) startPinch();
      return;
    }
    // 改地形:画线的工具按下就开始画(不平移)
    if (terrainDown(worldAt(e.clientX, e.clientY), e.button)) {
      moved.current = true;
      terrainStroke.current = touch;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return; // 只用左键
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, lon: getMapCenter(), touch };
    moved.current = false;
    if (stageRef.current) stageRef.current.style.cursor = '';
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  /**
   * 屏幕坐标 → 主图上的像素(不在地图上 = null)。
   * 视窗外面(宽屏两边的空白)不算;主图右边接的那一份、跨过 180° 经线的地方按列取模 —— 接缝两边点到的是同一块地
   */
  const pixelAt = (cx: number, cy: number): [number, number] | null => {
    if (getGlobeOn()) return data ? (globeApi.current?.pixelAt(cx, cy) ?? null) : null;
    if (!data || !canvasRef.current) return null;
    if (mp) {
      // 弯边投影:屏幕 → 地图平面 → 反投影回世界坐标(外轮廓外面 = 不在地图上)
      const w = worldAt(cx, cy);
      if (!w) return null;
      const s = data.raster.scale;
      return [Math.min(data.raster.w - 1, Math.floor(w[0] * s)), Math.min(data.raster.h - 1, Math.floor(w[1] * s))];
    }
    const cr = canvasRef.current.getBoundingClientRect();
    let px = Math.floor(((cx - cr.left) / cr.width) * data.raster.w);
    const py = Math.floor(((cy - cr.top) / cr.height) * data.raster.h);
    if (!inWindow(cx)) return null;
    px = ((px % data.raster.w) + data.raster.w) % data.raster.w;
    if (px < 0 || py < 0 || px >= data.raster.w || py >= data.raster.h) return null;
    return [px, py];
  };
  /** 屏幕上这一点在不在视窗(外框 ∩ 舞台)里 */
  const inWindow = (cx: number): boolean => {
    const el = stageRef.current;
    if (!el || !box.w) return false;
    const r = el.getBoundingClientRect();
    const [wl, wr] = windowSpan(view.k, { sw: r.width, sh: r.height, bw: box.w, bh: box.h });
    return cx - r.left >= wl && cx - r.left <= wr;
  };
  /** 屏幕坐标 → 地块(不在地图上 = −1) */
  const cellAt = (cx: number, cy: number): number => {
    const p = pixelAt(cx, cy);
    return p && data ? data.raster.cell[p[1] * data.raster.w + p[0]] : -1;
  };
  /**
   * 屏幕坐标 → 世界坐标(地图原图的像素坐标;不在地图上 = null)。
   * x 取模到 [0, 宽)(改地形画线时由 TerrainTools 按上一个点展开,跨接缝的线是连着的一笔)
   */
  const worldAt = (cx: number, cy: number): [number, number] | null => {
    if (!data || !canvasRef.current) return null;
    const cr = canvasRef.current.getBoundingClientRect();
    let u = (cx - cr.left) / cr.width;
    const v = (cy - cr.top) / cr.height;
    if (!inWindow(cx)) return null;
    if (mp) {
      if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
      return unprojectWorld(mp, u * data.world.width, v * data.world.height);
    }
    u -= Math.floor(u);
    if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
    return [u * data.world.width, v * data.world.height];
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = stageRef.current;
    if (!el || getGlobeOn()) return;
    // 双指捏合:等下一帧一起算
    if (pinch.current) {
      if (e.pointerType === 'touch') schedulePinch();
      return;
    }
    const rect = el.getBoundingClientRect();
    terrainMove(worldAt(e.clientX, e.clientY));
    let label: ReturnType<typeof pickLabelAt> = null;
    if (drag.current) {
      const d = drag.current;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > (d.touch ? TOUCH_SLOP : CLICK_SLOP)) moved.current = true;
      if (mp && box.w) {
        // 弯边投影:左右拖 = 转中央经线(赤道上的地方跟着鼠标走),上下拖 = 平移
        if (moved.current) setMapMoving(true);
        const pxPerDeg = view.k * (box.w / mp.W) * mp.s * mp.def.kx(0) * (Math.PI / 180);
        if (pxPerDeg > 0) scheduleCenter(d.lon - (e.clientX - d.x) / pxPerDeg);
        setView((v) => clampRef.current({ k: v.k, x: v.x, y: d.vy + e.clientY - d.y }, rect.width, rect.height));
      } else setView((v) => clampRef.current({ k: v.k, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }, rect.width, rect.height));
    } else {
      // 鼠标停在能点的字 / 城镇符号上:手指光标(改地形时不管字)
      label = getTerrainTool().on || draft ? null : pickLabelAt(e.clientX, e.clientY);
      el.style.cursor = label ? 'pointer' : '';
    }
    // 悬停小卡片:拖动、改地形、回放、新建时不显示;手指没有"悬停"(点了直接出面板)
    if (!data || (drag.current && moved.current) || getTerrainTool().on || replayOn || draft || e.pointerType === 'touch') return setHover(null);
    const p = pixelAt(e.clientX, e.clientY);
    if (!p) return setHover(null);
    showHover(p, label, e.clientX, e.clientY);
  };
  const probeRef = useRef<(cx: number, cy: number) => string[] | null>(() => null);
  probeRef.current = (cx, cy) => {
    const p = pixelAt(cx, cy);
    return p && data ? probeLines(data.world, data.raster, civ, p[0], p[1]) : null;
  };
  const showHover = (p: [number, number], label: ReturnType<typeof pickLabelAt>, x: number, y: number) => {
    if (!data) return;
    const info = hoverInfo({ world: data.world, raster: data.raster, civ, px: p[0], py: p[1], layer: mapLayer, label, year: getCivTime().year });
    setHover(info ? { info, x, y } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (getGlobeOn()) return;
    if (pinch.current) {
      // 还有两根手指按着(第三根松开了):接着捏合;否则结束捏合,剩下的一根接着拖
      if (touches.current.size >= 2) startPinch();
      else endPinch();
      return;
    }
    // 捏合以后剩下的那根手指:别的手指松开时不结束它的拖动
    if (e.pointerType === 'touch' && drag.current?.touch && touches.current.size > 0) return;
    terrainUp();
    terrainStroke.current = false;
    drag.current = null;
    setMapMoving(false);
  };
  /** 双击:缩放复位(中央经线不变 —— 它是这个世界的设置,拖远了、放大了双击回到整张图) */
  const resetView = () => {
    const el = stageRef.current;
    if (!el || !box.w) return setView({ k: 1, x: 0, y: 0 });
    const b = { sw: el.clientWidth, sh: el.clientHeight, bw: box.w, bh: box.h };
    const base = { k: 1, x: 0, y: 0 };
    setView(curved || !wrapW ? clampCurved(base, b) : viewCentredAt(base, b, wrapW, xOfLon(getMapCenter(), wrapW)));
  };
  // 改地形只在等距圆柱主图上改:地球仪、弯边投影里打开改地形就先切回等距圆柱(中心不变,地球仪的接上它正对着的经度);
  // 改地形时换成别的投影 = 收起改地形
  useEffect(() => {
    if (terrainTool.on && getProjection() !== 'equirect') setProjection('equirect');
  }, [terrainTool.on]);
  useEffect(() => {
    if (projection !== 'equirect' && getTerrainTool().on) setTerrainTool({ on: false });
  }, [projection]);

  // ---- 点选(阶段 4):单击(不是拖动)选中 城镇符号 / 城名 → 城,国名 → 国家,地名 → 地理实体;
  // 都没点到:"国家"开着时点到国土 → 国家,否则 → 州;点到海上 / 地图外 = 取消。双击(复位视图)不改选中 ----
  /** 双击的第一下之前选中的是什么(第二下时恢复) */
  const beforeClick = useRef<MapSelection | null>(null);
  const onStageClick = (e: React.MouseEvent) => {
    // 只管点在地图(或地图外的空白)上的:时间轴、按钮、图例上的点击冒泡上来不算
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.closest('.canvas-wrap, .globe')) return;
    if ((getGlobeOn() ? globeApi.current?.dragged() : moved.current) || replayOn) return;
    // 改地形:单击放火山 / 挖湖,不看详情(双击的第二下不再放)
    if (getTerrainTool().on) {
      if (e.detail < 2) terrainClick(worldAt(e.clientX, e.clientY));
      return;
    }
    // 新建时还没有历史,点了不看详情
    if (draft) return;
    // 双击的第二下(手指点两下时浏览器不一定数成 detail = 2):恢复第一下之前的选中
    if (e.detail >= 2 || performance.now() - dblTapAt.current < 600) {
      setSelection(beforeClick.current);
      return;
    }
    // 干预选对象国 / 迁都选城(阶段 4):点到的国家 / 城交给干预区,不改选中
    const pk = getPolityPick();
    if (pk) {
      const city = pk.target === 'settlement';
      const id = city ? settlementAtClick(e.clientX, e.clientY) : polityAtClick(e.clientX, e.clientY);
      const err = id >= 0 ? pk.accept(id) : city ? '这里没有城,点一座城的符号或城名' : '这里没有国家,点一个国家的国土或国名';
      setPolityPick(err ? { ...pk, msg: err } : null);
      return;
    }
    beforeClick.current = getSelection().sel;
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    const side = rect && e.clientX - rect.left > rect.width * 0.55 ? 'left' : 'right';
    const hit = labelAt(e.clientX, e.clientY);
    if (hit) return setSelection(hit, side);
    const c = cellAt(e.clientX, e.clientY);
    const r = civ && c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (!civ || r < 0) return clearSelection();
    if (getCivShow().polities && civ.polities.length) {
      const y = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
      const po = ownersAt(civ, y).polity[r];
      if (po >= 0) return setSelection({ kind: 'polity', id: po }, side);
    }
    setSelection({ kind: 'region', id: r }, side);
  };
  /** 点到的城镇符号 / 城名 / 国名 / 地名(主图:文字层;地球仪:球上的符号文字层) */
  const labelAt = (x: number, y: number) => (getGlobeOn() ? (globeApi.current?.labelAt(x, y) ?? null) : pickLabelAt(x, y));
  /** 单击处的国家(时间轴当前那一年;点到国名也算;没有 = −1) */
  const polityAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'polity') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    return ownersAt(civ, yr).polity[r];
  };

  // 打开改地形:单击不再看详情,已经打开的详情面板、"在地图上点一个国家"一起收起
  useEffect(() => {
    if (!terrainTool.on) return;
    clearSelection();
    setPolityPick(null);
  }, [terrainTool.on]);

  /** 单击处的城(点到城镇符号 / 城名;否则点到的州里时间轴当前那一年还在的城;没有 = −1) */
  const settlementAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'settlement') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    const s = civ.settlements.find((q) => q.region === r && q.founded <= yr && (q.ended === undefined || q.ended > yr));
    return s ? s.id : -1;
  };
  // 手机:浏览器自己的页面缩放不抢双指捏合(Safari 的 gesture 事件;别的浏览器靠 touch-action,见 app.css)
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', stop);
      document.removeEventListener('gesturechange', stop);
    };
  }, []);
  // Esc:先取消"在地图上点一个国家 / 城",再取消选中(在输入框里打字时不管)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (getPolityPick()) return setPolityPick(null);
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 平面主图 ⇄ 地球仪:两边的中心经度接上(地球仪从主图当前的中心转起;切回主图时转到地球仪正对着的经度) */
  const toggleGlobe = () => {
    setHover(null);
    if (!getGlobeOn()) return setGlobeOn(true);
    // 切回上一个平面投影(中心接上地球仪正对着的经度,见上面换投影那一段)
    setGlobeOn(false);
  };
  // 地球仪:回放帧、地形画布什么时候重画过(换世界 / 画风 / 图层)
  const globeReplay = useMemo(
    () => (replayOn && replay ? { w: replay.w, h: replay.h, frame: replay.frames[replay.idx] } : null),
    [replayOn, replay],
  );
  const terrainKey = useMemo(() => ({ data, style, layer }), [data, style, layer]);
  const onGlobeHover = (p: [number, number] | null) => {
    if (!p || !data || replayOn) return setHover(null);
    const [x, y] = mouseAt.current;
    showHover(p, globeApi.current?.labelAt(x, y) ?? null, x, y);
  };
  // ---- 顶部提示条:生成进度、重推历史、选目标、改地形的结果(同一时间只显示最近的一条) ----
  // 生成世界(首次打开、换种子、调参数、读档)/ 按新地形重新生成:一行"正在…",小字是种子和这一步在做什么
  useEffect(() => {
    if (progress)
      showToast({
        id: 'progress',
        kind: 'progress',
        text: progress.regen ? '正在按新地形重新生成' : '正在生成世界',
        more: [progress.seed !== undefined && !progress.regen ? `种子 ${progress.seed}，${progress.stage}` : progress.stage],
        progress: progress.pct,
      });
    else clearToast('progress');
  }, [progress]);
  // 回放世界形成:后台算各个年代的地形那一两秒(算好以后是地图上的字幕)
  const replayWait = replayOn && !replay;
  useEffect(() => {
    if (replayWait) showToast({ id: 'replay', kind: 'progress', text: '正在准备回放' });
    else clearToast('replay');
  }, [replayWait]);
  // 重推历史的进度、选目标的提示在 TargetPlates.tsx(和名牌、压暗一起)
  const terrainLast = terrainStatus.last;
  useEffect(() => {
    if (!terrainLast) return;
    // 对不上的改名先留着(撤销地形修改就会回来),没生效的干预概览里写了原因
    const lost = [
      terrainLast.lostNames ? `${terrainLast.lostNames} 处改名` : '',
      terrainLast.lostInterventions ? `${terrainLast.lostInterventions} 条干预` : '',
    ].filter(Boolean);
    const more = lost.length ? [`${lost.join('、')}暂未生效`] : undefined;
    const n = regenNote.current;
    regenNote.current = null;
    if (n) {
      showToast({
        id: 'terrain',
        kind: lost.length ? 'warn' : 'ok',
        text: n.kind === 'apply' ? '已按你说的改写 · 按新地形重新生成' : '已撤销改写 · 按原来的地形重新生成',
        more,
        action:
          n.kind === 'apply'
            ? {
                label: '撤销',
                act: 'rw-undo',
                onClick: () => {
                  undoTurn(n.turn);
                  clearToast('terrain');
                },
              }
            : undefined,
      });
      return;
    }
    showToast({ id: 'terrain', kind: lost.length ? 'warn' : 'ok', text: '已按新地形重新生成', more });
  }, [terrainLast]);

  // 推演出来没有文明(宜居的陆地太少):建好的世界说一句(新建时卡片上写,可以换一颗)
  const noCiv = !!rawCiv && !rawCiv.viable;
  const noCivToast = noCiv && stage === 'world';
  useEffect(() => {
    if (!noCivToast) return clearToast('world');
    showToast({ id: 'world', kind: 'warn', text: '这个世界没有文明', more: ['宜居的陆地太少'] });
  }, [noCivToast]);

  const civReady = !!civ && civ.viable;
  /** 正在重推 / 按新地形重新生成 / 生成新世界:改写框里这时发不了话、提议也不能执行 */
  const rewriteBusy = !!resim || terrainStatus.busy || !!progress;
  // 详情面板只挂一份:挂进一个自己建的容器,窄屏把容器放在底部卡片的位置,宽屏放进侧栏(放哪儿由那边的空位 ref 决定)。
  // 窗口跨过窄屏断点(比如手机横过来)时面板不重新挂,正在干预的那几步、填了一半的年份和名字都留着
  const inspectorHost = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'inspector-host';
    return el;
  }, []);
  const inspectorSlot = useCallback(
    (slot: HTMLElement | null) => {
      if (slot && inspectorHost.parentNode !== slot) slot.appendChild(inspectorHost);
    },
    [inspectorHost],
  );
  /** 建好的世界(不是新建中、不在我的世界):时间轴、详情、概览、事件标签这些才有 */
  const world = stage === 'world';
  const layerProps = { layer: mapLayer, civ, onLayer: applyLayer, thumbs, requestThumbs, disabled: !data };
  const newWorldProps = {
    params,
    title: draftTitle,
    base: stageBase,
    back: draftBack,
    onSeed: draftSeed,
    onRandomSeed: () => draftSeed(randomSeedValue()),
    onParams: draftParams,
    onTitle: draftRename,
    onCreate: createWorld,
    // 以它为底稿新建、调过参数:带过来的干预要等重推完(不然创建时截的缩略图、放的历史是没干预的)
    busy: !!progress || !!resim,
    ready: !!data && !progress,
    replay: { on: replayOn, ready: !!replay },
    onReplay: startReplay,
    noCiv,
    data,
    civ,
    rewriteBusy,
  };
  // 两层放大的地图框共用一个变换、按视窗裁;两层屏幕层按同一个视窗裁(见下面的 JSX)
  const wrapStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, clipPath: wrapClip(view, sb, wrapW), display: globeOn ? 'none' : undefined };
  const screenStyle: CSSProperties = { clipPath: screenClip(view, sb, wrapW), display: globeOn ? 'none' : undefined };
  return (
    <div
      className={`app${narrow ? ' phone' : ' has-side'}${chron.open ? ' chron-open' : ''}${panelOpen ? ' panel-open' : ''}${narrow && panelOpen && panelUi.sheet === 'full' ? ' sheet-full' : ''}${narrow && !selState.sel && panelUi.world === 'full' ? ' world-full' : ''}${narrow && panelUi.drag ? ' sheet-drag' : ''}${narrow && selState.sel && !panelOpen ? ' sheet-away' : ''}${picking ? ' picking' : ''}${globeOn ? ' globe-on' : ''}${data ? '' : ' booting'}${home ? ' home' : ''}${draft ? ' draft' : ''}`}
      data-theme={theme}
      data-layer={mapLayer}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 地图铺满全屏(地形画布是页面上第一张 canvas:画面回归检查、截图脚本按它取图) */}
      <main
        ref={stageRef}
        className={`stage${terrainTool.on ? ' terrain-on' : ''}`}
        onPointerDown={onPointerDown}
        onPointerDownCapture={onTouchDownCapture}
        onPointerMove={onPointerMove}
        onPointerMoveCapture={(e) => {
          mouseAt.current = [e.clientX, e.clientY];
          onTouchMoveCapture(e);
        }}
        onPointerUp={onPointerUp}
        onPointerUpCapture={onTouchUpCapture}
        onPointerCancel={onPointerUp}
        onPointerCancelCapture={onTouchUpCapture}
        onClick={onStageClick}
        onPointerLeave={() => {
          setHover(null);
          terrainMove(null);
        }}
        onDoubleClick={resetView}
      >
        {/* 地图分四层叠(见 mapWrap.ts 的"屏幕层"):和世界一样大的画布放在被 CSS 放大的地图框里,
            按屏幕像素画的(细节层、视窗装饰、文字层)放在不缩放的屏幕层里 */}
        <div className="canvas-wrap" style={wrapStyle}>
          <div className="map-box" data-wrap={curved ? undefined : '1'} data-proj={projection} style={{ width: box.w, height: box.h }}>
            <canvas ref={canvasRef} />
            {/* 右边接的那一份(左右无限拖动,见 mapWrap.ts;弯边投影时不用) */}
            <canvas ref={canvasCopyRef} className="wrap-copy" />
          </div>
        </div>
        <div className="screen-layer" style={screenStyle}>
          {/* 放大后的地形细节(弯边投影:按投影一行一行铺) */}
          {data && <TerrainDetail world={data.world} raster={data.raster} style={style} view={view} mp={mp} />}
          {data && <MapDecor world={data.world} style={style} view={view} mp={mp} />}
        </div>
        <div className="canvas-wrap-upper" style={wrapStyle}>
          <div className="map-box-upper" style={{ width: box.w, height: box.h }}>
            {data && <CivLayer world={data.world} raster={data.raster} civ={civ} geo={rawCiv} style={style} view={view} mp={mp} labelsHost={labelsHost} />}
            <canvas ref={overlayRef} className={`overlay ${replayOn && replay ? 'show' : ''}`} />
            <canvas ref={overlayCopyRef} className={`overlay wrap-copy ${replayOn && replay ? 'show' : ''}`} />
            {data && !curved && <TerrainOverlay width={data.world.width} height={data.world.height} shown={shownTerrain} wrap={wrapW} />}
          </div>
        </div>
        {/* 文字层(CivLayer 放进来);回放世界形成时藏起来(回放画面盖住文明层,字也不露出来) */}
        <div className="screen-layer" ref={setLabelsHost} style={replayOn && replay ? { ...screenStyle, display: 'none' } : screenStyle} />
        {/* 地图上钉在事发地的事件标签 */}
        {data && world && <EventPins civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} hidden={replayOn} />}
        {data && globeOn && (
          <Globe
            world={data.world}
            raster={data.raster}
            civ={civ}
            geo={rawCiv}
            style={style}
            layer={layer}
            terrain={canvasRef.current}
            terrainKey={terrainKey}
            replay={globeReplay}
            startLon={getMapCenter()}
            apiRef={globeApi}
            onHover={onGlobeHover}
            leftRoom={sideRoom(stageSize.w)}
          />
        )}
      </main>
      {/* 选干预目标 / 推演中:压暗地图、浮出名牌;选中国家:国都的圆环(TargetPlates.tsx) */}
      {data && world && <TargetLayer civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} resim={resim} generating={!!progress} labelAt={labelAt} />}

      {replayOn && replay && !home && (
        <div className="caption">
          <div className="big">{replay.idx === replay.frames.length - 1 ? '今天' : `约 ${replay.mya[replay.idx]} 百万年前`}</div>
          <div className="small">板块碰撞抬起山脉,河流一点点把它切开</div>
          <div className="track">
            <div style={{ width: `${((replay.idx + 1) / replay.frames.length) * 100}%` }} />
          </div>
        </div>
      )}

      {home ? (
        /* 我的世界:盖住整个页面(地图留在底下,回到刚才的世界不用重新生成) */
        <MyWorlds phone={narrow} onOpen={openStored} onNew={startDraft} onOpenText={openText} />
      ) : narrow ? (
        <>
          {/* 手机:底部的世界卡片(没选东西时;选中了东西换成详情卡片)、右上竖排的毛玻璃按钮(图层、地球);数据图层的图例在左上。
              界面都在卡片和毛玻璃按钮上,地图上不再压字、不用渐变遮罩;最近大事在世界卡片拉到顶时的列表里。
              新建时底部是新建世界的卡片 */}
          {draft ? (
            <NewWorld phone {...newWorldProps} />
          ) : (
            !selState.sel && (
              <PhoneSheet
                data={data}
                civ={civ}
                raw={rawCiv}
                params={params}
                generating={!!progress}
                replay={{ on: replayOn, ready: !!replay }}
                onReplay={startReplay}
                onHome={goHome}
                rewriteBusy={rewriteBusy}
                exp={{ data, civ, style, layer }}
              />
            )
          )}
          <PhoneButtons layers={{ ...layerProps, draft }} globeOn={globeOn} onToggleGlobe={toggleGlobe} />
          {style === 'data' && !terrainTool.on && (
            <div className="corner-tl">
              <Legend layer={layer} />
            </div>
          )}
        </>
      ) : (
        <>
          {/* 宽屏:左边侧栏(世界 / 选中的东西的详情、搜索、存档;新建时是新建世界的卡片);右上图层、导出、编年史;数据图层的图例在地图左上 */}
          {draft ? (
            <NewWorld phone={false} {...newWorldProps} />
          ) : (
            <Sidebar
              data={data}
              civ={civ}
              raw={rawCiv}
              params={params}
              generating={!!progress}
              replay={{ on: replayOn, ready: !!replay }}
              onReplay={startReplay}
              onHome={goHome}
              rewriteBusy={rewriteBusy}
              inspectorSlot={inspectorSlot}
            />
          )}
          <MapBar civ={civ} layers={layerProps} exp={{ data, civ, style, layer }} draft={draft} />
          {style === 'data' && !terrainTool.on && (
            <div className="corner-tl">
              <Legend layer={layer} />
            </div>
          )}
          {draft && !stageBase && draftTip && data && !progress && !replayOn && !terrainTool.on && <div className="draft-tip">拖动地图看看这颗星球；不满意就点「换一颗」</div>}
        </>
      )}
      {/* 顶部居中:提示条(同一时间只有一条) */}
      <ToastBar />
      {/* 右下(时间轴上方):地球 / 平面、放大、缩小。触屏不放 + −(用双指捏合);窄屏整个不放(地球在右上竖排的按钮里) */}
      <MapControls globeOn={globeOn} onToggleGlobe={toggleGlobe} onZoom={zoomButton} shifted={false} hidden={!data || narrow || home} zoom={!coarse} />
      <FirstHint show={hintOn && !!data && world && !terrainTool.on} touch={coarse} />
      {/* 底部:时间轴(宽屏是卡片右边那一块底下的胶囊;手机是浮在底部卡片上面的胶囊);新建时还没有历史,不放 */}
      <div className="bottom-row">
        <div className="bottom-tl">{data && world && <CivTimeline civ={civ} hidden={replayOn} dock="inline" />}</div>
      </div>
      {/* 详情面板:窄屏是从屏幕底升起的卡片(在这儿的空位里),宽屏在侧栏里(见上面的 inspectorHost) */}
      {data && world && createPortal(<Inspector civ={civ} raw={rawCiv} raster={data.raster} world={data.world} />, inspectorHost)}
      {narrow && world && <div className="inspector-slot" ref={inspectorSlot} />}
      {hover && world && <HoverCard info={hover.info} x={hover.x} y={hover.y} />}
      {/* 世界概览(点左上角的世界名打开):国家 / 编年史 / 我的干预 / 世界设定 */}
      {world && (
        <WorldOverview
          params={params}
          data={data}
          civ={civ}
          style={style}
          dataLayer={layer}
          generating={!!progress}
          resimBusy={!!resim}
          replay={{ on: replayOn, ready: !!replay }}
          onReplay={startReplay}
          onDraftFrom={draftFromCurrent}
        />
      )}
      {civ && <HistoryBook civ={civ} />}
      <AiSettingsHost />
      {dropping && (
        <div className="drop-hint">
          <div>松手打开存档(.json)</div>
        </div>
      )}
    </div>
  );
}

/** 按下到松开移动不超过这么多(屏幕像素,横 + 竖)算单击 */
const CLICK_SLOP = 5;
/** 手指按下时总会抖一点:移动不超过这么多还算"点一下" */
const TOUCH_SLOP = 10;

/**
 * 只露出视窗(外框 ∩ 舞台)里的那一段 —— 主图和右边接的那一份在视窗外的部分裁掉,同一个地方不会出现两次。
 * clip-path 在地图层自己的坐标里(缩放、平移之前)。还没有世界时不裁
 */
function wrapClip(v: { k: number; x: number; y: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  const l = (wl - v.x) / v.k;
  const r = b.sw - (wr - v.x) / v.k;
  return `inset(-100000px ${r}px -100000px ${l}px)`;
}

/** 屏幕层(不缩放,铺满舞台)按同一个视窗裁:舞台坐标 */
function screenClip(v: { k: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  return `inset(0px ${b.sw - wr}px 0px ${wl}px)`;
}

/**
 * 世界概览的"创世"页:这个世界是怎么来的、怎么换一个 ——
 *   左栏:新世界(随机种子)、种子输入 + 生成、地块 / 板块 / 河流 / 最高峰统计、回放世界形成、改地形(进入后概览收起,顶部出现工具条)
 *   右栏:世界参数滑条(陆地比例、板块数量、造山强度、气温、降水、精细度)、恢复默认
 * 换种子 / 改参数 = 重新生成(改过的名字、干预、地形都属于旧世界,一起作废;旧世界改过的会自动存在"我的世界"里)。
 * 换种子、新世界时概览收起(看新世界长出来);调参数时不收(常常连着调几项)。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../gen/world';
import { setTerrainTool } from './TerrainTools';
import { useEdits } from './editsStore';
import { closeOverview } from './overviewStore';

interface Slider {
  key: keyof WorldParams;
  name: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  hint: string;
}

export const SLIDERS: Slider[] = [
  { key: 'landFraction', name: '陆地比例', min: 0.12, max: 0.6, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, hint: '陆地占整个星球的比例' },
  { key: 'plates', name: '板块数量', min: 8, max: 60, step: 1, fmt: (v) => `${v}`, hint: '板块越多,陆地越破碎、岛屿和山脉越多(板块有大有小)' },
  { key: 'mountains', name: '造山强度', min: 0.2, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, hint: '板块碰撞隆起的力度' },
  { key: 'temperature', name: '气温', min: -12, max: 12, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v}°C`, hint: '整体偏冷(冰河期)还是偏暖' },
  { key: 'rainfall', name: '降水', min: 0.4, max: 1.8, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, hint: '整体偏干还是偏湿' },
  { key: 'cells', name: '精细度', min: 12000, max: 80000, step: 2000, fmt: (v) => `${Math.round(v / 1000)}k 地块`, hint: '越精细越慢' },
];

export interface GenesisProps {
  params: WorldParams;
  world: World | null;
  /** 用这组参数重新生成 */
  onCommit: (p: WorldParams) => void;
  /** 随机一个种子,生成新世界 */
  onRandomSeed: () => void;
  /** 世界还在生成 */
  generating: boolean;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 改地形进不去(新世界还在生成、正在回放) */
  terrainDisabled: boolean;
}

export function GenesisPage(p: GenesisProps) {
  const { params, world } = p;
  const edits = useEdits();
  const [seedText, setSeedText] = useState(String(params.seed));
  useEffect(() => setSeedText(String(params.seed)), [params.seed]);
  /** 换种子 / 新世界:收起概览,看新世界长出来(调参数不收:常常连着调几项) */
  const goSeed = () => {
    closeOverview();
    p.onCommit({ ...params, seed: Number(seedText) || 1 });
  };
  const isDefault = SLIDERS.every((s) => params[s.key] === DEFAULT_PARAMS[s.key]);
  const nTerrain = edits.terrain.length;
  return (
    <div className="ov-genesis">
      <section className="ov-sec">
        <h3>种子</h3>
        <div className="ov-seed">
          <input
            aria-label="种子"
            value={seedText}
            inputMode="numeric"
            onChange={(e) => setSeedText(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && goSeed()}
          />
          <button className="ov-btn" data-act="seed-go" disabled={!seedText} onClick={goSeed}>
            生成
          </button>
          <button
            className="ov-btn ov-primary"
            data-act="new-world"
            onClick={() => {
              closeOverview();
              p.onRandomSeed();
            }}
          >
            新世界
          </button>
        </div>
        <div className="ov-note">同一种子 + 参数永远得到同一个世界</div>
        {world && (
          <div className="ov-facts">
            <div>
              <b>{world.mesh.n.toLocaleString()}</b>
              <span>地块</span>
            </div>
            <div>
              <b>{world.tect.plateCount}</b>
              <span>板块</span>
            </div>
            <div>
              <b>{world.rivers.length}</b>
              <span>河流</span>
            </div>
            <div>
              <b>{Math.round(world.maxElevation).toLocaleString()}</b>
              <span>最高峰 米</span>
            </div>
          </div>
        )}
        <h3>地形</h3>
        <div className="ov-acts-row">
          <button
            className="ov-btn replay"
            data-act="replay"
            disabled={!world || p.generating || p.replay.on}
            onClick={() => {
              closeOverview();
              p.onReplay();
            }}
          >
            {p.replay.on ? (p.replay.ready ? '正在回放' : '正在准备回放') : '回放世界形成'}
          </button>
          <button
            className="ov-btn terrain-toggle"
            data-act="terrain"
            disabled={p.terrainDisabled}
            onClick={() => {
              closeOverview();
              setTerrainTool({ on: true });
            }}
            title="放火山、画山脉、挖湖……改完整个世界按新地形重新长一遍"
          >
            改地形{nTerrain ? `(已改 ${nTerrain} 处)` : ''}
          </button>
        </div>
      </section>
      <section className="ov-sec">
        <h3>世界参数</h3>
        {SLIDERS.map((s) => (
          <ParamSlider key={s.key} s={s} value={params[s.key]} onCommit={(v) => p.onCommit({ ...params, [s.key]: v })} />
        ))}
        <button className="ov-btn" data-act="params-reset" disabled={isDefault} onClick={() => p.onCommit({ ...DEFAULT_PARAMS, seed: params.seed })}>
          恢复默认
        </button>
      </section>
    </div>
  );
}

function ParamSlider({ s, value, onCommit }: { s: Slider; value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="ov-slider" title={s.hint} data-param={s.key}>
      <span className="ov-slider-row">
        <span>{s.name}</span>
        <b>{s.fmt(v)}</b>
      </span>
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={s.step}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== value && onCommit(v)}
        onKeyUp={() => v !== value && onCommit(v)}
      />
    </label>
  );
}

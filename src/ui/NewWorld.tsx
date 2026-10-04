/**
 * 新建世界(宽屏是左边的卡片,手机是底部的卡片):先定下这颗星球的样子,再点"创建世界"推演它的历史。
 * 这时地图只看地形(没有国家、时间轴),种子、六项世界参数、改地形都还能改;创建以后这三样锁住(世界设定页只能看)。
 *
 *   星球     种子 +"换一颗";世界参数(点开是六个滑条,松手就重新生成);回放这颗星球的形成
 *            长不出文明的星球下面一行提示(照样能创建)
 *   改地形   可选;点开是工具面板(TerrainTools.tsx 的 TerrainPanel)
 *   名字     给这个世界起个名字(不填 = 未命名世界)
 *   底部     创建世界(正在生成时点不了)
 * 以某个世界为底稿新建(世界设定页的"以它为底稿新建…"):种子锁住;多一组"跟过去的修改"(改过的名字、干预几处);
 * 名字先填好"原名(二)";左上返回原来那个世界。
 * 右上"···":用一句话改地形(AI)、AI 设置、源代码、两份协议、版本号。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { World, WorldParams } from '../gen/world';
import { DEFAULT_PARAMS } from '../gen/world';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import { TITLE_MAX } from '../gen/savefile';
import type { DraftBase } from './stageStore';
import { useEdits } from './editsStore';
import { TerrainPanel, setTerrainTool, useTerrainTool } from './TerrainTools';
import { ParamSlider, SLIDERS, paramsSide } from './WorldOverviewGenesis';
import { RewriteBox } from './Rewrite';
import { openAiSettings } from './AiSettings';
import { AiMenuItem, MenuItem, MenuSep, PopMenu } from './PopMenu';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import { Icon } from './icons';
import './worlds.css';

export interface NewWorldProps {
  phone: boolean;
  params: WorldParams;
  /** 名字(打开没建完的世界时是它存的名字;以别的世界为底稿时先填好"原名(二)") */
  title: string;
  base: DraftBase | null;
  /** 左上返回(我的世界 / 底稿那个世界);null = 不显示(第一次来,还没有别的世界) */
  back: { label: string; onClick: () => void } | null;
  onSeed: (seed: number) => void;
  onRandomSeed: () => void;
  onParams: (p: WorldParams) => void;
  onTitle: (title: string) => void;
  onCreate: (title: string) => void;
  /** 正在生成(换了种子、调了参数、改了地形):创建不了 */
  busy: boolean;
  /** 世界还没出来:回放、改地形点不了 */
  ready: boolean;
  replay: { on: boolean; ready: boolean };
  onReplay: () => void;
  /** 这颗星球长不出文明 */
  noCiv: boolean;
  /** 用一句话改地形要的东西 */
  data: { world: World; raster: Raster } | null;
  civ: Civ | null;
  rewriteBusy: boolean;
}

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export function NewWorld(p: NewWorldProps) {
  const edits = useEdits();
  const tool = useTerrainTool();
  const [paramsOpen, setParamsOpen] = useState(false);
  const [name, setName] = useState(p.title);
  useEffect(() => setName(p.title), [p.title]);
  const [seedText, setSeedText] = useState(String(p.params.seed));
  useEffect(() => setSeedText(String(p.params.seed)), [p.params.seed]);
  const [rewriting, setRewriting] = useState(false);
  const closeRewrite = useCallback(() => setRewriting(false), []);
  const more = useRef<HTMLDivElement>(null);
  // 手机:点拖动条收起 / 展开(回放世界形成时自动收起,让出地图)
  const [collapsed, setCollapsed] = useState(false);
  const down = collapsed || (p.phone && p.replay.on);

  const nTerrain = edits.terrain.length;
  const base = p.base;
  /** 以别的世界为底稿:有改名或干预要跟过来才列"跟过去的修改" */
  const carried = !!base && base.names + base.interventions > 0;
  const commitSeed = () => {
    const n = Math.floor(Number(seedText));
    if (n > 0 && n !== p.params.seed) p.onSeed(n);
    else setSeedText(String(p.params.seed));
  };
  const commitName = () => {
    if (name !== p.title) p.onTitle(name);
  };
  const isDefault = SLIDERS.every((s) => p.params[s.key] === DEFAULT_PARAMS[s.key]);
  const canRewrite = !!p.civ && !!p.data;

  const seedRow = base ? (
    <div className="sb-row nw-seed locked" data-act="seed-locked">
      <span className="sb-row-main">
        <b>种子</b>
        <small>换种子就是另一颗星球，请直接新建</small>
      </span>
      <span className="sb-row-side">{p.params.seed}</span>
      <Icon name="lock" size={15} className="nw-lock" />
    </div>
  ) : (
    <div className="sb-row nw-seed">
      <span className="sb-row-main">
        <b>种子</b>
      </span>
      <span className="nw-seed-ctl">
        <input
          className="nw-field nw-seed-input"
          aria-label="种子"
          value={seedText}
          inputMode="numeric"
          onChange={(e) => setSeedText(e.target.value.replace(/\D/g, '').slice(0, 9))}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          onBlur={commitSeed}
        />
        <button className="nw-btn tint" data-act="new-seed" onClick={p.onRandomSeed} title="随机换一个种子">
          <Icon name="dice" size={16} />
          换一颗
        </button>
      </span>
    </div>
  );
  const paramsRow = (
    <>
      <button className={`sb-row nw-params${paramsOpen ? ' open' : ''}`} data-act="params" aria-expanded={paramsOpen} onClick={() => setParamsOpen((o) => !o)}>
        <Icon name="sliders" size={p.phone ? 18 : 17} className="sb-ico" />
        <span className="sb-row-main">
          <b>世界参数</b>
        </span>
        {paramsOpen ? (
          !isDefault && (
            <span
              className="sb-link"
              role="button"
              data-act="params-reset"
              onClick={(e) => {
                e.stopPropagation();
                p.onParams({ ...DEFAULT_PARAMS, seed: p.params.seed });
              }}
            >
              恢复默认
            </span>
          )
        ) : (
          <span className="sb-row-side">{paramsSide(p.params)}</span>
        )}
        <Icon name={paramsOpen ? 'down' : 'chevron'} size={14} className="sb-chev" />
      </button>
      {paramsOpen && (
        <div className="nw-sliders">
          {SLIDERS.map((s) => (
            <ParamSlider key={s.key} s={s} value={p.params[s.key]} onCommit={(v) => p.onParams({ ...p.params, [s.key]: v })} />
          ))}
        </div>
      )}
    </>
  );
  const replayRow = (
    <button className="sb-row" data-act="replay" disabled={!p.ready || p.busy || p.replay.on} onClick={p.onReplay}>
      <Icon name="replay" size={p.phone ? 18 : 17} className="sb-ico" />
      <span className="sb-row-main">
        <b>{p.replay.on ? (p.replay.ready ? '正在回放' : '正在准备回放') : '回放这颗星球的形成'}</b>
      </span>
      <Icon name="chevron" size={14} className="sb-chev" />
    </button>
  );
  const terrainRow = (label: string, side: string) => (
    <button
      className="sb-row terrain-toggle"
      data-act="terrain"
      disabled={!p.ready || p.replay.on}
      onClick={() => setTerrainTool({ on: true })}
      title="放火山、画山脉、挖湖……"
    >
      <Icon name="terrain" size={p.phone ? 18 : 17} className="sb-ico" />
      <span className="sb-row-main">
        <b>{label}</b>
      </span>
      <span className="sb-row-side">{side}</span>
      <Icon name="chevron" size={14} className="sb-chev" />
    </button>
  );
  const terrainSide = nTerrain ? `改过 ${nTerrain} 处` : '还没改';
  const noCivHint = p.noCiv && <div className="nw-note warn">这颗星球长不出文明，换一颗或调大陆地比例</div>;
  const nameField = (
    <input
      className="nw-field nw-name"
      data-act="world-name"
      value={name}
      maxLength={TITLE_MAX}
      placeholder="给这个世界起个名字"
      spellCheck={false}
      aria-label="世界名"
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      onBlur={commitName}
    />
  );
  const createBtn = (
    <button className="nw-create" data-act="create-world" disabled={p.busy || !p.ready || p.replay.on} onClick={() => p.onCreate(name)}>
      {base ? '创建新世界' : '创建世界'}
    </button>
  );
  const baseRows = base && (
    <>
      <div className="sb-row static" data-act="base-names">
        <Icon name="rename" size={p.phone ? 18 : 17} className="sb-ico" />
        <span className="sb-row-main">
          <b>改过的名字</b>
        </span>
        <span className="sb-row-side">{base.names} 处</span>
      </div>
      <div className="sb-row static" data-act="base-interventions">
        <Icon name="intervene" size={p.phone ? 18 : 17} className="sb-ico" />
        <span className="sb-row-main">
          <b>干预历史</b>
        </span>
        <span className="sb-row-side">{base.interventions} 条</span>
      </div>
      <div className="nw-group-hint">地形改了以后，有的地方会变成海、历史也会不同；对不上的改名和干预先留着不生效，创建后会列出来。</div>
    </>
  );
  const moreMenu = (
    <div className="nw-more-wrap" ref={more}>
      <PopMenu className="sb-pill sb-more" icon={<Icon name="more" size={17} />} title="更多" act="world-more" align="right">
        <AiMenuItem icon={<Icon name="terrain" size={16} />} act="rewrite" disabled={!canRewrite} onClick={() => setRewriting(true)} note="AI">
          用一句话改地形
        </AiMenuItem>
        <MenuItem icon={<Icon name="sparkle" size={16} />} act="ai-settings" onClick={() => openAiSettings()}>
          AI 设置
        </MenuItem>
        <MenuSep />
        <MenuItem icon={<Icon name="info" size={16} />} href={SOURCE_URL} act="source">
          源代码
        </MenuItem>
        <MenuItem href={PRIVACY_URL} act="privacy">
          隐私政策
        </MenuItem>
        <MenuItem href={TERMS_URL} act="terms">
          用户协议
        </MenuItem>
        <div className="pm-foot" data-version>
          版本 {APP_VERSION}
        </div>
      </PopMenu>
    </div>
  );
  const heading = base ? `以${base.title}为底稿新建` : '新建世界';
  const backLink = p.back && (
    <button className="nw-back" data-act="back" onClick={p.back.onClick}>
      <Icon name="back" size={18} />
      {p.back.label}
    </button>
  );
  const rewrite = rewriting && canRewrite && (
    <div className={p.phone ? 'ps-rewrite' : 'sb-rewrite'}>
      <RewriteBox civ={p.civ!} world={p.data!.world} busy={p.rewriteBusy} onClose={closeRewrite} anchor={more} lock="history" />
    </div>
  );

  if (p.phone)
    return (
      <>
        <section
          className={`psheet nw-sheet${down ? ' down' : ''}${tool.on ? ' tools' : ''}`}
          aria-label="新建世界"
          onPointerDown={stop}
          onClick={stop}
          onDoubleClick={stop}
          onWheel={stop}
        >
          <button className="sheet-grip" data-act="new-sheet" aria-label={down ? '展开' : '收起'} aria-expanded={!down} onClick={() => setCollapsed((c) => !c)}>
            <i aria-hidden="true" />
          </button>
          <div className="nw-in">
            {backLink}
            <div className="nw-title-row">
              <div className="nw-title">{heading}</div>
              {moreMenu}
            </div>
            {!down &&
              (tool.on ? (
                <TerrainPanel disabled={p.busy} />
              ) : (
                <>
                  <div className="sb-group">
                    {seedRow}
                    {paramsRow}
                    {terrainRow('改地形', `可选，${terrainSide}`)}
                    {replayRow}
                  </div>
                  {noCivHint}
                  {carried && <div className="sb-group">{baseRows}</div>}
                  {nameField}
                  <div className="nw-bottom">
                    {createBtn}
                    <p>创建后，种子、参数和地形就定下来了；世界名、国名地名、历史随时能改。</p>
                  </div>
                </>
              ))}
          </div>
        </section>
        {rewrite}
      </>
    );

  return (
    <aside className="sidebar nw-card" aria-label="新建世界" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      <header className="sb-head nw-head">
        {backLink}
        <div className="nw-title-row">
          <div className="nw-title">{heading}</div>
          {moreMenu}
          {rewrite}
        </div>
        <div className="nw-intro">{base ? `设定都带过来了，改完存成一个新世界，${base.title}本身不变。` : '先定下这颗星球的样子，再推演它三千年的历史。'}</div>
      </header>
      <div className="sb-body nw-body">
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>星球</span>
          </div>
          <div className="sb-group">
            {seedRow}
            {paramsRow}
            {replayRow}
          </div>
          {noCivHint}
        </section>
        {tool.on ? (
          <TerrainPanel disabled={p.busy} />
        ) : (
          <section className="sb-sec">
            <div className="sb-sec-head">
              <span>改地形</span>
              <small>可选</small>
            </div>
            <div className="sb-group">{terrainRow('火山、山脉、湖……', terrainSide)}</div>
          </section>
        )}
        {carried && (
          <section className="sb-sec">
            <div className="sb-sec-head">
              <span>跟过去的修改</span>
            </div>
            <div className="sb-group">{baseRows}</div>
          </section>
        )}
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>名字</span>
          </div>
          {nameField}
        </section>
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>创建以后</span>
          </div>
          <div className="sb-group">
            <div className="sb-row static">
              <Icon name="lock" size={17} className="sb-ico" />
              <span className="sb-row-main">
                <b>种子、世界参数、地形</b>
              </span>
              <span className="sb-row-side">定下来，不能再改</span>
            </div>
            <div className="sb-row static">
              <Icon name="rename" size={17} className="sb-ico" />
              <span className="sb-row-main">
                <b>世界名、国名地名、历史</b>
              </span>
              <span className="sb-row-side">随时能改</span>
            </div>
          </div>
        </section>
      </div>
      <footer className="nw-foot">{createBtn}</footer>
    </aside>
  );
}

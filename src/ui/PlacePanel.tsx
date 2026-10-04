/**
 * 地理实体(山脉、河流、湖泊、岛屿、荒漠、海 / 大洋 / 海湾)的面板(和国家面板同一套样子,零件见 panelParts.tsx):
 *
 *   顶部  "山脉 · 第 N 年"、关闭;名字(可改);一行"拉丁原形 Aldor Mountains · 按某族语感 · 设为中心"(东方风只写按哪族语感)
 *   数字  按种类挑拿得到的(panelData.ts 的 placeFacts):山脉 最高峰 / 长度 / 跨州;河 长度 / 流经州 / 源头海拔;
 *         湖 面积 / 湖面海拔;岛 面积 / 最高峰;荒漠 面积 / 年降水;海 离岸最远 / 最深处
 *   当年在哪些国家境内(海:沿岸有哪些国家;色块 + 国名,可点;河按流经的先后,其余按占的多少)
 *   底部  改名 / 名字由来 / 起名(AI 按当地语感起几个,点一个就改名)
 */
import { useMemo, useState } from 'react';
import type { Place } from '../gen/civ/types';
import { cultureLabel } from '../gen/civ/display';
import { polityName } from '../gen/civ/growth';
import { placeKeyOf } from '../gen/edits';
import { NameEdit } from './NameEdit';
import { areaText, kmText, metersText, ownersOf, placeFacts } from './panelData';
import { AiBox, CenterLink, Foot, Link, PanelHead, Stats, SubLine, rgb, type DetailProps, type Stat, useRevealAi } from './panelParts';

const PLACE_KIND: Record<Place['kind'], string> = {
  sea: '海',
  mountains: '山脉',
  river: '河流',
  lake: '湖泊',
  island: '岛屿',
  desert: '荒漠',
};

/** 种类的叫法(海按生成时的名字分海 / 大洋 / 海湾) */
export function placeKindName(p: Place): string {
  const n = p.defaultName ?? p.name;
  if (p.kind === 'sea') return n.endsWith('洋') ? '大洋' : n.endsWith('湾') ? '海湾' : '海';
  return PLACE_KIND[p.kind];
}

export function PlacePanel({ civ, raw, raster, world, id, year, names }: DetailProps) {
  const p = civ.places[id];
  const key = placeKeyOf(civ, id);
  const [renaming, setRenaming] = useState(false);
  const { ai, aiRef } = useRevealAi({ civ, raw, raster, target: { kind: 'place', id }, lazy: true });
  const f = useMemo(() => placeFacts(civ, world, raster, id), [civ, world, raster, id]);
  const kind = placeKindName(p);
  const namer = p.culture >= 0 ? civ.cultures[p.culture] : undefined;

  // 当年在哪些国家境内:经过 / 覆盖的州各归谁(河按流经的先后,其余按占的多少)
  const own = ownersOf(civ, year);
  const share = new Map<number, number>();
  let peopled = 0;
  f.regions.forEach((r, i) => {
    const q = own.polity[r];
    if (q >= 0) share.set(q, (share.get(q) ?? 0) + f.weight[i]);
    if (own.culture[r] >= 0) peopled++;
  });
  const pols = (p.kind === 'river' ? [...share.keys()] : [...share].sort((a, b) => b[1] - a[1]).map((x) => x[0])).slice(0, 8).map((q) => civ.polities[q]).filter(Boolean);

  const stats: Stat[] = [];
  const num = (k: string, v: number | undefined, unit: string, text: (x: number) => string = metersText) => {
    if (v !== undefined && Number.isFinite(v)) stats.push({ k, v: text(v), note: unit });
  };
  if (p.kind === 'mountains') {
    num('最高峰', f.peak, '米');
    num('长度', f.lengthKm, '公里', kmText);
    if (f.regions.length) stats.push({ k: '跨州', v: f.regions.length });
  } else if (p.kind === 'river') {
    num('长度', f.lengthKm, '公里', kmText);
    if (f.regions.length) stats.push({ k: '流经州', v: f.regions.length });
    num('源头', f.source, '米');
  } else if (p.kind === 'sea') {
    num('离岸最远', f.shoreKm, '公里', kmText);
    num('最深', f.depth, '米');
  } else {
    num('面积', f.areaKm2, '平方公里', areaText);
    if (p.kind === 'lake') num('湖面海拔', f.lakeLevel, '米');
    if (p.kind === 'island') num('最高峰', f.peak, '米');
    if (p.kind === 'desert') num('年降水', f.rain, '毫米', (x) => `${Math.round(x)}`);
  }

  return (
    <div className="cp" data-place={id}>
      <PanelHead tag={kind} year={year}>
        <NameEdit
          k={key}
          kind="place"
          shown={p.name}
          current={p.name}
          fallback={raw.places[id].name}
          names={names}
          big
          editing={renaming}
          onEditing={setRenaming}
        />
        <SubLine
          className="ins-status"
          parts={[
            p.latin && (
              <>
                拉丁原形 <span className="ins-latin">{p.latin}</span>
              </>
            ),
            namer ? `按${cultureLabel(namer)}语感` : p.kind === 'sea' ? null : '按通行语感',
            <CenterLink world={world} civ={civ} sel={{ kind: 'place', id }} year={year} />,
          ]}
        />
      </PanelHead>
      <div className="cp-body">
        {stats.length > 0 && <Stats items={stats} />}
        {f.regions.length > 0 && (p.kind !== 'sea' || pols.length > 0) && (
          <div className="cp-grid cp-grid-top">
            <span className="cp-k">{p.kind === 'river' ? '流经' : p.kind === 'sea' ? '沿岸' : '所在'}</span>
            <span className="cp-links cp-chips">
              {pols.length
                ? pols.map((q) => (
                    <span key={q.id} className="cp-chip">
                      <i className="cp-sw" style={{ background: rgb(q.color) }} />
                      <Link to={{ kind: 'polity', id: q.id }}>{polityName(q, year)}</Link>
                    </span>
                  ))
                : peopled
                  ? '部落地带'
                  : '无人居住'}
            </span>
          </div>
        )}
        <AiBox ai={ai} aiRef={aiRef} />
      </div>
      <Foot cols={3}>
        <button className="cp-btn" data-act="rename" onClick={() => setRenaming(true)}>
          改名
        </button>
        <button className="cp-btn" data-ain="explain" disabled={ai.busy} onClick={ai.ask}>
          名字由来
        </button>
        <button className="cp-btn" data-ain="suggest" disabled={ai.busy} onClick={ai.suggestNow}>
          起名
        </button>
      </Foot>
    </div>
  );
}

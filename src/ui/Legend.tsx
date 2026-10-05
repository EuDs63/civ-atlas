import { BIOMES } from '../gen/biomes';
import { CURRENT_RAMP, ELEV_RAMP, PRECIP_RAMP, TEMP_RAMP, type LayerId } from '../render/layers';
import type { RGB } from '../render/common';

const css = (c: RGB) => `rgb(${c.map(Math.round).join(',')})`;

function Gradient({ stops, unit, labels }: { stops: [number, RGB][]; unit: string; labels: number[] }) {
  const lo = stops[0][0];
  const hi = stops[stops.length - 1][0];
  const g = stops.map(([v, c]) => `${css(c)} ${((v - lo) / (hi - lo)) * 100}%`).join(',');
  return (
    <div className="gradient">
      <div className="bar" style={{ background: `linear-gradient(90deg, ${g})` }} />
      <div className="ticks">
        {labels.map((l) => (
          <span key={l} style={{ left: `${((l - lo) / (hi - lo)) * 100}%` }}>
            {l.toLocaleString()}
          </span>
        ))}
      </div>
      <div className="unit">{unit}</div>
    </div>
  );
}

export function Legend({ layer }: { layer: LayerId }) {
  let body;
  if (layer === 'elevation') body = <Gradient stops={ELEV_RAMP} unit="海拔 米" labels={[-4000, 0, 2200, 5500]} />;
  else if (layer === 'temperature') body = <Gradient stops={TEMP_RAMP} unit="年均温 °C" labels={[-30, -15, 0, 15, 30]} />;
  else if (layer === 'precipitation')
    body = (
      <>
        <Gradient stops={PRECIP_RAMP} unit="年降水 mm · 白箭头 = 盛行风" labels={[0, 600, 1200, 2000, 3200]} />
      </>
    );
  else if (layer === 'currents')
    body = <Gradient stops={CURRENT_RAMP} unit="水温和同纬度比（°C），箭头是洋流方向" labels={[-6, -3, 0, 3, 6]} />;
  else if (layer === 'plates')
    body = (
      <div className="keys">
        <span>
          <i style={{ background: '#c8281e' }} />
          碰撞带(造山)
        </span>
        <span>
          <i style={{ background: '#1e5adc' }} />
          张裂带(裂谷 / 洋中脊)
        </span>
        <span>
          <i style={{ background: '#222' }} />
          箭头 = 漂移方向
        </span>
        <span>
          <i style={{ background: '#56687d' }} />
          偏暗 = 大洋板块
        </span>
      </div>
    );
  else
    body = (
      <div className="keys">
        {BIOMES.slice(1, -1).map((b) => (
          <span key={b.name}>
            <i style={{ background: css(b.real) }} />
            {b.name}
          </span>
        ))}
      </div>
    );
  return <div className="legend">{body}</div>;
}

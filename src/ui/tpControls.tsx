/**
 * 编辑地形面板里的两样小控件(TerrainTools 的面板、导入图片的面板共用):
 * 分段按钮(左边一个灰字,右边几段)、滑条(左边一个灰字,两头一个小点、一个大点,最右可以写数)。样式在 worlds.css 的 .tp-*。
 */
import type { CSSProperties, ReactNode } from 'react';

export function Seg<T extends string | number>({ label, items, value, onPick, act }: { label: string; items: { v: T; name: string }[]; value: T; onPick: (v: T) => void; act: string }) {
  return (
    <div className="tp-lbl">
      <b>{label}</b>
      <div className="tp-seg" role="radiogroup" aria-label={label} data-act={act}>
        {items.map((x) => (
          <button key={String(x.v)} role="radio" aria-checked={value === x.v} className={value === x.v ? 'on' : ''} data-v={x.v} onClick={() => onPick(x.v)}>
            {x.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Slider({
  label,
  act,
  min,
  max,
  step = 1,
  value,
  onChange,
  show,
}: {
  label: string;
  act: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  /** 最右写的数(不给 = 不写) */
  show?: ReactNode;
}) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="tp-lbl">
      <b>{label}</b>
      <div className="tp-range">
        <i className="tp-dot s" />
        <input
          type="range"
          aria-label={label}
          data-act={act}
          min={min}
          max={max}
          step={step}
          value={value}
          style={{ '--fill': `${fill}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <i className="tp-dot l" />
        {show !== undefined && <em>{show}</em>}
      </div>
    </div>
  );
}

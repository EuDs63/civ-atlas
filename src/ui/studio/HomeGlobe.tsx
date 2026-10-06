/**
 * 「我的世界」一个都没有时,中间那颗慢慢自转的星球:和新建界面同一套画法(PlanetGL),
 * 贴一张事先导出的实景图(种子 7 的世界,public/home-planet.jpg),约 1 分钟转一圈。
 * 系统设了"减少动态效果"就不转;没有 WebGL(或图没加载出来)就只留一个圆形的底色。
 */
import { useEffect, useRef, useState } from 'react';
import { PlanetGL, type PlanetFrame } from './planetGL';
import { TILT } from './layout';

const SRC = `${import.meta.env.BASE_URL}home-planet.jpg`;
/** 自转:弧度 / 毫秒(和新建界面一样,约 1 分钟一圈) */
const SPIN = 0.00011;
/** 一开始正中的经线(弧度):陆地多的那一面 */
const LON0 = 1.35;

export function HomeGlobe({ size }: { size: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const gl = PlanetGL.create(cv, { small: true });
    if (!gl) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    gl.resize(size, size, devicePixelRatio || 1);
    let lon = LON0;
    let last = 0;
    let raf = 0;
    let alive = true;
    const frame = (): PlanetFrame => ({
      projA: 'globe',
      projB: 'globe',
      s: 1,
      m: 1,
      k: size / 2,
      cx: size / 2,
      cy: size / 2,
      tilt: TILT,
      lon,
      a: 'home',
      b: 'home',
      mix: 1,
      drift: null,
      real: 'home',
      markA: 0,
    });
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      if (last) lon -= Math.min(100, now - last) * SPIN;
      last = now;
      gl.draw(frame());
    };
    const img = new Image();
    img.onload = () => {
      if (!alive || gl.isLost) return;
      gl.setStyle('home', img);
      gl.draw(frame());
      setOk(true);
      if (!reduce) raf = requestAnimationFrame(step);
    };
    img.src = SRC;
    gl.onLost = () => {
      cancelAnimationFrame(raf);
      setOk(false);
    };
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      gl.dispose();
    };
  }, [size]);
  return (
    <div className={`mw-globe${ok ? ' on' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <canvas ref={ref} />
    </div>
  );
}

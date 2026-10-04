/**
 * 主图(等距圆柱,东西相连)的接缝 / 两极检查图,输入是 snap.ts 截的整张地图原图(canvas 模式):
 *
 *   npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/f7.png canvas
 *   npx tsx scripts/seam.ts snaps/f7.png                 # → snaps/f7-seam.png、snaps/f7-poles.png
 *
 *   - <名字>-seam.png:左右两半对调(180° 经线挪到正中):接缝处的海岸、河、符号、界线应当接得上,看不出竖线
 *   - <名字>-poles.png:最上 / 最下 ~12° 纬度的两条,纵向放大 2 倍拼在一起:两极不糊、不破
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const inp = process.argv[2];
if (!inp) {
  console.log('用法:npx tsx scripts/seam.ts snaps/x.png');
  process.exit(1);
}
const base = inp.replace(/\.png$/, '');
const src = PNG.sync.read(readFileSync(inp));
const { width: w, height: h } = src;

// 左右两半对调
const seam = new PNG({ width: w, height: h });
const half = w >> 1;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const s = (y * w + ((x + half) % w)) * 4;
    const d = (y * w + x) * 4;
    for (let c = 0; c < 4; c++) seam.data[d + c] = src.data[s + c];
  }
}
writeFileSync(`${base}-seam.png`, PNG.sync.write(seam));

// 两极:上下各 h/15 行(约 12°),纵向放大 2 倍,中间隔一条灰线
const band = Math.round(h / 15);
const Z = 2;
const gap = 6;
const poles = new PNG({ width: w, height: band * Z * 2 + gap });
poles.data.fill(128);
const copy = (y0: number, oy: number) => {
  for (let y = 0; y < band * Z; y++) {
    const sy = y0 + Math.floor(y / Z);
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * 4;
      const d = ((oy + y) * w + x) * 4;
      for (let c = 0; c < 4; c++) poles.data[d + c] = src.data[s + c];
    }
  }
};
copy(0, 0);
copy(h - band, band * Z + gap);
writeFileSync(`${base}-poles.png`, PNG.sync.write(poles));
console.log(`${base}-seam.png、${base}-poles.png`);

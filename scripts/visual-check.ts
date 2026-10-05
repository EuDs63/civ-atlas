/**
 * 画面回归检查:固定种子渲染缩略图,和 tests/visual/baseline/ 里的基准图比对。
 *
 *   pnpm test:visual            比对;有图变了就打印差异百分比,并把对比图写到 snaps/visual-diff/
 *   pnpm test:visual --update   用当前画面覆盖基准图(改了画风 / 生成算法后跑,和代码一起提交)
 *
 * 每个种子(7、2024)渲染:写实、手绘、六个数据图层,各缩成 512×256;另有四张弯边投影的(见 PROJ_CASES)。
 * "变了"的判定:某像素任一通道差 > 16/255 记为变化像素;变化像素占比 > 0.5% 判为不通过。
 * 自动起临时 dev server(scripts/lib/devserver.ts),不需要先 pnpm dev。
 *
 * 加 --center=经度(如 --center=90)按"这条经线在正中"截(和用户左右拖动后看到的一样:左右边 = 中心 ± 180°;
 * 基准图在 tests/visual/baseline-c90/ 这样的目录里)。
 * 另有几张弯边投影(罗宾森、摩尔威德……)的:截的是按投影重画的地形图(见 PROJ_CASES)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { PNG } from 'pngjs';
import { startDevServer } from './lib/devserver';

const CENTER = Number(/--center=(-?[\d.]+)/.exec(process.argv.join(' '))?.[1] ?? 0);
const SEEDS = [7, 2024];
const VIEWS = [
  { name: 'realistic', query: 'style=realistic' },
  { name: 'fantasy', query: 'style=fantasy' },
  { name: 'plates', query: 'style=data&layer=plates' },
  { name: 'elevation', query: 'style=data&layer=elevation' },
  { name: 'temperature', query: 'style=data&layer=temperature' },
  { name: 'precipitation', query: 'style=data&layer=precipitation' },
  { name: 'currents', query: 'style=data&layer=currents' },
  { name: 'biomes', query: 'style=data&layer=biomes' },
];
/**
 * 弯边投影(按投影重画:面按行重投影,海岸、河逐点投影,符号正立,见 render/detail.ts 的 drawTerrainProjected):
 * 几种投影、画风、中央经线各截一张。
 * 中央经线用网址参数 lon= 给(和用户存下的一样),不走 --center 的左右转
 */
const PROJ_CASES = CENTER
  ? []
  : [
      { name: 'seed7-robinson-fantasy', query: 'seed=7&style=fantasy&proj=robinson' },
      { name: 'seed7-mollweide-realistic', query: 'seed=7&style=realistic&proj=mollweide&lon=-60' },
      { name: 'seed2024-naturalEarth-fantasy', query: 'seed=2024&style=fantasy&proj=naturalEarth&lon=150' },
      { name: 'seed2024-mercator-realistic', query: 'seed=2024&style=realistic&proj=mercator&lon=90' },
    ];
const CASES = [
  ...SEEDS.flatMap((seed) => VIEWS.map((v) => ({ name: `seed${seed}-${v.name}`, query: `seed=${seed}&${v.query}` }))),
  ...PROJ_CASES,
];

const THUMB_W = 512;
const THUMB_H = 256;
const CHANNEL_TOL = 16; // 单通道差多少算"这个像素变了"
const MAX_CHANGED = 0.5; // 变化像素占比超过多少(%)判为不通过

const BASELINE_DIR = `tests/visual/baseline${CENTER ? `-c${CENTER}` : ''}`;
const DIFF_DIR = 'snaps/visual-diff';
const UPDATE = process.argv.includes('--update');
const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length));

/** 打开一个画面,等渲染完成,把地图按块平均缩成 THUMB_W×THUMB_H 取回 PNG */
async function capture(browser: Browser, url: string, query: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${url}/?${query}`);
    await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 90_000 });
    const dataUrl = await page.evaluate(
      ([tw, th, lon]) => {
        const cv = document.querySelector('canvas') as HTMLCanvasElement;
        const src = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
        // 给了中心经度:主图左右转一下再缩(第 x 列取原图的第 x + sp 列)
        const turn = lon / 360 - Math.floor(lon / 360);
        const sp = Math.round(turn * cv.width) % cv.width;
        // 自己做块平均缩小,不用浏览器的 drawImage 缩放:不同系统 / 显卡的缩放算法会有细微差别
        const out = new ImageData(tw, th);
        for (let ty = 0; ty < th; ty++) {
          const y0 = Math.floor((ty * cv.height) / th);
          const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * cv.height) / th));
          for (let tx = 0; tx < tw; tx++) {
            const x0 = Math.floor((tx * cv.width) / tw);
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * cv.width) / tw));
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) {
                const i = (y * cv.width + ((x + sp) % cv.width)) * 4;
                r += src[i];
                g += src[i + 1];
                b += src[i + 2];
                n++;
              }
            }
            const o = (ty * tw + tx) * 4;
            out.data[o] = Math.round(r / n);
            out.data[o + 1] = Math.round(g / n);
            out.data[o + 2] = Math.round(b / n);
            out.data[o + 3] = 255;
          }
        }
        const small = document.createElement('canvas');
        small.width = tw;
        small.height = th;
        small.getContext('2d')!.putImageData(out, 0, 0);
        return small.toDataURL('image/png');
      },
      [THUMB_W, THUMB_H, CENTER],
    );
    if (errors.length) throw new Error(`页面报错:${errors.join(' | ')}`);
    return Buffer.from(dataUrl.split(',')[1], 'base64');
  } finally {
    await page.close();
  }
}

/**
 * 基准图压缩:每个通道四舍五入到 4 的倍数(误差最多 2/255,远小于判定阈值 16/255),
 * 去掉透明通道、用 Paeth 滤波 + 最高压缩,文件约小四成(现在 18 张一共约 2 MB)。
 */
function encodeBaseline(png: PNG): Buffer {
  for (let i = 0; i < png.data.length; i += 4) {
    for (let k = 0; k < 3; k++) png.data[i + k] = Math.min(255, Math.round(png.data[i + k] / 4) * 4);
  }
  return PNG.sync.write(png, { colorType: 2, deflateLevel: 9, filterType: 4 });
}

/** 比对两张图,返回变化像素占比(%)和一张"基准 | 当前 | 差异"三联对比图 */
function compare(base: PNG, cur: PNG): { pct: number; maxDelta: number; sheet: PNG } {
  const w = cur.width;
  const h = cur.height;
  const sheet = new PNG({ width: w * 3, height: h });
  let changed = 0;
  let maxDelta = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(
        Math.abs(base.data[i] - cur.data[i]),
        Math.abs(base.data[i + 1] - cur.data[i + 1]),
        Math.abs(base.data[i + 2] - cur.data[i + 2]),
      );
      if (d > maxDelta) maxDelta = d;
      const hit = d > CHANNEL_TOL;
      if (hit) changed++;
      // 左:基准;中:当前;右:当前画面变淡变灰,变了的像素标红
      const rowOff = y * w * 3;
      for (const [panel, px] of [
        [0, base.data],
        [1, cur.data],
      ] as const) {
        const o = (rowOff + panel * w + x) * 4;
        sheet.data[o] = px[i];
        sheet.data[o + 1] = px[i + 1];
        sheet.data[o + 2] = px[i + 2];
        sheet.data[o + 3] = 255;
      }
      const o = (rowOff + 2 * w + x) * 4;
      const gray = Math.round(0.3 * cur.data[i] + 0.59 * cur.data[i + 1] + 0.11 * cur.data[i + 2]);
      const faded = Math.round(200 + gray * 0.2);
      sheet.data[o] = hit ? 230 : faded;
      sheet.data[o + 1] = hit ? 20 : faded;
      sheet.data[o + 2] = hit ? 20 : faded;
      sheet.data[o + 3] = 255;
    }
  }
  return { pct: (changed / (w * h)) * 100, maxDelta, sheet };
}

// ---- 主流程 ----
fs.mkdirSync(BASELINE_DIR, { recursive: true });
fs.rmSync(DIFF_DIR, { recursive: true, force: true });

const t0 = Date.now();
const dev = await startDevServer();
const browser = await chromium.launch();
const shots = new Map<string, Buffer>();
try {
  // 几个页面并行跑,每个页面各自在后台线程里生成世界
  const queue = [...CASES];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        shots.set(c.name, await capture(browser, dev.url, c.query));
      }
    }),
  );
} finally {
  await browser.close();
  await dev.close();
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (UPDATE) {
  const keep = new Set(CASES.map((c) => `${c.name}.png`));
  for (const f of fs.readdirSync(BASELINE_DIR)) {
    if (f.endsWith('.png') && !keep.has(f)) fs.rmSync(path.join(BASELINE_DIR, f));
  }
  let total = 0;
  for (const c of CASES) {
    const buf = encodeBaseline(PNG.sync.read(shots.get(c.name)!));
    fs.writeFileSync(path.join(BASELINE_DIR, `${c.name}.png`), buf);
    total += buf.length;
  }
  console.log(`已更新 ${CASES.length} 张基准图 → ${BASELINE_DIR}/(共 ${(total / 1024).toFixed(0)} KB,用时 ${secs}s)`);
  console.log('记得把基准图和代码改动一起提交。');
  process.exit(0);
}

const rows: { name: string; status: string; pct: string; note: string }[] = [];
let failed = 0;
for (const c of CASES) {
  const basePath = path.join(BASELINE_DIR, `${c.name}.png`);
  const cur = PNG.sync.read(shots.get(c.name)!);
  if (!fs.existsSync(basePath)) {
    failed++;
    fs.mkdirSync(DIFF_DIR, { recursive: true });
    const outPath = path.join(DIFF_DIR, `${c.name}.actual.png`);
    fs.writeFileSync(outPath, PNG.sync.write(cur, { colorType: 2 }));
    rows.push({ name: c.name, status: '缺基准', pct: '-', note: outPath });
    continue;
  }
  const base = PNG.sync.read(fs.readFileSync(basePath));
  if (base.width !== cur.width || base.height !== cur.height) {
    failed++;
    rows.push({ name: c.name, status: '尺寸不同', pct: '-', note: `基准 ${base.width}×${base.height}` });
    continue;
  }
  const { pct, maxDelta, sheet } = compare(base, cur);
  if (pct > MAX_CHANGED) {
    failed++;
    fs.mkdirSync(DIFF_DIR, { recursive: true });
    const outPath = path.join(DIFF_DIR, `${c.name}.png`);
    fs.writeFileSync(outPath, PNG.sync.write(sheet, { colorType: 2 }));
    rows.push({ name: c.name, status: '变了', pct: `${pct.toFixed(2)}%`, note: outPath });
  } else {
    rows.push({ name: c.name, status: '通过', pct: `${pct.toFixed(2)}%`, note: maxDelta <= 2 ? '一致(只差基准图压缩的取整)' : `最大单通道差 ${maxDelta}` });
  }
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log(`画面回归检查(${CASES.length} 张,阈值:变化像素 > ${MAX_CHANGED}% 判为变了,用时 ${secs}s)`);
for (const r of rows) console.log(`  ${pad(r.status, 9)}${pad(r.name, 26)}${pad(r.pct, 9)}${r.note}`);

// 在 GitHub Actions 里:结果表写进运行摘要,不一致时加一条警告;这一步失败时 ci.yml 把对比图上传成附件 visual-diff
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `### 画面回归检查:${failed ? `${failed} 张和基准不一致` : '全部通过'}`,
    '',
    '| 状态 | 画面 | 变化像素 | 说明 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.status} | ${r.name} | ${r.pct} | ${r.note} |`),
    '',
    failed ? '对比图在本次运行的附件 `visual-diff` 里。有意改画面:本地 `pnpm test:visual --update`,把基准图一起提交。' : '',
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
}
if (failed && process.env.GITHUB_ACTIONS) {
  const list = rows.filter((r) => r.status !== '通过').map((r) => `${r.name} ${r.pct}`).join(',');
  console.log(`::warning title=画面回归::${failed} 张画面和基准不一致:${list}。对比图见本次运行附件 visual-diff`);
}

if (failed) {
  console.log(`\n${failed} 张画面和基准不一致。对比图(左 基准 | 中 当前 | 右 红色 = 变化处)在 ${DIFF_DIR}/`);
  console.log('如果这是有意的画面改动:pnpm test:visual --update,然后把 tests/visual/baseline/ 一起提交。');
  process.exit(1);
}
console.log('\n全部通过。');

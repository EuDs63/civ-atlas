/**
 * 无头截图:npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/x.png [canvas | crop=x,y,w,h,倍数 | zoom=倍数,fx,fy]
 *   不带第三个参数:截整个界面;canvas:只要地图原图;crop=...:地图局部放大(像素放大,看细节用)
 *   zoom=4,0.7,0.3:像用户一样用滚轮把地图放大 4 倍(以地图上 70%、30% 处为中心),截地图区域 ——
 *     文字层随缩放重画,看"放大后文字清不清楚"用这个
 *   地图原图 = 地图的各层(地图框 .map-box / .map-box-upper、屏幕层 .screen-layer)里所有看得见的 canvas
 *   按各自在屏幕上的位置、混合模式叠在一起(地形 + 细节层 + 文明层 + 文字层……)
 *   文明层:网址里加 civ=habitat / civ=regions,sites 等;地名默认打开,civ=-labels 关掉(见 src/ui/civView.ts)
 *   canvas / crop / zoom 用 2 倍像素密度截(文字层按屏幕像素画,这样叠到 2048 宽的原图上也清晰)
 *   世界东西相连:加 center=经度(如 center=90、center=180)先把地图转到这条经线在正中再截
 *     (像用户左右拖动一样;canvas / crop 截的是视窗里的那一整圈:左右边 = 中心 ± 180°;不给 = 0° 经线在正中)
 *   手机:加 device=宽x高(如 device=390x844、device=360x740)按手机截 —— 这么大的视口、触屏(hasTouch、isMobile)、
 *     两倍像素密度;不带第三个参数时截整个界面(手机布局:底部抽屉、两行时间轴)
 * 自动起一个临时 dev server(随机端口),不需要先 pnpm dev。
 */
import { chromium } from 'playwright';
import { startDevServer } from './lib/devserver';

const rawQuery = process.argv[2] ?? '';
// center= 不是网址参数:页面打开后再转过去
const centerLon = /(?:^|&)center=(-?[\d.]+)/.exec(rawQuery)?.[1];
// device= 也不是:按手机开页面(视口大小、触屏)
const device = /(?:^|&)device=(\d+)x(\d+)/.exec(rawQuery);
const query = rawQuery
  .replace(/(^|&)center=-?[\d.]+/, '')
  .replace(/(^|&)device=\d+x\d+/, '')
  .replace(/^&/, '');
const out = process.argv[3] ?? 'snaps/shot.png';
const full = process.argv[4] === 'canvas' || process.argv[4]?.startsWith('crop');
const crop = process.argv[4]?.startsWith('crop=') ? process.argv[4].slice(5).split(',').map(Number) : null;
const zoom = process.argv[4]?.startsWith('zoom=') ? process.argv[4].slice(5).split(',').map(Number) : null;

const dev = await startDevServer();
const browser = await chromium.launch();
const page = device
  ? await browser.newPage({ viewport: { width: Number(device[1]), height: Number(device[2]) }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  : await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: full || zoom ? 2 : 1 });
const logs: string[] = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${dev.url}/?${query}`);
const t0 = Date.now();
await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 }).catch(() => {});
if (/(^|&)civ=/.test(query)) await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 30000 }).catch(() => {});
// 地名默认打开:等文字层画完(字体加载好才画)
if (!/civ=[^&]*-labels/.test(query)) await page.waitForFunction(() => (window as any).__wfLabels?.ready, null, { timeout: 30000 }).catch(() => {});
const info = await page.evaluate(() => (window as any).__wf);
console.log('ready after', Date.now() - t0, 'ms', JSON.stringify(info));
if (centerLon !== undefined) {
  // 转到这条经线在正中,等文字层按新的位置重画完
  await page.evaluate(() => (((window as any).__wfLabels ??= {}).mark = 1));
  await page.evaluate((lon) => (window as any).__wfSetCenter?.(lon), Number(centerLon));
  await page.waitForFunction(() => !(window as any).__wfLabels?.mark, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(200);
  console.log('center', JSON.stringify(await page.evaluate(() => (window as any).__wfView)));
}
if (zoom) {
  // 像用户一样:鼠标移到地图上某处,滚轮放大;等文字层按新的缩放重画完再截
  const [k = 4, fx = 0.5, fy = 0.5] = zoom;
  let r = (await page.locator('.map-box').boundingBox())!;
  // 地图框(主图那一份)不一定在视窗正中,按视窗(缩放 1 倍时 = 居中的地图框大小)算放大中心
  const st = (await page.locator('main.stage').boundingBox())!;
  r = { ...r, x: st.x + (st.width - r.width) / 2 };
  await page.mouse.move(r.x + fx * r.width, r.y + fy * r.height);
  // 一次滚动的量浏览器会按像素密度换算,所以分几次滚,每次按当前倍数补差
  for (let i = 0; i < 8; i++) {
    const cur = await page.evaluate(() => (window as any).__wfLabels?.k ?? 1);
    if (Math.abs(Math.log(k / cur)) < 0.01) break;
    await page.evaluate(() => (((window as any).__wfLabels ??= {}).mark = 1));
    // 差得多:滚轮(一下 ≥ 50 像素才认作鼠标滚轮);只差一点:按着 Ctrl 滚一小下,当成触控板捏合(倍数 = e^(−deltaY / 100))
    const d = -Math.log(k / cur) / 0.0015;
    if (Math.abs(d) >= 50) await page.mouse.wheel(0, d);
    else {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -Math.log(k / cur) * 100);
      await page.keyboard.up('Control');
    }
    await page.waitForFunction(() => !(window as any).__wfLabels?.mark, null, { timeout: 15000 }).catch(() => {});
  }
  // 鼠标移出地图,免得悬停信息挡住画面
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  console.log('zoom', JSON.stringify(await page.evaluate(() => (window as any).__wfLabels)));
  await page.locator('main.stage').screenshot({ path: out });
} else if (full) {
  const dataUrl = await page.evaluate((crop) => {
    // 把地图各层里所有看得见的 canvas 按页面上的先后(= 上下顺序)叠成一张(尺寸以第一张为准)。
    // 文字层、细节层只盖住视口里看得见的那块:按它在屏幕上的位置换回地图框坐标(缩放前),再换算到原图上
    const box = document.querySelector('.map-box') as HTMLElement;
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    const layers = [...document.querySelectorAll('.map-box canvas, .map-box-upper canvas, .screen-layer canvas')] as HTMLCanvasElement[];
    // 截视窗里的那一整圈 —— 从外框左边(地图框坐标 fx)起,右边接的那一份(.wrap-copy)也叠进来
    const br = box.getBoundingClientRect();
    const sr = (box.closest('.stage') as HTMLElement).getBoundingClientRect();
    const fx = (sr.left + sr.width / 2 - (bw * (br.width / bw)) / 2 - br.left) / (br.width / bw);
    const cv = document.createElement('canvas');
    cv.width = layers[0].width;
    cv.height = layers[0].height;
    const cc = cv.getContext('2d')!;
    cc.imageSmoothingQuality = 'high';
    const k = br.width / bw;
    for (const l of layers) {
      const st = getComputedStyle(l);
      const lr = l.getBoundingClientRect();
      if (!l.width || !l.height || !lr.width || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      cc.globalAlpha = Number(st.opacity);
      cc.globalCompositeOperation = st.mixBlendMode === 'multiply' ? 'multiply' : 'source-over';
      const sx = cv.width / bw;
      const sy = cv.height / bh;
      cc.drawImage(l, ((lr.left - br.left) / k - fx) * sx, ((lr.top - br.top) / k) * sy, (lr.width / k) * sx, (lr.height / k) * sy);
    }
    cc.globalAlpha = 1;
    cc.globalCompositeOperation = 'source-over';
    if (!crop) return cv.toDataURL('image/png');
    const [x, y, w, h, z = 2] = crop;
    const o = document.createElement('canvas');
    o.width = w * z;
    o.height = h * z;
    const c = o.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.drawImage(cv, x, y, w, h, 0, 0, w * z, h * z);
    return o.toDataURL('image/png');
  }, crop);
  const fs = await import('node:fs');
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
} else {
  await page.screenshot({ path: out });
}
if (logs.length) console.log(logs.join('\n'));
await browser.close();
await dev.close();

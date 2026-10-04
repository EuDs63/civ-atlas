/**
 * 地球仪截图:npx tsx scripts/globe-snap.ts "seed=7&style=fantasy" snaps/globe.png [经度,纬度,缩放 …]
 *   网址参数和主图一样(civ=polities、civYear=1200 …),自动加 view=globe;
 *   后面每个"经度,纬度,缩放"截一张(文件名后面加 -1、-2 …);不给 = 打开时的默认视图。
 *   放大到主图那张贴图不够清楚时会等高清贴图换上再截(最多 30 秒)。
 *   --stage:截整个地图区域(带时间轴、按钮);默认只截地球仪。
 *   --cpu:用 CPU 画法(没有 WebGL2 时的退路)
 *   --sel=名字:每个视图先选中球上写着这个名字的东西(国家、城、山河……),看选中的描边
 *   --panel:和 --sel 一起用:详情面板留着、截整页(看面板打开时球心左移)
 *   --gpu:用本机显卡(macOS 上走 Metal);默认是无头浏览器的软件渲染(SwiftShader),慢很多
 *   --bench:每个视图再量转动时每帧耗时(等显卡画完):"停着"= 每帧都排全部文字(最慢),"拖着"= 只排大字(真拖动时就是这样);
 *           overlay = 球上面那层(矢量线 + 文字)的耗时,place = 其中排文字,verts = 矢量线描了多少个点(中位数)
 * 自动起一个临时 dev server(随机端口)。
 */
import { chromium } from 'playwright';
import { startDevServer } from './lib/devserver';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const query = `${args[0] ?? 'seed=7'}&view=globe${flags.has('--cpu') ? '&globe=cpu' : ''}`;
const out = args[1] ?? 'snaps/globe.png';
const views = args.slice(2).map((s) => s.split(',').map(Number));

const dev = await startDevServer();
const browser = await chromium.launch({
  args: flags.has('--gpu') ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
const logs: string[] = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(`${dev.url}/?${query}`);
await page.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 90000 });
if (/(^|&)civ=/.test(query)) await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 30000 }).catch(() => {});
// 写实风的地球仪贴图(不打光 + 坡度)在后台画,换上之前是主图那张:等它换上(数据图层、CPU 画法一直是主图那张)
await page.waitForFunction(() => { const g = (window as any).__wfGlobe; return g.tex === 'globe' || g.style === 'data' || g.renderer === 'cpu'; }, null, { timeout: 30000 }).catch(() => console.log('  地球仪贴图没换上'));
await page.waitForTimeout(600);
console.log('ready after', Date.now() - t0, 'ms', JSON.stringify(await page.evaluate(() => { const g = (window as any).__wfGlobe; return { renderer: g.renderer, gpu: g.gpu, openMs: g.openMs, upload: g.upload }; })));
const shots = views.length ? views : [null];
for (let i = 0; i < shots.length; i++) {
  const v = shots[i];
  if (v) {
    await page.evaluate(([lon, lat, k]) => (window as any).__wfGlobeSet(lon, lat, k), v);
    await page.waitForTimeout(300);
    // 放大了:等高清贴图(没触发就不等)
    await page.waitForFunction(() => { const g = (window as any).__wfGlobe; return g.tier === 2 || !g.texPending; }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const sel = [...flags].find((f) => f.startsWith('--sel='))?.slice(6);
  if (sel) {
    const ok = await page.evaluate((n) => (window as any).__wfGlobeSelectName(n), sel);
    if (!ok) console.log(`  球上没有「${sel}」这个名字,没选中`);
    // 等球转过去、球心随面板打开挪过去(约 0.6 秒)
    await page.waitForTimeout(900);
    // 详情面板会盖住一边:截图时藏起来(--panel:留着,截整页,看球心左移)
    if (!flags.has('--panel')) {
      await page.addStyleTag({ content: '.inspector{display:none !important}' });
      await page.waitForTimeout(100);
    }
  }
  await page.mouse.move(3, 3);
  const file = shots.length > 1 ? out.replace(/(\.\w+)$/, `-${i + 1}$1`) : out;
  if (flags.has('--panel')) await page.screenshot({ path: file });
  else await page.locator(flags.has('--stage') ? 'main.stage' : '.globe').screenshot({ path: file });
  const g = await page.evaluate(() => (window as any).__wfGlobe);
  if (flags.has('--bench')) {
    const fmt = (b: any) => `中位数 ${b.median.toFixed(1)} ms、p90 ${b.p90.toFixed(1)}、最慢 ${b.max.toFixed(1)};overlay ${b.overlay.toFixed(1)}、place ${b.place.toFixed(1)}、verts ${b.lineVerts}`;
    console.log('  每帧(停着)', fmt(await page.evaluate(() => (window as any).__wfGlobeBench(120))));
    console.log('  每帧(拖着)', fmt(await page.evaluate(() => (window as any).__wfGlobeBench(120, true))));
    await page.waitForTimeout(300);
  }
  console.log(file, JSON.stringify({ lon: g.lon.toFixed(1), lat: g.lat.toFixed(1), k: g.k.toFixed(2), tier: g.tier, hiMs: g.hiMs, tex: g.tex, relief: g.relief, texMs: g.texMs?.toFixed(0), glyphs: g.glyphs, glyphMs: g.glyphMs?.toFixed(2), shift: g.shift, marks: g.marks, labels: g.labels, places: g.places, selVerts: g.selVerts, frameMs: g.frameMs.toFixed(1), texts: g.texts.slice(0, 12) }));
}
if (logs.length) console.log(logs.join('\n'));
await browser.close();
await dev.close();

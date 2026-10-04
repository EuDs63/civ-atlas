/**
 * 冒烟检查:npx tsx scripts/replay-check.ts
 * 界面骨架(地图铺满、四角小字、图层与投影弹层、世界概览浮层、右侧详情面板)、回放、悬停、点选改名、存档读档分享、
 * 导出、干预、改地形、AI、东西相连、多种投影、地球仪;手机布局(390×844 触屏:底部抽屉、两行时间轴、双指捏合)。
 * 种子、参数、回放、改地形在世界概览的"创世"页,存档 / 导出 / AI 在概览头部(点左上角的世界名打开);
 * 某一点的完整读数用 window.__wfProbe(悬停卡片只露一两行)。
 */
import { chromium, type Page } from 'playwright';
import { startDevServer } from './lib/devserver';
const dev = await startDevServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

/**
 * 打开世界概览(点左上角的世界名),翻到某一页:countries 国家 / chronicle 编年史 / interventions 我的干预 /
 * genesis 创世(种子、新世界、参数、回放世界形成、改地形)。头部有存档、导出、AI、成书
 */
const openOverview = async (p: Page = page, tab?: string) => {
  if (!(await p.locator('.ov-root:not([hidden])').count())) await p.click('[data-act=overview]');
  await p.locator('.ov-root:not([hidden]) .ov').waitFor({ timeout: 5000 });
  if (tab) await p.click(`.ov-tab[data-tab=${tab}]`);
  await p.waitForTimeout(200);
};
const closeOverview = async (p: Page = page) => {
  if (await p.locator('.ov-root:not([hidden])').count()) await p.click('.ov-x');
  await p.waitForTimeout(200);
};
/** 图层与投影弹层 */
const openLayers = async (p: Page = page) => {
  if (!(await p.locator('.lp-pop').count())) await p.click('[data-act=layers]');
  await p.locator('.lp-pop').waitFor({ timeout: 5000 });
};
/** 换图层(政区 / 民族 / 地形 / 生态 / 高程 / 实景 / 板块 / 气温 / 降水;点完弹层自己收起) */
const pickLayer = async (p: Page, id: string) => {
  await openLayers(p);
  await p.click(`.lp-pop [data-layer=${id}]`);
};
/** 换投影(点完收起弹层) */
const pickProj = async (p: Page, id: string) => {
  await openLayers(p);
  await p.click(`.lp-proj[data-proj=${id}]`);
  await p.keyboard.press('Escape');
};
/** 弹层里当前选中的投影 */
const projOn = async (p: Page = page) => {
  await openLayers(p);
  const v = await p.locator('.lp-proj.on').getAttribute('data-proj').catch(() => null);
  await p.keyboard.press('Escape');
  return v;
};
/** 进入改地形(概览"创世"页的"改地形";进入后概览收起,顶部出现工具条) */
const terrainOn = async (p: Page = page) => {
  await openOverview(p, 'genesis');
  await p.click('.ov [data-act=terrain]');
  await p.locator('.terrain-bar').waitFor({ timeout: 5000 });
  await p.waitForTimeout(150);
};
/** 回放世界形成(概览"创世"页的按钮;点了概览收起) */
const replayClick = async (p: Page = page) => {
  await openOverview(p, 'genesis');
  await p.click('.ov [data-act=replay]');
};
/** 某一点的完整读数:群落 / 海拔(水深)/ 气温降水 / 经纬度板块 / 国家 · 最近城市 / 民族 / 州(一行一条,用 " / " 连起来) */
const probe = (p: Page, x: number, y: number) =>
  p.evaluate(([cx, cy]) => (((window as any).__wfProbe?.(cx, cy) ?? []) as string[]).join(' / '), [x, y]);
/** 顶部提示条上某个来源的那条(save 存档 / export 导出 / progress 生成……) */
const toastText = (p: Page, id: string, timeout = 3000) =>
  p.locator(`.toast[data-toast=${id}]`).innerText({ timeout }).then((t) => t.replace(/\n/g, ' '), () => '');
// 界面骨架:地图铺满全屏;左上世界名 + 副标;右下"政区 · 等距圆柱";第一次打开有操作提示(拖一下就没了);
// 悬停小卡片(国名 + 州数);右下 + − 缩放;弹层:缩略图、切到实景 → 深色主题、网址记下;叠加开关(地名……)、民族图例;
// 世界概览:打开、四个页签、Esc / 点外面收起、国家表点一行 → 概览收起、选中这国;点国家 → 右侧面板(宽 340)、右下按钮左移
{
  await page.goto(`${dev.url}/?seed=7`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const vp = page.viewportSize()!;
  const stage = (await page.locator('main.stage').boundingBox())!;
  const mapBox = (await page.locator('.map-box').boundingBox())!;
  const title = (await page.locator('.world-title').innerText()).replace(/\n/g, ' ');
  const label0 = await page.locator('.lp-btn').innerText();
  const theme0 = await page.locator('.app').getAttribute('data-theme');
  const hint0 = await page.locator('.first-hint').count();
  const oldChrome = await page.locator('header:not(.ov-head), aside').count();
  // 右下 + −
  const k0 = (await page.evaluate(() => (window as any).__wfView)).k;
  await page.click('[data-act=zoom-in]');
  await page.waitForTimeout(150);
  const k1 = (await page.evaluate(() => (window as any).__wfView)).k;
  await page.click('[data-act=zoom-out]');
  await page.waitForTimeout(150);
  const k2 = (await page.evaluate(() => (window as any).__wfView)).k;
  // 拖一下
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(760, 410, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const hint1 = await page.locator('.first-hint').count();
  // 悬停小卡片:国家图层上显示"某国 N 州"
  let card = '';
  for (let i = 0; i < 80 && !/\d+ 州/.test(card); i++) {
    await page.mouse.move(150 + ((i * 197) % 1000), 160 + ((i * 83) % 460));
    await page.waitForTimeout(25);
    card = (await page.locator('.hover-card').innerText().catch(() => '')).replace(/\n/g, ' ');
  }
  // 弹层:缩略图做出来;切到实景
  await page.click('[data-act=layers]');
  const pop = (await page.locator('.lp-pop').innerText().catch(() => '')).replace(/\n/g, ' ');
  await page.waitForFunction(() => document.querySelectorAll('.lp-layer .lp-thumb:not(.empty)').length >= 6, null, { timeout: 20000 }).catch(() => {});
  const thumbs = await page.locator('.lp-layer .lp-thumb:not(.empty)').count();
  await page.click('.lp-layer[data-layer=realistic]');
  await page.waitForFunction(() => (window as any).__wf?.style === 'realistic', null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const theme1 = await page.locator('.app').getAttribute('data-theme');
  const label1 = await page.locator('.lp-btn').innerText();
  const url1 = page.url();
  const popClosed = !(await page.locator('.lp-pop').count());
  await pickLayer(page, 'political');
  await page.waitForTimeout(300);
  const theme2 = await page.locator('.app').getAttribute('data-theme');
  // 弹层里的叠加开关:点"州"打开州界(弹层不收),再点关掉;选"民族"时下面列出民族色块
  await page.click('[data-act=layers]');
  const togs = (await page.locator('.lp-toggles').innerText().catch(() => '')).replace(/\n/g, ' ');
  await page.click('.lp-tog[data-civ=regions]');
  const regionsOn = (await page.locator('.lp-tog[data-civ=regions]').getAttribute('aria-checked')) === 'true';
  const stillOpen = (await page.locator('.lp-pop').count()) === 1;
  await page.click('.lp-tog[data-civ=regions]');
  await page.click('.lp-pop [data-layer=cultures]');
  await page.click('[data-act=layers]');
  const cultureKeys = await page.locator('.lp-cultures .lp-cu').count();
  await page.click('.lp-pop [data-layer=political]');
  await page.waitForTimeout(300);
  // 世界概览:点世界名打开;头部、四个页签;Esc 收起;点外面收起
  await page.click('[data-act=overview]');
  await page.waitForTimeout(300);
  const ovOpen = await page.locator('.ov-root:not([hidden]) .ov').isVisible();
  const ovHead = (await page.locator('.ov-head').innerText()).replace(/\n/g, ' ');
  const ovTabs = (await page.locator('.ov-tabs').innerText()).replace(/\n/g, ' ');
  const ovRows = await page.locator('.ov-countries .ov-row').count();
  const pages: Record<string, string> = {};
  for (const t of ['chronicle', 'interventions', 'genesis']) {
    await page.click(`.ov-tab[data-tab=${t}]`);
    await page.waitForTimeout(200);
    pages[t] = (await page.locator('.ov-body').innerText()).replace(/\n/g, ' ');
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const escClosed = !(await page.locator('.ov-root:not([hidden])').count());
  await page.click('[data-act=overview]');
  await page.mouse.click(8, vp.height / 2);
  await page.waitForTimeout(200);
  const scrimClosed = !(await page.locator('.ov-root:not([hidden])').count());
  // 国家表点一行:概览收起,选中这国(右侧面板)
  await openOverview(page, 'countries');
  const rowName = (await page.locator('.ov-countries .ov-row:not(.dead) .ov-name').first().innerText()).trim();
  await page.click('.ov-countries .ov-row:not(.dead) >> nth=0');
  await page.waitForTimeout(300);
  const rowClosed = !(await page.locator('.ov-root:not([hidden])').count());
  const rowIns = (await page.locator('.inspector').innerText({ timeout: 3000 }).catch(() => '')).replace(/\n/g, ' ');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // 点国家:右侧面板,右下按钮左移
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const pol = ((await page.evaluate('window.__wfPickables()')) as Pick[])
    .filter((q) => q.kind === 'polity' && q.x > 200 && q.x < vp.width - 420 && q.y > 120 && q.y < vp.height - 140)
    .sort((a, b) => Math.abs(a.x - vp.width / 2) - Math.abs(b.x - vp.width / 2))[0];
  let ins: { x: number; y: number; width: number; height: number } | null = null;
  let shifted = 0;
  if (pol) {
    await page.mouse.click(pol.x, pol.y);
    ins = await page.locator('.inspector').boundingBox({ timeout: 3000 }).catch(() => null);
    shifted = await page.locator('.map-controls.shifted').count();
    await page.keyboard.press('Escape');
  }
  console.log(
    `界面骨架:舞台 ${stage.width}×${stage.height}(视口 ${vp.width}×${vp.height}),地图框 ${Math.round(mapBox.width)}×${Math.round(mapBox.height)};左上「${title}」;右下「${label0}」;` +
      `主题 ${theme0};首次提示 ${hint0} → 拖动后 ${hint1};缩放按钮 ${k0} → ${k1.toFixed(2)} → ${k2.toFixed(2)};悬停「${card}」;` +
      `弹层「${pop.slice(0, 40)}…」缩略图 ${thumbs} 张;切实景 → 主题 ${theme1}、按钮「${label1}」、弹层收起 ${popClosed}、网址 ${url1.split('?')[1]};切回政区 → 主题 ${theme2};` +
      `叠加开关「${togs}」:点"州" ${regionsOn}、弹层不收 ${stillOpen};民族色块 ${cultureKeys} 个;` +
      `概览打开 ${ovOpen}、头部「${ovHead}」、页签「${ovTabs}」、国家 ${ovRows} 行;编年史「${pages.chronicle?.slice(0, 30)}…」;我的干预「${pages.interventions}」;` +
      `创世「${pages.genesis?.slice(0, 40)}…」;Esc 收起 ${escClosed}、点外面收起 ${scrimClosed};国家表点「${rowName}」→ 概览收起 ${rowClosed}、面板「${rowIns.slice(0, 30)}」;` +
      `点「${pol?.text}」→ 面板 ${ins ? `${Math.round(ins.width)}×${Math.round(ins.height)} @ ${Math.round(ins.x)},${Math.round(ins.y)}` : '没出来'}、右下按钮左移 ${shifted}`,
  );
  if (stage.width !== vp.width || stage.height !== vp.height) errs.push('界面骨架:地图没有铺满全屏');
  if (!(mapBox.height >= vp.height - 1 && mapBox.width >= vp.width - 1)) errs.push('界面骨架:地图框没有盖满舞台');
  if (oldChrome) errs.push('界面骨架:页面里还有 header / aside 元素(顶栏、侧边栏已经去掉,地图应铺满全屏)');
  if (!/未命名世界/.test(title) || !/种子 7 · 现存 \d+ 国 · 未干预 · 查看概览/.test(title)) errs.push(`界面骨架:左上角的世界名 / 副标不对(${title})`);
  if (label0 !== '政区 · 等距圆柱' || theme0 !== 'light') errs.push(`界面骨架:默认图层应为"政区 · 等距圆柱"、浅色(${label0},${theme0})`);
  if (hint0 !== 1 || hint1 !== 0) errs.push('界面骨架:第一次打开的操作提示没出现 / 拖动后没消失');
  if (!(k1 > 1.4 && Math.abs(k2 - 1) < 0.01)) errs.push(`界面骨架:右下的 + − 没有缩放(${k0} → ${k1} → ${k2})`);
  if (!/\d+ 州/.test(card)) errs.push(`界面骨架:国家图层上悬停没有"国名 N 州"(${card})`);
  if (!pop.includes('图层') || !pop.includes('投影') || !pop.includes('中央经线') || !pop.includes('经纬网')) errs.push('界面骨架:图层与投影弹层内容不全');
  if (thumbs < 6) errs.push(`界面骨架:弹层里的缩略图没做出来(${thumbs} 张)`);
  if (theme1 !== 'dark' || label1 !== '实景 · 等距圆柱' || !popClosed || !/[?&]layer=realistic/.test(url1)) errs.push(`界面骨架:切到实景不对(主题 ${theme1},按钮 ${label1},网址 ${url1})`);
  if (theme2 !== 'light') errs.push('界面骨架:切回政区后没换回浅色主题');
  if (!['地名', '宜居度', '州', '城址', '道路'].every((w) => togs.includes(w)) || !regionsOn || !stillOpen) errs.push(`图层弹层:叠加开关不全 / 点了没反应(${togs})`);
  if (cultureKeys < 2) errs.push(`图层弹层:选"民族"时没有列出民族色块(${cultureKeys})`);
  if (!ovOpen || !['存档', '导出', '成书', 'AI', '国家 现存 / 共', '民族', '城镇', '种子 7', '当前'].every((w) => ovHead.includes(w))) errs.push(`世界概览:打不开 / 头部不全(${ovHead})`);
  if (!['国家', '编年史', '我的干预 0', '创世'].every((w) => ovTabs.includes(w)) || ovRows < 3) errs.push(`世界概览:页签不全 / 国家表没有列出国家(${ovTabs};${ovRows} 行)`);
  if (!/大事 \d+/.test(pages.chronicle ?? '') || !(pages.interventions ?? '').includes('还没有干预')) errs.push('世界概览:编年史页 / 我的干预页(空)不对');
  if (!['新世界', '世界参数', '回放世界形成', '改地形', '地块', '板块', '河流'].every((w) => (pages.genesis ?? '').includes(w))) errs.push(`世界概览:创世页功能不全(${pages.genesis})`);
  if (!escClosed || !scrimClosed) errs.push('世界概览:Esc / 点外面收不起');
  if (!rowClosed || !rowIns.includes(rowName)) errs.push(`世界概览:国家表点一行没有收起概览、选中这国(${rowName};${rowIns.slice(0, 40)})`);
  if (!ins || Math.abs(ins.width - 340) > 2 || Math.abs(ins.x + ins.width - (vp.width - 20)) > 2 || !shifted) errs.push('界面骨架:点国家后右侧面板的位置不对 / 右下按钮没有左移');
  await page.evaluate(() => localStorage.clear());
}

await page.goto(`${dev.url}/?seed=7&style=realistic`);
await page.waitForFunction(() => (window as any).__wf?.ready);

// 地名(默认打开):第一次画字时字体就已经加载好(不闪默认字体),画出来的条数合理;滚轮放大后按新的倍数重画
const labelsOk = await page
  .waitForFunction(() => (window as any).__wfLabels?.ready, null, { timeout: 30000 })
  .then(() => true, () => false);
const labels = await page.evaluate(() => (window as any).__wfLabels);
console.log('地名:', JSON.stringify(labels));
if (!labelsOk || !(labels?.drawn > 5)) errs.push('地名没有画出来');
if (labels && !labels.firstFontOk) errs.push('第一次画地名时字体还没加载好(会闪一下默认字体)');
{
  const box = (await page.locator('.map-box').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => (window as any).__wfLabels?.k > 1.5, null, { timeout: 10000 }).catch(() => {});
  const z = await page.evaluate(() => (window as any).__wfLabels);
  console.log('放大后地名:', JSON.stringify(z));
  if (!(z?.k > 1.5) || !(z?.drawn > 5)) errs.push('放大后地名没有重画');
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(200);
}
await replayClick();
await page.waitForTimeout(1600);
await page.screenshot({ path: 'snaps/replay-a.png' });
await page.waitForTimeout(1600);
await page.screenshot({ path: 'snaps/replay-b.png' });
// 某一点的读数(回放时悬停卡片不出来,读数照常)
await page.mouse.move(900, 400);
await page.waitForTimeout(300);
const hover = await probe(page, 900, 400);
console.log('读数:', hover || '(无)');
if (!hover.includes('海拔') && !hover.includes('水深')) errs.push('某一点的读数(海拔 / 水深)没有');

// 每次画完地图都会换一个新的 window.__wf;先在旧的上做个记号,记号消失 = 画了新的一张
const wf = () => page.evaluate(() => (window as any).__wf);
const markWf = () => page.evaluate(() => ((window as any).__wf.mark = 1));
const waitRedraw = () => page.waitForFunction(() => !(window as any).__wf.mark, null, { timeout: 30000 });
// 回放按钮在概览"创世"页(点了概览收起);地质放完时字幕从"约 N 百万年前 / 今天"换成文明回放的"第 N 年"
const replayBtn = page.locator('.ov button.replay');
const IDLE = '回放世界形成';
await page.waitForFunction(() => /第 \d+ 年/.test(document.querySelector('.caption .big')?.textContent ?? ''), null, { timeout: 20000 });

// 地质放完接着放文明:时间轴从第 0 年往后走,色块用半分辨率,每帧耗时(底图 + 国名、城镇符号的文字层)要在预算内
const civFrames = await page.evaluate(async () => {
  const w = window as any;
  const ms: number[] = [];
  const years: number[] = [];
  let last: unknown = null;
  const t0 = performance.now();
  while (performance.now() - t0 < 2500) {
    await new Promise((r) => requestAnimationFrame(r));
    const c = w.__wfCiv;
    if (c && c !== last && c.fast) {
      const l = w.__wfLabels;
      ms.push(c.ms + (l && l.fast && Math.abs(l.year - c.year) < 1e-6 ? l.ms : 0));
      years.push(c.year);
    }
    last = c;
  }
  return { ms, years, caption: document.querySelector('.caption .big')?.textContent ?? '', bar: !!document.querySelector('.civ-timeline') };
});
const sorted = [...civFrames.ms].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? NaN;
console.log(
  `文明回放:${civFrames.ms.length} 帧,第 ${Math.round(civFrames.years[0] ?? NaN)} → ${Math.round(civFrames.years.at(-1) ?? NaN)} 年,` +
    `每帧(底图 + 文字层)中位数 ${median.toFixed(1)} ms、最慢 ${(sorted.at(-1) ?? NaN).toFixed(1)} ms;字幕 ${JSON.stringify(civFrames.caption)}`,
);
if (civFrames.ms.length < 5 || !(civFrames.years.at(-1)! > civFrames.years[0])) errs.push('地质回放放完后文明回放没有接着放');
if (!civFrames.bar || !/第 \d+ 年/.test(civFrames.caption)) errs.push('文明回放时没有时间轴 / "第 N 年"字幕');
// 本机约 10–20 ms;CI 的虚拟机慢两三倍,同一段回放在 CI 上 16–40 ms 来回跳,预算放宽到 2 倍
const REPLAY_BUDGET = process.env.CI ? 60 : 30;
if (!(median <= REPLAY_BUDGET)) errs.push(`文明回放每帧太慢(中位数 ${median.toFixed(1)} ms,预算 ${REPLAY_BUDGET} ms)`);
// 悬停时显示民族名
await page.mouse.move(1150, 330);
await page.waitForTimeout(300);
const civHover = await page.locator('.hover').innerText().catch(() => '');
console.log('文明回放时悬停:', civHover.replace(/\n/g, ' / ') || '(无)');

// 同一个世界里切回画过的画风:直接贴缓存,不重画
for (const id of ['terrain', 'realistic', 'terrain']) {
  await markWf();
  await pickLayer(page, id);
  await waitRedraw();
}
const cached = await wf();
console.log('切回画过的画风 renderMs:', cached.renderMs.toFixed(1));
if (!(cached.renderMs < 20)) errs.push(`切回画过的画风仍在重画(renderMs=${cached.renderMs.toFixed(1)})`);

// 回放中点"新世界":新世界出来后回放按钮要恢复正常、还能再点
await replayClick();
await page.waitForTimeout(1000);
await markWf();
await openOverview(page, 'genesis');
await page.click('.ov [data-act=new-world]');
const newClosed = !(await page.locator('.ov-root:not([hidden])').count());
// 生成新世界时顶部提示条上有进度
const genToast = await page.locator('.toast[data-toast=progress]').innerText({ timeout: 5000 }).catch(() => '');
await waitRedraw();
console.log(`新世界:生成时提示条「${genToast.replace(/\n/g, ' ')}」`);
if (!genToast) errs.push('生成新世界时顶部提示条上没有进度');
if (!newClosed) errs.push('点"新世界"后概览没有收起');
await openOverview(page, 'genesis');
const txt = await replayBtn.innerText();
const off = await replayBtn.isDisabled();
console.log('回放中换新世界后按钮:', JSON.stringify(txt), off ? '(禁用)' : '(可点)');
if (txt !== IDLE || off) errs.push(`回放中换新世界后按钮卡住了:${txt}${off ? '(禁用)' : ''}`);
else {
  await replayBtn.click();
  const replays = await page
    .waitForFunction(() => /百万年前|今天/.test(document.querySelector('.caption .big')?.textContent ?? ''), null, { timeout: 15000 })
    .then(() => true, () => false);
  if (!replays) errs.push('新世界点回放没有开始播放');
}

// 打开"民族"视图:悬停在有人住的地方要显示"XX族"
await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=cultures`);
await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 60000 });
const box = (await page.locator('.map-box canvas').first().boundingBox())!;
let people = '';
for (let i = 0; i < 40 && !people; i++) {
  await page.mouse.move(box.x + box.width * (0.1 + 0.8 * ((i * 0.618) % 1)), box.y + box.height * (0.2 + 0.6 * ((i * 0.382) % 1)));
  await page.waitForTimeout(40);
  const t = await page.locator('.hover').innerText().catch(() => '');
  if (t.includes('族')) people = t;
}
console.log('民族视图悬停:', people.replace(/\n/g, ' / ') || '(没找到有人住的地方)');
if (!people) errs.push('民族视图下悬停没有显示"XX族"');
if (!(await page.locator('.civ-timeline').isVisible())) errs.push('打开"民族"后没有时间轴');

// 打开"国家"视图:首次绘制文明层(底图 + 国名、城名、城镇符号的文字层)≤ 150 ms;概览的国家页列出这一年的国家;
// 悬停显示"某国 · 最近城市 某城";从第 1500 年按 4× 接着放,国家、城市随年份变化时每帧(底图 + 文字层)≤ 30 ms。
// CI 的虚拟机比一般电脑慢两三倍(同一段回放每帧耗时约是本机的 2.5 倍),首次绘制的预算在 CI 上放宽到 2 倍
const DRAW_BUDGET = process.env.CI ? 300 : 150;
for (const style of ['realistic', 'fantasy']) {
  await page.goto(`${dev.url}/?seed=7&style=${style}&civ=polities,routes&civYear=1500`);
  await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 60000 });
  // 文字层等字体加载好才画;画出国名、城镇符号才算画完
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 30000 }).catch(() => {});
  const civMs = await page.evaluate(() => (window as any).__wfCiv.ms as number);
  const lab = await page.evaluate(() => (window as any).__wfLabels);
  const first = civMs + (lab?.ms ?? NaN);
  await openOverview(page, 'countries');
  const nations = await page.locator('.ov-countries .ov-row:not(.dead)').count();
  await closeOverview();
  console.log(
    `国家视图(${style}):首次绘制 ${first.toFixed(1)} ms(底图 ${civMs.toFixed(1)} + 文字层 ${(lab?.ms ?? NaN).toFixed(1)}),` +
      `国名 ${lab?.polities} 个、城镇符号 ${lab?.marks} 个、文字 ${lab?.drawn} 条,图例 ${nations} 行`,
  );
  if (!(first <= DRAW_BUDGET)) errs.push(`国家视图首次绘制太慢(${first.toFixed(1)} ms,预算 ${DRAW_BUDGET} ms)`);
  if (!(lab?.polities > 0) || !(lab?.marks > 0)) errs.push('国家视图没有画出国名 / 城镇符号');
  if (nations < 2) errs.push('国家视图的图例没有列出国家');
  if (style === 'realistic') {
    let found = '';
    let card = '';
    // 先在国名上悬停(国名写在国土上),再在地图上撒点找
    const spots = ((await page.evaluate('window.__wfPickables()')) as { kind: string; x: number; y: number }[]).filter((p) => p.kind === 'polity');
    for (let i = 0; i < spots.length + 200 && !found; i++) {
      if (i < spots.length) await page.mouse.move(spots[i].x, spots[i].y);
      else await page.mouse.move(box.x + box.width * (0.05 + 0.9 * ((i * 0.618) % 1)), box.y + box.height * (0.1 + 0.8 * ((i * 0.382) % 1)));
      await page.waitForTimeout(30);
      const x = i < spots.length ? spots[i].x : box.x + box.width * (0.05 + 0.9 * ((i * 0.618) % 1));
      const y = i < spots.length ? spots[i].y : box.y + box.height * (0.1 + 0.8 * ((i * 0.382) % 1));
      const t = (await probe(page, x, y)).replace(/ \/ /g, '\n');
      // 国名可能是"索拉特王国",也可能是东方的"大昌"、"景辰王朝":只要"某国 · 最近城市",不是部落地带
      if (/^(?!部落地带).+ · 最近城市/m.test(t)) {
        found = t;
        // 悬停小卡片:国名 + 州数
        card = (await page.locator('.hover-card').innerText().catch(() => '')).replace(/\n/g, ' ');
      }
    }
    console.log('国家视图读数:', found.replace(/\n/g, ' / ') || '(没找到国内的地方)', `;悬停卡片「${card}」`);
    if (!found) errs.push('国家视图下读数里没有"某国 · 最近城市"');
    else if (!/\d+ 州/.test(card)) errs.push(`国家视图下悬停卡片没有"国名 N 州"(${card})`);
  }
  await page.mouse.move(5, 5);
  await page.click('.timebar .tb-speed button:has-text("4×")');
  await page.click('.timebar button.tb-play');
  const frames = await page.evaluate(async () => {
    const w = window as any;
    const ms: number[] = [];
    const years: number[] = [];
    const text: number[] = [];
    let last: unknown = null;
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      await new Promise((r) => requestAnimationFrame(r));
      const c = w.__wfCiv;
      if (c && c !== last && c.fast) {
        // 这一帧的文字层(国名、城镇符号随年份重画):同一年画的那次
        const l = w.__wfLabels;
        const lm = l && l.fast && Math.abs(l.year - c.year) < 1e-6 ? l.ms : 0;
        ms.push(c.ms + lm);
        text.push(lm);
        years.push(c.year);
      }
      last = c;
    }
    return { ms, years, text };
  });
  const fs = [...frames.ms].sort((a, b) => a - b);
  const med = fs[fs.length >> 1] ?? NaN;
  const ts = [...frames.text].sort((a, b) => a - b);
  console.log(
    `国家视图回放(${style}):${fs.length} 帧,第 ${Math.round(frames.years[0] ?? NaN)} → ${Math.round(frames.years.at(-1) ?? NaN)} 年,` +
      `每帧(底图 + 文字层)中位数 ${med.toFixed(1)} ms、最慢 ${(fs.at(-1) ?? NaN).toFixed(1)} ms;其中文字层中位数 ${(ts[ts.length >> 1] ?? NaN).toFixed(1)} ms`,
  );
  if (fs.length < 5) errs.push('国家视图点播放后没有接着放');
  if (!(med <= REPLAY_BUDGET)) errs.push(`国家视图回放每帧太慢(中位数 ${med.toFixed(1)} ms,预算 ${REPLAY_BUDGET} ms)`);
}

// 时间轴:打开网页从第 2600 年起按 1× 自动播放(无头浏览器里默认不播,网址加 play=1);经过大事时事发地出标签、
// 左下出最近事件;4× 快四倍;放到第 3000 年停下,再点播放从 2600 年重播;点最近事件跳到那一年、地图高亮事发地;点国家暂停
{
  const tlState = () =>
    page.evaluate(() => ({
      year: Number(document.querySelector('.timebar .tb-year')?.textContent?.match(/\d+/)?.[0] ?? NaN),
      playing: !!document.querySelector('.timebar .tb-play.on'),
    }));
  const visiblePin = (timeout: number) =>
    page
      .waitForFunction(() => [...document.querySelectorAll('.ev-pin')].find((e) => (e as HTMLElement).style.visibility === 'visible')?.textContent ?? '', null, { timeout })
      .then((h) => h.jsonValue() as Promise<string>, () => '');
  await page.goto(`${dev.url}/?seed=7&style=fantasy&play=1`);
  await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 60000 });
  const s0 = await tlState();
  const pin = await visiblePin(15000);
  const recent = await page.locator('.recent-ev .recent-row').count();
  const a = await tlState();
  await page.waitForTimeout(1000);
  const b = await tlState();
  await page.click('.timebar .tb-speed button:has-text("4×")');
  const c = await tlState();
  await page.waitForTimeout(1000);
  const d = await tlState();
  const stopped = await page
    .waitForFunction(() => !document.querySelector('.timebar .tb-play.on') && document.querySelector('.timebar .tb-year')?.textContent === '第 3000 年', null, { timeout: 20000 })
    .then(() => true, () => false);
  await page.click('.timebar button.tb-play');
  await page.waitForTimeout(150);
  const again = await tlState();
  // 点左下倒数第二条最近事件
  const rows = page.locator('.recent-ev .recent-row');
  const nRows = await rows.count();
  const row = rows.nth(Math.max(0, nRows - 2));
  const rowYear = Number((await row.locator('.recent-year').innerText().catch(() => '')).trim());
  const h0 = await page.evaluate(() => (window as any).__wfHighlight?.stamp ?? 0);
  await row.click();
  await page.waitForFunction((s) => (window as any).__wfHighlight?.stamp > s, h0, { timeout: 5000 }).catch(() => {});
  const jumped = await tlState();
  const lit = await page.evaluate(() => (window as any).__wfHighlight?.lit ?? 0);
  const jumpPin = await visiblePin(3000);
  // 接着放,再点一个国家:暂停
  await page.click('.timebar button.tb-play');
  await page.waitForTimeout(300);
  const before = await tlState();
  const spots = ((await page.evaluate('window.__wfPickables()')) as { kind: string; x: number; y: number }[]).filter((p) => p.kind === 'polity');
  if (spots.length) await page.mouse.click(spots[0].x, spots[0].y);
  await page.waitForTimeout(300);
  const paused = await tlState();
  await page.keyboard.press('Escape');
  const rate1 = b.year - a.year;
  const rate4 = d.year - c.year;
  console.log(
    `时间轴:打开 → 第 ${s0.year} 年${s0.playing ? '(在放)' : '(停着)'};标签「${pin.slice(0, 40)}」;最近事件 ${recent} 条;` +
      `1× 每秒 ${rate1} 年、4× 每秒 ${rate4} 年;放到头停下 ${stopped},再点播放 → 第 ${again.year} 年;` +
      `点最近事件第 ${rowYear} 年 → 时间轴第 ${jumped.year} 年${jumped.playing ? '(在放)' : '(停着)'},高亮 ${lit} 州,标签「${jumpPin.slice(0, 30)}」;` +
      `播放中点国家 → ${before.playing && !paused.playing ? '暂停' : '没暂停'}`,
  );
  if (!s0.playing || !(s0.year >= 2600 && s0.year <= 2660)) errs.push(`时间轴:打开网页没有从第 2600 年起自动播放(第 ${s0.year} 年${s0.playing ? '' : ',没在放'})`);
  if (!pin) errs.push('时间轴:播放经过大事时地图上没有出事件标签');
  if (!(recent >= 1 && recent <= 4)) errs.push(`时间轴:左下最近事件应有 1–4 条(${recent})`);
  if (!(rate1 >= 12 && rate1 <= 30)) errs.push(`时间轴:1× 应每秒约 20 年(${rate1})`);
  if (!(rate4 >= 50 && rate4 <= 110)) errs.push(`时间轴:4× 应每秒约 80 年(${rate4})`);
  if (!stopped) errs.push('时间轴:放到第 3000 年没有停下');
  if (!again.playing || !(again.year >= 2600 && again.year <= 2640)) errs.push(`时间轴:放完再点播放没有从第 2600 年重播(第 ${again.year} 年)`);
  if (!rowYear || jumped.year !== rowYear || jumped.playing) errs.push(`时间轴:点最近事件没有跳到那一年并暂停(第 ${rowYear} 年 → 第 ${jumped.year} 年)`);
  if (!(lit > 0)) errs.push('时间轴:点最近事件后地图上没有高亮事发地');
  if (!jumpPin) errs.push('时间轴:点最近事件后事发地没有标签');
  if (!spots.length || !before.playing || paused.playing) errs.push('时间轴:播放中点国家没有暂停');
  // 无头浏览器里默认不自动播放(截图固定),网址给了 civYear 也不播
  await page.goto(`${dev.url}/?seed=7&style=fantasy`);
  await page.waitForFunction(() => (window as any).__wfCiv?.ready || (window as any).__wfLabels?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const still = await tlState();
  if (still.playing) errs.push('时间轴:无头浏览器里不该自动播放');
}

// 编年史(阶段 3):世界概览的编年史页点一条:时间轴跳到那一年并暂停,地图上高亮事发地,还没发生的淡显
{
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 60000 });
  // 时间轴上的大事菱形:有菱形、每 100 年一格刻度;悬停出提示;点一个 → 时间轴跳到那一年、地图上高亮(和点编年史的一条一样)
  {
    const nDots = await page.locator('.timebar .tb-mark').count();
    const nTicks = await page.locator('.timebar .tb-tick').count();
    const single = page.locator('.timebar .tb-mark[data-n="1"]');
    const ns = await single.count();
    const dot = single.nth(Math.floor(ns / 2));
    const want = ns ? await dot.getAttribute('data-year') : null;
    const b = ns ? await dot.boundingBox() : null;
    let tip = '';
    let tl = '';
    let lit = 0;
    if (b) {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      tip = await page
        .locator('.tb-tip')
        .innerText({ timeout: 3000 })
        .catch(() => '');
      const s0 = await page.evaluate(() => (window as any).__wfHighlight?.stamp ?? 0);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForFunction((s) => (window as any).__wfHighlight?.stamp > s, s0, { timeout: 5000 }).catch(() => {});
      tl = await page.locator('.timebar .tb-year').innerText();
      lit = await page.evaluate(() => (window as any).__wfHighlight?.lit ?? 0);
    }
    console.log(`时间轴刻度:菱形 ${nDots}、百年刻度 ${nTicks};悬停「${tip.replace(/\n/g, ' ')}」;点第 ${want} 年的菱形 → 时间轴 ${tl},高亮 ${lit} 州`);
    if (nDots < 5) errs.push(`时间轴上没有大事菱形(${nDots})`);
    if (nTicks !== 31) errs.push(`时间轴的百年刻度不对(${nTicks} 格,应为 31)`);
    if (!/\d+ 年/.test(tip)) errs.push('悬停在刻度上没有出提示');
    if (!want || tl !== `第 ${want} 年`) errs.push(`点时间轴上的刻度后年份没有跟着变(刻度 ${want},时间轴 ${tl})`);
    if (!(lit > 0)) errs.push('点时间轴上的刻度后地图上没有高亮');
    await page.mouse.move(5, 5);
  }
  // 时间轴上没有"编年史"按钮(编年史在世界概览里);概览的编年史页(新的在上)点一条:概览收起,时间轴跳到那一年、地图高亮
  if (await page.locator('.timebar button:has-text("编年史")').count()) errs.push('时间轴上还有"编年史"按钮');
  await openOverview(page, 'chronicle');
  const opened = await page
    .waitForSelector('.ov .chronicle .chron-row', { timeout: 10000 })
    .then(() => true, () => false);
  const rows = page.locator('.chron-list > .chron-item > .chron-row');
  const n = await rows.count();
  const row = rows.nth(Math.min(Math.floor(n * 0.7), Math.max(0, n - 1)));
  const label = opened ? await row.innerText() : '';
  const want = label.match(/\d+/)?.[0];
  if (opened) await row.click();
  await page.waitForFunction(() => (window as any).__wfHighlight?.stamp > 0, null, { timeout: 5000 }).catch(() => {});
  const chronClosed = !(await page.locator('.ov-root:not([hidden])').count());
  const tl = await page.locator('.timebar .tb-year').innerText().catch(() => '');
  const hl = await page.evaluate(() => (window as any).__wfHighlight);
  // 再打开编年史页:那一年之后的事淡显
  await openOverview(page, 'chronicle');
  const future = await page.locator('.chron-row[data-st=future]').count();
  await closeOverview();
  console.log(
    `编年史:${n} 条;点「${label.replace(/\n/g, ' ')}」→ 概览收起 ${chronClosed}、时间轴 ${tl},高亮 ${hl?.lit} 州(${hl?.ms?.toFixed(1)} ms),淡显 ${future} 条`,
  );
  if (!opened || n < 3) errs.push('编年史页没有打开 / 没有列出纪事');
  if (!chronClosed) errs.push('点编年史的一条后概览没有收起');
  if (!want || tl !== `第 ${want} 年`) errs.push(`点编年史的一条后时间轴没有跳到那一年(条目 ${want},时间轴 ${tl})`);
  if (!(hl?.lit > 0)) errs.push('点编年史的一条后地图上没有高亮');
  if (!(future > 0)) errs.push('编年史里还没发生的事没有淡显');

  // 导出(阶段 4):顶栏"导出 → 地图图片",接住下载的 PNG:尺寸对、不是空白、文件名带种子和时间轴当前的年份;
  // 再导一张 16 位高度图:位深、尺寸对,海平面灰度和提示里写的一致
  {
    const year = (await page.locator('.timebar .tb-year').innerText().catch(() => '')).match(/\d+/)?.[0];
    const grab = async (job: string) => {
      await openOverview();
      await page.click('.export-btn');
      await page.click('.export-scale button:nth-child(1)');
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.click(`.export-item[data-job=${job}]`),
      ]);
      const file = await dl.path();
      const buf = file ? (await import('node:fs')).readFileSync(file) : Buffer.alloc(0);
      return { name: dl.suggestedFilename(), buf, dbg: await page.evaluate(() => (window as any).__wfExport) };
    };
    const { PNG } = await import('pngjs');
    try {
      const map = await grab('map');
      const png = PNG.sync.read(map.buf);
      // 不是空白:抽样看亮度的起伏,且没有透明像素
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      let clear = 0;
      for (let i = 0; i < png.data.length; i += 4 * 97) {
        const l = png.data[i] * 0.3 + png.data[i + 1] * 0.59 + png.data[i + 2] * 0.11;
        sum += l;
        sum2 += l * l;
        n++;
        if (png.data[i + 3] < 255) clear++;
      }
      const sd = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
      console.log(
        `导出地图图片:${map.name},${png.width}×${png.height},${(map.buf.length / 1e6).toFixed(1)} MB,亮度标准差 ${sd.toFixed(1)},` +
          `文字 ${map.dbg?.detail?.labelCount} 条,用时 ${map.dbg?.ms?.toFixed(0)} ms`,
      );
      if (png.width !== 2048 || png.height !== 1024) errs.push(`导出的地图图片尺寸不对(${png.width}×${png.height})`);
      if (!(sd > 10) || clear > 0) errs.push(`导出的地图图片像是空白的(亮度标准差 ${sd.toFixed(1)},透明像素 ${clear})`);
      if (!(map.dbg?.detail?.labelCount > 5)) errs.push('导出的地图图片上没有地名');
      if (!year || !map.name.includes(`种子7-第${year}年-手绘`)) errs.push(`导出的文件名没带种子 / 时间轴当前的年份(${map.name},时间轴第 ${year} 年)`);

      // 同一张图导成 JPEG:是 JPEG、尺寸对、比 PNG 小得多
      const jpg = await grab('mapjpg');
      const isJpeg = jpg.buf[0] === 0xff && jpg.buf[1] === 0xd8 && jpg.buf[2] === 0xff;
      console.log(
        `导出地图 JPEG:${jpg.name},${jpg.dbg?.w}×${jpg.dbg?.h},${(jpg.buf.length / 1e6).toFixed(2)} MB` +
          `(PNG ${(map.buf.length / 1e6).toFixed(2)} MB,是它的 1/${(map.buf.length / Math.max(1, jpg.buf.length)).toFixed(1)})`,
      );
      if (!isJpeg || !jpg.name.endsWith('.jpg') || jpg.dbg?.w !== 2048) errs.push(`导出的 JPEG 不对(${jpg.name},${jpg.buf.length} 字节)`);
      if (!(jpg.buf.length < map.buf.length / 2)) errs.push(`JPEG 没比 PNG 小多少(${jpg.buf.length} / ${map.buf.length} 字节)`);

      const hm = await grab('height16');
      const h = PNG.sync.read(hm.buf, { skipRescale: true });
      const status = await toastText(page, 'export');
      const sea = Number(status.match(/海平面 = 灰度 (\d+)/)?.[1]);
      console.log(`导出 16 位高度图:${hm.name},${h.width}×${h.height},位深 ${h.depth};提示「${status.replace(/\n/g, ' ')}」`);
      if (h.width !== 2048 || h.height !== 1024 || h.depth !== 16) errs.push(`16 位高度图不对(${h.width}×${h.height},位深 ${h.depth})`);
      if (!(sea > 0 && sea < 65535) || sea !== hm.dbg?.seaLevel) errs.push('16 位高度图导出后没有写海平面灰度');
    } catch (e) {
      errs.push(`导出失败:${(e as Error).message}`);
    }
    await closeOverview();
  }
}

// 点选 + 改名(阶段 4):拖动地图不选中;点一座城 → 详情面板 → 改名 → 地图上的字、悬停都变了 → 恢复默认 → Esc 关面板
{
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const mb = (await page.locator('.map-box').boundingBox())!;
  // 拖动(按下 → 挪 120 像素 → 松开)不算单击
  await page.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(mb.x + mb.width * 0.5 + i * 20, mb.y + mb.height * 0.5 + i * 8);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const dragSel = await page.locator('.inspector').count();
  await page.mouse.dblclick(mb.x + mb.width * 0.5, mb.y + mb.height * 0.5);
  await page.waitForTimeout(250);
  const dblSel = await page.locator('.inspector').count();
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const ps = (await page.evaluate('window.__wfPickables()')) as Pick[];
  // 挑一座悬停时"最近城市"就是它自己的城(同一州里可能有更大的城):改名后悬停信息里才看得到新名字;
  // 符号在舞台中间一带(详情面板在左 / 右边弹出,宽约 300 像素,会盖住靠边的符号)
  let city: Pick | undefined;
  let mark: Pick | undefined;
  const vw = page.viewportSize()!.width;
  for (const c of ps.filter((p) => p.kind === 'settlement' && ps.some((m) => m.kind === 'mark' && m.id === p.id && m.x > 450 && m.x < vw - 450)).slice(0, 20)) {
    const m = ps.find((q) => q.kind === 'mark' && q.id === c.id)!;
    const t = await probe(page, m.x, m.y);
    if (t.includes(`最近城市 ${c.text}`)) {
      city = c;
      mark = m;
      break;
    }
  }
  let panel = '';
  let renamed = false;
  let hoverNew = '';
  let reset = false;
  let closed = false;
  let renameMs = NaN;
  let exportNew = false;
  if (city && mark) {
    await page.mouse.click(mark.x, mark.y);
    panel = await page
      .locator('.inspector')
      .innerText({ timeout: 3000 })
      .catch(() => '');
    await page.click('.inspector .ins-name');
    await page.fill('.inspector .ins-edit input', '饕餮城');
    // 在页面里计时:按回车 → 地图文字层画出新名字
    renameMs = (await page.evaluate(`(async () => {
      const w = window;
      const t0 = performance.now();
      document.querySelector('.inspector .ins-edit input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((res) => {
        const check = () => ((w.__wfLabels?.texts || []).includes('饕餮城') || performance.now() - t0 > 5000 ? res() : requestAnimationFrame(check));
        check();
      });
      return performance.now() - t0;
    })()`)) as number;
    const texts = (await page.evaluate('window.__wfLabels.texts')) as string[];
    renamed = texts.includes('饕餮城') && !texts.includes(city.text);
    // 改名后重新取一次这座城的符号位置(地图万一挪动过也能对准)
    const after = ((await page.evaluate('window.__wfPickables()')) as Pick[]).find((q) => q.kind === 'mark' && q.id === mark!.id) ?? mark;
    await page.mouse.move(after.x, after.y);
    await page.waitForTimeout(200);
    // 悬停在城镇符号上:小卡片写这座城的名字
    hoverNew = await page.locator('.hover-card').innerText().catch(() => '');
    // 导出的编年史里也是改过的名字
    try {
      await openOverview();
      await page.click('.export-btn');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.export-item[data-job=md]')]);
      const file = await dl.path();
      exportNew = file ? (await import('node:fs')).readFileSync(file, 'utf8').includes('饕餮城') : false;
    } catch (e) {
      errs.push(`改名后导出编年史失败:${(e as Error).message}`);
    }
    await closeOverview();
    await page.click('.inspector .ins-reset');
    reset = await page
      .waitForFunction((n) => (window as any).__wfLabels?.texts?.includes(n), city.text, { timeout: 5000 })
      .then(() => true, () => false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    closed = (await page.locator('.inspector').count()) === 0;
  }
  console.log(
    `点选:拖动后面板 ${dragSel} 个、双击后 ${dblSel} 个;点「${city?.text}」→ 面板「${panel.replace(/\n/g, ' ').slice(0, 40)}…」;` +
      `改名 → 地图上的字变了 ${renamed}(${renameMs.toFixed(1)} ms),悬停「${hoverNew.replace(/\n/g, ' ')}」;导出的编年史里有新名字 ${exportNew};恢复默认 ${reset};Esc 关面板 ${closed}`,
  );
  if (dragSel) errs.push('拖动地图误触发了选中');
  if (dblSel) errs.push('双击(复位视图)后留下了选中');
  if (!city || !panel.includes(city.text)) errs.push('点城镇符号后没有出现这座城的详情面板');
  if (!renamed) errs.push('改名后地图上的城名没有变');
  if (!hoverNew.includes('饕餮城')) errs.push('改名后悬停信息里的城名没有变');
  if (!exportNew) errs.push('改名后导出的编年史里没有新名字');
  if (!reset) errs.push('恢复默认后地图上的城名没有变回来');
  if (!closed) errs.push('按 Esc 没有关掉详情面板');
  const RENAME_BUDGET = process.env.CI ? 250 : 100;
  if (!(renameMs <= RENAME_BUDGET)) errs.push(`改名太慢(${renameMs.toFixed(1)} ms,预算 ${RENAME_BUDGET} ms)`);
}
// 存档(阶段 4):改一个名字 → 刷新页面 → 名字还在(自动恢复);存成文件 → 换一个世界 → 从文件打开 → 名字回来
{
  const labelsHave = (n: string, timeout = 60000) =>
    page.waitForFunction((t) => (window as any).__wfLabels?.texts?.includes(t), n, { timeout }).then(() => true, () => false);
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const ps = (await page.evaluate('window.__wfPickables()')) as Pick[];
  // 挑一座悬停时"最近城市"就是它自己的城(同一州里可能有更大的城):改名后悬停信息里才看得到新名字;
  // 符号在舞台中间一带(详情面板在左 / 右边弹出,宽约 300 像素,会盖住靠边的符号)
  let city: Pick | undefined;
  let mark: Pick | undefined;
  const vw = page.viewportSize()!.width;
  for (const c of ps.filter((p) => p.kind === 'settlement' && ps.some((m) => m.kind === 'mark' && m.id === p.id && m.x > 450 && m.x < vw - 450)).slice(0, 20)) {
    const m = ps.find((q) => q.kind === 'mark' && q.id === c.id)!;
    const t = await probe(page, m.x, m.y);
    if (t.includes(`最近城市 ${c.text}`)) {
      city = c;
      mark = m;
      break;
    }
  }
  let kept = false;
  let restoredNote = '';
  let fileName = '';
  let fileOk = false;
  let back = false;
  let loadNote = '';
  let listed = 0;
  if (city && mark) {
    await page.mouse.click(mark.x, mark.y);
    await page.click('.inspector .ins-name');
    await page.fill('.inspector .ins-edit input', '饕餮城');
    await page.keyboard.press('Enter');
    await labelsHave('饕餮城', 5000);
    await page.keyboard.press('Escape');
    await page.reload();
    await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
    kept = await labelsHave('饕餮城', 10000);
    restoredNote = await toastText(page, 'save');
    // "我的世界"里有这个世界;存成文件
    await openOverview();
    await page.click('.save-btn');
    listed = await page.locator('.save-row').count();
    try {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-act=save-file]')]);
      fileName = dl.suggestedFilename();
      const file = await dl.path();
      const text = file ? (await import('node:fs')).readFileSync(file, 'utf8') : '';
      const save = JSON.parse(text);
      fileOk = save.app === '文明与地图' && save.seed === 7 && Object.values(save.edits?.names ?? {}).includes('饕餮城') && /^[0-9a-f]{12}$/.test(save.check);
      // 换一个世界(种子 2024),再从文件打开
      await page.click('.ov-tab[data-tab=genesis]');
      await page.fill('.ov-seed input', '2024');
      await page.press('.ov-seed input', 'Enter');
      await page.waitForFunction(() => location.search.includes('seed=2024') && (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
      await page.waitForTimeout(300);
      if (file) await page.setInputFiles('[data-testid=save-file-input]', file);
      back = (await labelsHave('饕餮城')) && page.url().includes('seed=7');
      loadNote = await toastText(page, 'save');
    } catch (e) {
      errs.push(`存成文件 / 从文件打开失败:${(e as Error).message}`);
    }
    await closeOverview();
  }
  console.log(
    `存档:改名「${city?.text}」→ 饕餮城,刷新后还在 ${kept}(提示「${restoredNote.replace(/\n/g, ' ')}」);我的世界 ${listed} 个;` +
      `存成文件 ${fileName} 内容对 ${fileOk};换种子 2024 后从文件打开,名字回来 ${back}(提示「${loadNote.replace(/\n/g, ' ')}」)`,
  );
  if (!city) errs.push('存档检查没找到可以改名的城');
  if (!kept) errs.push('改名后刷新页面,名字没有自动恢复');
  if (!restoredNote.includes('已恢复')) errs.push('刷新后没有"已恢复上次的修改"的提示');
  if (listed < 1) errs.push('"我的世界"里没有列出改过的世界');
  if (!fileOk || !/^文明与地图-.+\.json$/.test(fileName)) errs.push(`存成的文件不对(${fileName})`);
  if (!back) errs.push('从文件打开后没有回到存档的世界 / 名字没回来');
  // 收尾:删掉这个世界的存档(不影响后面的检查)
  await page.evaluate(() => localStorage.clear());
}

// 旧存档的键(阶段 4 远处的历史别乱):浏览器里存着一个旧版本(r + 州号的键)的自动存档 → 打开这个世界 →
// 改名照样套上(州名、城名),自动存里的键就地换成了 c 格式(按地块)
{
  const { worldKey } = await import('../src/gen/savefile');
  const { DEFAULT_PARAMS } = await import('../src/gen/world');
  const params = { ...DEFAULT_PARAMS, seed: 7 };
  const id = worldKey(params);
  const legacy = {
    app: '文明与地图',
    format: 1,
    generator: 1,
    seed: 7,
    params,
    edits: { names: { 'region:r0': '九嶷州', 'settlement:r3#0': '饕餮城' }, interventions: [], terrain: [] },
    check: '',
    savedAt: '2026-09-20T08:00:00.000Z',
  };
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`wenming-ditu:world:${id}`, JSON.stringify(legacy)]);
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  // 自动存写回去是同步的(套上修改那一刻);等一下提示出来
  await page.waitForTimeout(500);
  const stored = await page.evaluate((k) => localStorage.getItem(k), `wenming-ditu:world:${id}`);
  const names: Record<string, string> = stored ? JSON.parse(stored).edits?.names ?? {} : {};
  const keys = Object.keys(names);
  const note = await toastText(page, 'save');
  const upgraded = keys.length === 2 && keys.every((k) => /^(region|settlement):c\d+(#\d+)?$/.test(k)) && Object.values(names).sort().join() === '九嶷州,饕餮城';
  console.log(`旧存档的键:读回后 ${JSON.stringify(names)},换成 c 格式 ${upgraded}(提示「${note.replace(/\n/g, ' ')}」)`);
  if (!upgraded) errs.push(`旧存档里 r 格式的键没有换成 c 格式:${JSON.stringify(names)}`);
  if (/找不到对应的地方/.test(note)) errs.push(`旧存档的改名有找不到的:${note}`);
  await page.evaluate(() => localStorage.clear());
}
// 世界换成球面以前(生成器版本 4 及以前)的存档文件、分享链接:照常打开成同一个种子的球面世界,提示"来自旧版本",
// 地形修改按经纬度套上(跨 180° 经线的那一笔也行),指不到的改名 / 干预先留着;页面不报错
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { encodeShare } = await import('../src/gen/savefile');
  const old = {
    app: '文明与地图',
    format: 1,
    generator: 4,
    seed: 7,
    params: { seed: 7, cells: 12000, landFraction: 0.33, plates: 30, mountains: 1, temperature: 0, rainfall: 1 },
    edits: {
      names: { 'settlement:r3#0': '饕餮城', 'polity:c4567#0': '秦', 'place:river@c11999#0': '弱水' },
      interventions: [{ kind: 'protect', a: 'polity:c4567#0', from: 1200 }],
      terrain: [{ kind: 'range', pts: [2000, 300, 2048, 340, 30, 380], r: 23, s: 1 }],
    },
    check: '3f9a0c1d7b2e',
    title: '平面时代的世界',
    savedAt: '2026-09-20T08:00:00.000Z',
  };
  const before = errs.length;
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=2024&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  const file = path.join(os.tmpdir(), `wf-old-save-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(old));
  await page.setInputFiles('[data-testid=save-file-input]', file);
  const fileOpened = await page
    .waitForFunction(() => location.search.includes('seed=7') && (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 })
    .then(() => true, () => false);
  const fileNote = await toastText(page, 'save', 5000);
  // 地形修改也套上了(打开时直接带着地形修改生成):改了 5 处 = 3 处改名 + 1 条干预 + 1 处地形
  const regen = fileNote.includes('改了 5 处');
  fs.rmSync(file, { force: true });
  // 分享链接:另一个浏览器(没有本地存档)打开
  const ctx4 = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const p4 = await ctx4.newPage();
  p4.on('pageerror', (e) => errs.push(`旧分享链接:${e.message}`));
  const hash = await encodeShare(old as never);
  await p4.goto(`${dev.url}/?seed=7&cells=12000${hash}`);
  const linkOpened = await p4
    .waitForFunction(() => location.search.includes('seed=7') && (window as any).__wf?.ready, null, { timeout: 60000 })
    .then(() => true, () => false);
  await p4.waitForTimeout(500);
  const linkNote = await toastText(p4, 'save', 5000);
  await ctx4.close();
  const pageErrs = errs.length - before;
  console.log(`平面时代的存档:从文件打开 ${fileOpened}(提示「${fileNote}」),修改(含地形)都套上 ${regen};分享链接打开 ${linkOpened}(提示「${linkNote}」)`);
  if (!fileOpened || !fileNote.includes('来自旧版本')) errs.push(`平面时代的存档文件没有照常打开 / 没提示"来自旧版本"(${fileNote})`);
  if (!regen) errs.push('平面时代的存档:修改没有全部套上(应为改了 5 处)');
  if (!linkOpened || !linkNote.includes('来自旧版本')) errs.push(`平面时代的分享链接没有照常打开 / 没提示"来自旧版本"(${linkNote})`);
  if (pageErrs > 0) errs.push('打开平面时代的存档、分享链接时页面报错');
  await page.evaluate(() => localStorage.clear());
}
// 隐私模式(localStorage 一碰就抛错):页面照常能用,改名照样生效,存档菜单里提示"不让存"
{
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  await ctx2.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  const p2 = await ctx2.newPage();
  const errs2: string[] = [];
  p2.on('pageerror', (e) => errs2.push(e.message));
  p2.on('console', (m) => m.type() === 'error' && errs2.push(m.text()));
  await p2.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  const ok = await p2.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 }).then(() => true, () => false);
  await p2.waitForTimeout(300);
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const ps = ok ? ((await p2.evaluate('window.__wfPickables()')) as Pick[]) : [];
  const mark = ps.find((m) => m.kind === 'mark');
  let renamed = false;
  let note = '';
  if (mark) {
    await p2.mouse.click(mark.x, mark.y);
    await p2.click('.inspector .ins-name');
    await p2.fill('.inspector .ins-edit input', '饕餮城');
    await p2.keyboard.press('Enter');
    renamed = await p2
      .waitForFunction(() => (window as any).__wfLabels?.texts?.includes('饕餮城'), null, { timeout: 5000 })
      .then(() => true, () => false);
    await p2.keyboard.press('Escape');
    await openOverview(p2);
    await p2.click('.save-btn');
    note = await p2.locator('.save-menu').innerText().catch(() => '');
  }
  console.log(`隐私模式:页面加载 ${ok},改名生效 ${renamed},菜单提示「${note.split('\n').find((l) => l.includes('不让')) ?? ''}」;错误 ${errs2.length} 条`);
  if (!ok || !renamed) errs.push('隐私模式(浏览器不让存)下页面不能用 / 改名不生效');
  if (!note.includes('不让网页存数据')) errs.push('隐私模式下存档菜单没有提示"不让存"');
  if (errs2.length) errs.push(`隐私模式下有报错:${errs2[0]}`);
  await ctx2.close();
}

// 分享链接(阶段 4):改名 → 复制分享链接 → 另一个浏览器(什么都没存)打开这个链接 → 名字在、地址栏的 # 去掉了;
// 那边本地改成别的名字后再打开链接 → 顶部提示条问"用链接里的 / 保留本地",两个都点一遍;剪贴板用不了 → 存档菜单里一行手动复制
{
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const has = (p: typeof page, n: string, timeout = 30000) =>
    p.waitForFunction((t) => (window as any).__wfLabels?.texts?.includes(t), n, { timeout }).then(() => true, () => false);
  const ready = (p: typeof page) => p.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  const rename = async (p: typeof page, id: number, name: string) => {
    const mark = ((await p.evaluate('window.__wfPickables()')) as Pick[]).find((m) => m.kind === 'mark' && m.id === id);
    if (!mark) return false;
    await p.mouse.click(mark.x, mark.y);
    await p.click('.inspector .ins-name');
    await p.fill('.inspector .ins-edit input', name);
    await p.keyboard.press('Enter');
    const ok = await has(p, name, 5000);
    await p.keyboard.press('Escape');
    return ok;
  };
  const note = (p: typeof page) => toastText(p, 'save');
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) {
    p.on('pageerror', (e) => errs.push(`分享:${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errs.push(`分享:${m.text()}`));
  }
  await a.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await ready(a);
  await a.waitForTimeout(300);
  const picks = (await a.evaluate('window.__wfPickables()')) as Pick[];
  const city = picks.find((p) => p.kind === 'settlement' && picks.some((m) => m.kind === 'mark' && m.id === p.id));
  let share: { url: string; length: number; withData: boolean; copied: boolean } | null = null;
  let clip = '';
  let copyNote = '';
  let opened = false;
  let hashGone = false;
  let openNote = '';
  let ask = '';
  /** 问的时候开着的窗口(应该没有:问题在提示条上) */
  let askModal = 0;
  let kept = false;
  let used = false;
  let manualOk = false;
  if (city && (await rename(a, city.id, '梼杌城'))) {
    await openOverview(a);
    await a.click('.save-btn');
    await a.click('[data-act=share-link]');
    share = await a.waitForFunction(() => (window as any).__wfShare, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
    clip = await a.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    copyNote = await note(a);
    if (share) {
      // 另一个浏览器打开
      await b.goto(share.url);
      await ready(b);
      opened = await has(b, '梼杌城');
      hashGone = (await b.evaluate(() => location.hash)) === '' && b.url().includes('seed=7');
      openNote = await note(b);
      // 那边本地改成别的名字(自动存下),再打开同一个链接:问
      if (opened && (await rename(b, city.id, '混沌城'))) {
        await b.waitForTimeout(300);
        await b.goto(share.url);
        ask = await toastText(b, 'share-ask', 20000);
        askModal = await b.locator('[aria-modal=true]:visible').count();
        if (ask) {
          await b.click('.toast[data-toast=share-ask] [data-act=share-keep]');
          await ready(b);
          kept = (await has(b, '混沌城')) && !(await b.evaluate(() => (window as any).__wfLabels.texts.includes('梼杌城')));
          await b.goto(share.url);
          await b.locator('.toast[data-toast=share-ask]').waitFor({ timeout: 20000 }).catch(() => {});
          await b.click('.toast[data-toast=share-ask] [data-act=share-use]').catch(() => {});
          used = await has(b, '梼杌城');
        }
      }
    }
    // 剪贴板用不了:存档菜单留着,里面多一行选中了链接的输入框
    // (写成字符串:tsx 编译函数时会插入页面里没有的 __name)
    await a.evaluate(`
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: function () { return Promise.reject(new DOMException('denied', 'NotAllowedError')); } });
      document.execCommand = function () { return false; };
    `);
    await openOverview(a);
    await a.click('.save-btn');
    await a.click('[data-act=share-link]');
    const ta = await a.locator('.save-menu [data-testid=share-manual] input').inputValue({ timeout: 10000 }).catch(() => '');
    manualOk = !!ta && ta === (await a.evaluate(() => (window as any).__wfShare?.url)) && ta.includes('#share=');
    await a.keyboard.press('Escape');
  }
  console.log(
    `分享链接:改名「${city?.text}」→ 梼杌城,复制 ${share?.length ?? '-'} 字(剪贴板一致 ${!!share && clip === share.url},提示「${copyNote}」);` +
      `新浏览器打开 名字在 ${opened}、# 去掉 ${hashGone}(提示「${openNote}」);本地改过再开:提示条「${ask}」,` +
      `保留本地 ${kept},用链接里的 ${used};剪贴板用不了时手动复制框 ${manualOk}`,
  );
  if (!city) errs.push('分享:没找到可以改名的城');
  else {
    if (!share?.withData || !share.url.includes('#share=')) errs.push('分享:复制的链接没带修改');
    if (!share || clip !== share.url) errs.push('分享:剪贴板里的不是分享链接');
    if (!copyNote.startsWith('已复制分享链接')) errs.push(`分享:复制后的提示不对(${copyNote})`);
    if (!opened) errs.push('分享:另一个浏览器打开链接后名字不在');
    if (!hashGone) errs.push('分享:打开后地址栏的 # 没去掉');
    if (!openNote.includes('已打开分享的世界')) errs.push(`分享:打开链接后的提示不对(${openNote})`);
    if (!ask.includes('1 处和链接不同') || !ask.includes('用链接里的') || !ask.includes('保留本地'))
      errs.push(`分享:本地有不同修改时提示条上没有问"用链接里的 / 保留本地"(${ask})`);
    if (askModal) errs.push('分享:问"用链接里的 / 保留本地"时另开了窗口');
    if (!kept) errs.push('分享:点"保留本地的"后名字不是本地的');
    if (!used) errs.push('分享:点"用链接里的"后名字不是链接里的');
    if (!manualOk) errs.push('分享:剪贴板用不了时存档菜单里没有手动复制的一行');
  }
  await ctxA.close();
  await ctxB.close();
}

// 各种状态(统一走顶部提示条,不另开窗口):首次打开世界出来之前只有同色底 + "正在生成世界"的进度(四角先藏着);
// 导入坏文件 → 提示条报错(打不开 xx.json + 原因);没有干预时概览"我的干预"是一句空状态;
// 浏览器存储满了 → 提示"没能自动存档"带"存成文件",存档菜单里当前世界那一行也写着
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const sp = await ctx.newPage();
  sp.on('pageerror', (e) => errs.push(`各种状态:${e.message}`));
  await sp.goto(`${dev.url}/?seed=7`);
  await sp.locator('.toast[data-toast=progress]').waitFor({ timeout: 20000 }).catch(() => {});
  const boot = await sp.evaluate(() => ({
    booting: !!document.querySelector('.app.booting'),
    toast: document.querySelector('.toast[data-toast=progress]')?.textContent ?? '',
    corner: getComputedStyle(document.querySelector('.corner-tl')!).visibility,
    world: !!(window as any).__wf?.ready,
  }));
  await sp.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  const after = await sp.evaluate(() => ({ booting: !!document.querySelector('.app.booting'), corner: getComputedStyle(document.querySelector('.corner-tl')!).visibility }));
  // 坏文件
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const bad = path.join(os.tmpdir(), `wf-bad-${process.pid}.json`);
  fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  await sp.setInputFiles('[data-testid=save-file-input]', bad);
  // 读完再删(页面是异步读文件的,先删了会变成"读不了这个文件")
  const badNote = await sp.locator('.toast[data-toast=save].k-error').innerText({ timeout: 5000 }).then((t) => t.replace(/\n/g, ' '), () => '');
  fs.rmSync(bad, { force: true });
  // 没有干预
  await openOverview(sp, 'interventions');
  const empty = await sp.locator('.ov [data-empty=interventions]').innerText().catch(() => '');
  await closeOverview(sp);
  // 存储满了:同一个页面里把世界存档的写入换成一写就报配额满(不再开新页面、重新生成世界,冒烟省时间)
  await sp.evaluate(`
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('wenming-ditu:world:')) throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, k, v);
    };
  `);
  const fp = sp;
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  // 避开顶部的提示条(坏文件的报错还在)
  const mark = ((await fp.evaluate('window.__wfPickables()')) as Pick[]).find((m) => m.kind === 'mark' && m.y > 140);
  let fullNote = '';
  let fullMenu = '';
  if (mark) {
    await fp.mouse.click(mark.x, mark.y);
    await fp.click('.inspector .ins-name');
    await fp.fill('.inspector .ins-edit input', '饕餮城');
    await fp.keyboard.press('Enter');
    fullNote = await toastText(fp, 'storage', 5000);
    await fp.keyboard.press('Escape');
    await openOverview(fp);
    await fp.click('.save-btn');
    fullMenu = await fp.locator('.save-menu .save-cur').innerText().catch(() => '');
  }
  await ctx.close();
  console.log(
    `各种状态:首次打开 同色底 ${boot.booting}、四角 ${boot.corner}、提示条「${boot.toast}」→ 生成好后 四角 ${after.corner};` +
      `坏文件「${badNote}」;没有干预「${empty}」;存储满了「${fullNote}」,菜单「${fullMenu.replace(/\n/g, ' ')}」`,
  );
  if (!boot.world && (!boot.booting || boot.corner !== 'hidden' || !boot.toast.includes('正在生成世界')))
    errs.push(`首次打开:世界出来之前应该只有同色底和"正在生成世界"的进度(四角 ${boot.corner},提示条「${boot.toast}」)`);
  if (after.booting || after.corner !== 'visible') errs.push('首次打开:世界生成好以后四角没有出来');
  if (!badNote.includes('打不开') || !badNote.includes('不是「文明与地图」的存档')) errs.push(`导入坏文件:没有报错提示(${badNote})`);
  if (!empty.includes('还没有干预')) errs.push(`概览"我的干预"没有空状态(${empty})`);
  if (!mark) errs.push('存储满了:没找到可以改名的城');
  else {
    if (!fullNote.includes('没能自动存档') || !fullNote.includes('存成文件')) errs.push(`存储满了:没有提示"没能自动存档"(${fullNote})`);
    if (!fullMenu.includes('存储已满')) errs.push(`存储满了:存档菜单里当前世界那一行没写(${fullMenu})`);
  }
}

// 干预(阶段 4):点一个后来会亡的国家 → 国家面板"干预历史 → 保护" → 后台重推 → 它到最后都没亡,相关事件里记了一条干预,
// 时间轴从干预那一年接着放、轨道上多一枚"令";刷新页面恢复这条干预时不打断(无头浏览器里没有自动播放:停着不动)
{
  // 找一个"那一年还在、后来会亡"的国家:在 Node 里推一遍同一个世界,挑亡国之前国土最大的那一年,
  // 在地图上点它的国土(按世界坐标换成屏幕坐标;历史换了一遍时不用改这里)
  let Y = 0;
  let name = '';
  let fellAt = '';
  let best: { y: number; regs: number[]; id: number } | null = null;
  /** 某州里离治所(可能有城镇符号)最远的那块地的世界坐标 */
  let seatAt: (r: number) => [number, number] = () => [NaN, NaN];
  {
    const { DEFAULT_PARAMS, generateWorld } = await import('../src/gen/world');
    const { generateCiv } = await import('../src/gen/civ');
    const { ownersAt } = await import('../src/gen/civ/timeline');
    const w7 = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
    const c7 = generateCiv(w7);
    seatAt = (r) => {
      const R = c7.regions;
      let far = R.seat[r];
      let fd = -1;
      for (let k = R.cellStart[r]; k < R.cellStart[r + 1]; k++) {
        const c = R.cells[k];
        const d = Math.hypot(w7.mesh.x[c] - w7.mesh.x[R.seat[r]], w7.mesh.y[c] - w7.mesh.y[R.seat[r]]);
        if (d > fd && d < 200) (fd = d), (far = c);
      }
      return [w7.mesh.x[far], w7.mesh.y[far]];
    };
    for (const p of c7.polities) {
      if (p.ended === undefined || !c7.annals.some((e) => e.kind === 'fall' && e.a === p.id)) continue;
      for (const f of [0.5, 0.7, 0.85]) {
        const y = Math.floor(p.founded + (p.ended - p.founded) * f);
        const own = ownersAt(c7, y).polity;
        const regs: number[] = [];
        for (let r = 0; r < own.length; r++) if (own[r] === p.id) regs.push(r);
        if (!best || regs.length > best.regs.length) best = { y, regs, id: p.id };
      }
    }
    if (best) {
      Y = best.y;
      await page.evaluate(() => localStorage.clear());
      await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities&civYear=${Y}`);
      await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(300);
      const R = c7.regions;
      for (const r of best.regs.slice(0, 12)) {
        // 这州里离治所(可能有城镇符号)最远的那块地
        let far = R.seat[r];
        let fd = -1;
        for (let k = R.cellStart[r]; k < R.cellStart[r + 1]; k++) {
          const c = R.cells[k];
          const d = Math.hypot(w7.mesh.x[c] - w7.mesh.x[R.seat[r]], w7.mesh.y[c] - w7.mesh.y[R.seat[r]]);
          if (d > fd && d < 200) (fd = d), (far = c);
        }
        // 上一下选中后地图还在飞过去:停稳了再换算坐标
        await page.keyboard.press('Escape');
        await page.waitForTimeout(700);
        const at = (await page.evaluate(([x, y]) => (window as any).__wfWorldToClient(x, y), [w7.mesh.x[far], w7.mesh.y[far]])) as [number, number] | null;
        if (!at) continue;
        await page.mouse.click(at[0], at[1]);
        const id = await page
          .locator('.inspector .cp[data-polity]')
          .getAttribute('data-polity', { timeout: 3000 })
          .catch(() => null);
        if (id !== null && Number(id) === best.id) {
          name = (await page.locator('.inspector .ins-name').innerText()).trim();
          fellAt = String(Math.floor(c7.polities[best.id].ended!));
          break;
        }
      }
    }
  }
  /** 在地图上重新点开这个国家(地图可能飞走了:每次停稳了再按世界坐标换算);返回面板的字 */
  const reopen = async (): Promise<string> => {
    if (!best) return '';
    for (const r of best.regs.slice(0, 12)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const at = (await page.evaluate(([x, y]) => (window as any).__wfWorldToClient(x, y), seatAt(r))) as [number, number] | null;
      if (!at) continue;
      await page.mouse.click(at[0], at[1]);
      const id = await page
        .locator('.inspector .cp[data-polity]')
        .getAttribute('data-polity', { timeout: 3000 })
        .catch(() => null);
      if (id !== null && Number(id) === best!.id) return page.locator('.inspector').innerText();
    }
    return '';
  };
  let resim: { paintedMs: number; workerMs: number } | null = null;
  let aliveAfter = '';
  let chron = '';
  let tl = '';
  let playing = false;
  let orders = 0;
  let listed = 0;
  let ivToast = '';
  let insChron = '';
  let events = '';
  if (name) {
    // 国家面板"相关事件"旁的"全部 ›" = 打开概览的编年史页、只看这国;收起概览再下干预
    await page.click('.inspector [data-act=chronicle]');
    insChron = await page.locator('.ov-root:not([hidden]) .chron-pick select').evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.text ?? '').catch(() => '');
    await closeOverview();
    const prev = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
    await page.click('.inspector .cp-btn[data-act=intervene]');
    await page.click('.inspector .cp-cmd[data-cmd=protect]');
    await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
    resim = await page.evaluate(() => (window as any).__wfResim ?? null);
    await page.waitForTimeout(300);
    tl = await page.locator('.timebar .tb-year').innerText().catch(() => '');
    playing = (await page.locator('.timebar .tb-play.on').count()) > 0;
    orders = await page.locator('.timebar .tb-order').count();
    // 已生效的提示(带撤销)
    ivToast = await toastText(page, 'resim-done');
    await page.click('.timebar button.tb-play'); // 暂停,下面重新点开这个国家读面板(下了令面板就收起了)
    const again = await reopen();
    // 还活着:没有"结局"一行,小字是"N 年立国"
    aliveAfter = again ? (again.includes('结局') ? `还是亡了(${again.replace(/\n/g, ' ').slice(0, 80)})` : '至今还在') : '';
    events = await page.locator('.inspector .cp-events').innerText().catch(() => '');
    await page.keyboard.press('Escape');
    await openOverview(page, 'chronicle');
    chron = await page.locator('.chronicle').innerText().catch(() => '');
    await page.click('.ov-tab[data-tab=interventions]');
    listed = await page.locator('.ov-ivs .ov-iv').count();
    await closeOverview();
  }
  console.log(
    `干预:「${name}」原本第 ${fellAt} 年亡 → 点"保护" → 重推 ${resim ? `${resim.paintedMs.toFixed(0)} ms(线程里 ${resim.workerMs.toFixed(0)} ms)` : '没完成'};` +
      `面板「${aliveAfter}」;时间轴 ${tl}${playing ? '(在放)' : '(停着)'}、「令」${orders} 枚;提示条「${ivToast}」;概览里干预 ${listed} 条;` +
      `面板的"全部 ›"打开概览、只看「${insChron}」;面板相关事件里有干预 ${/干预/.test(events)};编年史里有干预 ${/干预\s+[^\n]*自此不亡/.test(chron)}`,
  );
  if (!name) errs.push('干预:没在地图上点到一个后来会亡的国家');
  else {
    if (!resim) errs.push('干预:点"保护"后没有重推');
    if (!aliveAfter.includes('至今')) errs.push(`干预:加了"保护"以后「${name}」还是亡了(${aliveAfter})`);
    if (!/干预/.test(events) || !events.includes('自此不亡')) errs.push(`干预:国家面板的相关事件里没有这条干预(${events.replace(/\n/g, ' ')})`);
    if (!/干预\s+[^\n]*自此不亡/.test(chron)) errs.push('干预:编年史里没有记这条干预');
    if (!insChron || insChron === '全部国家') errs.push(`干预:面板里点"全部 ›"没有打开概览的编年史页、只看这国(${insChron})`);
    const ty = Number(tl.match(/\d+/)?.[0] ?? NaN);
    if (!(ty >= Y && ty <= Y + 40) || !playing) errs.push(`干预:重推完时间轴没有从干预那一年(${Y})接着放(${tl}${playing ? '' : ',没在放'})`);
    if (orders !== 1) errs.push(`干预:时间轴上应有 1 枚「令」(${orders})`);
    if (listed !== 1) errs.push(`干预:概览里的干预列表应有 1 条(${listed})`);
    if (!/已从 \d+ 年重新推演 · .*保护.*撤销/.test(ivToast)) errs.push(`干预:重推完顶部没有"已从 N 年重新推演"(带撤销)的提示(${ivToast})`);
    const RESIM_BUDGET = process.env.CI ? 2500 : 1000;
    if (resim && !(resim.paintedMs <= RESIM_BUDGET)) errs.push(`干预:重推太慢(${resim.paintedMs.toFixed(0)} ms,预算 ${RESIM_BUDGET} ms)`);
    // 干预也自动存:刷新页面 → 自动恢复修改 → 按存下的干预重推一次
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
    const again = await page
      .waitForFunction(() => ((window as any).__wfResim?.seq ?? 0) > 0, null, { timeout: 20000 })
      .then(() => true, () => false);
    await page.waitForTimeout(300);
    const tlAgain = await page.locator('.timebar .tb-year').innerText().catch(() => '');
    const playAgain = (await page.locator('.timebar .tb-play.on').count()) > 0;
    await openOverview(page, 'interventions');
    const listedAgain = await page.locator('.ov-ivs .ov-iv').count();
    console.log(`干预:刷新后自动恢复、重推 ${again},概览里干预 ${listedAgain} 条;时间轴 ${tlAgain}${playAgain ? '(在放)' : '(停着)'}`);
    if (!again || listedAgain !== 1) errs.push('干预:刷新页面后没有按自动存下的干预重推');
    if (playAgain || tlAgain.replace(/\s/g, '') !== `第${Y}年`) errs.push(`干预:刷新后恢复干预不该动时间轴(网址里的第 ${Y} 年;${tlAgain}${playAgain ? ',在放' : ''})`);
    // "我的干预"里撤销这一条:重推历史,顶部提示"已撤销",列表变成空状态
    const prevU = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
    await page.click('.ov [data-act=iv-undo]');
    const undone = await page
      .waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prevU, { timeout: 20000 })
      .then(() => true, () => false);
    const undoToast = await toastText(page, 'resim-done');
    const emptyAfter = await page.locator('.ov [data-empty=interventions]').count();
    const tabAfter = (await page.locator('.ov-tab[data-tab=interventions]').innerText()).trim();
    await closeOverview();
    console.log(`干预:概览里撤销 → 重推 ${undone},提示「${undoToast}」,列表空 ${emptyAfter === 1},页签「${tabAfter}」`);
    if (!undone || !undoToast.includes('已撤销') || emptyAfter !== 1 || tabAfter !== '我的干预 0') errs.push(`干预:概览里撤销不对(重推 ${undone},提示「${undoToast}」,页签「${tabAfter}」)`);
  }
  await page.evaluate(() => localStorage.clear());
}

// 国家面板:点国家 → 暂停、地图飞过去(疆域在面板左边)、国都圆环;信息页(三格数字、朝代条、疆域、邻国、相关事件、2×2 按钮)
// → 干预历史 → 干预页(生效年份、六条命令)→ 宣战:只有相邻国家浮出名牌 → Esc 回到干预页 → 结盟:地图压暗、提示条"选择与…结盟的国家"、
// 悬停名牌反色、悬停国土"点击选择" → 点名牌 → 面板收起、"已从 N 年重新推演 · …结盟"带撤销、从 N 年接着放 → 撤销 →"已撤销"
{
  type Plate = { kind: string; id: number; text: string; note: string; x: number; y: number; on: boolean; self: boolean };
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const Y = 2600;
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&civYear=${Y}`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const vp = page.viewportSize()!;
  const plates = () => page.evaluate('window.__wfPlates()') as Promise<Plate[]>;
  const pol = ((await page.evaluate('window.__wfPickables()')) as Pick[])
    .filter((q) => q.kind === 'polity' && q.x > 300 && q.x < vp.width - 500 && q.y > 150 && q.y < vp.height - 180)
    .sort((a, b) => Math.abs(a.x - vp.width / 2) - Math.abs(b.x - vp.width / 2))[0];
  let info = '';
  let flown = '';
  let mark = false;
  let near: string[] = [];
  let cmds = 0;
  let cmdText = '';
  let warPlates: Plate[] = [];
  let backToCmd = false;
  let dim = 0;
  let allyPlates: Plate[] = [];
  let pickToast = '';
  let hiddenWhilePicking = false;
  let plateOn = false;
  let hoverVerdict = '';
  let doneToast = '';
  let panelAfter = -1;
  let tlAfter = '';
  let playingAfter = false;
  let undoToast = '';
  let moved = false;
  if (pol) {
    const v0 = await page.evaluate(() => (window as any).__wfView);
    await page.mouse.click(pol.x, pol.y);
    await page.waitForTimeout(900);
    const v1 = await page.evaluate(() => (window as any).__wfView);
    flown = `k ${v0.k.toFixed(2)} → ${v1.k.toFixed(2)},中心经度 ${v0.lon.toFixed(1)}° → ${v1.lon.toFixed(1)}°`;
    moved = Math.abs(v1.k - v0.k) > 0.01 || Math.abs(((v1.lon - v0.lon + 540) % 360) - 180) > 0.5 || Math.abs(v1.y - v0.y) > 2;
    info = (await page.locator('.inspector').innerText().catch(() => '')).replace(/\n/g, ' / ');
    mark = await page.locator('.tp-mark .tp-ring').isVisible().catch(() => false);
    near = await page.locator('.inspector .cp-grid .cp-links').first().locator('.ins-link').allInnerTexts();
    // 干预页
    await page.click('.inspector .cp-btn[data-act=intervene]');
    cmds = await page.locator('.inspector .cp-cmd').count();
    cmdText = (await page.locator('.inspector .cp-from').innerText().catch(() => '')).replace(/\n/g, ' ');
    // 宣战:只有相邻的国家浮出名牌;Esc 回到干预页
    if (await page.locator('.inspector .cp-cmd[data-cmd=declare]').isEnabled()) {
      await page.click('.inspector .cp-cmd[data-cmd=declare]');
      await page.waitForTimeout(900);
      warPlates = await plates();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    backToCmd = (await page.locator('.inspector .cp[data-tab=cmd]').isVisible().catch(() => false)) && !(await page.locator('.tp-dim').count());
    // 结盟:地图压暗、名牌、提示条
    await page.click('.inspector .cp-cmd[data-cmd=ally]');
    await page.waitForTimeout(900);
    dim = await page.locator('.tp-dim').count();
    allyPlates = await plates();
    pickToast = await toastText(page, 'pick');
    hiddenWhilePicking = !(await page.locator('.inspector').isVisible().catch(() => false));
    const tgt = allyPlates.filter((p) => !p.self).sort((a, b) => Math.abs(a.x - vp.width / 2) - Math.abs(b.x - vp.width / 2))[0];
    if (tgt) {
      // 悬停在这国的国土上(名牌四周绕几圈找):悬停卡片写"点击选择",名牌反色
      search: for (const r of [30, 50, 80, 120])
        for (let a = 0; a < 8; a++) {
          await page.mouse.move(tgt.x + r * Math.cos((a * Math.PI) / 4), tgt.y + r * Math.sin((a * Math.PI) / 4));
          await page.waitForTimeout(80);
          hoverVerdict = (await page.locator('.hover-card').innerText().catch(() => '')).replace(/\n/g, ' ');
          if (hoverVerdict.includes(tgt.text)) break search;
        }
      await page.mouse.move(tgt.x, tgt.y);
      await page.waitForTimeout(150);
      plateOn = (await plates()).some((p) => p.id === tgt.id && p.on);
      const prev = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
      await page.mouse.click(tgt.x, tgt.y);
      await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(300);
      doneToast = await toastText(page, 'resim-done');
      panelAfter = await page.locator('.inspector').count();
      tlAfter = await page.locator('.timebar .tb-year').innerText().catch(() => '');
      playingAfter = (await page.locator('.timebar .tb-play.on').count()) > 0;
      // 撤销
      const prev2 = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
      await page.click('.toast[data-toast=resim-done] .toast-act').catch(() => {});
      await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev2, { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(300);
      undoToast = await toastText(page, 'resim-done');
    }
  }
  const warNames = warPlates.filter((p) => !p.self).map((p) => p.text);
  console.log(
    `国家面板:点「${pol?.text}」→ 飞过去 ${flown};国都圆环 ${mark};面板「${info.slice(0, 160)}…」;` +
      `干预页 ${cmds} 条命令、「${cmdText}」;宣战名牌 ${warNames.join('、') || '—'}(邻国 ${near.join('、') || '—'});Esc 回到干预页 ${backToCmd};` +
      `结盟:压暗 ${dim}、名牌 ${allyPlates.length} 个、提示条「${pickToast}」、面板藏起 ${hiddenWhilePicking}、悬停「${hoverVerdict}」、名牌反色 ${plateOn};` +
      `点名牌 →「${doneToast}」,面板 ${panelAfter} 个,时间轴 ${tlAfter}${playingAfter ? '(在放)' : '(停着)'};撤销 →「${undoToast}」`,
  );
  if (!pol) errs.push('国家面板:没找到能点的国家');
  else {
    if (!/国家 · 第 \d+ 年/.test(info) || !['州', '人口', '主体民族', '朝代', '疆域', '邻国', '相关事件', '干预历史', '改名', '名字由来', '写国史'].every((w) => info.includes(w)))
      errs.push(`国家面板:信息页内容不全(${info.slice(0, 200)})`);
    if (!moved) errs.push(`国家面板:点国家后地图没有飞过去(${flown})`);
    if (!mark) errs.push('国家面板:选中国家后国都没有圆环');
    if (cmds !== 6 || !/生效年份.*年.*该年之前的历史不变/.test(cmdText)) errs.push(`国家面板:干预页不对(${cmds} 条命令,「${cmdText}」)`);
    if (warNames.some((n) => !near.includes(n))) errs.push(`国家面板:宣战时浮出了不相邻国家的名牌(${warNames.join('、')};邻国 ${near.join('、')})`);
    if (!backToCmd) errs.push('国家面板:选目标时按 Esc 没有回到干预页');
    if (!dim || allyPlates.length < 3 || !allyPlates.some((p) => p.self && p.note === '本国')) errs.push(`国家面板:结盟选目标时没有压暗 / 名牌不对(压暗 ${dim},名牌 ${allyPlates.length})`);
    if (!/^选择与.+结盟的国家 \d+ 年起生效 取消 · Esc$/.test(pickToast)) errs.push(`国家面板:选目标的提示条不对(${pickToast})`);
    if (!hiddenWhilePicking) errs.push('国家面板:选目标时面板没有收起');
    if (!/点击选择/.test(hoverVerdict)) errs.push(`国家面板:选目标时悬停可选的国家没有"点击选择"(${hoverVerdict})`);
    if (!plateOn) errs.push('国家面板:鼠标移到可选目标上名牌没有反色');
    if (!/^已从 \d+ 年重新推演 · .+与.+结盟 撤销$/.test(doneToast)) errs.push(`国家面板:下令后没有"已从 N 年重新推演 · …结盟"带撤销(${doneToast})`);
    if (panelAfter !== 0) errs.push('国家面板:下令后面板没有收起');
    const ty = Number(tlAfter.match(/\d+/)?.[0] ?? NaN);
    if (!(ty >= Y - 1 && ty <= Y + 40) || !playingAfter) errs.push(`国家面板:下令后没有从生效年份接着放(${tlAfter}${playingAfter ? '' : ',没在放'})`);
    if (!/^已撤销/.test(undoToast)) errs.push(`国家面板:撤销后没有"已撤销"(${undoToast})`);
  }
  await page.evaluate(() => localStorage.clear());
}

// 改地形(阶段 4):打开"改地形" → 在海里点一下放火山 → 后台按新地形重新生成 → 那里成了陆地(悬停显示海拔);
// 刷新后自动恢复(直接带着地形修改生成);分享链接在另一个浏览器里打开,地形修改在(也是直接带着修改生成);撤销 → 又变回海
{
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&style=fantasy`);
  await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  // 种子 7 大洋中间的一处海(世界坐标;生成算法换代、这里成了陆地时改它)
  const at = async (p = page) => {
    const r = (await p.locator('.map-box').boundingBox())!;
    return [r.x + (1205 / 2048) * r.width, r.y + (577 / 1024) * r.height] as const;
  };
  const probeSea = async (p = page) => {
    const [x, y] = await at(p);
    await p.mouse.move(x + 1, y);
    await p.mouse.move(x, y);
    await p.waitForTimeout(200);
    return probe(p, x, y);
  };
  const regen = async (act: () => Promise<unknown>) => {
    const prev = await page.evaluate(() => (window as any).__wfTerrain?.id ?? 0);
    await act();
    await page.waitForFunction((p) => ((window as any).__wfTerrain?.id ?? 0) > p, prev, { timeout: 30000 }).catch(() => null);
    return page.evaluate(() => (window as any).__wfTerrain ?? null) as Promise<{ id: number; paintedMs: number; workerMs: number } | null>;
  };
  const before = await probeSea();
  await terrainOn();
  const panel = await page.locator('.terrain-bar').innerText().catch(() => '');
  const barBox = await page.locator('.terrain-bar').boundingBox();
  const t = await regen(async () => {
    const [x, y] = await at();
    await page.mouse.click(x, y);
  });
  const after = await probeSea();
  const count = await page.locator('.terrain-bar .tbar-count').innerText().catch(() => '');
  // 重新生成的结果照旧走顶部提示条,排在工具条下面
  const tBox = await page.locator('.toast[data-toast=terrain]').boundingBox().catch(() => null);
  console.log(
    `改地形:工具条 ${barBox ? `${Math.round(barBox.width)}×${Math.round(barBox.height)} @ ${Math.round(barBox.x)},${Math.round(barBox.y)}` : '没出来'};` +
      `海里点火山 → 重新生成 ${t ? `${t.paintedMs.toFixed(0)} ms(线程里 ${t.workerMs.toFixed(0)} ms)` : '没完成'};` +
      `之前「${before.split(' / ')[1] ?? ''}」→ 之后「${after.split(' / ')[1] ?? ''}」;工具条「${count}」;提示条在 ${tBox ? Math.round(tBox.y) : '-'}`,
  );
  if (!['火山', '山脉', '湖', '撤销', '完成'].every((w) => panel.includes(w)) || !barBox || barBox.y > 40) errs.push(`改地形:进入后顶部没有工具条(${panel})`);
  if (tBox && barBox && tBox.y < barBox.y + barBox.height) errs.push('改地形:提示条压在工具条上');
  // 工具条只有一行(用法在各工具的悬停提示里,不另写一行说明)
  if (barBox && barBox.height > 56) errs.push(`改地形:工具条不止一行(高 ${Math.round(barBox.height)})`);
  if (!before.includes('水深')) errs.push(`改地形:测试点原本应该是海(${before})`);
  if (!t) errs.push('改地形:放了火山以后没有重新生成');
  else {
    if (!after.includes('海拔')) errs.push(`改地形:海里放了火山,重新生成后那里没变成陆地(${after})`);
    // 从点下去到新地图画好(线程里生成 + 文明 + 铺像素约 0.8–1 秒,主线程画手绘底图、文字约 0.6 秒);
    // 机器负载高时单次能慢到 2.5 秒,CI 虚拟机再慢两倍
    const BUDGET = process.env.CI ? 6000 : 3000;
    if (!(t.paintedMs <= BUDGET)) errs.push(`改地形:重新生成太慢(${t.paintedMs.toFixed(0)} ms,预算 ${BUDGET} ms)`);
    // 自动存:刷新后直接带着地形修改生成(只生成一次),那里还是陆地
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const again = await probeSea();
    const regenAfterReload = await page.evaluate(() => (window as any).__wfTerrain ?? null);
    console.log(`改地形:刷新后「${again.split(' / ')[1] ?? ''}」,刷新后又重新生成了 ${regenAfterReload ? '是' : '否'}`);
    if (!again.includes('海拔')) errs.push('改地形:刷新页面后地形修改没有自动恢复');
    if (regenAfterReload) errs.push('改地形:刷新后先生成原样再按地形修改重新生成了一遍(应该直接带着修改生成)');
    // 分享链接:另一个浏览器(什么都没存)打开,那里是陆地;也是直接带着地形修改生成
    await openOverview();
    await page.click('.save-btn');
    await page.click('[data-act=share-link]');
    const link = await page.waitForFunction(() => (window as any).__wfShare?.url, null, { timeout: 10000 }).then((h) => h.jsonValue() as Promise<string>, () => '');
    await page.keyboard.press('Escape');
    const ctx3 = await browser.newContext({ viewport: { width: 1400, height: 820 } });
    const p3 = await ctx3.newPage();
    p3.on('pageerror', (e) => errs.push(`改地形分享:${e.message}`));
    let shared = '';
    let regenShared: unknown = null;
    if (link) {
      await p3.goto(link);
      await p3.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
      await p3.waitForTimeout(800);
      shared = await probeSea(p3);
      regenShared = await p3.evaluate(() => (window as any).__wfTerrain ?? null);
    }
    console.log(`改地形:分享链接 ${link.length} 字,另一个浏览器打开 →「${shared.split(' / ')[1] ?? ''}」,打开后又重新生成了 ${regenShared ? '是' : '否'}`);
    if (!link.includes('#share=')) errs.push('改地形:只改了地形时分享链接没带修改');
    else if (!shared.includes('海拔')) errs.push(`改地形:带地形修改的分享链接打开后,那里不是陆地(${shared})`);
    if (regenShared) errs.push('改地形:分享链接打开时先生成原样再按地形修改重新生成了一遍(应该直接带着修改生成)');
    await ctx3.close();
    // 撤销:又变回海
    await closeOverview();
    await terrainOn();
    const u = await regen(() => page.click('.terrain-bar [data-act=terrain-undo]'));
    const undone = await probeSea();
    // "完成":工具条收起,单击地图又是看详情
    await page.click('.terrain-bar [data-act=terrain-done]');
    await page.waitForTimeout(200);
    const barGone = !(await page.locator('.terrain-bar').count());
    console.log(`改地形:撤销 → 「${undone.split(' / ')[1] ?? ''}」;点"完成"工具条收起 ${barGone}`);
    if (!u || !undone.includes('水深')) errs.push(`改地形:撤销后没有变回海(${undone})`);
    if (!barGone) errs.push('改地形:点"完成"后工具条没收起');
  }
  await page.evaluate(() => localStorage.clear());
}

// 干预 · 立国:点一个有主的州 → 详情面板"在这里立国"(起名"饕餮")→ 后台重推 → 地图上那一州归了新国家
{
  const Y = 1500;
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=regions&civYear=${Y}`);
  await page.waitForFunction(() => (window as any).__wfLabels?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const inspector = () =>
    page
      .locator('.inspector')
      .innerText({ timeout: 2000 })
      .catch(() => '');
  // 按网格点地图,找一个详情面板是"州"、写着"属某国"的。
  // 选中以后地图会飞过去:网格先换成世界坐标,每次等地图停稳了再换回屏幕坐标
  const box = (await page.locator('.map-box').boundingBox())!;
  const grid: [number, number][] = [];
  for (let gy = 0.3; gy < 0.8; gy += 0.07)
    for (let gx = 0.2; gx < 0.62; gx += 0.04) {
      const w = (await page.evaluate(([cx, cy]) => (window as any).__wfClientToWorld(cx, cy), [box.x + box.width * gx, box.y + box.height * gy])) as [number, number] | null;
      if (w) grid.push(w);
    }
  let spot: { x: number; y: number; name: string; wx: number; wy: number } | null = null;
  for (const [wx, wy] of grid) {
    if (spot) break;
    {
      // 先关掉上一次的详情面板(它可能正好盖住这一点),和上一下隔开,免得算成双击;等上一下的飞行停下
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const at = (await page.evaluate(([x, y]) => (window as any).__wfWorldToClient(x, y), [wx, wy])) as [number, number] | null;
      if (!at || at[0] < 40 || at[0] > page.viewportSize()!.width - 420 || at[1] < 100 || at[1] > page.viewportSize()!.height - 120) continue;
      const [x, y] = at;
      await page.mouse.move(x, y);
      await page.waitForTimeout(150);
      // 点到的是州名(字可能压在邻州上)就不算:悬停信息里这一点所在的州要和面板里的是同一州(点之前量:点了地图就飞走了)
      const hv = await probe(page, x, y);
      await page.mouse.click(x, y);
      await page.waitForTimeout(100);
      // 面板顶部:标题"州 · 第 N 年"、关闭、州名(可能带"恢复默认"),下一行"属 某国 · …"(州名以外的"第 N 州"只看顶部)
      const t = await page
        .locator('.inspector .cp-head')
        .innerText({ timeout: 2000 })
        .catch(() => '');
      const m = /^州 · 第 \d+ 年\s*\n\s*✕\s*\n\s*(.+?)\s*\n(?:\s*恢复默认\s*\n)?\s*属(.+?)(?: · |\n|$)/.exec(t.trim());
      const inHover = /第 (\d+) 州/.exec(hv)?.[1];
      const inPanel = [...t.matchAll(/第 (\d+) 州/g)].at(-1)?.[1];
      if (m && inHover && inHover === inPanel && (await page.locator('.inspector [data-act=found]').count())) {
        spot = { x, y, name: m[1], wx, wy };
      }
    }
  }
  let resim: { paintedMs: number; workerMs: number } | null = null;
  let regionAfter = '';
  let onMap = '';
  let listed = '';
  let chron = '';
  if (spot) {
    // 州面板底部"在这里立国" → 干预页(生效年份 + 国名)→ "立国"
    await page.click('.inspector [data-act=found]');
    await page.fill('.inspector .cp-field input', '饕餮');
    const prev = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
    await page.click('.inspector [data-act=found-go]');
    await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
    resim = await page.evaluate(() => (window as any).__wfResim ?? null);
    await page.waitForTimeout(300);
    regionAfter = (await page.locator('.inspector .ins-status').innerText().catch(() => '')).replace(/\n/g, ' ');
    await openOverview(page, 'interventions');
    listed = (await page.locator('.ov-ivs .ov-iv').allInnerTexts().catch(() => [])).join(' / ').replace(/\n/g, ' ');
    await closeOverview();
    // 换成"政区"图层,在同一处点一下:点到的是新国家(或它的国都)
    await pickLayer(page, 'political');
    await page.waitForTimeout(500);
    // 按世界坐标重新换成屏幕坐标(中间开关过概览、换过图层,地图万一挪动过也能对准)
    const at = (await page.evaluate(([x, y]) => (window as any).__wfWorldToClient(x, y), [spot.wx, spot.wy])) as [number, number] | null;
    // 先看悬停信息(不受文字影响;点下去以后详情面板可能正好盖住这一点)
    await page.mouse.move(at?.[0] ?? spot.x, at?.[1] ?? spot.y);
    await page.waitForTimeout(200);
    const hov = await probe(page, at?.[0] ?? spot.x, at?.[1] ?? spot.y);
    await page.mouse.click(at?.[0] ?? spot.x, at?.[1] ?? spot.y);
    await page.waitForTimeout(300);
    onMap = (await inspector()).replace(/\n/g, ' ').slice(0, 120);
    // 立国以后文字重新排过,那一点上可能正好压着邻州的州名(点到的是字):那就看悬停信息
    if (!onMap.includes('饕餮')) onMap += ` / 悬停 ${hov}`;
    await openOverview(page, 'chronicle');
    chron = await page.locator('.chronicle').innerText().catch(() => '');
    await closeOverview();
  }
  console.log(
    `立国:州「${spot?.name}」→ 点"在这里立国" → 重推 ${resim ? `${resim.paintedMs.toFixed(0)} ms(线程里 ${resim.workerMs.toFixed(0)} ms)` : '没完成'};` +
      `州面板「${regionAfter}」;地图上点同一处「${onMap}」;概览「${listed}」`,
  );
  if (!spot) errs.push('立国:没找到一个有主、能立国的州');
  else {
    if (!resim) errs.push('立国:点"立国"后没有重推');
    if (!regionAfter.includes('属 饕餮')) errs.push(`立国:重推后这州没归新国家(${regionAfter})`);
    if (!onMap.includes('饕餮')) errs.push(`立国:打开"国家"后在地图上点这州,不是新国家(${onMap})`);
    if (!/\d+ 年起.*在.+立国,即饕餮/.test(listed)) errs.push(`立国:概览里的干预列表不对(${listed})`);
    if (!/干预\s+[^\n]*自立,号饕餮/.test(chron)) errs.push('立国:编年史里没有这条干预');
    const RESIM_BUDGET = process.env.CI ? 2500 : 1000;
    if (resim && !(resim.paintedMs <= RESIM_BUDGET)) errs.push(`立国:重推太慢(${resim.paintedMs.toFixed(0)} ms,预算 ${RESIM_BUDGET} ms)`);
  }
  await page.evaluate(() => localStorage.clear());
}

// 城 / 地理实体 / 州的面板(和国家面板同一套):点一座城 → 城面板(三格、兴衰、历任归属、2×2 按钮)→ "看所属国家"切到国家面板;
// 点一个地名 → 地理实体面板(改名 / 名字由来 / 起名);点一个州 → 州面板 → "划给…" → 干预页 → "选择国家" → 地图压暗、名牌、
// 提示条 → 点名牌 → "已从 N 年重新推演 · …划给…"带撤销,州面板里列出这一州的干预 → 撤销 → "已撤销"、列表没了
{
  type Plate = { kind: string; id: number; text: string; note: string; x: number; y: number; on: boolean; self: boolean };
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const Y = 2600;
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&civYear=${Y}`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const vp = page.viewportSize()!;
  const free = (x: number, y: number) => x > 60 && x < vp.width - 420 && y > 110 && y < vp.height - 150;
  const panel = () =>
    page
      .locator('.inspector')
      .innerText({ timeout: 2000 })
      .then((t) => t.replace(/\n/g, ' / '), () => '');
  const picks = () => page.evaluate('window.__wfPickables()') as Promise<Pick[]>;
  /** 关掉面板、等上一下的飞行停下,再点编号为 id 的东西(按现在的屏幕位置) */
  const clickPick = async (kind: string, id: number): Promise<boolean> => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    const p = (await picks()).find((q) => q.kind === kind && q.id === id && free(q.x, q.y));
    if (!p) return false;
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(300);
    return true;
  };
  // 1. 城(挑一座属某国、不是国都的:"看所属国家""迁都到这里"都能点)
  let cityInfo = '';
  let ownerInfo = '';
  let moveCity = -1;
  const marks = (await picks()).filter((q) => q.kind === 'mark' && free(q.x, q.y)).slice(0, 12);
  for (const m of marks) {
    if (!(await clickPick('mark', m.id))) continue;
    if (!(await page.locator('.inspector .cp[data-settlement]').count()) || !(await page.locator('.inspector [data-act=owner]').isEnabled())) continue;
    if (!(await page.locator('.inspector [data-act=move-here]').isEnabled())) continue;
    moveCity = m.id;
    cityInfo = await panel();
    await page.click('.inspector [data-act=owner]');
    await page.waitForTimeout(300);
    ownerInfo = (await page.locator('.inspector .cp[data-polity]').count()) ? await panel() : '';
    break;
  }
  // 2. 地理实体(地名)
  let placeInfo = '';
  const places = (await picks()).filter((q) => q.kind === 'place' && free(q.x, q.y)).slice(0, 8);
  for (const q of places) {
    if (!(await clickPick('place', q.id))) continue;
    if (await page.locator('.inspector .cp[data-place]').count()) {
      placeInfo = await panel();
      break;
    }
  }
  // 3. 州:按网格找地图上的点(先用悬停读数看是不是某个州,是才点),找一个面板是"州"、能"划给…"的
  let regionInfo = '';
  let cedePage = '';
  let pickToast = '';
  let dim = 0;
  let cedePlates: Plate[] = [];
  let hidden = false;
  let doneToast = '';
  let mineAfter = '';
  let undoToast = '';
  let mineGone = false;
  const box = (await page.locator('.map-box').boundingBox())!;
  const grid: [number, number][] = [];
  for (let gy = 0.3; gy < 0.8; gy += 0.08)
    for (let gx = 0.15; gx < 0.62; gx += 0.05) {
      const w = (await page.evaluate(([cx, cy]) => (window as any).__wfClientToWorld(cx, cy), [box.x + box.width * gx, box.y + box.height * gy])) as [number, number] | null;
      if (w) grid.push(w);
    }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  for (const [wx, wy] of grid) {
    const at = (await page.evaluate(([x, y]) => (window as any).__wfWorldToClient(x, y), [wx, wy])) as [number, number] | null;
    if (!at || !free(at[0], at[1]) || !/第 \d+ 州/.test(await probe(page, at[0], at[1]))) continue;
    await page.mouse.click(at[0], at[1]);
    await page.waitForTimeout(300);
    if (!(await page.locator('.inspector .cp[data-region] [data-act=cede]').count())) {
      // 点到的是字 / 城:关掉、等地图停稳再试下一处
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      continue;
    }
    regionInfo = await panel();
    await page.click('.inspector [data-act=cede]');
    await page.waitForTimeout(200);
    cedePage = await panel();
    if (!(await page.locator('.inspector [data-act=cede-pick]').isEnabled())) continue;
    await page.click('.inspector [data-act=cede-pick]');
    await page.waitForTimeout(900);
    dim = await page.locator('.tp-dim').count();
    cedePlates = (await page.evaluate('window.__wfPlates()')) as Plate[];
    pickToast = await toastText(page, 'pick');
    hidden = !(await page.locator('.inspector').isVisible().catch(() => false));
    const tgt = cedePlates.filter((p) => !p.self).sort((a, b) => Math.abs(a.x - vp.width / 2) - Math.abs(b.x - vp.width / 2))[0];
    if (tgt) {
      const prev = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
      await page.mouse.click(tgt.x, tgt.y);
      await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(300);
      doneToast = await toastText(page, 'resim-done');
      mineAfter = (await page.locator('.inspector .cp-mine').innerText({ timeout: 2000 }).catch(() => '')).replace(/\n/g, ' ');
      const prev2 = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
      await page.click('.toast[data-toast=resim-done] .toast-act').catch(() => {});
      await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev2, { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(300);
      undoToast = await toastText(page, 'resim-done');
      mineGone = (await page.locator('.inspector .cp[data-region]').count()) === 1 && !(await page.locator('.inspector .cp-mine').count());
    }
    break;
  }
  // 4. 城面板"迁都到这里":替所属国下迁都令(和国家干预页同一套)→ 面板收起、推演 → "已从 N 年重新推演 · …迁都…"带撤销 → 撤销
  let moveToast = '';
  let moveHidden = false;
  let moveUndo = '';
  if (moveCity >= 0 && (await clickPick('mark', moveCity)) && (await page.locator('.inspector [data-act=move-here]').isEnabled().catch(() => false))) {
    const prev = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
    await page.click('.inspector [data-act=move-here]');
    await page.waitForTimeout(100);
    moveHidden = !(await page.locator('.inspector').isVisible().catch(() => false));
    await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(300);
    moveToast = await toastText(page, 'resim-done');
    const prev2 = await page.evaluate(() => (window as any).__wfResim?.seq ?? 0);
    await page.click('.toast[data-toast=resim-done] .toast-act').catch(() => {});
    await page.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev2, { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(300);
    moveUndo = await toastText(page, 'resim-done');
  }
  console.log(
    `城面板「${cityInfo.slice(0, 120)}…」→ 看所属国家「${ownerInfo.slice(0, 40)}」;地理实体面板「${placeInfo.slice(0, 80)}」;` +
      `州面板「${regionInfo.slice(0, 80)}…」→ 划给…「${cedePage.replace(/.*?生效年份/, '生效年份').slice(0, 60)}」→ 压暗 ${dim}、名牌 ${cedePlates.length} 个、提示条「${pickToast}」、面板藏起 ${hidden}` +
      ` → 点名牌「${doneToast}」,这一州的干预「${mineAfter}」→ 撤销「${undoToast}」,列表没了 ${mineGone};` +
      `迁都到这里 → 面板收起 ${moveHidden}、「${moveToast}」→ 撤销「${moveUndo}」`,
  );
  if (!/^城 · 第 \d+ 年/.test(cityInfo) || !['级别', '人口', '做过国都', '兴衰', '迁都到这里', '看所属国家', '改名', '名字由来'].every((w) => cityInfo.includes(w)))
    errs.push(`城面板:内容不全(${cityInfo.slice(0, 200)})`);
  if (!/^国家 · 第 \d+ 年/.test(ownerInfo)) errs.push(`城面板:"看所属国家"没有切到国家面板(${ownerInfo.slice(0, 60)})`);
  if (!/^(山脉|河流|湖泊|岛屿|荒漠|海|大洋|海湾) · 第 \d+ 年/.test(placeInfo) || !['改名', '名字由来', '起名'].every((w) => placeInfo.includes(w)))
    errs.push(`地理实体面板:没出来 / 内容不全(${placeInfo.slice(0, 120)})`);
  if (!/^州 · 第 \d+ 年/.test(regionInfo) || !['主体民族', '宜居度', '在这里立国', '划给…', '改名', '名字由来'].every((w) => regionInfo.includes(w)))
    errs.push(`州面板:没出来 / 内容不全(${regionInfo.slice(0, 160)})`);
  if (!/生效年份.*该年之前的历史不变.*永久.*选择国家/.test(cedePage)) errs.push(`州面板:"划给…"的干预页不对(${cedePage.slice(0, 160)})`);
  if (!dim || !cedePlates.length) errs.push(`州面板:"划给…"选国家时没有压暗 / 名牌(压暗 ${dim},名牌 ${cedePlates.length})`);
  if (!/^选择.+要划给的国家 \d+ 年起生效 取消 · Esc$/.test(pickToast)) errs.push(`州面板:"划给…"选国家的提示条不对(${pickToast})`);
  if (!hidden) errs.push('州面板:选国家时面板没有收起');
  if (!/^已从 \d+ 年重新推演 · .+划给.+ 撤销$/.test(doneToast)) errs.push(`州面板:划给后没有"已从 N 年重新推演 · …划给…"带撤销(${doneToast})`);
  if (!mineAfter.includes('划给')) errs.push(`州面板:划给后面板里没列出这一州的干预(${mineAfter})`);
  if (!/^已撤销/.test(undoToast) || !mineGone) errs.push(`州面板:撤销后不对(「${undoToast}」,列表没了 ${mineGone})`);
  if (moveCity < 0) errs.push('城面板:没找到能"迁都到这里"的城');
  else if (!moveHidden || !/^已从 \d+ 年重新推演 · .+迁都.+ 撤销$/.test(moveToast) || !/^已撤销/.test(moveUndo))
    errs.push(`城面板:"迁都到这里"不对(面板收起 ${moveHidden},「${moveToast}」,撤销「${moveUndo}」)`);
  await page.evaluate(() => localStorage.clear());
}

// 成书(不联网):右上"成书" → 生成史书窗口(写什么 / 文体 / 篇幅,切选项);没设置 AI 时点"开始生成" →
// 窗口关上、提示条"还没有设置 AI · 去设置"(打开 AI 设置);窗口里的"AI 设置"打开设置,Esc 只关设置。
// 测试用假 AI(放慢):开始生成 → 右上"正在撰写《世界通史》"+ 进度条 → "已完成 · 打开" → 阅读页(书名、正文)→
// 读过就收起;刷新后"已写的史书"里还在,点开能读,删除(点两次)
{
  const hp = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  hp.on('pageerror', (e) => errs.push(`[成书] ${e.message}`));
  hp.on('console', (m) => m.type() === 'error' && errs.push(`[成书] ${m.text()}`));
  await hp.goto(`${dev.url}/?seed=7&style=fantasy`);
  await hp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await hp.click('[data-act=book]');
  const opened = await hp.waitForSelector('.bk-dialog', { timeout: 5000 }).then(() => true, () => false);
  const labels = (await hp.locator('.bk-k').allInnerTexts().catch(() => [] as string[])).join(' / ');
  const scopes = await hp.locator('[data-scope]').count();
  await hp.click('[data-style=annals]').catch(() => null);
  await hp.click('[data-length=k3]').catch(() => null);
  const styleOn = await hp.locator('[data-style=annals].on').count();
  const lengthOn = await hp.locator('[data-length=k3].on').count();
  const hint = await hp.locator('[data-testid=book-hint]').innerText().catch(() => '');
  // 窗口里的"AI 设置":打开设置,Esc 只关设置,成书窗口还在
  await hp.click('.bk-ai').catch(() => null);
  const aiFromDialog = await hp.waitForSelector('.ai-dialog', { timeout: 5000 }).then(() => true, () => false);
  await hp.keyboard.press('Escape');
  await hp.waitForTimeout(200);
  const aiClosedOnly = !(await hp.locator('.ai-dialog').count()) && (await hp.locator('.bk-dialog').count()) === 1;
  await hp.click('[data-act=book-start]').catch(() => null);
  const noAi = await toastText(hp, 'book');
  const dialogClosed = !(await hp.locator('.bk-dialog').count());
  await hp.click('.toast[data-toast=book] .toast-act').catch(() => null);
  const settings = await hp.waitForSelector('.ai-dialog', { timeout: 5000 }).then(() => true, () => false);
  await hp.keyboard.press('Escape');
  // 世界概览头部的"成书"、编年史页的"写成史书"也打开同一个窗口(概览收起)
  await openOverview(hp);
  await hp.click('[data-act=ov-book]').catch(() => null);
  const fromOverview = await hp.waitForSelector('.bk-dialog', { timeout: 3000 }).then(() => true, () => false);
  await hp.keyboard.press('Escape');
  await openOverview(hp, 'chronicle');
  await hp.click('.chron-ai').catch(() => null);
  const fromChronicle = await hp.waitForSelector('.bk-dialog', { timeout: 3000 }).then(() => true, () => false);
  await hp.keyboard.press('Escape');
  if (!fromOverview || !fromChronicle) errs.push(`成书:概览头部的"成书"(${fromOverview})/ 编年史的"写成史书"(${fromChronicle})没打开生成史书窗口`);
  console.log(
    `成书(没设置 AI):窗口 ${opened ? '打开' : '没打开'}(${labels};写什么 ${scopes} 项);切到编年体 ${styleOn}、短篇 ${lengthOn};「${hint}」;` +
      `窗口里的 AI 设置 ${aiFromDialog}、Esc 只关设置 ${aiClosedOnly};开始生成 → 提示「${noAi}」、窗口关上 ${dialogClosed};点"去设置"打开设置 ${settings}`,
  );
  if (!opened) errs.push('成书:点右上"成书"没有打开生成史书窗口');
  else {
    if (labels !== '写什么 / 文体 / 篇幅') errs.push(`成书:窗口里的三行选项不对(${labels})`);
    if (scopes !== 1) errs.push(`成书:没选中国家时"写什么"应该只有"整个世界"(${scopes} 项)`);
    if (!styleOn || !lengthOn) errs.push('成书:点文体 / 篇幅选项没有切过去');
    if (!/约需 \d+–\d+ 分钟/.test(hint)) errs.push(`成书:窗口里没有写要多久(${hint})`);
    if (!aiFromDialog || !aiClosedOnly) errs.push('成书:窗口里的"AI 设置"没打开设置,或 Esc 把成书窗口也关了');
    if (!noAi.includes('还没有设置 AI') || !noAi.includes('去设置')) errs.push(`成书:没设置 AI 时点"开始生成"没有提示条(${noAi})`);
    if (!dialogClosed) errs.push('成书:没设置 AI 时窗口挡着提示条');
    if (!settings) errs.push('成书:提示条上的"去设置"没打开 AI 设置');
  }

  await hp.goto(`${dev.url}/?seed=7&style=fantasy&ai=mock&mockms=150`);
  await hp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await hp.click('[data-act=book]');
  await hp.waitForSelector('.bk-dialog', { timeout: 5000 }).catch(() => null);
  await hp.click('[data-length=k3]').catch(() => null);
  const t0 = Date.now();
  await hp.click('[data-act=book-start]').catch(() => null);
  const writing = await hp.locator('.book-chip').innerText({ timeout: 3000 }).catch(() => '');
  const done = await hp.locator('.book-chip.done').innerText({ timeout: 20000 }).catch(() => '');
  const ms = Date.now() - t0;
  await hp.click('.book-chip.done').catch(() => null);
  await hp.waitForSelector('.bk-reader', { timeout: 5000 }).catch(() => null);
  const title = await hp.locator('.bk-reader .bk-book').innerText().catch(() => '');
  const meta = await hp.locator('.bk-reader .bk-meta').innerText().catch(() => '');
  const body = await hp.locator('.bk-reader .bk-text').innerText().catch(() => '');
  await hp.keyboard.press('Escape');
  await hp.waitForTimeout(200);
  const readerClosed = !(await hp.locator('.bk-reader').count());
  const chipGone = !(await hp.locator('.book-chip').count());
  await hp.reload();
  await hp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await hp.click('[data-act=book]');
  await hp.waitForSelector('.bk-dialog', { timeout: 5000 }).catch(() => null);
  const kept = await hp.locator('.bk-lib-row').count();
  await hp.click('.bk-lib-row >> nth=0').catch(() => null);
  const reopened = await hp.locator('.bk-reader .bk-book').innerText({ timeout: 3000 }).catch(() => '');
  await hp.click('[data-act=book-delete]').catch(() => null);
  await hp.click('[data-act=book-delete]').catch(() => null);
  await hp.waitForTimeout(200);
  const deleted = !(await hp.locator('.bk-reader').count());
  await hp.click('[data-act=book]');
  const left = await hp.locator('.bk-lib-row').count();
  // 写的时候点右上的进度:边写边看,可以停止(写到一半的不存),再点"重试"接着写完
  await hp.click('[data-act=book-start]').catch(() => null);
  await hp.click('.book-chip', { timeout: 3000 }).catch(() => null);
  const stopBtn = await hp.locator('[data-act=book-stop]').count();
  await hp.click('[data-act=book-stop]').catch(() => null);
  await hp.waitForFunction(() => document.querySelector('.bk-reader .bk-info')?.textContent?.includes('已停止'), null, { timeout: 3000 }).catch(() => null);
  const stopped = await hp.locator('.bk-reader .bk-info').innerText({ timeout: 3000 }).catch(() => '');
  const stoppedLeft = await hp.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('civ-atlas:ai-notes:')).length);
  await hp.click('[data-act=book-redo]').catch(() => null);
  const redone = await hp
    .waitForFunction(() => /\d+ 字 · 测试用假 AI/.test(document.querySelector('.bk-reader .bk-info')?.textContent ?? ''), null, { timeout: 20000 })
    .then(() => true, () => false);
  await hp.keyboard.press('Escape');
  console.log(
    `成书(假 AI):「${writing.replace(/\n/g, ' ')}」→「${done.replace(/\n/g, ' ')}」${ms} ms;阅读「${title}」(${meta}),正文 ${body.length} 字;` +
      `Esc 关上 ${readerClosed}、右上收起 ${chipGone};刷新后已写的史书 ${kept} 部,点开「${reopened}」;删除 ${deleted},剩 ${left} 部;` +
      `写的时候打开:停止按钮 ${stopBtn}、停下后「${stopped}」(存下 ${stoppedLeft} 部)、重试写完 ${redone}`,
  );
  if (!stopBtn || !stopped.includes('已停止') || stoppedLeft !== 0) errs.push(`成书:写的时候不能停止,或停下后存了半部(${stopped})`);
  if (!redone) errs.push('成书:停下后点"重试"没有写完');
  if (!writing.includes('正在撰写《世界通史》')) errs.push(`成书:开始生成后右上没有"正在撰写《世界通史》"(${writing})`);
  if (!done.includes('《世界通史》已完成 · 打开')) errs.push(`成书:写完右上没有"已完成 · 打开"(${done})`);
  if (title !== '《世界通史》') errs.push(`成书:阅读页书名不对(${title})`);
  if (!/编年体|纪传体/.test(meta) || !meta.includes('短篇') || !meta.includes('截至')) errs.push(`成书:阅读页元信息不对(${meta})`);
  if (!body.includes('测试用假 AI')) errs.push('成书:阅读页没有正文');
  if (!readerClosed || !chipGone) errs.push('成书:Esc 没关上阅读页,或读过之后右上的"已完成"还在');
  if (kept !== 1) errs.push(`成书:刷新后"已写的史书"应该有 1 部(${kept})`);
  if (reopened !== '《世界通史》') errs.push(`成书:点已写的史书没打开阅读页(${reopened})`);
  if (!deleted || left !== 0) errs.push(`成书:删除没生效(阅读页关上 ${deleted},剩 ${left} 部)`);
  await hp.evaluate(() => localStorage.clear());
  await hp.close();
}

// 搜索:右上"搜索" → 框里先列出最大的几个国家 → 输入名字出结果 → 点一条:框关上、选中它(右侧出面板);
// 选中国家后"成书"的"写什么"多出这一国;Esc / 点框外面关上
{
  const sp = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  sp.on('pageerror', (e) => errs.push(`[搜索] ${e.message}`));
  sp.on('console', (m) => m.type() === 'error' && errs.push(`[搜索] ${m.text()}`));
  await sp.goto(`${dev.url}/?seed=7&style=fantasy`);
  await sp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await sp.click('[data-act=search]');
  const shown = await sp.waitForSelector('.search-box', { timeout: 5000 }).then(() => true, () => false);
  const placeholder = await sp.locator('.search-input').getAttribute('placeholder').catch(() => '');
  const first = await sp.locator('.search-row >> nth=0').innerText().catch(() => '');
  const initial = await sp.locator('.search-row').count();
  await sp.keyboard.press('Escape');
  const escClosed = !(await sp.locator('.search-box').count());
  // 按名字搜第一个国家
  const name = first.split('\n')[0];
  await sp.click('[data-act=search]');
  await sp.fill('.search-input', name);
  await sp.waitForTimeout(150);
  const rows = (await sp.locator('.search-row .search-name').allInnerTexts().catch(() => [] as string[])) as string[];
  await sp.click('.search-row >> nth=0').catch(() => null);
  await sp.waitForTimeout(300);
  const pickClosed = !(await sp.locator('.search-box').count());
  const selected = await sp.evaluate(() => document.querySelector('.app')?.classList.contains('panel-open') ?? false);
  await sp.click('[data-act=book]');
  await sp.waitForSelector('.bk-dialog', { timeout: 5000 }).catch(() => null);
  const scopes = (await sp.locator('[data-scope]').allInnerTexts().catch(() => [] as string[])).join(' / ');
  const worldFirst = await sp.locator('[data-scope=world].on').count();
  await sp.keyboard.press('Escape');
  // 国家面板里的"写国史":打开成书窗口,默认写这一国
  await sp.click('.app button:has-text("国史")', { timeout: 3000 }).catch(() => null);
  const polityDefault = await sp.locator('.bk-dialog [data-scope=polity].on').innerText({ timeout: 3000 }).catch(() => '');
  await sp.keyboard.press('Escape');
  // 点框外面关上
  await sp.click('[data-act=search]');
  await sp.mouse.click(700, 450);
  await sp.waitForTimeout(150);
  const outsideClosed = !(await sp.locator('.search-box').count());
  console.log(
    `搜索:框 ${shown ? '出来' : '没出来'}(占位「${placeholder}」),先列 ${initial} 个国家,第一个「${first.replace(/\n/g, ' ')}」;Esc 关上 ${escClosed};` +
      `搜「${name}」→ ${rows.join('、')};点第一条:框关上 ${pickClosed}、选中 ${selected};成书的写什么:${scopes}(默认整个世界 ${worldFirst});` +
      `面板里写国史 → 默认「${polityDefault}」;点外面关上 ${outsideClosed}`,
  );
  if (!shown) errs.push('搜索:点右上"搜索"没有出来搜索框');
  else {
    if (placeholder !== '国家、城市或民族') errs.push(`搜索:占位文字不对(${placeholder})`);
    if (initial < 3 || initial > 8 || !/\d+ 州/.test(first)) errs.push(`搜索:空着时应该列出最大的几个国家(${initial} 个,${first})`);
    if (!escClosed || !outsideClosed) errs.push('搜索:Esc / 点外面没关上搜索框');
    if (!rows.length || !rows.some((r) => r.includes(name))) errs.push(`搜索:输入名字没搜到(${rows.join('、')})`);
    if (!pickClosed || !selected) errs.push('搜索:点一条没关框 / 没选中');
    if (!scopes.includes('整个世界') || !scopes.includes(name) || !worldFirst) errs.push(`搜索:选中国家后成书的"写什么"没有这一国 / 默认不是整个世界(${scopes})`);
    if (polityDefault !== name) errs.push(`成书:国家面板里的"写国史"没有默认写这一国(${polityDefault})`);
  }
  await sp.close();
}

// AI 改写(阶段 5「对话式编辑」,不联网):右上"改写" → 框里一行说明 + 三句按这个世界写的例子;没设置 AI 时"发送"点不了,
// 底部一行提示 +"设置 AI"(打开设置;Esc 只关设置)。测试用假 AI(时间轴在 2000 年):说一句(不提地形)→ 列出一条"保护"提议(2000 年起、至 2300 年)→
// "执行 1 条":框收起、后台重推,提示条"已按你说的改写"(带撤销)、左上"已干预 1 处" → 提示条上点撤销 → 重推回"未干预";
// 再打开框,那一轮写"已撤销";点框外面关上
{
  const rp = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  rp.on('pageerror', (e) => errs.push(`[改写] ${e.message}`));
  rp.on('console', (m) => m.type() === 'error' && errs.push(`[改写] ${m.text()}`));
  await rp.goto(`${dev.url}/?seed=7&style=fantasy`);
  await rp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await rp.locator('[data-act=rewrite]:not([disabled])').waitFor({ timeout: 60000 });
  await rp.click('[data-act=rewrite]');
  const shown = await rp.waitForSelector('.rw-box', { timeout: 5000 }).then(() => true, () => false);
  const hint = await rp.locator('.rw-hint').innerText().catch(() => '');
  const examples = (await rp.locator('.rw-example').allInnerTexts().catch(() => [] as string[])) as string[];
  const unset = await rp.locator('.rw-unset').innerText().catch(() => '');
  await rp.fill('.rw-input textarea', '让最大的国家多撑三百年');
  const sendOff = await rp.locator('[data-act=rw-send]').isDisabled().catch(() => false);
  await rp.click('.rw-unset .rw-link').catch(() => null);
  const aiOpened = await rp.waitForSelector('.ai-dialog', { timeout: 5000 }).then(() => true, () => false);
  await rp.keyboard.press('Escape');
  await rp.waitForTimeout(150);
  const boxKept = (await rp.locator('.rw-box').count()) === 1 && !(await rp.locator('.ai-dialog').count());
  await rp.keyboard.press('Escape');
  const escClosed = !(await rp.locator('.rw-box').count());
  console.log(
    `改写(没设置 AI):框 ${shown ? '出来' : '没出来'}「${hint.slice(0, 24)}…」,例子 ${examples.join(' / ')};「${unset.replace(/\n/g, ' ')}」,发送点不了 ${sendOff};` +
      `"设置 AI"打开设置 ${aiOpened}、Esc 只关设置 ${boxKept};再 Esc 关上 ${escClosed}`,
  );
  if (!shown) errs.push('改写:点右上"改写"没有出来框');
  else {
    if (!hint.includes('点了执行才改')) errs.push(`改写:框里没有说明(${hint})`);
    if (examples.length !== 3) errs.push(`改写:空的时候应该有三句例子(${examples.join(' / ')})`);
    if (!unset.includes('设置 AI') || !sendOff) errs.push(`改写:没设置 AI 时应该提示、"发送"点不了(${unset};点不了 ${sendOff})`);
    if (!aiOpened || !boxKept || !escClosed) errs.push(`改写:"设置 AI"没打开设置 / Esc 把改写框也关了 / 再按 Esc 没关上(${aiOpened}、${boxKept}、${escClosed})`);
  }

  await rp.goto(`${dev.url}/?seed=7&style=fantasy&ai=mock&civYear=2000`);
  await rp.locator('[data-act=rewrite]:not([disabled])').waitFor({ timeout: 60000 });
  await rp.waitForTimeout(300);
  const sub0 = await rp.locator('.wt-sub').innerText().catch(() => '');
  await rp.click('[data-act=rewrite]');
  await rp.fill('.rw-input textarea', '让最大的国家多撑三百年');
  await rp.click('[data-act=rw-send]');
  await rp.waitForSelector('.rw-turn .rw-ans', { timeout: 10000 }).catch(() => null);
  const items = (await rp.locator('.rw-item .rw-text').allInnerTexts().catch(() => [] as string[])) as string[];
  const years = (await rp.locator('.rw-item .rw-year').allInnerTexts().catch(() => [] as string[])) as string[];
  const checked = await rp.locator('.rw-check[aria-checked=true]').count();
  const go = await rp.locator('[data-act=rw-apply]').innerText().catch(() => '');
  const cannot = await rp.locator('.rw-cannot').count();
  const prev = await rp.evaluate(() => (window as any).__wfResim?.seq ?? 0);
  await rp.click('[data-act=rw-apply]').catch(() => null);
  await rp.waitForTimeout(100);
  const boxGone = !(await rp.locator('.rw-box').count());
  const resimmed = await rp
    .waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 })
    .then(() => true, () => false);
  const done = await toastText(rp, 'resim-done', 5000);
  const sub1 = await rp.locator('.wt-sub').innerText().catch(() => '');
  const prevU = await rp.evaluate(() => (window as any).__wfResim?.seq ?? 0);
  await rp.click('.toast[data-toast=resim-done] [data-act=rw-undo]').catch(() => null);
  const undone = await rp
    .waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prevU, { timeout: 20000 })
    .then(() => true, () => false);
  const undoToast = await toastText(rp, 'resim-done', 5000);
  const sub2 = await rp.locator('.wt-sub').innerText().catch(() => '');
  await rp.click('[data-act=rewrite]');
  const turnState = await rp.locator('.rw-turn .rw-done').innerText({ timeout: 3000 }).catch(() => '');
  await rp.mouse.click(700, 450);
  await rp.waitForTimeout(150);
  const outsideClosed = !(await rp.locator('.rw-box').count());
  console.log(
    `改写(假 AI):提议 ${items.map((t, i) => `${years[i]} ${t}`).join(';')}(勾着 ${checked} 条,按钮「${go}」,做不到 ${cannot} 句);` +
      `执行:框收起 ${boxGone}、重推 ${resimmed}、提示「${done}」、左上「${sub0}」→「${sub1}」;撤销:重推 ${undone}、提示「${undoToast}」、左上「${sub2}」;` +
      `再打开那一轮「${turnState}」;点外面关上 ${outsideClosed}`,
  );
  if (items.length !== 1 || !/:保护\(至第 2300 年\)$/.test(items[0] ?? '') || years[0] !== '2000') errs.push(`改写:假 AI 的提议不对(${items.join(';')})`);
  if (checked !== 1 || go !== '执行 1 条' || cannot !== 1) errs.push(`改写:提议默认全勾、按钮写条数、做不到的一句(勾 ${checked},「${go}」,做不到 ${cannot})`);
  if (!boxGone || !resimmed) errs.push(`改写:点"执行"后框没收起 / 没有重推(${boxGone}、${resimmed})`);
  if (!/已按你说的改写 · 从 \d+ 年重新推演.*撤销/.test(done)) errs.push(`改写:执行后提示条不对(${done})`);
  if (!sub0.includes('未干预') || !sub1.includes('已干预 1 处')) errs.push(`改写:执行后左上应从"未干预"变成"已干预 1 处"(${sub0} → ${sub1})`);
  if (!undone || !undoToast.includes('已撤销改写') || !sub2.includes('未干预')) errs.push(`改写:提示条上的撤销不对(重推 ${undone},「${undoToast}」,左上「${sub2}」)`);
  if (turnState !== '已撤销') errs.push(`改写:撤销后再打开,那一轮应写"已撤销"(${turnState})`);
  if (!outsideClosed) errs.push('改写:点框外面没关上');
  await rp.evaluate(() => localStorage.clear());
  await rp.close();
}

// AI 设置(阶段 5):打开"AI" → 我们的 AI 显示"内测" → 假 AI(ai=mock,不联网)"测试一下"成功 → 调用记录里有一条、刷新后还在 → 清空
{
  const outside: string[] = [];
  const onReq = (r: { url: () => string }) => /deepseek\.com|aliyuncs\.com/.test(new URL(r.url()).host) && outside.push(r.url());
  page.on('request', onReq);
  await page.goto(`${dev.url}/?seed=7&ai=mock`);
  await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await openOverview();
  await page.click('.ai-btn');
  await page.waitForSelector('.ai-dialog', { timeout: 10000 });
  const official = await page.locator('[data-ai=official]').innerText();
  const mockOn = await page.locator('[data-ai=mock]').getAttribute('aria-checked');
  await page.click('[data-act=ai-test]');
  const test = await page
    .waitForSelector('.ai-test.ok, .ai-test.error', { timeout: 10000 })
    .then((h) => h.innerText(), () => '');
  await page.click('[data-tab=log]');
  const rows = await page.locator('.ai-log-row').count();
  await page.click('.ai-log-row >> nth=0 >> .ai-log-head');
  const detail = (await page.locator('.ai-log-body').innerText().catch(() => '')).replace(/\n/g, ' ');
  // 刷新后记录还在(存在浏览器的 IndexedDB 里)
  await page.reload();
  await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await openOverview();
  await page.click('.ai-btn');
  await page.click('[data-tab=log]');
  await page.waitForFunction(() => document.querySelectorAll('.ai-log-row').length > 0, null, { timeout: 5000 }).catch(() => {});
  const kept = await page.locator('.ai-log-row').count();
  await page.click('[data-act=ai-log-clear]');
  await page.click('[data-act=ai-log-clear]');
  const cleared = await page.locator('.ai-log-row').count();
  await page.keyboard.press('Escape');
  const closed = !(await page.locator('.ai-dialog').count());
  await closeOverview();
  page.off('request', onReq);
  console.log(
    `AI 设置:我们的 AI「${official.replace(/\n/g, ' ')}」;假 AI 选中 ${mockOn};测试「${test}」;` +
      `调用记录 ${rows} 条,展开「${detail.slice(0, 60)}」;刷新后 ${kept} 条;清空后 ${cleared} 条`,
  );
  if (!official.includes('内测')) errs.push(`AI 设置:没配置服务器时"我们的 AI"没显示内测(${official})`);
  if (mockOn !== 'true') errs.push('AI 设置:网址带 ai=mock 时假 AI 没被选中');
  if (!test.includes('连上了')) errs.push(`AI 设置:假 AI"测试一下"没成功(${test})`);
  if (rows !== 1) errs.push(`AI 设置:测试后调用记录应该有 1 条(实际 ${rows})`);
  if (!detail.includes('连接测试') && !detail.includes('你好')) errs.push(`AI 设置:展开调用记录看不到发出去的内容(${detail})`);
  if (kept !== 1) errs.push(`AI 设置:刷新后调用记录没留住(${kept} 条)`);
  if (cleared !== 0) errs.push('AI 设置:清空后还有记录');
  if (!closed) errs.push('AI 设置:按 Esc 没关掉');
  if (outside.length) errs.push(`AI 设置:冒烟测试里请求了真的服务商(${outside[0]})`);
  await page.evaluate(() => localStorage.clear());
}

// AI 释名 / 起名(阶段 5,不联网):没设置 AI 时点"释名" → 一行提示"还没有设置 AI" +"设置 AI"打开设置面板;
// 测试用假 AI:点一座城 → 释名(写完存下)→ AI 起名 → 选第一个 → 就用这个 → 地图上的城名变了
{
  await page.evaluate(() => localStorage.clear());
  let notSet = '';
  let settingsOpened = false;
  {
    await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
    await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    type Pick = { kind: string; id: number; text: string; x: number; y: number };
    const ps = (await page.evaluate('window.__wfPickables()')) as Pick[];
    const city = ps.find((p) => p.kind === 'settlement' && ps.some((m) => m.kind === 'mark' && m.id === p.id));
    const mark = city && ps.find((m) => m.kind === 'mark' && m.id === city.id);
    if (mark) {
      await page.mouse.click(mark.x, mark.y);
      await page.click('.inspector [data-ain=explain]');
      notSet = await page
        .waitForSelector('.inspector .ain-err', { timeout: 5000 })
        .then((h) => h.innerText(), () => '');
      await page.click('.inspector .ain-err button:has-text("设置 AI")').catch(() => {});
      settingsOpened = await page
        .waitForSelector('.ai-dialog', { timeout: 5000 })
        .then(() => true, () => false);
      await page.keyboard.press('Escape');
    }
  }
  console.log(`AI 释名(没设置 AI):「${notSet.replace(/\n/g, ' ')}」→ 点"设置 AI"打开设置面板 ${settingsOpened}`);
  if (!/还没有设置 AI/.test(notSet) || !notSet.includes('设置 AI')) errs.push(`AI 释名:没设置 AI 时没有一行提示和"设置 AI"(${notSet})`);
  if (!settingsOpened) errs.push('AI 释名:点"设置 AI"没有打开设置面板');
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities&ai=mock`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  const ps = (await page.evaluate('window.__wfPickables()')) as Pick[];
  // 挑一座悬停时"最近城市"就是它自己的城(同一州里可能有更大的城):改名后悬停信息里才看得到新名字;
  // 符号在舞台中间一带(详情面板在左 / 右边弹出,宽约 300 像素,会盖住靠边的符号)
  let city: Pick | undefined;
  let mark: Pick | undefined;
  const vw = page.viewportSize()!.width;
  for (const c of ps.filter((p) => p.kind === 'settlement' && ps.some((m) => m.kind === 'mark' && m.id === p.id && m.x > 450 && m.x < vw - 450)).slice(0, 20)) {
    const m = ps.find((q) => q.kind === 'mark' && q.id === c.id)!;
    const t = await probe(page, m.x, m.y);
    if (t.includes(`最近城市 ${c.text}`)) {
      city = c;
      mark = m;
      break;
    }
  }
  let note = '';
  let cands: string[] = [];
  let chosen = '';
  let renamed = false;
  let stale = '';
  if (city && mark) {
    await page.mouse.click(mark.x, mark.y);
    await page.click('.inspector [data-ain=explain]');
    await page.waitForSelector('.inspector .ain-note:not(.writing) .ain-text', { timeout: 10000 }).catch(() => null);
    note = await page.locator('.inspector .ain-note .ain-text').innerText().catch(() => '');
    // "AI 起名"在改名时的输入框下面(和国家面板一样);先点进要求框(名字输入框收起),再点"起 5 个"
    await page.click('.inspector [data-act=rename]');
    await page.click('.inspector [data-ain=suggest]');
    await page.click('.inspector .ain-wish input');
    await page.click('.inspector .ain-go');
    await page.waitForSelector('.inspector .ain-cand', { timeout: 10000 }).catch(() => null);
    cands = await page.locator('.inspector .ain-cand-name').allInnerTexts();
    if (cands.length) {
      chosen = cands[0];
      await page.click('.inspector .ain-cand-btn >> nth=0');
      await page.click('.inspector .ain-ok');
      renamed = await page
        .waitForFunction(([n, old]) => (window as any).__wfLabels?.texts?.includes(n) && !(window as any).__wfLabels.texts.includes(old), [chosen, city.text], { timeout: 5000 })
        .then(() => true, () => false);
      stale = await page.locator('.inspector .ain-stale').innerText().catch(() => '');
    }
  }
  console.log(`AI 释名 / 起名:点「${city?.text}」→ 释名「${note.slice(0, 30)}…」;候选 ${cands.join('、')};选「${chosen}」→ 地图上的城名变了 ${renamed};释名标「${stale}」`);
  if (!city) errs.push('AI 起名:没找到能点的城');
  else {
    if (!note.includes('测试用假 AI')) errs.push('AI 释名:没写出(假 AI 的)名字由来');
    if (!cands.length) errs.push('AI 起名:没出候选名字');
    if (!renamed) errs.push('AI 起名:选中候选、确定后地图上的城名没有变');
    if (!stale.includes('写于改名前')) errs.push('AI 起名:改名后释名没有标"写于改名前"');
  }
  await page.evaluate(() => localStorage.clear());
}

// 世界东西相连:左右无限拖动(每帧耗时)、拖一整圈回到原处画面一致、接缝两侧点到同一块地、
// 编年史跳转走短边、手绘风的外框罗盘画在视窗上、导出按当前视图中心展开
{
  const { PNG } = await import('pngjs');
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const view = () => page.evaluate(() => (window as any).__wfView);
  const setCenter = async (lon: number) => {
    await page.evaluate(() => (((window as any).__wfLabels ??= {}).mark = 1));
    await page.evaluate((l) => (window as any).__wfSetCenter(l), lon);
    await page.waitForFunction(() => !(window as any).__wfLabels?.mark, null, { timeout: 5000 }).catch(() => {});
  };
  const v0 = await view();
  const box = (await page.locator('.map-box').boundingBox())!;
  const sx = box.x + box.width * 0.3;
  const sy = box.y + box.height * 0.5;
  // 1. 拖动时每帧耗时:按住以后在页面里连发 60 次移动,每次量"事件 → 地图层变换、文字层重排、视窗装饰重画"做完
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const frames = await page.evaluate(
    async ([x0, y0]) => {
      const el = document.querySelector('main.stage')!;
      // 等 React 这一轮做完:它排的任务在前,我们的消息在后(不要在这里声明具名函数:tsx 会插入页面里没有的 __name)
      const ch = new MessageChannel();
      const ms: number[] = [];
      const lab: number[] = [];
      for (let i = 1; i <= 60; i++) {
        const t0 = performance.now();
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: x0 + i * 9, clientY: y0, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
        await new Promise<void>((r) => {
          ch.port1.onmessage = () => r();
          ch.port2.postMessage(0);
        });
        ms.push(performance.now() - t0);
        lab.push((window as any).__wfLabels?.ms ?? NaN);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return { ms, lab };
    },
    [sx, sy],
  );
  await page.mouse.up();
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const panMed = med(frames.ms);
  const panMax = Math.max(...frames.ms);
  const v1 = await view();
  console.log(
    `左右拖动:60 帧,每帧(事件 → 重排文字 → 画完)中位数 ${panMed.toFixed(1)} ms、最慢 ${panMax.toFixed(1)} ms(文字层中位数 ${med(frames.lab).toFixed(1)} ms);` +
      `中心经度 ${v0.lon.toFixed(1)}° → ${v1.lon.toFixed(1)}°`,
  );
  if (!(Math.abs(v1.lon - v0.lon) > 30)) errs.push('东西相连:缩放 1 倍时左右拖不动');
  // 预算一帧 16 ms(60 帧 / 秒);CI 的虚拟机比一般电脑慢两三倍(同一段文字层重排约是本机的 3 倍),放宽到 2.5 倍
  const PAN_BUDGET = process.env.CI ? 40 : 16;
  if (!(panMed <= PAN_BUDGET)) errs.push(`东西相连:拖动每帧太慢(中位数 ${panMed.toFixed(1)} ms,预算 ${PAN_BUDGET} ms)`);

  // 2. 拖一整圈(一圈 = 缩放倍数 × 地图框宽)回到原处:画面一模一样
  await setCenter(0);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const shotA = PNG.sync.read(await page.locator('main.stage').screenshot());
  const vA = await view();
  const P = vA.k * vA.bw;
  let halfway = NaN;
  for (let h = 0; h < 2; h++) {
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + P / 2, sy, { steps: 12 });
    await page.mouse.up();
    // __wfView 在 React 画完这一帧以后才更新:慢的机器上马上读会读到上一步的(差一步 = 15°)
    await page.waitForTimeout(200);
    if (h === 0) halfway = (await view()).lon;
  }
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const shotB = PNG.sync.read(await page.locator('main.stage').screenshot());
  const vB = await view();
  let diff = 0;
  for (let i = 0; i < shotA.data.length; i += 4) {
    if (Math.max(Math.abs(shotA.data[i] - shotB.data[i]), Math.abs(shotA.data[i + 1] - shotB.data[i + 1]), Math.abs(shotA.data[i + 2] - shotB.data[i + 2])) > 16) diff++;
  }
  const diffPct = (diff / (shotA.width * shotA.height)) * 100;
  console.log(`拖一整圈(${P.toFixed(0)} 像素):中心 ${vA.lon.toFixed(2)}° → 半圈时 ${halfway.toFixed(2)}° → ${vB.lon.toFixed(2)}°,画面变化 ${diffPct.toFixed(3)}%`);
  if (!(Math.abs(Math.abs(halfway) - 180) < 0.5)) errs.push(`东西相连:拖半圈没转到 180°(${halfway})`);
  if (!(Math.abs(vB.lon - vA.lon) < 0.01) || !(diffPct < 0.2)) errs.push(`东西相连:拖一整圈没回到原处(画面变化 ${diffPct.toFixed(2)}%)`);

  // 3. 接缝两侧:同一个地方从视窗的不同位置点(一次在主图上,一次在右边接的那一份上),选中的是同一个州、悬停信息一样(带经度)。
  // 关掉地名、国名(字的位置随视窗变,点到字就选中字了),只比地块
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=-labels`);
  await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await page.waitForFunction(() => (window as any).__wfCiv?.ready, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  const W = 2048;
  const H = 1024;
  let pairs = 0;
  let same = 0;
  let lonHover = '';
  // 同一个世界点:一次让它落在视窗中线右边 300 像素(主图右边接的那一份上),一次落在左边 300 像素(主图上);
  // 两次都正好落在整数屏幕像素上(转中心时按它算),点到的是同一个像素
  const stage = (await page.locator('main.stage').boundingBox())!;
  const vv = await view();
  const lonOf = (x: number) => ((x / W - Math.floor(x / W)) * 360) - 180;
  // 180° 经线两边找陆地(那一带可能大半是海:从接缝往两边各找几档)
  for (let yy = 0.12; yy <= 0.88 && pairs < 6; yy += 0.04) {
    const Y = Math.round(box.y + yy * box.height);
    for (const wx of [5, W - 5, 60, W - 60, 150, W - 150]) {
      if (pairs >= 6) break;
      const got: string[] = [];
      for (const side of [1, -1]) {
        const X = Math.round(stage.x + stage.width / 2 + side * 300);
        const d = X - stage.x - vv.sw / 2;
        // 上一下选中后地图飞走了(国家:缩放到看全疆域):先放回原来的视图
        await page.evaluate((v) => (window as any).__wfSetView({ k: v.k, x: v.x, y: v.y }), vv);
        await page.evaluate((l) => (window as any).__wfSetCenter(l), lonOf(wx - (d * W) / (vv.k * vv.bw)));
        // 先取消选中(同一个州再选一次不会重画选中层),和上一下隔开,免得算成双击
        await page.keyboard.press('Escape');
        await page.waitForTimeout(450);
        await page.evaluate(() => ((window as any).__wfSelection = null));
        const at = [X, Y];
        await page.mouse.move(at[0], at[1]);
        await page.waitForTimeout(60);
        const hov = (await probe(page, at[0], at[1])).replace(/ \/ /g, '\n');
        await page.mouse.click(at[0], at[1]);
        await page.waitForTimeout(120);
        const sel = await page.evaluate(() => (window as any).__wfSelection);
        got.push(sel ? `${sel.kind}:${sel.id}|${hov}` : '');
        if (!lonHover) lonHover = hov.split('\n').find((l) => l.includes('经度')) ?? '';
      }
      if (!got[0]) continue; // 海上(点了是取消选中),换一处
      pairs++;
      if (got[0] === got[1]) same++;
    }
  }
  await page.keyboard.press('Escape');
  console.log(`接缝两侧点选:${pairs} 处,两种中心下选中同一个 ${same} 处;读数「${lonHover}」`);
  if (!pairs || same !== pairs) errs.push(`东西相连:接缝附近同一处从不同位置点,选中的不一样(${same}/${pairs})`);
  if (!/经度 \d+°[EW]?/.test(lonHover)) errs.push('东西相连:读数里没有经度');

  // 4. 编年史点一条:放大 3 倍、中心转到 180°,事发地不在视野里就平移过去 —— 走短边(平移量不超过半圈)
  {
    await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
    await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    await setCenter(180);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 6; i++) {
      const k = (await view()).k;
      if (k >= 2.9) break;
      await page.mouse.wheel(0, -Math.log(3 / k) / 0.0015);
      await page.waitForTimeout(100);
    }
    await openOverview(page, 'chronicle');
    await page.waitForSelector('.chronicle .chron-row', { timeout: 10000 });
    const rows = page.locator('.chron-list > .chron-item > .chron-row');
    const n = Math.min(12, await rows.count());
    const pans: number[] = [];
    let half = 0;
    for (let i = 0; i < n; i++) {
      // 点一条概览就收起:每条之前再打开编年史页
      await openOverview(page, 'chronicle');
      await page.evaluate(() => ((window as any).__wfPan = null));
      await rows.nth(i).click();
      await page.waitForTimeout(550);
      const pan = await page.evaluate(() => (window as any).__wfPan);
      const v = await view();
      half = (v.k * v.bw) / 2;
      if (pan) pans.push(pan.dx);
    }
    const worst = pans.length ? Math.max(...pans.map((d) => Math.abs(d))) : 0;
    console.log(`编年史跳转(东西相连):点了 ${n} 条,平移了 ${pans.length} 次,最大横向平移 ${worst.toFixed(0)} 像素(半圈 ${half.toFixed(0)} 像素)`);
    if (!pans.length) errs.push('东西相连:编年史点了好几条,地图一次都没平移过去');
    if (worst > half + 2) errs.push(`东西相连:编年史跳转绕了远路(平移 ${worst.toFixed(0)} 像素 > 半圈 ${half.toFixed(0)})`);
    // 双击:缩放复位,中央经线不变(它是这个世界的设置)
    const before = (await view()).lon;
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    const vr = await view();
    const dl = Math.abs(((vr.lon - before + 540) % 360) - 180);
    if (!(vr.k === 1 && dl < 0.5)) errs.push(`东西相连:双击没有只复位缩放(k=${vr.k},中心 ${before.toFixed(1)}° → ${vr.lon.toFixed(1)}°)`);
  }

  // 5. 手绘风:外框、罗盘、纸边做旧画在视窗上(视窗装饰层画了,地形图本身没有外框)
  const decor = await page.evaluate(() => {
    const d = document.querySelector('canvas.decor') as HTMLCanvasElement | null;
    return { shown: !!d && d.style.display !== 'none' && d.width > 0, dbg: (window as any).__wfDecor };
  });
  console.log(`视窗装饰:${JSON.stringify(decor)}`);
  if (!decor.shown) errs.push('东西相连:手绘风的外框 / 罗盘没有画在视窗上');

  // 6. 改地形:中心转到 180°(接缝在视窗正中),"山脉"按住从接缝左边拖到右边 —— 画的线是连着的一笔(不横穿整张图),能照常重新生成
  {
    await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=-labels`);
    await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__wfSetCenter(180));
    await page.waitForTimeout(150);
    await terrainOn();
    await page.click('.terrain-bar [data-tool=range]');
    const [cx, cy] = (await page.evaluate(() => (window as any).__wfWorldToClient(0, 420))) as [number, number];
    const prev = await page.evaluate(() => (window as any).__wfTerrain?.id ?? 0);
    await page.mouse.move(cx - 70, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 70, cy + 10, { steps: 14 });
    await page.mouse.up();
    const d = await page.locator('.terrain-overlay path.tt-line').first().getAttribute('d').catch(() => null);
    const xs = (d ?? '').match(/-?[\d.]+/g)?.map(Number).filter((_, i) => i % 2 === 0) ?? [];
    let jump = 0;
    for (let i = 1; i < xs.length; i++) jump = Math.max(jump, Math.abs(xs[i] - xs[i - 1]));
    const regen = await page
      .waitForFunction((p) => ((window as any).__wfTerrain?.id ?? 0) > p, prev, { timeout: 60000 })
      .then(() => page.evaluate(() => (window as any).__wfTerrain), () => null);
    console.log(`改地形跨接缝:线上 ${xs.length} 个点,x 从 ${xs[0]} 到 ${xs.at(-1)},相邻两点最大跳 ${jump};重新生成 ${regen ? `${regen.paintedMs.toFixed(0)} ms` : '没完成'}`);
    if (xs.length < 3 || jump > 200) errs.push(`东西相连:跨接缝画的山脉线不是连着的一笔(相邻两点跳 ${jump})`);
    if (!(Math.min(...xs) < 2048 && Math.max(...xs) > 2048) && !(Math.min(...xs) < 0 && Math.max(...xs) > 0)) errs.push('东西相连:山脉线没有跨过 180° 经线');
    if (!regen) errs.push('东西相连:跨接缝画了山脉以后没有重新生成');
  }

  // 7. 导出:中心转到 90°E 导出地图图片(不带地名),图片中部 = 地形图左右转四分之一圈
  {
    await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=-labels`);
    await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__wfSetCenter(90));
    await page.waitForTimeout(200);
    const terrain = await page.evaluate(() => {
      const cv = document.querySelector('.map-box canvas') as HTMLCanvasElement;
      return { w: cv.width, h: cv.height, px: Array.from(cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data) };
    });
    await openOverview();
    await page.click('.export-btn');
    await page.click('.export-scale button:nth-child(1)');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.export-item[data-job=map]')]);
    const file = await dl.path();
    const png = PNG.sync.read((await import('node:fs')).readFileSync(file!));
    const sp = terrain.w / 4;
    let bad = 0;
    let n = 0;
    for (let y = Math.floor(terrain.h * 0.36); y < terrain.h * 0.64; y += 3) {
      for (let x = Math.floor(terrain.w * 0.3); x < terrain.w * 0.7; x += 3) {
        const i = (y * png.width + x) * 4;
        const j = (y * terrain.w + ((x + sp) % terrain.w)) * 4;
        n++;
        if (Math.max(Math.abs(png.data[i] - terrain.px[j]), Math.abs(png.data[i + 1] - terrain.px[j + 1]), Math.abs(png.data[i + 2] - terrain.px[j + 2])) > 12) bad++;
      }
    }
    await closeOverview();
    console.log(`导出(中心 90°E):${png.width}×${png.height},中部和地形图转四分之一圈对不上的像素 ${((bad / n) * 100).toFixed(2)}%`);
    if (png.width !== 2048 || bad / n > 0.01) errs.push(`东西相连:导出没有按当前视图中心展开(${((bad / n) * 100).toFixed(1)}% 对不上)`);
  }
}

// 多种投影:弹层里切到罗宾森(切换耗时)→ 点一座城 → 详情是这座城;左右拖 = 转中央经线;弹层里的中央经线滑条;
// 改中央经线 → 刷新后投影和中心都还在;导出罗宾森图片(尺寸、外轮廓外是底色、里面有图)
{
  const { PNG } = await import('pngjs');
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await page.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const view = () => page.evaluate(() => (window as any).__wfView);
  // 1. 切到罗宾森:地形、文明层、文字都按投影重画;量"点下去 → 画完"的耗时
  await openLayers();
  const t0 = Date.now();
  await page.click('.lp-proj[data-proj=robinson]');
  const switched = await page
    .waitForFunction(() => (window as any).__wfLabels?.proj === 'robinson' && (window as any).__wfLabels?.fitted && (window as any).__wfCivProj?.proj === 'robinson', null, { timeout: 10000 })
    .then(() => true, () => false);
  const switchMs = Date.now() - t0;
  const lab = await page.evaluate(() => (window as any).__wfLabels);
  const lpLabel = await page.locator('.lp-btn').innerText();
  await page.keyboard.press('Escape');
  if (lpLabel !== '政区 · 罗宾森') errs.push(`投影:切到罗宾森后右下按钮不是"政区 · 罗宾森"(${lpLabel})`);
  console.log(`切到罗宾森:${switched ? `${switchMs} ms 画完` : '没画完'};文字 ${lab?.drawn} 条、国名 ${lab?.polities} 个、城镇符号 ${lab?.marks} 个`);
  if (!switched) errs.push('投影:切到罗宾森以后地图没有按投影重画');
  if (!(lab?.polities > 2 && lab?.marks > 5)) errs.push('投影:罗宾森里国名、城镇符号没画出来');
  // 2. 点一座城(城镇符号)→ 详情面板是这座城
  const pk = await page.evaluate(() => {
    const all = (window as any).__wfPickables() as { kind: string; id: number; text: string; x: number; y: number }[];
    const names = all.filter((p) => p.kind === 'settlement' && p.text);
    for (const n of names) {
      const m = all.find((p) => p.kind === 'mark' && p.id === n.id);
      if (m) return { name: n.text, x: m.x, y: m.y };
    }
    return null;
  });
  let insp = '';
  if (pk) {
    await page.mouse.click(pk.x, pk.y);
    await page.waitForSelector('.inspector', { timeout: 5000 }).catch(() => {});
    insp = (await page.locator('.inspector').innerText().catch(() => '')).replace(/\n/g, ' / ');
  }
  console.log(`罗宾森里点城「${pk?.name ?? '(没找到)'}」→ 详情「${insp.slice(0, 40)}」`);
  if (!pk || !insp.includes(pk.name)) errs.push('投影:罗宾森里点一座城,详情不是这座城');
  // 详情面板"设为中心":中央经线转到这座城
  if (pk) {
    await page.click('.inspector [data-act=set-center]');
    await page.waitForTimeout(300);
  }
  await page.keyboard.press('Escape');
  // 3. 左右拖 = 转中央经线(整图重投影);悬停信息照常(点城时地图飞过去放大了:先放回整张图)
  await page.evaluate(() => (window as any).__wfSetView({ k: 1, x: 0, y: 0 }));
  await page.waitForTimeout(300);
  const c0 = (await view()).lon;
  const mb = (await page.locator('.map-box').boundingBox())!;
  await page.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width * 0.62, mb.y + mb.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const c1 = (await view()).lon;
  await page.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height * 0.45);
  await page.waitForTimeout(200);
  const hov = await page.locator('.hover').innerText().catch(() => '');
  console.log(`罗宾森里左右拖:中央经线 ${c0.toFixed(1)}° → ${c1.toFixed(1)}°;悬停「${hov.split('\n')[0]}」`);
  if (Math.abs(((c1 - c0 + 540) % 360) - 180) < 20) errs.push('投影:罗宾森里左右拖动没有转中央经线');
  if (!hov) errs.push('投影:罗宾森里悬停没有信息');
  // 3b. 放大后左右拖:细节层(放大后按屏幕像素重画的那一层)不藏起来,跟着整块平移;松手后按新的中央经线重画
  await page.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height * 0.5);
  for (let i = 0; i < 40 && (await view()).k < 8; i++) {
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(400);
  const kz = (await view()).k;
  let dHidden = 0;
  let dSlid = 0;
  await page.mouse.down();
  for (let s = 1; s <= 15; s++) {
    await page.mouse.move(mb.x + mb.width * (0.5 - (0.2 * s) / 15), mb.y + mb.height * 0.5);
    await page.waitForTimeout(16);
    const d = await page.evaluate(() => ({ ...(window as any).__wfDetail, shown: (document.querySelector('canvas.detail') as HTMLElement).style.display !== 'none' }));
    if (!d.on || !d.shown) dHidden++;
    else if (d.slide) dSlid++;
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dEnd = await page.evaluate(() => (window as any).__wfDetail);
  const lonEnd = (await view()).lon;
  console.log(`罗宾森放大 ${kz.toFixed(1)} 倍左右拖:15 步里细节层藏起来 ${dHidden} 次、整块平移 ${dSlid} 次;松手后按 ${dEnd?.lon?.toFixed(1)}°(中央经线 ${lonEnd.toFixed(1)}°)重画`);
  if (dHidden) errs.push('投影:罗宾森放大后左右拖动时细节层藏起来了(露出放大的整图,发糊)');
  if (!dSlid) errs.push('投影:罗宾森放大后左右拖动时细节层没有跟着平移');
  if (!dEnd?.on || dEnd.slide || Math.abs(dEnd.lon - lonEnd) > 1e-6) errs.push('投影:罗宾森放大后拖完,细节层没有按新的中央经线重画');
  await page.evaluate(() => (window as any).__wfSetView({ k: 1, x: 0, y: 0 }));
  await page.waitForTimeout(300);
  // 4. 只用左键:右键不出菜单;弹层里的中央经线滑条转到 −120°(显示"120°W")
  await page.mouse.click(mb.x + mb.width * 0.3, mb.y + mb.height * 0.5, { button: 'right' });
  const ctx = await page.locator('.ctx-menu').count();
  await openLayers();
  await page.evaluate(() => {
    const el = document.querySelector('.lp-center input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '-120');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const lonLabel = await page.locator('.lp-center b').innerText().catch(() => '');
  await page.keyboard.press('Escape');
  const c2 = (await view()).lon;
  console.log(`右键菜单 ${ctx} 个;中央经线滑条 → ${c2.toFixed(1)}°(显示「${lonLabel}」)`);
  if (ctx) errs.push('投影:右键还会出菜单(只用左键)');
  if (Math.abs(c2 + 120) > 0.5 || lonLabel !== '120°W') errs.push(`投影:弹层里的中央经线滑条没有转过去(${c2},${lonLabel})`);
  // 5. 改中心(和弹层里的中央经线滑条走同一个入口 requestMapCenter)→ 刷新后投影、中心都还在
  await page.evaluate(() => (window as any).__wfSetCenter(75));
  await page.waitForTimeout(700);
  const url = page.url();
  await page.reload();
  await page.waitForFunction(() => (window as any).__wfLabels?.proj === 'robinson', null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(300);
  const vr = await view();
  const on = await projOn(page);
  console.log(`改中心 75° 后刷新(${url.split('?')[1]}):投影 ${vr?.proj}(弹层 ${on}),中心 ${vr?.lon?.toFixed(1)}°`);
  if (vr?.proj !== 'robinson' || on !== 'robinson' || Math.abs((vr?.lon ?? 0) - 75) > 0.5) errs.push('投影:改了投影和中央经线,刷新后没留住');
  // 6. 换中心 / 换投影重画耗时(每次:地形 + 文明层重铺 + 国名重新拟合 + 排字)
  const redraw = await page.evaluate(async () => {
    const w = window as any;
    const ms: number[] = [];
    for (const lon of [100, 130, 160, -170, -140]) {
      const t = performance.now();
      w.__wfSetCenter(lon);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      ms.push(performance.now() - t);
    }
    for (const p of ['mollweide', 'mercator', 'naturalEarth', 'robinson']) {
      const t = performance.now();
      w.__wfSetProjection(p);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      ms.push(performance.now() - t);
    }
    return ms;
  });
  const worstRedraw = Math.max(...redraw);
  console.log(`换中心 / 换投影重画:${redraw.map((x) => x.toFixed(0)).join('、')} ms(最慢 ${worstRedraw.toFixed(0)} ms,预算 300 ms)`);
  // 地图铺满全屏后地图框约是原来的两倍大(1400×820 的窗口里 1640×820,原来约 1126×563),重画跟着慢一倍;
  // CI 的虚拟机又比本机慢两三倍、偶尔一次卡到 1 秒多,上限放宽到 2 倍。本机仍按 900 ms
  const REDRAW_LIMIT = process.env.CI ? 1800 : 900;
  if (worstRedraw > REDRAW_LIMIT) errs.push(`投影:换中心 / 换投影重画太慢(${worstRedraw.toFixed(0)} ms,上限 ${REDRAW_LIMIT} ms)`);
  // 7. 导出罗宾森图片:尺寸对,四角在外轮廓外(底色),正中有图(和底色不同、颜色有变化)
  await openOverview();
  await page.click('.export-btn');
  await page.click('.export-scale button:nth-child(1)');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.export-item[data-job=map]')]);
  const png = PNG.sync.read((await import('node:fs')).readFileSync((await dl.path())!));
  await closeOverview();
  const px = (x: number, y: number) => {
    const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const corner = px(png.width * 0.02, png.height * 0.03);
  let varied = 0;
  let last = '';
  for (let y = png.height * 0.3; y < png.height * 0.7; y += 37) {
    for (let x = png.width * 0.3; x < png.width * 0.7; x += 41) {
      const c = px(x, y).join(',');
      if (c !== last) varied++;
      last = c;
    }
  }
  const paper = [0xef, 0xe2, 0xc2];
  const cornerPaper = corner.every((v, i) => Math.abs(v - paper[i]) < 40);
  console.log(`导出罗宾森:${png.width}×${png.height},角上 ${corner.join(',')}(纸色 ${cornerPaper}),中部取样 ${varied} 种颜色变化`);
  if (png.width !== 2048 || png.height !== 1024) errs.push(`投影:导出的罗宾森图片尺寸不对(${png.width}×${png.height})`);
  if (!cornerPaper || varied < 20) errs.push('投影:导出的罗宾森图片不对(外轮廓外不是底色,或中部是空白)');
  // 8. 改地形时切回等距圆柱(弯边投影里不改地形)
  await terrainOn();
  await page.waitForTimeout(300);
  const onAfter = await projOn(page);
  console.log(`罗宾森里打开改地形 → 投影 ${onAfter}`);
  if (onAfter !== 'equirect') errs.push('投影:弯边投影里打开改地形,没有切回等距圆柱');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.clear());
}

// 3D 地球仪:从平面主图打开的耗时(网址记下 proj=globe)、转动每帧耗时(无头浏览器是软件渲染,量一个上限);拖动转了、拖动不算单击;
// 悬停有信息;单击一座城 → 详情是这座城;时间轴拖到早年 → 文明层贴图重新上传、球上画面变了;
// 回放世界形成在球上放;导出菜单里的"导出地球仪这一面"、双击回正;切回平面地图时中心经度接上;没有 WebGL2(globe=cpu)时退回 CPU 画、不白屏
{
  const { PNG } = await import('pngjs');
  // 无头浏览器里 WebGL2 走软件渲染(SwiftShader),新版 Chromium 要显式允许
  const gBrowser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const gp = await gBrowser.newPage({ viewport: { width: 1400, height: 820 } });
  gp.on('pageerror', (e) => errs.push(`地球仪:${e.message}`));
  gp.on('console', (m) => m.type() === 'error' && errs.push(`地球仪:${m.text()}`));
  const G = () => gp.evaluate(() => (window as any).__wfGlobe);
  type Img = ReturnType<typeof PNG.sync.read>;
  const shot = async (): Promise<Img> => PNG.sync.read(await gp.locator('.globe').screenshot());
  const diff = (a: Img, b: Img) => {
    let n = 0;
    let bad = 0;
    for (let i = 0; i < Math.min(a.data.length, b.data.length); i += 4 * 7) {
      n++;
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) bad++;
    }
    return bad / Math.max(1, n);
  };
  // 从平面主图点"地球仪"打开(地形图已经画好;打开的耗时 = 编译着色器 + 上传贴图 + 画第一帧)
  await gp.goto(`${dev.url}/?seed=7&style=fantasy&civ=polities`);
  await gp.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await gp.click('button.globe-toggle');
  const opened = await gp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 }).then(() => true, () => false);
  // 网址记下投影(proj=globe;稍等一下,投影、中心停下来半秒才写)
  const urlOk = await gp.waitForFunction(() => /[?&]proj=globe/.test(location.search), null, { timeout: 5000 }).then(() => true, () => false);
  if (!urlOk) errs.push('地球仪:打开后网址里没有 proj=globe(刷新会回到平面地图)');
  await gp.waitForFunction(() => (window as any).__wfGlobe?.marks > 5, null, { timeout: 30000 }).catch(() => {});
  const g0 = await G();
  console.log(`地球仪:${g0?.renderer}(${g0?.gpu}),打开 ${g0?.openMs?.toFixed(0)} ms,贴图上传 ${JSON.stringify(g0?.upload)},符号 ${g0?.marks}、文字 ${g0?.labels}`);
  if (!opened) errs.push('地球仪没有打开');
  if (!(await gp.locator('.canvas-wrap').isHidden())) errs.push('地球仪打开时平面主图没有藏起来');
  if (!(g0?.marks > 5)) errs.push('地球仪上没有城镇符号');
  // 每帧耗时(着色器 + 符号文字层,等显卡画完,全分辨率):无头浏览器是软件渲染,只量一个上限 ——
  // 本机约 25 ms,CI 的虚拟机(SwiftShader 不带 LLVM)约 300 ms;真显卡上约 1–2 ms(scripts/globe-snap.ts --gpu --bench)。
  // 这里只防"慢了一个数量级"的退步;转动时还会按帧间隔自动降分辨率
  const bench = await gp.evaluate(() => (window as any).__wfGlobeBench(20));
  console.log(`地球仪每帧(${bench.renderer},${bench.w}×${bench.h}):中位数 ${bench.median.toFixed(1)} ms、p90 ${bench.p90.toFixed(1)} ms、最慢 ${bench.max.toFixed(1)} ms`);
  if (bench.renderer === 'webgl2' && !(bench.median < 1000)) errs.push(`地球仪每帧太慢(中位数 ${bench.median.toFixed(1)} ms)`);

  // 拖动:经度变了;拖动不算单击
  const gb = (await gp.locator('.globe').boundingBox())!;
  const cx = gb.x + gb.width / 2;
  const cy = gb.y + gb.height * 0.48;
  await gp.mouse.move(cx, cy);
  await gp.mouse.down();
  for (let i = 1; i <= 8; i++) await gp.mouse.move(cx - i * 25, cy + i * 4);
  await gp.waitForTimeout(120);
  await gp.mouse.up();
  await gp.waitForTimeout(400);
  const g1 = await G();
  const dLon = ((g1.lon - g0.lon + 540) % 360) - 180;
  console.log(`拖动 200 像素(转动时分辨率比例 ${g1.q?.toFixed(2)}):经度 ${g0.lon.toFixed(1)}° → ${g1.lon.toFixed(1)}°,纬度 ${g0.lat.toFixed(1)}° → ${g1.lat.toFixed(1)}°`);
  if (!(dLon > 10)) errs.push('地球仪:往左拖没有往东转');
  if (await gp.locator('.inspector').count()) errs.push('地球仪:拖动被当成了单击');

  // 悬停
  await gp.mouse.move(cx + 30, cy - 20);
  await gp.waitForTimeout(200);
  const hov = await gp.locator('.hover-card').innerText().catch(() => '');
  console.log('地球仪悬停:', hov.replace(/\n/g, ' / ') || '(无)');
  if (!hov.trim()) errs.push('地球仪:悬停小卡片没有出现');

  // 单击一座城(正面中间一带、详情面板盖不到的地方)→ 详情是这座城
  type GMark = { id: number; name: string; x: number; y: number; d: number };
  const marks = ((await gp.evaluate('window.__wfGlobeMarks()')) as GMark[]).filter((m) => m.name && m.d > 0.5 && m.x > gb.x + 380 && m.x < gb.x + gb.width - 380 && m.y > gb.y + 120 && m.y < gb.y + gb.height - 160);
  let picked = '';
  let panel = '';
  for (const m of marks.slice(0, 6)) {
    await gp.mouse.click(m.x, m.y);
    panel = await gp.locator('.inspector .ins-name').innerText({ timeout: 2000 }).catch(() => '');
    if (panel.includes(m.name)) {
      picked = m.name;
      break;
    }
    await gp.keyboard.press('Escape');
    // 面板开过一下,球心会往左挪再挪回来:等它回到原位再点下一个
    await gp.waitForTimeout(700);
  }
  console.log(`地球仪单击城:候选 ${marks.length} 个,点到「${picked || '—'}」,详情「${panel.replace(/\n/g, ' ')}」`);
  if (!picked) errs.push('地球仪:单击城镇符号没有打开这座城的详情');
  await gp.keyboard.press('Escape');
  // 面板关上,球心挪回原位(约 0.6 秒)
  await gp.waitForTimeout(700);

  // 时间轴拖到早年:文明层贴图重新上传,球上画面变了;拖动时每帧(文明底图 + 上传 + 画一帧)耗时
  const before = await shot();
  const ver0 = (await G()).civVer;
  const scrub = await gp.evaluate(async () => {
    const w = window as any;
    const ms: number[] = [];
    let last: unknown = null;
    let lastG: unknown = null;
    const t0 = performance.now();
    // 像用户一样按住时间轴的轨道往左拖(按在基线上,不是菱形那一行)
    const el = document.querySelector('.timebar .tb-track') as HTMLElement;
    const r = el.getBoundingClientRect();
    // (这里不定义具名函数:tsx 会给它包一层页面里没有的 __name)
    const ev = { bubbles: true, pointerId: 7, button: 0, clientX: r.right, clientY: r.top + 30 };
    el.dispatchEvent(new PointerEvent('pointerdown', ev));
    let i = 0;
    while (performance.now() - t0 < 1500) {
      // 每帧挪一点(从结束年份往前拖)
      el.dispatchEvent(new PointerEvent('pointermove', { ...ev, clientX: r.left + r.width * (1 - Math.min(1, i++ / 60) * 0.7) }));
      await new Promise((r) => requestAnimationFrame(r));
      const c = w.__wfCiv;
      const g = w.__wfGlobe;
      if (c && c !== last && g && g !== lastG) ms.push(c.ms + (g.upload.civ ?? 0) + g.frameMs);
      last = c;
      lastG = g;
    }
    // 最后停在第 30% 年(慢的机器上一秒半拖不了几帧:保证和开始时差得够远)
    el.dispatchEvent(new PointerEvent('pointermove', { ...ev, clientX: r.left + r.width * 0.3 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...ev, clientX: r.left + r.width * 0.3 }));
    return ms;
  });
  await gp.waitForTimeout(800);
  const after = await shot();
  const ver1 = (await G()).civVer;
  const sorted = [...scrub].sort((a, b) => a - b);
  const d = diff(before, after);
  console.log(`地球仪拖时间轴:${scrub.length} 帧,每帧(文明底图 + 上传贴图 + 画球)中位数 ${(sorted[sorted.length >> 1] ?? NaN).toFixed(1)} ms、最慢 ${(sorted.at(-1) ?? NaN).toFixed(1)} ms;文明底图画了 ${ver1 - ver0} 次,画面变了 ${(d * 100).toFixed(1)}%`);
  if (!(ver1 > ver0) || !(d > 0.01)) errs.push('地球仪:拖时间轴后文明层贴图没有变');
  if (!(scrub.length >= 3)) errs.push('地球仪:拖时间轴时文明层没有跟着画');

  // 回放世界形成:回放帧盖到球上
  await replayClick(gp);
  const replayed = await gp.waitForFunction(() => (window as any).__wfGlobe?.replay > 0.9 && (window as any).__wfGlobe?.upload?.replay !== undefined, null, { timeout: 30000 }).then(() => true, () => false);
  console.log('地球仪回放世界形成:', replayed ? '回放帧上了球' : '没有');
  if (!replayed) errs.push('地球仪:回放世界形成没有在球上放');
  await gp.waitForFunction(() => /第 \d+ 年/.test(document.querySelector('.caption .big')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});

  // 球上没有按钮(回正靠双击、经纬网在图层弹层里、导出在导出菜单里);导出菜单里多一项"导出地球仪这一面"
  const globeBtns = await gp.locator('.globe button').count();
  if (globeBtns) errs.push(`地球仪:球上还有按钮(${globeBtns} 个)`);
  await openOverview(gp);
  await gp.click('.export-btn');
  const globeItem = await gp.locator('.export-item[data-job=globe]').innerText().catch(() => '');
  const [dl] = await Promise.all([gp.waitForEvent('download', { timeout: 30000 }).catch(() => null), gp.click('.export-item[data-job=globe]')]);
  const ex = await gp.evaluate(() => (window as any).__wfGlobeExport);
  await closeOverview(gp);
  console.log(`地球仪导出:菜单项「${globeItem.replace(/\n/g, ' ')}」`, JSON.stringify(ex), dl ? dl.suggestedFilename() : '(没有下载)');
  if (!globeItem.includes('导出地球仪这一面')) errs.push('地球仪:导出菜单里没有"导出地球仪这一面"');
  if (!dl || !/地球仪/.test(dl.suggestedFilename()) || !(ex?.w >= 1000)) errs.push('地球仪:导出这一面没有下载图片');
  // 双击回正:北在上、赤道居中
  await gp.evaluate(() => (window as any).__wfGlobeSet(40, 50, 1.4));
  await gp.waitForTimeout(200);
  {
    const b = (await gp.locator('.globe').boundingBox())!;
    await gp.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  }
  await gp.waitForTimeout(1000);
  const reset = await G();
  console.log(`双击回正:纬度 50° → ${reset.lat?.toFixed(1)}°,缩放 1.4 → ${reset.k?.toFixed(2)}`);
  if (!(Math.abs(reset.lat) < 1 && Math.abs(reset.k - 1) < 0.02)) errs.push(`地球仪:双击没有回正(纬度 ${reset.lat},缩放 ${reset.k})`);
  await gp.keyboard.press('Escape');

  // 切回平面地图:中心经度接上
  const gl = (await G()).lon;
  await gp.click('button.globe-toggle');
  await gp.waitForTimeout(400);
  const fv = await gp.evaluate(() => (window as any).__wfView);
  const off = Math.abs(((fv.lon - gl + 540) % 360) - 180);
  console.log(`切回平面地图:地球仪中心 ${gl.toFixed(1)}° → 主图中心 ${fv.lon.toFixed(1)}°`);
  if (!(await gp.locator('.canvas-wrap').isVisible()) || (await gp.locator('.globe').count())) errs.push('地球仪:切回平面地图后主图没有出来');
  if (!(off < 2)) errs.push(`地球仪:切回平面地图后中心经度没有接上(差 ${off.toFixed(1)}°)`);

  // 投影切换里的"地球仪":罗宾森 → 地球仪(从罗宾森的中心转起)→ 右下角按钮切回罗宾森(中心接上)→ 点一座城照常;
  // 经纬网只有一个开关(在图层弹层里;开了以后地球仪上也画经纬网)
  {
    await pickProj(gp, 'robinson');
    await gp.waitForFunction(() => (window as any).__wfLabels?.proj === 'robinson' && (window as any).__wfLabels?.fitted, null, { timeout: 15000 }).catch(() => {});
    await gp.evaluate(() => (window as any).__wfSetCenter(60));
    await gp.waitForTimeout(300);
    await pickProj(gp, 'globe');
    await gp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 }).catch(() => {});
    await gp.waitForTimeout(300);
    const glon = (await G()).lon;
    await openLayers(gp);
    await gp.keyboard.press('Escape');
    const gratShot0 = await shot();
    await openLayers(gp);
    await gp.click('.lp-pop [data-act=graticule]');
    await gp.keyboard.press('Escape');
    await gp.waitForTimeout(300);
    const gratDiff = diff(gratShot0, await shot());
    const gratOn = (await G()).graticule ? 'on' : 'off';
    await openLayers(gp);
    await gp.click('.lp-pop [data-act=graticule]');
    await gp.keyboard.press('Escape');
    // 地球仪转一下再切回
    await gp.evaluate(() => (window as any).__wfGlobeSet(100, 10, 1));
    await gp.waitForTimeout(400);
    await gp.click('button.globe-toggle');
    await gp.waitForFunction(() => (window as any).__wfLabels?.proj === 'robinson' && (window as any).__wfLabels?.fitted, null, { timeout: 15000 }).catch(() => {});
    await gp.waitForTimeout(300);
    const on = await projOn(gp);
    const back = await gp.evaluate(() => (window as any).__wfView);
    const pk = await gp.evaluate(() => {
      const all = (window as any).__wfPickables() as { kind: string; id: number; text: string; x: number; y: number }[];
      for (const n of all.filter((p) => p.kind === 'settlement' && p.text)) {
        const m = all.find((p) => p.kind === 'mark' && p.id === n.id);
        if (m) return { name: n.text, x: m.x, y: m.y };
      }
      return null;
    });
    let insp = '';
    if (pk) {
      await gp.mouse.click(pk.x, pk.y);
      await gp.waitForSelector('.inspector', { timeout: 5000 }).catch(() => {});
      insp = await gp.locator('.inspector').innerText().catch(() => '');
      await gp.keyboard.press('Escape');
    }
    console.log(
      `罗宾森 → 地球仪:中心 60° → 球朝 ${glon?.toFixed(1)}°;经纬网共用 ${gratOn}(画面变了 ${(gratDiff * 100).toFixed(1)}%);转到 100° 切回 → ${on},中心 ${back?.lon?.toFixed(1)}°;点城「${pk?.name}」→ 详情 ${insp.includes(pk?.name ?? '---')}`,
    );
    if (Math.abs(((glon - 60 + 540) % 360) - 180) > 2) errs.push('投影 × 地球仪:切到地球仪时没有朝着当前的中央经线');
    if (gratOn !== 'on' || !(gratDiff > 0.002)) errs.push(`投影 × 地球仪:弹层里开了经纬网,地球仪上没有跟着画(${gratOn},画面变了 ${(gratDiff * 100).toFixed(2)}%)`);
    if (on !== 'robinson') errs.push('投影 × 地球仪:从地球仪切回来没有回到罗宾森');
    if (Math.abs(((back?.lon - 100 + 540) % 360) - 180) > 2) errs.push('投影 × 地球仪:从地球仪切回罗宾森,中心没有接上');
    if (!pk || !insp.includes(pk.name)) errs.push('投影 × 地球仪:切回罗宾森后点城,详情不是这座城');
  }

  // 高清贴图(两倍像素密度的屏幕):缩放 1 倍时不起后台线程(换画风也不起);放大到 1.5 倍以上才铺;
  // 缩回 1 倍以后留着;换画风再换回来直接用,不重铺;换世界才扔
  {
    const hp = await gBrowser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
    hp.on('pageerror', (e) => errs.push(`地球仪高清贴图:${e.message}`));
    const H = () => hp.evaluate(() => (window as any).__wfGlobe);
    await hp.goto(`${dev.url}/?seed=7&style=realistic&view=globe`);
    await hp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 });
    await hp.waitForTimeout(1500);
    const a = await H();
    await pickLayer(hp, 'terrain');
    await hp.waitForFunction(() => (window as any).__wfGlobe?.style === 'fantasy', null, { timeout: 30000 });
    await hp.waitForTimeout(1000);
    const b = await H();
    await pickLayer(hp, 'realistic');
    await hp.waitForFunction(() => (window as any).__wfGlobe?.style === 'realistic', null, { timeout: 30000 });
    // 放大到 1.8 倍:后台铺高清,铺好换上
    await hp.evaluate(() => (window as any).__wfGlobeSet(20, 20, 1.8));
    const got = await hp.waitForFunction(() => (window as any).__wfGlobe?.tier === 2, null, { timeout: 90000 }).then(() => true, () => false);
    const c = await H();
    // 缩回 1 倍:留着
    await hp.evaluate(() => (window as any).__wfGlobeSet(20, 20, 1));
    await hp.waitForTimeout(500);
    const d = await H();
    // 换手绘(1 倍,不铺)再换回写实:直接用留着的那张
    await pickLayer(hp, 'terrain');
    await hp.waitForFunction(() => (window as any).__wfGlobe?.style === 'fantasy', null, { timeout: 30000 });
    await hp.waitForTimeout(800);
    const e = await H();
    await pickLayer(hp, 'realistic');
    await hp.waitForFunction(() => (window as any).__wfGlobe?.style === 'realistic', null, { timeout: 30000 });
    await hp.waitForTimeout(500);
    const f = await H();
    // 换世界:扔掉,1 倍时也不重铺
    await openOverview(hp, 'genesis');
    await hp.click('.ov [data-act=new-world]');
    await hp.waitForFunction(() => (window as any).__wfGlobe?.hdCached === 0 && (window as any).__wf?.ready, null, { timeout: 60000 }).catch(() => {});
    await hp.waitForTimeout(1500);
    const g = await H();
    const row = (x: any) => `${x.style} ${x.k.toFixed(1)} 倍:第 ${x.tier} 档,起过 ${x.hdStarted} 次、留着 ${x.hdCached} 张`;
    console.log(`地球仪高清贴图(两倍像素密度):打开 ${row(a)};换手绘 ${row(b)};放大 ${row(c)}(${c.hiMs?.toFixed(0)} ms);缩回 ${row(d)};换手绘 ${row(e)};换回写实 ${row(f)};换世界 ${row(g)}`);
    if (a.hdStarted !== 0 || b.hdStarted !== 0) errs.push('地球仪:缩放 1 倍时起了高清贴图的后台线程');
    if (!got || c.hdStarted !== 1) errs.push('地球仪:放大到 1.8 倍没有换上高清贴图');
    if (d.tier !== 2) errs.push('地球仪:缩回 1 倍后高清贴图没有留着');
    if (e.hdStarted !== 1 || e.tier !== 1) errs.push('地球仪:1 倍时换画风起了后台线程');
    if (f.tier !== 2 || f.hdStarted !== 1) errs.push('地球仪:换回铺过高清的画风没有直接用留着的那张');
    if (g.hdCached !== 0 || g.tier !== 1 || g.hdStarted !== 1) errs.push('地球仪:换世界后高清贴图没有扔掉,或 1 倍时又去铺了');
    await hp.close();
  }

  // 地球仪按投影重画:手绘的山丘等符号每帧正立着画(贴图里不带)、写实风换上不打光 + 坡度的贴图(后台画好换上);
  // 国家面板打开时球心左移、关上挪回来;事件标签钉在球上的事发地,转到背面就藏起来
  {
    const pp = await gBrowser.newPage({ viewport: { width: 1400, height: 820 } });
    pp.on('pageerror', (e) => errs.push(`地球仪按投影重画:${e.message}`));
    const P = () => pp.evaluate(() => (window as any).__wfGlobe);
    await pp.goto(`${dev.url}/?seed=7&style=fantasy&view=globe`);
    await pp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 });
    await pp.evaluate(() => (window as any).__wfGlobeSet(0, -80, 1));
    await pp.waitForTimeout(400);
    const f1 = await P();
    // 写实:先用主图那张,后台画好换上
    await pickLayer(pp, 'realistic');
    const relit = await pp.waitForFunction(() => (window as any).__wfGlobe?.style === 'realistic' && (window as any).__wfGlobe?.relief, null, { timeout: 60000 }).then(() => true, () => false);
    const r1 = await P();
    // 面板:选中球上的一个名字 → 球心左移;Esc 关掉 → 挪回来
    const name = r1.texts[0];
    await pp.evaluate((n) => (window as any).__wfGlobeSelectName(n), name);
    await pp.waitForTimeout(900);
    const s1 = (await P()).shift;
    await pp.keyboard.press('Escape');
    await pp.waitForTimeout(900);
    const s2 = (await P()).shift;
    console.log(
      `地球仪按投影重画:手绘南极 ${f1.tex} 贴图、正立符号 ${f1.glyphs} 个(${f1.glyphMs?.toFixed(1)} ms);写实 ${r1.tex} 贴图、重新打光 ${r1.relief}(后台 ${r1.texMs?.toFixed(0)} ms);` +
        `选中「${name}」球心 ${s1} → 关掉 ${s2}`,
    );
    if (f1.tex !== 'globe' || !(f1.glyphs > 50)) errs.push('地球仪:手绘风的山丘等符号没有在球上正立着画');
    if (!relit || r1.tex !== 'globe') errs.push('地球仪:写实风没有换上重新打光的贴图');
    if (!(s1 < -170) || s2 !== 0) errs.push(`地球仪:国家面板打开时球心没有左移、关上没有挪回来(${s1} → ${s2})`);
    // 事件标签:点左下的最近事件(球转到事发地,那一条的标签停约 5 秒)→ 标签在球上(在球的圆盘里),转到对面就藏起来
    // (不靠播放:CI 上软件渲染一帧几百毫秒,放到下一件大事要很久)
    await pp.goto(`${dev.url}/?seed=7&style=fantasy&view=globe`);
    await pp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 });
    const pinAt = () =>
      pp.evaluate(() => {
        const el = [...document.querySelectorAll('.ev-pin')].find((e) => (e as HTMLElement).style.visibility === 'visible') as HTMLElement | undefined;
        if (!el) return null;
        const r = el.querySelector('.ev-ring')!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: el.textContent ?? '' };
      });
    const recentRows = pp.locator('.recent-ev .recent-row');
    if (await recentRows.count()) await recentRows.last().click();
    const seen = await pp.waitForFunction(() => [...document.querySelectorAll('.ev-pin')].some((e) => (e as HTMLElement).style.visibility === 'visible'), null, { timeout: 20000 }).then(() => true, () => false);
    // 等球转到事发地(约 0.65 秒)再量位置
    if (seen) await pp.waitForTimeout(1200);
    const pin = seen ? await pinAt() : null;
    let inDisk = false;
    let hidden = false;
    if (pin) {
      const gb = (await pp.locator('.globe').boundingBox())!;
      const g = await P();
      const R = 0.43 * Math.min(gb.width, gb.height) * g.k;
      inDisk = Math.hypot(pin.x - (gb.x + gb.width / 2 + g.shift), pin.y - (gb.y + gb.height * 0.48)) < R;
      // 转到对面(经度 + 180°、纬度反过来):这个标签藏起来(原来在背面的别的标签这时可能转到了正面)
      await pp.evaluate(([lon, lat]) => (window as any).__wfGlobeSet(lon + 180, -lat), [g.lon, g.lat]);
      await pp.waitForTimeout(600);
      hidden = await pp.evaluate(
        (t) => [...document.querySelectorAll('.ev-pin')].filter((e) => e.textContent === t).every((e) => (e as HTMLElement).style.visibility !== 'visible'),
        pin.text,
      );
    }
    console.log(`地球仪事件标签:${pin ? `「${pin.text.slice(0, 30)}」在球上 ${inDisk}、转到对面藏起来 ${hidden}` : '没出现'}`);
    if (!pin || !inDisk) errs.push('地球仪:点最近事件后球上的事发地没有事件标签');
    if (pin && !hidden) errs.push('地球仪:事件标签转到球的背面还在');
    await pp.close();
  }

  // 没有 WebGL2:退回 CPU 画,不白屏(旧网址 view=globe 照样打开地球仪)
  await gp.goto(`${dev.url}/?seed=2024&style=realistic&view=globe&globe=cpu`);
  const cpuOk = await gp.waitForFunction(() => (window as any).__wfGlobe?.ready, null, { timeout: 60000 }).then(() => true, () => false);
  // 状态在顶部提示条上(不在球上另写一行)
  const cpuToast = await gp
    .waitForFunction(() => [...document.querySelectorAll('.toast-main')].some((e) => e.textContent?.includes('兼容画法')), null, { timeout: 8000 })
    .then(() => true, () => false);
  const gc = await G();
  const img = await shot();
  const at = (x: number, y: number) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const mid = at(img.width / 2, img.height * 0.48);
  console.log(`CPU 画法:${gc?.renderer},打开 ${gc?.openMs?.toFixed(0)} ms,一帧 ${gc?.frameMs?.toFixed(0)} ms,球心颜色 ${mid},顶部提示 ${cpuToast}`);
  if (!cpuToast) errs.push('地球仪:CPU 画法时顶部没有提示');
  if (!cpuOk || gc?.renderer !== 'cpu') errs.push('地球仪:CPU 画法没有打开');
  if (mid[0] + mid[1] + mid[2] < 60) errs.push('地球仪:CPU 画法球上是黑的');
  await gBrowser.close();
}

// 手机布局(390×844,触屏):时间轴两行固定在最底部、右下没有 + −、操作提示是"双指缩放"、悬停卡片不出来;
// 双指捏合 → 地图比例变了;点国家 → 底部抽屉半高(国家落在抽屉上方)→ 往上拖展开 → 干预 → 结盟 → 点名牌 → 已生效 → 撤销;
// 图层抽屉(从底部升起)切到实景;概览的国家列表点一国;搜索点一条
{
  type Pick = { kind: string; id: number; text: string; x: number; y: number };
  type Plate = { kind: string; id: number; text: string; note: string; x: number; y: number; on: boolean; self: boolean };
  const VW = 390;
  const VH = 844;
  const mctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => errs.push(`手机:${e.message}`));
  const cdp = await mctx.newCDPSession(mp);
  const touch = (type: string, pts: [number, number][]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) } as never);
  /** 手指从 a 滑到 b(一根或两根手指,按 steps 步) */
  const swipe = async (a: [number, number][], b: [number, number][], steps = 10) => {
    await touch('touchStart', a);
    for (let i = 1; i <= steps; i++) {
      await touch(
        'touchMove',
        a.map(([x, y], j) => [x + ((b[j][0] - x) * i) / steps, y + ((b[j][1] - y) * i) / steps]),
      );
      await mp.waitForTimeout(20);
    }
    await touch('touchEnd', []);
  };
  const mToast = (id: string) => mp.locator(`.toast[data-toast=${id}]`).innerText({ timeout: 3000 }).then((t) => t.replace(/\n/g, ' '), () => '');
  const box = (sel: string) => mp.locator(sel).first().boundingBox().catch(() => null);
  await mp.goto(`${dev.url}/?seed=7&civYear=2600`);
  await mp.waitForFunction(() => (window as any).__wfLabels?.polities > 0, null, { timeout: 60000 });
  await mp.waitForTimeout(600);
  // 骨架
  const row = await box('.bottom-row');
  const track = await box('.tb-track');
  const sub = await mp.locator('.wt-sub').innerText().catch(() => '');
  const hint0 = await mp.locator('.first-hint').innerText().catch(() => '');
  const zoomBtns = await mp.locator('[data-act=zoom-in], [data-act=zoom-out], .map-controls').count();
  const recentRows = await mp.locator('.recent-row').count();
  // 双指捏合:两指从中间往两边分开 → 放大;中点下的地方还在中点下
  const k0 = (await mp.evaluate(() => (window as any).__wfView)).k;
  const mid0 = await mp.evaluate(([x, y]) => (window as any).__wfClientToWorld(x, y), [195, 380]);
  await swipe(
    [
      [150, 380],
      [240, 380],
    ],
    [
      [90, 380],
      [300, 380],
    ],
  );
  await mp.waitForTimeout(300);
  const k1 = (await mp.evaluate(() => (window as any).__wfView)).k;
  const mid1 = await mp.evaluate(([x, y]) => (window as any).__wfClientToWorld(x, y), [195, 380]);
  const hint1 = await mp.locator('.first-hint').count();
  // 单指拖动:平移
  const vA = await mp.evaluate(() => (window as any).__wfView);
  await swipe([[200, 300]], [[140, 330]]);
  await mp.waitForTimeout(200);
  const vB = await mp.evaluate(() => (window as any).__wfView);
  const panned = Math.abs(vB.x - vA.x) > 20 || Math.abs(vB.y - vA.y) > 10;
  // 手指点两下:回正
  await mp.touchscreen.tap(195, 250);
  await mp.waitForTimeout(80);
  await mp.touchscreen.tap(197, 252);
  await mp.waitForTimeout(500);
  const kReset = (await mp.evaluate(() => (window as any).__wfView)).k;
  await mp.evaluate(() => (window as any).__wfSelect('polity', -1));
  await mp.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await mp.waitForTimeout(300);
  // 点国家 → 底部抽屉半高;国家落在抽屉上方
  const pol = ((await mp.evaluate('window.__wfPickables()')) as Pick[])
    .filter((q) => q.kind === 'polity' && q.x > 40 && q.x < VW - 40 && q.y > 130 && q.y < VH - 200)
    .sort((a, b) => Math.abs(a.x - VW / 2) + Math.abs(a.y - VH / 2) - Math.abs(b.x - VW / 2) - Math.abs(b.y - VH / 2))[0];
  type Rect = { x: number; y: number; width: number; height: number } | null;
  let sheet0: Rect = null;
  let sheet1: Rect = null;
  let ring: Rect = null;
  let hover = 0;
  let info = '';
  let full = false;
  let cmds = 0;
  let pickToast = '';
  let hiddenWhilePicking = false;
  let doneToast = '';
  let undoToast = '';
  let tgtText = '';
  if (pol) {
    await mp.touchscreen.tap(pol.x, pol.y);
    await mp.waitForTimeout(1100);
    hover = await mp.locator('.hover-card').count();
    sheet0 = await box('.inspector.sheet');
    ring = await box('.tp-mark .tp-ring');
    info = (await mp.locator('.inspector').innerText().catch(() => '')).replace(/\n/g, ' / ');
    // 往上拖拖动条 → 展开
    const grip = await box('.sheet-grip');
    if (grip) {
      await swipe([[VW / 2, grip.y + grip.height / 2]], [[VW / 2, grip.y + grip.height / 2 - 260]]);
      await mp.waitForTimeout(500);
      full = /sheet-full/.test((await mp.locator('.inspector').getAttribute('class')) ?? '');
      sheet1 = await box('.inspector.sheet');
    }
    // 干预 → 结盟 → 点名牌
    await mp.tap('.inspector [data-act=intervene]');
    await mp.waitForTimeout(300);
    cmds = await mp.locator('.inspector .cp-cmd').count();
    if (await mp.locator('.inspector .cp-cmd[data-cmd=ally]').isEnabled().catch(() => false)) {
      await mp.tap('.inspector .cp-cmd[data-cmd=ally]');
      await mp.waitForTimeout(1100);
      pickToast = await mToast('pick');
      hiddenWhilePicking = !(await mp.locator('.inspector').isVisible().catch(() => false));
      const tgt = ((await mp.evaluate('window.__wfPlates()')) as Plate[])
        .filter((p) => !p.self && p.x > 30 && p.x < VW - 30 && p.y > 150 && p.y < VH - 120)
        .sort((a, b) => Math.abs(a.y - VH / 2) - Math.abs(b.y - VH / 2))[0];
      if (tgt) {
        tgtText = tgt.text;
        const prev = await mp.evaluate(() => (window as any).__wfResim?.seq ?? 0);
        await mp.touchscreen.tap(tgt.x, tgt.y);
        await mp.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev, { timeout: 20000 }).catch(() => null);
        await mp.waitForTimeout(300);
        doneToast = await mToast('resim-done');
        const prev2 = await mp.evaluate(() => (window as any).__wfResim?.seq ?? 0);
        await mp.tap('.toast[data-toast=resim-done] .toast-act').catch(() => {});
        await mp.waitForFunction((s) => ((window as any).__wfResim?.seq ?? 0) > s, prev2, { timeout: 20000 }).catch(() => null);
        await mp.waitForTimeout(300);
        undoToast = await mToast('resim-done');
      }
    }
  }
  // 图层抽屉:从底部升起、铺满宽度;切到实景
  await mp.tap('[data-act=layers]');
  await mp.waitForTimeout(400);
  const lp = await box('.lp-pop');
  await mp.tap('.lp-pop [data-layer=realistic]');
  await mp.waitForFunction(() => (window as any).__wf?.style === 'realistic', null, { timeout: 10000 }).catch(() => {});
  await mp.waitForTimeout(300);
  const dark = await mp.locator('.app').getAttribute('data-theme');
  const lpClosed = !(await mp.locator('.lp-pop').count());
  // 概览:国家列表点一国 → 概览收起、抽屉里是这国
  await mp.tap('[data-act=overview]');
  await mp.waitForTimeout(400);
  const ovRow = mp.locator('.ov-row').first();
  const ovName = await ovRow.locator('.ov-name').innerText().catch(() => '');
  const ovRowText = (await ovRow.innerText().catch(() => '')).replace(/\n/g, ' ');
  await ovRow.tap().catch(() => {});
  await mp.waitForTimeout(900);
  const ovClosed = !(await mp.locator('.ov-root:not([hidden])').count());
  const ovIns = await mp.locator('.inspector').innerText().catch(() => '');
  // 搜索:全宽的框,点一条 → 抽屉里是它
  await mp.tap('.inspector .cp-x').catch(() => {});
  await mp.waitForTimeout(300);
  await mp.tap('[data-act=search]');
  await mp.waitForTimeout(300);
  const sb = await box('.search-box');
  const hit = mp.locator('.search-row').first();
  const hitName = await hit.locator('.search-name').innerText().catch(() => '');
  await hit.tap().catch(() => {});
  await mp.waitForTimeout(900);
  const searchIns = await mp.locator('.inspector').innerText().catch(() => '');
  console.log(
    `手机布局:底部一行 ${JSON.stringify(row)},轨道高 ${track?.height};副标「${sub}」;提示「${hint0}」;+ − ${zoomBtns} 个;最近事件 ${recentRows} 条;` +
      `捏合 k ${k0.toFixed(2)} → ${k1.toFixed(2)}(中点下 ${mid0?.map((v: number) => v.toFixed(0))} → ${mid1?.map((v: number) => v.toFixed(0))});单指拖动 ${panned};点两下回正 k ${kReset.toFixed(2)};` +
      `点「${pol?.text}」→ 抽屉 ${JSON.stringify(sheet0)}、国都圆环 ${JSON.stringify(ring)}、悬停卡片 ${hover};上拖 → 展开 ${full} ${JSON.stringify(sheet1)};` +
      `干预页 ${cmds} 条;结盟提示「${pickToast}」、抽屉藏起 ${hiddenWhilePicking};点「${tgtText}」→「${doneToast}」;撤销 →「${undoToast}」;` +
      `图层抽屉 ${JSON.stringify(lp)} → 实景 ${dark}、收起 ${lpClosed};概览「${ovRowText}」→ 收起 ${ovClosed};搜索框 ${JSON.stringify(sb)} → 「${hitName}」`,
  );
  if (!row || Math.abs(row.y + row.height - VH) > 1 || row.width !== VW || !track || track.height < 32) errs.push(`手机:时间轴没有固定在最底部、全宽 / 轨道太矮(${JSON.stringify(row)},轨道 ${track?.height})`);
  if (!/^种子 7 · \d+ 国 · 概览 ›$/.test(sub)) errs.push(`手机:副标不对(${sub})`);
  if (!hint0.includes('双指缩放') || hint1 !== 0) errs.push(`手机:操作提示不对 / 捏合后没消失(${hint0})`);
  if (zoomBtns) errs.push('手机:右下还有地球仪 / 缩放按钮');
  if (recentRows > 1) errs.push(`手机:最近事件应只有 1 条(${recentRows})`);
  if (!(k1 > k0 * 1.6)) errs.push(`手机:双指捏合后地图比例没变(${k0} → ${k1})`);
  if (!mid0 || !mid1 || Math.hypot(mid1[0] - mid0[0], mid1[1] - mid0[1]) > 12) errs.push(`手机:捏合不是以两指中点为中心(${mid0} → ${mid1})`);
  if (!panned) errs.push('手机:单指拖动没有平移');
  if (Math.abs(kReset - 1) > 0.01) errs.push(`手机:点两下没有回正(k ${kReset})`);
  if (!pol) errs.push('手机:没找到能点的国家');
  else {
    const halfTop = 0.55 * VH - 92;
    if (!sheet0 || Math.abs(sheet0.y - halfTop) > 8 || Math.abs(sheet0.y + sheet0.height - (VH - 92)) > 2 || sheet0.width !== VW)
      errs.push(`手机:点国家后底部抽屉的位置不对(${JSON.stringify(sheet0)},半高上边应在 ${halfTop})`);
    if (!/国家 · 第 \d+ 年/.test(info) || !info.includes('干预历史')) errs.push(`手机:抽屉里不是国家面板(${info.slice(0, 80)})`);
    if (!ring || !sheet0 || !(ring.y > 60 && ring.y + ring.height < sheet0.y)) errs.push(`手机:选中的国家没有落在抽屉上方(国都圆环 ${JSON.stringify(ring)})`);
    if (hover) errs.push('手机:点了以后出了悬停卡片');
    if (!full || !sheet1 || Math.abs(sheet1.y - 0.12 * VH) > 8) errs.push(`手机:往上拖没有展开(${JSON.stringify(sheet1)})`);
    if (cmds !== 6) errs.push(`手机:干预页不对(${cmds} 条命令)`);
    if (!/^选择与.+结盟的国家 \d+ 年起生效 取消$/.test(pickToast) || !hiddenWhilePicking) errs.push(`手机:选目标的提示条 / 抽屉收起不对(${pickToast})`);
    if (!/^已从 \d+ 年重新推演 · .+与.+结盟 撤销$/.test(doneToast)) errs.push(`手机:点名牌后没有生效(${doneToast})`);
    if (!/^已撤销/.test(undoToast)) errs.push(`手机:撤销后没有"已撤销"(${undoToast})`);
  }
  if (!lp || Math.abs(lp.y + lp.height - VH) > 1 || lp.width !== VW) errs.push(`手机:图层弹层不是底部抽屉(${JSON.stringify(lp)})`);
  if (dark !== 'dark' || !lpClosed) errs.push(`手机:图层抽屉里切到实景不对(${dark})`);
  if (!ovClosed || !ovName || !ovIns.includes(ovName)) errs.push(`手机:概览的国家列表点一国没有打开这国(${ovName})`);
  if (!sb || sb.width < VW - 30) errs.push(`手机:搜索框没有全宽展开(${JSON.stringify(sb)})`);
  if (!hitName || !searchIns.includes(hitName)) errs.push(`手机:搜索点一条没有打开它(${hitName})`);
  await mctx.close();
}

// 源代码 · 隐私政策 · 用户协议:概览底部三条链接(网址和 src/ui/links.ts 一致、新标签页打开;手机上在屏幕里、点得到);
// AI 设置里的"隐私政策";构建产物里有 privacy.html、terms.html,能打开(200),页面里的仓库网址和 links.ts 一致
{
  const { SOURCE_URL, PRIVACY_URL, TERMS_URL } = await import('../src/ui/links');
  const want: Record<string, string> = { source: SOURCE_URL, privacy: PRIVACY_URL, terms: TERMS_URL };
  type Link = { id: string; text: string; href: string; abs: string; target: string; box: [number, number, number, number]; hit: boolean };
  const aboutLinks = (p: Page) =>
    p.locator('.ov-about a').evaluateAll((as) =>
      as.map((a) => {
        const r = a.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          id: a.getAttribute('data-link') ?? '',
          text: a.textContent ?? '',
          href: a.getAttribute('href') ?? '',
          abs: (a as HTMLAnchorElement).href,
          target: a.getAttribute('target') ?? '',
          box: [r.x, r.y, r.width, r.height].map(Math.round) as [number, number, number, number],
          hit: !!top && a.contains(top),
        };
      }),
    );
  const checkLinks = (tag: string, links: Link[], vw: number, vh: number) => {
    if (links.map((l) => l.text).join(' · ') !== '源代码 · 隐私政策 · 用户协议') errs.push(`${tag}概览底部的链接不对(${links.map((l) => l.text).join(' · ')})`);
    for (const l of links) {
      if (l.href !== want[l.id]) errs.push(`${tag}「${l.text}」的网址不对(${l.href},应为 ${want[l.id]})`);
      if (l.target !== '_blank') errs.push(`${tag}「${l.text}」不是新标签页打开`);
      const [x, y, w, h] = l.box;
      if (!(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= vw && y + h <= vh) || !l.hit) errs.push(`${tag}「${l.text}」不在屏幕里或被挡住(${l.box})`);
    }
  };
  // 宽屏:概览底部;AI 设置里的"隐私政策";两个页面从开发服务打开
  await page.setViewportSize({ width: 1400, height: 820 });
  await page.goto(`${dev.url}/?seed=7`);
  await page.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await openOverview();
  const desk = await aboutLinks(page);
  checkLinks('链接:', desk, 1400, 820);
  await page.click('.ai-btn');
  await page.waitForSelector('.ai-dialog', { timeout: 10000 });
  const aiPriv = await page.locator('.ai-foot a[data-link=privacy]').evaluate((a) => [a.getAttribute('href'), a.getAttribute('target'), a.textContent]).catch(() => null);
  await page.keyboard.press('Escape');
  await closeOverview();
  if (!aiPriv || aiPriv[0] !== PRIVACY_URL || aiPriv[1] !== '_blank' || aiPriv[2] !== '隐私政策') errs.push(`链接:AI 设置里没有"隐私政策"链接(${aiPriv})`);
  const devPages: string[] = [];
  for (const l of desk.filter((l) => l.id !== 'source')) {
    const r = await page.request.get(l.abs);
    const body = await r.text();
    devPages.push(`${l.text} ${r.status()}`);
    if (r.status() !== 200 || !body.includes(`<h1>${l.text}</h1>`)) errs.push(`链接:「${l.text}」(${l.abs})打不开(${r.status()})`);
  }
  // 手机:概览铺满全屏,底部三条链接在屏幕里、点得到
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  await mp.goto(`${dev.url}/?seed=7`);
  await mp.waitForFunction(() => (window as any).__wf?.ready, null, { timeout: 60000 });
  await mp.tap('[data-act=overview]');
  await mp.locator('.ov-root:not([hidden]) .ov-about').waitFor({ timeout: 5000 }).catch(() => {});
  const phone = await aboutLinks(mp);
  checkLinks('链接(手机):', phone, 390, 844);
  const minH = Math.min(...phone.map((l) => l.box[3]));
  if (!(minH >= 28)) errs.push(`链接(手机):概览底部的链接太矮,手指不好点(高 ${minH})`);
  await mctx.close();
  // 构建产物:vite build 到临时目录,vite preview 起一个服务,两个页面 200、仓库网址和 links.ts 一致
  const { build, preview } = await import('vite');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'civ-atlas-smoke-'));
  const built: string[] = [];
  try {
    await build({ logLevel: 'error', build: { outDir, emptyOutDir: true } });
    const srv = await preview({ logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port: 0, open: false } });
    const base = (srv.resolvedUrls?.local[0] ?? '').replace(/\/$/, '');
    try {
      for (const [f, h1] of [
        ['privacy.html', '隐私政策'],
        ['terms.html', '用户协议'],
      ]) {
        const onDisk = fs.existsSync(path.join(outDir, f));
        const r = await page.request.get(`${base}/${f}`);
        const body = await r.text();
        built.push(`${f} ${onDisk ? '有' : '没有'} ${r.status()}`);
        if (!onDisk) errs.push(`链接:构建产物里没有 ${f}`);
        if (r.status() !== 200 || !body.includes(`<h1>${h1}</h1>`)) errs.push(`链接:构建后的 ${f} 打不开(${r.status()})`);
        const repos = [...body.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)].map((m) => m[0]);
        if (!repos.length || repos.some((u) => u !== SOURCE_URL)) errs.push(`链接:${f} 里的仓库网址和 links.ts 不一致(${[...new Set(repos)]})`);
        if (!body.includes('href="./"')) errs.push(`链接:${f} 底部没有回到地图的链接`);
      }
    } finally {
      await srv.close();
    }
  } catch (e) {
    errs.push(`链接:构建 / 预览失败(${(e as Error).message})`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  console.log(
    `链接:宽屏 ${desk.map((l) => `${l.text}→${l.href}`).join(' · ')};AI 设置「${aiPriv?.[2]}」→ ${aiPriv?.[0]};开发服务 ${devPages.join('、')};` +
      `手机 ${phone.map((l) => `${l.text}@${l.box}${l.hit ? '' : '(被挡)'}`).join(' · ')};构建 ${built.join('、')}`,
  );
}

console.log('errors:', errs);
await browser.close();
await dev.close();
if (errs.length) process.exit(1);

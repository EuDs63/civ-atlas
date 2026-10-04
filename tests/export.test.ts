/**
 * 导出(阶段 4):高度图编码(尺寸、位深、海平面、确定性,用 pngjs 读回来核对)、编年史 Markdown / 纯文本的结构。
 * 地图图片的合成要画布,在冒烟测试(scripts/replay-check.ts)里点"导出 → 地图图片"核对。
 */
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { generateCiv } from '../src/gen/civ';
import { AZGAAR_SEA_GRAY, AZGAAR_WATER_MAX, heightmapGray, heightmapNote, heightmapPng } from '../src/gen/heightmap';
import { crc32, encodeGrayPng } from '../src/gen/png';
import { buildChronicle, chronicleDocument, chronicleEraYears, filterChronicle } from '../src/gen/civ/chronicle';
import type { Civ } from '../src/gen/civ/types';

/** pngjs 读回:16 位用 skipRescale 保留原值;灰度图读出来是 RGBA,取 R 通道 */
function decode(bytes: Uint8Array) {
  const png = PNG.sync.read(Buffer.from(bytes), { skipRescale: true });
  const src = png.data as unknown as ArrayLike<number>;
  const gray = new Array<number>(png.width * png.height);
  for (let i = 0; i < gray.length; i++) gray[i] = src[i * 4];
  return { png, gray };
}

function fakeRaster(w: number, h: number, elev: number[], water: number[]): Pick<Raster, 'w' | 'h' | 'elev' | 'water'> {
  return { w, h, elev: Float32Array.from(elev), water: Uint8Array.from(water) };
}

let cached: { world: World; raster: Raster } | null = null;
function world7() {
  if (!cached) {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
    cached = { world, raster: rasterize(world, 1) };
  }
  return cached;
}

describe('PNG 编码器', () => {
  it('CRC-32 和标准值一致', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('8 位 / 16 位灰度:pngjs 读回来逐像素一致(五种滤波都会用到)', async () => {
    const w = 37;
    const h = 23;
    const d8 = new Uint8Array(w * h);
    const d16 = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        // 平滑坡 + 一些噪点 + 一块纯色:不同的行会挑不同的滤波
        const v = y < 6 ? 128 : y < 12 ? x * 7 + y * 3 : (x * 131 + y * 71) % 251;
        d8[k] = v & 0xff;
        d16[k] = (v * 257 + x * 13 + y * 1000) & 0xffff;
      }
    }
    for (const [bits, data] of [
      [8, d8],
      [16, d16],
    ] as const) {
      const bytes = await encodeGrayPng({ width: w, height: h, bitDepth: bits, data }, { Comment: 'test' });
      const { png, gray } = decode(bytes);
      expect(png.width).toBe(w);
      expect(png.height).toBe(h);
      expect((png as unknown as { depth: number }).depth).toBe(bits);
      expect(gray).toEqual([...data]);
    }
  });

  it('尺寸和像素数对不上就报错', async () => {
    await expect(encodeGrayPng({ width: 4, height: 4, bitDepth: 8, data: new Uint8Array(3) })).rejects.toThrow();
  });
});

describe('高度图', () => {
  it('小图:16 位线性铺满、海陆分在海平面两侧;8 位按 Azgaar 刻度', () => {
    // 一行:深海、浅海、海岸陆地、湖、最高峰、低地
    const r = fakeRaster(6, 1, [-4000, -10, 0, 120, 3000, 50], [1, 1, 0, 2, 0, 0]);
    const h16 = heightmapGray(r, 16);
    const d16 = [...h16.data];
    expect(h16.info.lo).toBe(-4000);
    expect(h16.info.hi).toBe(3000);
    expect(d16[0]).toBe(0);
    expect(d16[4]).toBe(65535);
    const S = h16.info.seaLevel;
    expect(S).toBe(Math.round((4000 / 7000) * 65535));
    expect(d16[1]).toBeLessThan(S);
    expect(d16[2]).toBeGreaterThan(S); // 海拔 0 的陆地也比海平面亮
    expect(d16[3]).toBeGreaterThan(S); // 湖算陆地
    const h8 = heightmapGray(r, 8);
    const d8 = [...h8.data];
    expect(h8.info.seaLevel).toBe(AZGAAR_SEA_GRAY);
    expect(d8[0]).toBe(0);
    expect(d8[1]).toBeLessThanOrEqual(AZGAAR_WATER_MAX);
    expect(d8[1]).toBeGreaterThan(40);
    expect(d8[2]).toBe(AZGAAR_SEA_GRAY);
    expect(d8[4]).toBe(255);
    // 低地按指数 1.8 反推:50 米 / 3000 米 → (1/60)^(1/1.8) ≈ 0.10 → 51 + 21
    expect(d8[5]).toBe(51 + Math.round(204 * (50 / 3000) ** (1 / 1.8)));
  });

  it('全是海 / 全是陆地 / 有 NaN 的世界也不出错', () => {
    for (const r of [
      fakeRaster(3, 1, [-100, -50, -1], [1, 1, 1]),
      fakeRaster(3, 1, [0, 10, 5000], [0, 0, 0]),
      fakeRaster(3, 1, [NaN, -10, 10], [0, 1, 0]),
    ]) {
      for (const bits of [8, 16] as const) {
        const { data, info } = heightmapGray(r, bits);
        expect(Number.isFinite(info.seaLevel)).toBe(true);
        for (let k = 0; k < data.length; k++) {
          expect(Number.isFinite(data[k])).toBe(true);
          if (r.water[k] === 1) expect(data[k]).toBeLessThan(info.seaLevel);
          else expect(data[k]).toBeGreaterThanOrEqual(info.seaLevel);
        }
      }
    }
  });

  it('seed 7:16 位 PNG 读回来尺寸、位深对,海平面两侧海陆分明,能换算回海拔;同一个世界每次编出来一样', async () => {
    const { world, raster } = world7();
    const a = await heightmapPng(raster, 16, 7);
    const { png, gray } = decode(a.png);
    expect(png.width).toBe(world.width);
    expect(png.height).toBe(world.height);
    expect(png.width / png.height).toBe(2);
    expect((png as unknown as { depth: number }).depth).toBe(16);
    expect((png as unknown as { colorType: number }).colorType).toBe(0);
    const S = a.info.seaLevel;
    expect(S).toBeGreaterThan(20000);
    expect(S).toBeLessThan(45000);
    let land = 0;
    let maxErr = 0;
    let vMin = Infinity;
    let vMax = -Infinity;
    const step = (a.info.hi - a.info.lo) / 65535;
    // 逐像素数"站错边"的(海 ≥ 海平面、陆地 ≤ 海平面),最后一起判(两百万次 expect 太慢)
    let wrong = 0;
    for (let k = 0; k < gray.length; k++) {
      const v = gray[k];
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
      if (raster.water[k] === 1) wrong += v < S ? 0 : 1;
      else {
        wrong += v > S ? 0 : 1;
        land++;
        const e = a.info.lo + (v / 65535) * (a.info.hi - a.info.lo);
        maxErr = Math.max(maxErr, Math.abs(e - Math.max(raster.elev[k], 0)));
      }
    }
    expect(wrong).toBe(0);
    expect(land).toBe(a.info.land);
    expect(maxErr).toBeLessThan(step + 1.01); // 取整误差 + 贴海平面的陆地抬高一级
    expect(vMin).toBe(0);
    expect(vMax).toBe(65535);
    // 确定性:同一张 Raster 再编一次、同一个种子重新生成再编一次,字节都一样
    const b = await heightmapPng(raster, 16, 7);
    expect(Buffer.from(b.png).equals(Buffer.from(a.png))).toBe(true);
    const again = rasterize(generateWorld({ ...DEFAULT_PARAMS, seed: 7 }), 1);
    const c = await heightmapPng(again, 16, 7);
    expect(Buffer.from(c.png).equals(Buffer.from(a.png))).toBe(true);
    // 压缩过(地形细节噪声让 16 位的低字节接近随机,压不到太小)
    expect(a.png.length).toBeLessThan(png.width * png.height * 2 * 0.8);
  }, 60000);

  it('seed 7:8 位 PNG 读回来,海 ≤ 46、陆地 ≥ 51,最高峰 255', async () => {
    const { world, raster } = world7();
    const a = await heightmapPng(raster, 8, 7);
    const { png, gray } = decode(a.png);
    expect([png.width, png.height]).toEqual([world.width, world.height]);
    expect((png as unknown as { depth: number }).depth).toBe(8);
    let maxLand = 0;
    let wrong = 0;
    for (let k = 0; k < gray.length; k++) {
      if (raster.water[k] === 1) wrong += gray[k] <= AZGAAR_WATER_MAX ? 0 : 1;
      else {
        wrong += gray[k] >= AZGAAR_SEA_GRAY ? 0 : 1;
        maxLand = Math.max(maxLand, gray[k]);
      }
    }
    expect(wrong).toBe(0);
    expect(maxLand).toBe(255);
  }, 60000);

  it('说明文字写清尺寸、海平面灰度和换算', () => {
    const { raster } = world7();
    const h16 = heightmapGray(raster, 16);
    const t16 = heightmapNote(h16.info, { seed: 7, file: 'x-16位.png' });
    expect(t16).toContain(`海平面(0 米)= 灰度 ${h16.info.seaLevel}`);
    expect(t16).toContain('2048 × 1024');
    expect(t16).toContain('等距圆柱投影');
    const t8 = heightmapNote(heightmapGray(raster, 8).info, { seed: 7, file: 'x-8位.png' });
    expect(t8).toContain('海平面 = 灰度 51');
    expect(t8).toContain('Azgaar');
  });
});

describe('编年史导出', () => {
  let civ: Civ | null = null;
  const civ7 = () => (civ ??= generateCiv(world7().world));

  it('一节多少年:三千年分六节', () => {
    expect(chronicleEraYears(3000)).toBe(500);
    expect(chronicleEraYears(1000)).toBe(200);
    expect(chronicleEraYears(0)).toBe(50);
  });

  it('Markdown:标题带种子和年份范围,先大事后全部,按时代分节,条数对得上', () => {
    const c = civ7();
    const all = buildChronicle(c);
    const majors = filterChronicle(all, { major: true });
    const md = chronicleDocument(c, { format: 'md', seed: 7 });
    const lines = md.split('\n');
    expect(lines[0]).toBe(`# 编年史 · 种子 7 · 第 0—${Math.floor(c.endYear)} 年`);
    const iMajor = lines.indexOf('## 大事');
    const iAll = lines.indexOf('## 全部纪事');
    expect(iMajor).toBeGreaterThan(0);
    expect(iAll).toBeGreaterThan(iMajor);
    const majorPart = lines.slice(iMajor, iAll);
    const allPart = lines.slice(iAll);
    expect(majorPart.filter((l) => l.startsWith('- **'))).toHaveLength(majors.length);
    expect(allPart.filter((l) => l.startsWith('- **'))).toHaveLength(all.length);
    const kids = all.reduce((n, e) => n + (e.children?.length ?? 0), 0);
    expect(allPart.filter((l) => l.startsWith('  - 第 '))).toHaveLength(kids);
    // 大事里不列子条目
    expect(majorPart.some((l) => l.startsWith('  - '))).toBe(false);
    // 时代小节:从早到晚,每节 500 年,条目的年份落在所属的节里
    for (const part of [majorPart, allPart]) {
      let lo = -1;
      let hi = -1;
      let prev = -1;
      for (const l of part) {
        const era = l.match(/^### 第 (\d+)—(\d+) 年$/);
        if (era) {
          lo = Number(era[1]);
          hi = Number(era[2]);
          expect(lo).toBeGreaterThan(prev);
          expect(lo % 500).toBe(0);
          prev = lo;
          continue;
        }
        const y = l.match(/^- \*\*第 (\d+)/);
        if (y) {
          expect(Number(y[1])).toBeGreaterThanOrEqual(lo);
          expect(Number(y[1])).toBeLessThanOrEqual(hi);
        }
      }
      expect(prev).toBeGreaterThanOrEqual(0);
    }
    // 同一个 civ 每次一样
    expect(chronicleDocument(c, { format: 'md', seed: 7 })).toBe(md);
  }, 60000);

  it('纯文本:同样的结构,不带 Markdown 记号', () => {
    const c = civ7();
    const all = buildChronicle(c);
    const txt = chronicleDocument(c, { format: 'txt', seed: 7, params: '陆地比例 35%' });
    const lines = txt.split('\n');
    expect(lines[0]).toBe(`编年史 · 种子 7 · 第 0—${Math.floor(c.endYear)} 年`);
    expect(txt).toContain('世界参数:陆地比例 35%');
    expect(txt.indexOf('════ 大事 ════')).toBeLessThan(txt.indexOf('════ 全部纪事 ════'));
    expect(txt).toMatch(/^【第 \d+—\d+ 年】$/m);
    expect(txt).toContain(`【第 2500—${Math.floor(c.endYear)} 年】`);
    expect(txt).not.toMatch(/^#|\*\*/m);
    const allPart = lines.slice(lines.indexOf('════ 全部纪事 ════'));
    expect(allPart.filter((l) => /^第 \d+/.test(l))).toHaveLength(all.length);
  }, 60000);

  it('没有文明的世界:写一句说明,不出错', () => {
    const empty = { ...civ7(), annals: [] } as Civ;
    const md = chronicleDocument(empty, { format: 'md', seed: 1 });
    expect(md).toContain('没有文明兴起');
    expect(md).not.toContain('## 大事');
  });
});

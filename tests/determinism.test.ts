/**
 * 同一个种子在任何电脑上都生成逐位一致的世界:
 * 地形、文明的**全部数据**(每个类型化数组逐字节、每个小数按 64 位原样,名字也算)按字段各算一个指纹,钉住。
 * CI(x64 Linux)和本地(Apple 芯片 macOS)都要过 —— 推演里 Math.pow / exp / log 算出来、之后要比较或存下来的量
 * 都舍入到 24 位(gen/civ/rand.ts 的 round24),最后一位的差别不会漏进世界里。
 *
 * 对不上时,失败信息里是"哪几个字段变了"。生成算法有意改了(GENERATOR_VERSION 加一)时更新期望值:
 *   PRINT_FINGERPRINT=1 npx vitest run tests/determinism.test.ts
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

/** 一个值的指纹:类型化数组逐字节,数按 64 位原样,对象按键名排序 */
function print(v: unknown): string {
  const h = createHash('sha1');
  const feed = (x: unknown): void => {
    if (x === null || x === undefined) return void h.update(`~${x}`);
    if (ArrayBuffer.isView(x)) {
      h.update(`<${x.constructor.name}:${x.byteLength}>`);
      return void h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    }
    if (Array.isArray(x)) {
      h.update(`[${x.length}`);
      x.forEach(feed);
      return void h.update(']');
    }
    if (typeof x === 'object') {
      for (const k of Object.keys(x as object).sort()) {
        h.update(`.${k}`);
        feed((x as Record<string, unknown>)[k]);
      }
      return;
    }
    if (typeof x === 'number') {
      f64[0] = x;
      h.update('n');
      return void h.update(f64b);
    }
    h.update(`${typeof x}:${String(x)}`);
  };
  feed(v);
  return h.digest('hex').slice(0, 12);
}

/** 地形、文明各字段的指纹(字段名前加 world. / civ.) */
function fingerprint(seed: number): Record<string, string> {
  const w = generateWorld({ ...DEFAULT_PARAMS, cells: 12000, seed });
  const civ = generateCiv(w);
  const out: Record<string, string> = {};
  for (const k of Object.keys(w).sort()) out[`world.${k}`] = print((w as unknown as Record<string, unknown>)[k]);
  for (const k of Object.keys(civ).sort()) out[`civ.${k}`] = print((civ as unknown as Record<string, unknown>)[k]);
  return out;
}

/**
 * 期望值是 GENERATOR_VERSION 5 算的。经纬度换算、沿大圆走、球面三角形面积这些三角函数都舍入到 24 位,
 * 推演里的超越函数也一样,所以各 CPU、各浏览器逐位一致
 */
const EXPECTED: Record<number, Record<string, string>> = {
  2024: {
    'world.biome': 'eb1a781aedc1',
    'world.climate': 'de99136bdcb4',
    'world.elevation': '39969675c0c3',
    'world.flux': 'b4841c0d7631',
    'world.height': 'fd7f315bb385',
    'world.history': '3c479ef4810a',
    'world.maxElevation': '5758b63b2859',
    'world.mesh': 'bfa5bc2bb9fd',
    'world.params': '07a29a2f2d8b',
    'world.precipitation': 'c2e5fa205cc8',
    'world.riverThreshold': '0e691d82f410',
    'world.rivers': 'a2cec68c6e32',
    'world.seaIce': '66f1f036161b',
    'world.tect': '65c2e4cbd18f',
    'world.temperature': 'af980f474484',
    'world.volcanoes': '1184f5b8d4b6',
    'world.water': 'b8b1b2dec1cc',
    'world.waterLevel': '984bd1fa82c4',
    'world.width': '2fd8ac4eb585',
    'civ.annals': '1344d73ce093',
    'civ.checkpoints': '3c3dbdb1530e',
    'civ.culture': 'de207bbd6688',
    'civ.cultures': '30549c3c8d1e',
    'civ.endYear': 'c1d83dcab0a1',
    'civ.habitat': 'c62c910c517a',
    'civ.log': '9c936381c4eb',
    'civ.places': '34cd99c846e4',
    'civ.polities': '5fb1e42a2fda',
    'civ.polity': '5bd50a3a2c28',
    'civ.polityYears': 'e5d380617183',
    'civ.regions': 'a57c1747d310',
    'civ.routes': '1432476aa0b2',
    'civ.seed': '3ff6de7b7854',
    'civ.settlements': '5eb5aa1ce279',
    'civ.spreadYears': '12cf4022f9b0',
    'civ.viable': '139cfad50334',
  },
  7: {
    'world.biome': '20c19527abd6',
    'world.climate': 'd66f2d1ccdb0',
    'world.elevation': '8dd2243190fe',
    'world.flux': 'c0cb3dd08810',
    'world.height': 'fd7f315bb385',
    'world.history': '46fb0f6b62a1',
    'world.maxElevation': '026a5ab67a87',
    'world.mesh': 'c2903f932177',
    'world.params': 'e48d0dd04f61',
    'world.precipitation': 'fffc02e3884c',
    'world.riverThreshold': '54110659ac90',
    'world.rivers': '3436c1762169',
    'world.seaIce': 'c09ec3f15a1f',
    'world.tect': 'ca74fad97a86',
    'world.temperature': '82c4f111e9e8',
    'world.volcanoes': '1184f5b8d4b6',
    'world.water': '9dafa02952ec',
    'world.waterLevel': '1376ef2bd877',
    'world.width': '2fd8ac4eb585',
    'civ.annals': '92a551fab1c0',
    'civ.checkpoints': 'bf5f70ad566a',
    'civ.culture': 'ab93c545300d',
    'civ.cultures': '4149e26f5dc7',
    'civ.endYear': 'c1d83dcab0a1',
    'civ.habitat': '282c8ad88ec7',
    'civ.log': '5a95d51dbdbe',
    'civ.places': 'e206043351a6',
    'civ.polities': '64c3d39d89ee',
    'civ.polity': '6e1580ab3563',
    'civ.polityYears': 'e5d380617183',
    'civ.regions': '51664e70ed43',
    'civ.routes': '402e15d7ae9c',
    'civ.seed': '0096064c9137',
    'civ.settlements': 'd568b2f977a8',
    'civ.spreadYears': '1d9da2b8c240',
    'civ.viable': '139cfad50334',
  },
};

describe('同一个种子在任何电脑上都是同一个世界', () => {
  it.each([2024, 7])('seed %i(12k 地块):地形、文明全部数据的指纹逐字段对得上', (seed) => {
    const fp = fingerprint(seed);
    if (process.env.PRINT_FINGERPRINT) console.log(`${seed}: ${JSON.stringify(fp, null, 2)}`);
    expect(fp).toEqual(EXPECTED[seed]);
  }, 60_000);
});

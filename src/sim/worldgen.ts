import { Material } from '../core/types.ts';
import { WORLD } from '../core/config.ts';
import { fbm2, fbm3, smoothstep, clamp } from '../core/rng.ts';
import { VoxelWorld } from './VoxelWorld.ts';

/**
 * 「開始台地 → 谷 → 尾根 → 到達台地」を作る。
 *
 * 谷は橋を、尾根はトンネル(または大規模な切土)を一度は考えさせるための地形。
 * 谷底には軟弱な河川堆積物を、尾根には斜めに走る破砕帯を仕込んであるので、
 * 「調査してから決めるか、勘で掘るか」の判断が最初から発生する。
 */

const PLATEAU_Y = 18;
const VALLEY_Y = 5;
const RIDGE_Y = 27;

const VALLEY_CENTER = 20;
const RIDGE_CENTER = 40;

/** 尾根の低い鞍部(遠回りすれば越えられる抜け道)の z 位置。 */
const SADDLE_Z = 5;

export function baseHeight(x: number, z: number, seed: number): number {
  let h = PLATEAU_Y;

  // 谷を刻む。底は平ら(幅7)、両岸は急。
  const vd = Math.abs(x - VALLEY_CENTER + (fbm2(z * 0.09, 3.5, seed) - 0.5) * 4);
  const valleyMask = 1 - smoothstep(3, 9, vd);
  h = h + (VALLEY_Y - h) * valleyMask;

  // 尾根を盛る。z 方向の一箇所だけ鞍部があり、そこは遠回りすれば越えられる。
  const saddle = 1 - smoothstep(0, 6, Math.abs(z - SADDLE_Z));
  const ridgeTop = RIDGE_Y - 3.5 * saddle;
  const rd = Math.abs(x - RIDGE_CENTER);
  const ridgeMask = 1 - smoothstep(1, 7, rd);
  h += Math.max(0, ridgeTop - PLATEAU_Y) * ridgeMask;

  // 全体に起伏
  h += (fbm2(x * 0.11, z * 0.11, seed) - 0.5) * 3.0;

  return clamp(h, 2, WORLD.SY - 3);
}

/**
 * その列の表層(土 or 軟弱)の厚さ。
 * 急斜面ほど薄い。おかげで尾根の肩は岩がむき出しになり、
 * 「あの斜面は岩だから無支保で掘れそうだ」と地形を読む手掛かりになる。
 */
function soilThickness(x: number, z: number, seed: number): number {
  const slope = Math.max(
    Math.abs(baseHeight(x + 1, z, seed) - baseHeight(x - 1, z, seed)),
    Math.abs(baseHeight(x, z + 1, seed) - baseHeight(x, z - 1, seed)),
  ) / 2;
  const base = 2 + fbm2(x * 0.17 + 40, z * 0.17, seed + 101) * 3;
  return Math.max(0, Math.round(base * (1 - smoothstep(0.5, 2.2, slope))));
}

/**
 * 尾根を斜めに横切る破砕帯。調査せずに掘ると当たる。
 * z 方向には限りがあるので、横にずらして掘れば避けられる。
 * 「岩盤を狙って遠回りするか、軟弱層を突っ切って支保コストを払うか」がここで発生する。
 */
function inFaultZone(x: number, y: number, z: number, seed: number): boolean {
  if (Math.abs(z - 16) >= 6 || x <= 27 || x >= 52) return false;
  const d = Math.abs((x - 37) * 0.78 + (z - 16) * 0.62);
  const wobble = (fbm2(y * 0.3, z * 0.2, seed + 77) - 0.5) * 3.0;
  return d + wobble < 2.2;
}

/** 散在する軟弱レンズ。 */
function inWeakLens(x: number, y: number, z: number, seed: number): boolean {
  return fbm3(x * 0.13, y * 0.22, z * 0.13, seed + 313, 3) > 0.72;
}

export interface GeneratedWorld {
  world: VoxelWorld;
  heights: Float32Array;
}

export function generateWorld(seed: number = WORLD.SEED): GeneratedWorld {
  const world = new VoxelWorld(WORLD.SX, WORLD.SY, WORLD.SZ, WORLD.WATER_TABLE_Y);
  const heights = new Float32Array(WORLD.SX * WORLD.SZ);

  for (let x = 0; x < WORLD.SX; x++) {
    for (let z = 0; z < WORLD.SZ; z++) {
      const hf = baseHeight(x, z, seed);
      const top = Math.round(hf);
      heights[x * WORLD.SZ + z] = hf;
      const soil = soilThickness(x, z, seed);
      // 谷底(低い列)は河川堆積物。掘るのは楽だが耐力ゼロに近い。
      const riverbed = top <= VALLEY_Y + 3;

      for (let y = 0; y <= top; y++) {
        let m: Material;
        if (y <= 1) {
          m = Material.ROCK; // 岩盤
        } else if (y > top - soil) {
          m = riverbed ? Material.WEAK : Material.DIRT;
        } else {
          m = Material.ROCK;
        }

        if (m === Material.ROCK && (inFaultZone(x, y, z, seed) || inWeakLens(x, y, z, seed)) && y > 1) {
          m = Material.WEAK;
        }
        world.initSet(x, y, z, m);
      }
      for (let y = top + 1; y < WORLD.SY; y++) {
        world.initSet(x, y, z, Material.AIR);
      }
    }
  }

  return { world, heights };
}

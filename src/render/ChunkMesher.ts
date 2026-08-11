import * as THREE from 'three';
import { Material } from '../core/types.ts';
import {
  AO_STRENGTH,
  COLORS,
  GRASS_COLOR,
  SMOOTH_CLAMP,
  SMOOTH_ITERATIONS,
  SMOOTH_PAD,
  SURFACE_SNAP_REACH,
  UNKNOWN_COLOR,
} from '../core/config.ts';
import type { VoxelWorld } from '../sim/VoxelWorld.ts';
import { OX, OZ } from './Scene.ts';

/**
 * ボクセル格子から、ボクセルに見えない地形を作る (Surface Nets)。
 *
 * 格子の「セル中心」を格子点として、隣り合う8セルの塊 (デュアルセル) ごとに
 * 頂点を1つだけ置き、境界面の中点の重心に寄せる。角で占有率を平均する作り方だと
 * 1セル幅の坑道が閉じて消えてしまうので、占有はセル単位の 0/1 のまま扱う。
 *
 * そのあと3段階で「地形」に寄せる:
 *   1. 手つかずの列は worldgen の連続高さ (float) に吸着させる。ここが一番効く。
 *      掘っても盛ってもいない地面は、丸めの階段が一切残らない曲面になる。
 *   2. 残り (掘った跡・盛った跡) は拘束付きラプラシアン平滑化。
 *      各頂点は自分のセルの中心から SMOOTH_CLAMP 以上は動かさない。
 *      「マス目を数えれば予測できる」を壊さないための拘束。
 *   3. 周囲の詰まり具合から陰 (AO) を頂点カラーに焼く。
 *
 * 通常ビュー用と地質ビュー用の2つの頂点カラーを同時に作るのは前と同じ。
 */

const tmp = new THREE.Color();

export interface ChunkBounds {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface MeshInput {
  world: VoxelWorld;
  /** その列の地質が判明しているか */
  isKnown: (x: number, z: number) => boolean;
  /** worldgen の連続地表高さ。手つかずの列を吸着させる先。 */
  heightAt: (x: number, z: number) => number;
}

/** デュアルセルの立方体の12辺 (端点は 0..7 のビット表現 = (a,b,c))。 */
const EDGES: readonly [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // z 方向
  [0, 2], [1, 3], [4, 6], [5, 7], // y 方向
  [0, 4], [1, 5], [2, 6], [3, 7], // x 方向
];

/** コーナー番号 (a,b,c) → ビット。a=x, b=y, c=z。 */
function corner(a: number, b: number, c: number): number {
  return a * 4 + b * 2 + c;
}

export function buildChunkGeometry(input: MeshInput, b: ChunkBounds): THREE.BufferGeometry {
  const { world } = input;
  // 内側のループで何十万回も引くので、境界判定込みの直接参照にする。
  const mat = world.mat;
  const wsx = world.sx;
  const wsy = world.sy;
  const wsz = world.sz;
  const isSolid = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= wsx || y >= wsy || z >= wsz) return false;
    return (mat[(x * wsy + y) * wsz + z] as number) !== Material.AIR;
  };

  // 平滑化も法線も近傍に依存するので、チャンクの外まで一度作ってから中身だけを出す。
  // こうしないと継ぎ目で陰影と形が割れる。
  const i0 = Math.max(-1, b.x0 - 1 - SMOOTH_PAD);
  const i1 = Math.min(world.sx - 1, b.x1 - 1 + SMOOTH_PAD);
  const k0 = Math.max(-1, b.z0 - 1 - SMOOTH_PAD);
  const k1 = Math.min(world.sz - 1, b.z1 - 1 + SMOOTH_PAD);
  const j0 = -1;
  const j1 = world.sy - 1;

  const ni = i1 - i0 + 1;
  const nj = j1 - j0 + 1;
  const nk = k1 - k0 + 1;
  const at = (i: number, j: number, k: number): number => ((i - i0) * nj + (j - j0)) * nk + (k - k0);
  const inGrid = (i: number, j: number, k: number): boolean =>
    i >= i0 && i <= i1 && j >= j0 && j <= j1 && k >= k0 && k <= k1;

  const index = new Int32Array(ni * nj * nk).fill(-1);
  const vx: number[] = [];
  const vy: number[] = [];
  const vz: number[] = [];
  /** そのデュアルセルの公称中心 (8セルが共有する角)。平滑化の拘束の基準。 */
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  /** 連続高さに吸着済み = 動かさない。 */
  const pinned: boolean[] = [];
  const material: number[] = [];
  /** 世界の縁の人工的な切り口か (自然の露頭と区別する)。 */
  const artificial: boolean[] = [];

  const solid = new Array<boolean>(8);

  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      for (let k = k0; k <= k1; k++) {
        let count = 0;
        for (let a = 0; a < 2; a++) {
          for (let bb = 0; bb < 2; bb++) {
            for (let c = 0; c < 2; c++) {
              const s = isSolid(i + a, j + bb, k + c);
              solid[corner(a, bb, c)] = s;
              if (s) count++;
            }
          }
        }
        if (count === 0 || count === 8) continue;

        // 符号が変わる辺の中点の重心。0/1 の場だと交点はちょうど中点になる。
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [p, q] of EDGES) {
          if (solid[p] === solid[q]) continue;
          const pa = (p >> 2) & 1;
          const pb = (p >> 1) & 1;
          const pc = p & 1;
          const qa = (q >> 2) & 1;
          const qb = (q >> 1) & 1;
          const qc = q & 1;
          sx += i + (pa + qa) / 2 + 0.5;
          sy += j + (pb + qb) / 2 + 0.5;
          sz += k + (pc + qc) / 2 + 0.5;
          n++;
        }

        const id = vx.length;
        index[at(i, j, k)] = id;
        vx.push(sx / n);
        vy.push(sy / n);
        vz.push(sz / n);
        ax.push(i + 1);
        ay.push(j + 1);
        az.push(k + 1);
        pinned.push(false);
        material.push(dominantMaterial(world, i, j, k));
        artificial.push(i < 0 || i + 1 >= world.sx || k < 0 || k + 1 >= world.sz);
      }
    }
  }

  const vertexCount = vx.length;
  if (vertexCount === 0) return emptyGeometry();

  // --- 1. 手つかずの地表は連続曲面に吸着させる ----------------------------
  //
  // 上下に動かすだけだと、急斜面が段々畑のまま残る。1マス横にずれるだけで
  // 高さが3マス変わるような壁では、頂点は「横」に動かないと面に乗らないから。
  // なので y を合わせるのではなく、曲面 y = H(x,z) へ最短距離で寄せる
  // (ニュートン法を数歩)。平らなところでは今までどおり真上下の移動になり、
  // 急斜面では自動的に横移動が主になる。
  const surface = (x: number, z: number): number => input.heightAt(x, z) + 1;
  for (let v = 0; v < vertexCount; v++) {
    const cx = Math.floor(vx[v] as number);
    const cz = Math.floor(vz[v] as number);
    if (
      world.isColumnModified(cx, cz) ||
      world.isColumnModified(cx + 1, cz) ||
      world.isColumnModified(cx, cz + 1) ||
      world.isColumnModified(cx + 1, cz + 1)
    ) {
      continue;
    }

    let px = vx[v] as number;
    let py = vy[v] as number;
    let pz = vz[v] as number;
    for (let step = 0; step < 3; step++) {
      const h = surface(px, pz);
      const hx = (surface(px + 0.5, pz) - surface(px - 0.5, pz)) as number;
      const hz = (surface(px, pz + 0.5) - surface(px, pz - 0.5)) as number;
      const t = (py - h) / (1 + hx * hx + hz * hz);
      px += t * hx;
      py -= t;
      pz += t * hz;
    }
    // 曲面から遠いものは地中や掘った跡なので触らない。
    const moved = Math.hypot(px - (vx[v] as number), py - (vy[v] as number), pz - (vz[v] as number));
    if (moved > SURFACE_SNAP_REACH) continue;
    // 動かしてよい範囲はセル1つぶんまで。マス目の予測可能性を守る。
    vx[v] = clampAround(px, vx[v] as number);
    vy[v] = clampAround(py, vy[v] as number);
    vz[v] = clampAround(pz, vz[v] as number);
    pinned[v] = true;
    artificial[v] = false; // 自然の地表は露頭として本当の色を見せる
  }

  // --- 2. 残りを拘束付きラプラシアン平滑化 --------------------------------
  smooth(
    { vx, vy, vz, ax, ay, az, pinned, vertexCount },
    { world, index, at, inGrid, i0, i1, j0, j1, k0, k1 },
  );

  // --- 3. 面を張る (法線は余白ぶんも積んでから、中身だけを出す) -----------
  const nx = new Float32Array(vertexCount);
  const ny = new Float32Array(vertexCount);
  const nz = new Float32Array(vertexCount);
  const owned: number[] = [];

  const vertexAt = (i: number, j: number, k: number): number =>
    inGrid(i, j, k) ? (index[at(i, j, k)] as number) : -1;

  const accumulate = (a: number, bq: number, c: number): void => {
    const e1x = (vx[bq] as number) - (vx[a] as number);
    const e1y = (vy[bq] as number) - (vy[a] as number);
    const e1z = (vz[bq] as number) - (vz[a] as number);
    const e2x = (vx[c] as number) - (vx[a] as number);
    const e2y = (vy[c] as number) - (vy[a] as number);
    const e2z = (vz[c] as number) - (vz[a] as number);
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    for (const v of [a, bq, c]) {
      nx[v] = (nx[v] as number) + cx;
      ny[v] = (ny[v] as number) + cy;
      nz[v] = (nz[v] as number) + cz;
    }
  };

  const addQuad = (q0: number, q1: number, q2: number, q3: number, flip: boolean, keep: boolean): void => {
    if (q0 < 0 || q1 < 0 || q2 < 0 || q3 < 0) return;
    const a = flip ? q3 : q0;
    const bq = flip ? q2 : q1;
    const c = flip ? q1 : q2;
    const d = flip ? q0 : q3;
    accumulate(a, bq, c);
    accumulate(a, c, d);
    if (keep) owned.push(a, bq, c, a, c, d);
  };

  // 世界の縁の壁も張る。範囲外は空気なので、x=-1 の辺から -x 側の壁が出る。
  const ox0 = b.x0 === 0 ? -1 : b.x0;
  const oz0 = b.z0 === 0 ? -1 : b.z0;

  for (let x = Math.max(-1, i0); x <= Math.min(i1 + 1, world.sx - 1); x++) {
    const ownX = x >= ox0 && x < b.x1;
    for (let z = Math.max(-1, k0); z <= Math.min(k1 + 1, world.sz - 1); z++) {
      const keep = ownX && z >= oz0 && z < b.z1;
      for (let y = -1; y < world.sy; y++) {
        const s = isSolid(x, y, z);
        // +x の辺のまわりの4つのデュアルセル (x, y-1..y, z-1..z)。
        // 法線が +x を向くように j → k の順で回す。
        if (s !== isSolid(x + 1, y, z)) {
          addQuad(
            vertexAt(x, y - 1, z - 1), vertexAt(x, y, z - 1), vertexAt(x, y, z), vertexAt(x, y - 1, z),
            !s, keep,
          );
        }
        // +y の辺: (x-1..x, y, z-1..z)
        if (s !== isSolid(x, y + 1, z)) {
          addQuad(
            vertexAt(x - 1, y, z - 1), vertexAt(x - 1, y, z), vertexAt(x, y, z), vertexAt(x, y, z - 1),
            !s, keep,
          );
        }
        // +z の辺: (x-1..x, y-1..y, z)
        if (s !== isSolid(x, y, z + 1)) {
          addQuad(
            vertexAt(x - 1, y - 1, z), vertexAt(x, y - 1, z), vertexAt(x, y, z), vertexAt(x - 1, y, z),
            !s, keep,
          );
        }
      }
    }
  }

  if (owned.length === 0) return emptyGeometry();

  // --- 4. 使う頂点だけ詰め直して属性を作る --------------------------------
  const remap = new Int32Array(vertexCount).fill(-1);
  const positions: number[] = [];
  const normals: number[] = [];
  const colorNormal: number[] = [];
  const colorGeo: number[] = [];
  const indices: number[] = [];

  for (const v of owned) {
    let r = remap[v] as number;
    if (r < 0) {
      r = positions.length / 3;
      remap[v] = r;

      const px = vx[v] as number;
      const py = vy[v] as number;
      const pz = vz[v] as number;
      positions.push(OX + px, py, OZ + pz);

      const len = Math.hypot(nx[v] as number, ny[v] as number, nz[v] as number) || 1;
      const ux = (nx[v] as number) / len;
      const uy = (ny[v] as number) / len;
      const uz = (nz[v] as number) / len;
      normals.push(ux, uy, uz);

      const m = material[v] as Material;
      const known = input.isKnown(Math.floor(px), Math.floor(pz));
      const ao = 1 - AO_STRENGTH * Math.max(0, occupancy(isSolid, px, py, pz) - 0.5) * 2;

      // 世界の縁は人工的な切り口なので、未調査なら地質をタダでは見せない。
      // 自然にできた崖や谷壁は露頭。ここは本当の色が見える = 地形を読む価値がある。
      const base =
        artificial[v] && !known
          ? UNKNOWN_COLOR
          : m === Material.DIRT && uy > 0.45
            ? GRASS_COLOR
            : COLORS[m];
      tmp.setHex(base).multiplyScalar(ao);
      colorNormal.push(tmp.r, tmp.g, tmp.b);
      tmp.setHex(known ? COLORS[m] : UNKNOWN_COLOR).multiplyScalar(ao);
      colorGeo.push(tmp.r, tmp.g, tmp.b);
    }
    indices.push(r);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colorNormal, 3));
  g.setAttribute('colorGeo', new THREE.Float32BufferAttribute(colorGeo, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

interface SmoothVerts {
  vx: number[];
  vy: number[];
  vz: number[];
  ax: number[];
  ay: number[];
  az: number[];
  pinned: boolean[];
  vertexCount: number;
}

interface SmoothGrid {
  world: VoxelWorld;
  index: Int32Array;
  at: (i: number, j: number, k: number) => number;
  inGrid: (i: number, j: number, k: number) => boolean;
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  k0: number;
  k1: number;
}

/**
 * 6近傍のデュアルセルの平均へ寄せる。吸着済みの頂点は動かさないが、
 * 隣の平均には効く。おかげで掘った跡が自然地形へ滑らかに繋がる。
 */
function smooth(v: SmoothVerts, g: SmoothGrid): void {
  const { vx, vy, vz, ax, ay, az, pinned, vertexCount } = v;
  const cellOf = new Int32Array(vertexCount * 3);
  for (let i = g.i0; i <= g.i1; i++) {
    for (let j = g.j0; j <= g.j1; j++) {
      for (let k = g.k0; k <= g.k1; k++) {
        const id = g.index[g.at(i, j, k)] as number;
        if (id < 0) continue;
        cellOf[id * 3] = i;
        cellOf[id * 3 + 1] = j;
        cellOf[id * 3 + 2] = k;
      }
    }
  }

  const tx = new Float64Array(vertexCount);
  const ty = new Float64Array(vertexCount);
  const tz = new Float64Array(vertexCount);
  const NEIGHBORS: readonly [number, number, number][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];

  for (let pass = 0; pass < SMOOTH_ITERATIONS; pass++) {
    for (let id = 0; id < vertexCount; id++) {
      if (pinned[id]) continue;
      const i = cellOf[id * 3] as number;
      const j = cellOf[id * 3 + 1] as number;
      const k = cellOf[id * 3 + 2] as number;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;
      for (const [di, dj, dk] of NEIGHBORS) {
        if (!g.inGrid(i + di, j + dj, k + dk)) continue;
        const nb = g.index[g.at(i + di, j + dj, k + dk)] as number;
        if (nb < 0) continue;
        sx += vx[nb] as number;
        sy += vy[nb] as number;
        sz += vz[nb] as number;
        n++;
      }
      if (n === 0) {
        tx[id] = vx[id] as number;
        ty[id] = vy[id] as number;
        tz[id] = vz[id] as number;
        continue;
      }
      // 自分のセルの中心から離れすぎないように押し戻す。
      tx[id] = clampAround(sx / n, ax[id] as number);
      ty[id] = clampAround(sy / n, ay[id] as number);
      tz[id] = clampAround(sz / n, az[id] as number);
    }
    for (let id = 0; id < vertexCount; id++) {
      if (pinned[id]) continue;
      vx[id] = tx[id] as number;
      vy[id] = ty[id] as number;
      vz[id] = tz[id] as number;
    }
  }
}

function clampAround(value: number, anchor: number): number {
  if (value < anchor - SMOOTH_CLAMP) return anchor - SMOOTH_CLAMP;
  if (value > anchor + SMOOTH_CLAMP) return anchor + SMOOTH_CLAMP;
  return value;
}

/** デュアルセル内で一番多い固体材質。地層の境目が頂点カラーで自然に混ざる。 */
function dominantMaterial(world: VoxelWorld, i: number, j: number, k: number): Material {
  const votes = [0, 0, 0, 0];
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 2; c++) {
        const m = world.get(i + a, j + b, k + c);
        if (m !== Material.AIR) votes[m] = (votes[m] as number) + 1;
      }
    }
  }
  let best: Material = Material.DIRT;
  let bestCount = -1;
  for (const m of [Material.ROCK, Material.DIRT, Material.WEAK] as const) {
    if ((votes[m] as number) > bestCount) {
      bestCount = votes[m] as number;
      best = m;
    }
  }
  return best;
}

/** まわりの詰まり具合。平地で 0.5、窪みや坑内ほど大きくなる。 */
function occupancy(
  isSolid: (x: number, y: number, z: number) => boolean,
  px: number,
  py: number,
  pz: number,
): number {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  let n = 0;
  for (let x = cx - 2; x <= cx + 1; x++) {
    for (let y = cy - 2; y <= cy + 1; y++) {
      for (let z = cz - 2; z <= cz + 1; z++) {
        if (isSolid(x, y, z)) n++;
      }
    }
  }
  return n / 64;
}

function emptyGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
  g.setAttribute('colorGeo', new THREE.Float32BufferAttribute([], 3));
  g.setIndex([]);
  g.computeBoundingSphere();
  return g;
}

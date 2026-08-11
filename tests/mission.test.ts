import { describe, expect, it } from 'vitest';
import { Material } from '../src/core/types.ts';
import type { Cell } from '../src/core/types.ts';
import { VoxelWorld } from '../src/sim/VoxelWorld.ts';
import { findRoute, isStandable, steepestGrade } from '../src/sim/mission.ts';
import type { RouteQuery } from '../src/sim/mission.ts';

/** 平らな地面 (top y=4) の 1 列だけの世界。 */
function flat(sx = 12): VoxelWorld {
  const w = new VoxelWorld(sx, 12, 3, 0);
  for (let x = 0; x < sx; x++) {
    for (let z = 0; z < 3; z++) {
      for (let y = 0; y <= 4; y++) w.initSet(x, y, z, Material.DIRT);
      for (let y = 5; y < 12; y++) w.initSet(x, y, z, Material.AIR);
    }
  }
  return w;
}

const noDeck = (): boolean => false;
const q = (world: VoxelWorld, hasDeck: RouteQuery['hasDeck'] = noDeck): RouteQuery => ({ world, hasDeck });

describe('歩ける場所', () => {
  it('地面の上には立てる', () => {
    const w = flat();
    expect(isStandable(q(w), 3, 5, 1)).toBe(true);
    expect(isStandable(q(w), 3, 4, 1)).toBe(false); // 地面の中
    expect(isStandable(q(w), 3, 6, 1)).toBe(false); // 宙に浮いている
  });

  it('桁の上にも立てる', () => {
    const w = flat();
    const deck = (x: number, y: number): boolean => y === 8 && x === 3;
    expect(isStandable(q(w, deck), 3, 8, 1)).toBe(true);
  });
});

describe('接続判定', () => {
  it('平らな地面はつながっている', () => {
    const w = flat();
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 }).connected).toBe(true);
  });

  it('段差1までは登れる', () => {
    const w = flat();
    for (let x = 6; x < 12; x++) w.set(x, 5, 1, Material.DIRT, true);
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 6, z: 1 }).connected).toBe(true);
  });

  it('段差2は登れない', () => {
    const w = flat();
    for (let x = 6; x < 12; x++) {
      for (let z = 0; z < 3; z++) {
        w.set(x, 5, z, Material.DIRT, true);
        w.set(x, 6, z, Material.DIRT, true);
      }
    }
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 7, z: 1 }).connected).toBe(false);
  });

  it('谷を挟むと届かないが、桁を渡せばつながる', () => {
    const w = flat();
    for (let x = 4; x <= 7; x++) {
      for (let z = 0; z < 3; z++) for (let y = 0; y <= 4; y++) w.set(x, y, z, Material.AIR);
    }
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 }).connected).toBe(false);

    const deck = (x: number, y: number, z: number): boolean => y === 5 && z === 1 && x >= 3 && x <= 8;
    const res = findRoute(q(w, deck), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 });
    expect(res.connected).toBe(true);
    expect(res.path[0]).toEqual({ x: 0, y: 5, z: 1 });
    expect(res.path.at(-1)).toMatchObject({ x: 11, z: 1 });
  });

  it('トンネルの中も歩ける', () => {
    const w = new VoxelWorld(12, 12, 3, 0);
    for (let x = 0; x < 12; x++) {
      for (let z = 0; z < 3; z++) {
        const top = x >= 4 && x <= 7 ? 9 : 4; // 中央だけ山
        for (let y = 0; y <= top; y++) w.initSet(x, y, z, Material.ROCK);
        for (let y = top + 1; y < 12; y++) w.initSet(x, y, z, Material.AIR);
      }
    }
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 }).connected).toBe(false);
    for (let x = 4; x <= 7; x++) w.excavate(x, 5, 1); // 坑道を貫通させる
    expect(findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 }).connected).toBe(true);
  });
});

describe('経路長の上限', () => {
  it('遠回りしすぎると「到達はできるが道路にならない」', () => {
    const w = flat(20);
    const near = findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 19, y: 5, z: 1 }, 30);
    expect(near.reachable).toBe(true);
    expect(near.connected).toBe(true);

    const far = findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 19, y: 5, z: 1 }, 10);
    expect(far.reachable).toBe(true);
    expect(far.connected).toBe(false); // 遠回りにも値段がつく
    expect(far.length).toBe(20);
  });
});

describe('勾配の上限', () => {
  /**
   * x が everyN マス進むごとに1マス上がる階段。
   * 横に逃げ場を作らない (sz=1) ので、勾配の制限だけが効く。
   */
  function stairs(sx: number, everyN: number, sz = 1): VoxelWorld {
    const w = new VoxelWorld(sx, 24, sz, 0);
    for (let x = 0; x < sx; x++) {
      const top = 4 + Math.floor(x / everyN);
      for (let z = 0; z < sz; z++) {
        for (let y = 0; y <= top; y++) w.initSet(x, y, z, Material.DIRT);
        for (let y = top + 1; y < 24; y++) w.initSet(x, y, z, Material.AIR);
      }
    }
    return w;
  }

  it('1マスごとに1マス上がる崖は、道路として認められない', () => {
    const w = stairs(12, 1);
    const start = { x: 0, y: 5, z: 0 };
    const goal = { x: 11, y: 16, z: 0 };
    // 旧ルール (段差1が連続してよい) なら通る
    expect(findRoute(q(w), start, goal, { gradeRun: 1 }).reachable).toBe(true);
    // 勾配ルールでは通らない
    expect(findRoute(q(w), start, goal, { gradeRun: 3 }).reachable).toBe(false);
  });

  it('3マスに1マスの階段なら通る', () => {
    const w = stairs(24, 3);
    const r = findRoute(q(w), { x: 0, y: 5, z: 0 }, { x: 23, y: 12, z: 0 }, { gradeRun: 3 });
    expect(r.reachable).toBe(true);
    // 上下した直後は必ず平坦が続いている
    for (let i = 1; i < r.path.length; i++) {
      if ((r.path[i] as Cell).y === (r.path[i - 1] as Cell).y) continue;
      for (let k = i + 1; k < Math.min(r.path.length, i + 3); k++) {
        expect((r.path[k] as Cell).y).toBe((r.path[i] as Cell).y);
      }
    }
  });

  it('下り勾配にも同じ制限がかかる', () => {
    const w = stairs(12, 1);
    expect(findRoute(q(w), { x: 11, y: 16, z: 0 }, { x: 0, y: 5, z: 0 }, { gradeRun: 3 }).reachable).toBe(false);
  });

  it('横に逃げ場があれば、九十九折りで登れる (遠回りという値段を払って)', () => {
    // 同じ崖でも、横に振れる幅があれば距離を稼いで登れる。現実の峠道と同じ。
    const wide = stairs(12, 1, 5);
    const direct = findRoute(q(stairs(12, 1)), { x: 0, y: 5, z: 0 }, { x: 11, y: 16, z: 0 }, { gradeRun: 3 });
    const zigzag = findRoute(q(wide), { x: 0, y: 5, z: 2 }, { x: 11, y: 16, z: 2 }, { gradeRun: 3 });
    expect(direct.reachable).toBe(false);
    expect(zigzag.reachable).toBe(true);
    expect(zigzag.length).toBeGreaterThan(12); // まっすぐ行くより確実に長い
  });

  it('届かないときは、一番 GOAL に近づけたところまでの線が返る', () => {
    const w = flat();
    // x=6 から先を掘り落として、渡れない谷にする
    for (let x = 6; x <= 8; x++) {
      for (let z = 0; z < 3; z++) for (let y = 0; y <= 4; y++) w.set(x, y, z, Material.AIR);
    }
    const r = findRoute(q(w), { x: 0, y: 5, z: 1 }, { x: 11, y: 5, z: 1 }, { gradeRun: 3 });
    expect(r.reachable).toBe(false);
    expect(r.path).toHaveLength(0);
    // 工事中の道路を描くための線。谷の手前まで来ている。
    expect(r.best.length).toBeGreaterThan(1);
    expect(r.best.at(-1)?.x).toBe(5);
  });
});

describe('最急勾配の表示', () => {
  it('1マスの上下を窓ぶんに広げて測る (実際の道路の走り方に合わせる)', () => {
    const path: Cell[] = [
      { x: 0, y: 5, z: 0 },
      { x: 1, y: 5, z: 0 },
      { x: 2, y: 6, z: 0 },
      { x: 3, y: 6, z: 0 },
    ];
    // 1セル = 横8m × 縦2m。3マスで1マス上がるので 2 / 24 = 8.3%
    expect(steepestGrade(path, 3, 8, 2)).toBeCloseTo(2 / 24, 5);
  });
});

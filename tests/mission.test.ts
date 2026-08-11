import { describe, expect, it } from 'vitest';
import { Material } from '../src/core/types.ts';
import { VoxelWorld } from '../src/sim/VoxelWorld.ts';
import { findRoute, isStandable } from '../src/sim/mission.ts';
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

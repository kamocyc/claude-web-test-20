import { describe, expect, it } from 'vitest';
import { generateWorld } from '../src/sim/worldgen.ts';
import { Game } from '../src/sim/Game.ts';
import { Material } from '../src/core/types.ts';
import { WORLD } from '../src/core/config.ts';

describe('worldgen', () => {
  it('シードが同じなら決定的に同じ地形になる', () => {
    const a = generateWorld(1234);
    const b = generateWorld(1234);
    expect(a.world.mat).toEqual(b.world.mat);
    const c = generateWorld(9999);
    expect(c.world.mat).not.toEqual(a.world.mat);
  });

  it('谷と尾根が期待した範囲にできている', () => {
    const { world } = generateWorld();
    const z = 16;
    const valleyFloor = world.surfaceY(20, z);
    const ridgeTop = world.surfaceY(40, z);
    const plateau = world.surfaceY(4, z);

    expect(valleyFloor).toBeLessThan(plateau - 8); // 谷は深い
    expect(ridgeTop).toBeGreaterThan(plateau + 6); // 尾根は高い
  });

  it('尾根には鞍部があり、そこは本線より低い(遠回りの選択肢)', () => {
    const { world } = generateWorld();
    expect(world.surfaceY(40, 5)).toBeLessThan(world.surfaceY(40, 16) - 3);
  });

  it('谷底は軟弱層になっている(橋脚を立てるなら基礎が要る)', () => {
    const { world } = generateWorld();
    const top = world.surfaceY(20, 16);
    expect(world.get(20, top, 16)).toBe(Material.WEAK);
  });

  it('底の2層は岩盤', () => {
    const { world } = generateWorld();
    for (let x = 0; x < WORLD.SX; x += 7) {
      for (let z = 0; z < WORLD.SZ; z += 7) {
        expect(world.get(x, 0, z)).toBe(Material.ROCK);
        expect(world.get(x, 1, z)).toBe(Material.ROCK);
      }
    }
  });

  it('初期状態では START から GOAL へ歩いて行けない', () => {
    const game = new Game();
    expect(game.checkRoute()).toBe(false);
  });

  it('3種の地質がすべて十分に存在する', () => {
    const { world } = generateWorld();
    const counts = [0, 0, 0, 0];
    for (const m of world.mat) counts[m] = (counts[m] ?? 0) + 1;
    expect(counts[Material.DIRT]).toBeGreaterThan(1000);
    expect(counts[Material.ROCK]).toBeGreaterThan(1000);
    expect(counts[Material.WEAK]).toBeGreaterThan(500);
  });
});

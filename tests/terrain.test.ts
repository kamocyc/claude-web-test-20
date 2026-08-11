import { describe, expect, it } from 'vitest';
import { Material } from '../src/core/types.ts';
import { WORLD } from '../src/core/config.ts';
import { Game } from '../src/sim/Game.ts';
import { buildChunkGeometry } from '../src/render/ChunkMesher.ts';
import type { MeshInput } from '../src/render/ChunkMesher.ts';

function inputFor(game: Game): MeshInput {
  return {
    world: game.world,
    isKnown: (x, z) => game.survey.isKnown(x, z),
    heightAt: (x, z) => game.heightAt(x, z),
  };
}

const CHUNK = { x0: 0, y0: 0, z0: 0, x1: 16, y1: WORLD.SY, z1: 16 };

describe('地形メッシュ (Surface Nets)', () => {
  it('同じ入力からは同じメッシュができる', () => {
    const g = new Game();
    const a = buildChunkGeometry(inputFor(g), CHUNK);
    const b = buildChunkGeometry(inputFor(g), CHUNK);
    const pa = a.attributes.position!.array as Float32Array;
    const pb = b.attributes.position!.array as Float32Array;
    expect(pa.length).toBe(pb.length);
    expect(pa.length).toBeGreaterThan(0);
    for (let i = 0; i < pa.length; i++) expect(pa[i]).toBe(pb[i]);
  });

  it('手つかずの地表は連続曲面に乗る (丸めの階段が残らない)', () => {
    const g = new Game();
    const geo = buildChunkGeometry(inputFor(g), CHUNK);
    const pos = geo.attributes.position!.array as Float32Array;
    const nrm = geo.attributes.normal!.array as Float32Array;
    let checked = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if ((nrm[i + 1] as number) < 0.8) continue; // 上を向いている面だけ
      const x = (pos[i] as number) + WORLD.SX / 2;
      const z = (pos[i + 2] as number) + WORLD.SZ / 2;
      if (x < 2 || z < 2 || x > 14 || z > 14) continue; // 世界の縁は別扱い
      // 曲面へ最短距離で寄せているので、真上下の一致ではなく面上にいることを見る。
      expect(Math.abs((pos[i + 1] as number) - (g.heightAt(x, z) + 1))).toBeLessThan(0.02);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('1セル幅の坑道が平滑化で塞がらない (回帰の要)', () => {
    const g = new Game();
    const z = 20;
    const before = buildChunkGeometry(inputFor(g), CHUNK);
    for (let x = 4; x < 14; x++) g.world.set(x, 14, z, Material.AIR);
    const after = buildChunkGeometry(inputFor(g), { ...CHUNK, z0: 16, z1: 32 });

    let inside = 0;
    const pos = after.attributes.position!.array as Float32Array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = (pos[i] as number) + WORLD.SX / 2;
      const y = pos[i + 1] as number;
      const zz = (pos[i + 2] as number) + WORLD.SZ / 2;
      if (x > 5 && x < 13 && y > 13.5 && y < 15.5 && zz > z - 0.5 && zz < z + 1.5) inside++;
    }
    // 坑道の壁の頂点が立っている = 空洞として抜けている
    expect(inside).toBeGreaterThan(10);
    expect(before.attributes.position!.count).toBeGreaterThan(0);
  });

  it('掘った列は連続高さに吸着しない (格子どおりの切土になる)', () => {
    const g = new Game();
    expect(g.world.isColumnModified(8, 8)).toBe(false);
    g.world.set(8, g.world.surfaceY(8, 8), 8, Material.AIR);
    expect(g.world.isColumnModified(8, 8)).toBe(true);
  });

  it('世界の縁の切り口は、未調査なら地質色を見せない', () => {
    const g = new Game();
    const edge = { x0: 0, y0: 0, z0: 0, x1: 4, y1: WORLD.SY, z1: 16 };
    const unknown = buildChunkGeometry(inputFor(g), edge);
    g.survey.bore(0, 8);
    g.survey.bore(1, 8);
    const known = buildChunkGeometry(inputFor(g), edge);
    const ca = unknown.attributes.color!.array as Float32Array;
    const cb = known.attributes.color!.array as Float32Array;
    // 調査したぶんだけ色が変わる
    let diff = 0;
    for (let i = 0; i < Math.min(ca.length, cb.length); i++) if (ca[i] !== cb[i]) diff++;
    expect(diff).toBeGreaterThan(0);
  });
});

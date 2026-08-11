import { describe, expect, it } from 'vitest';
import { Material } from '../src/core/types.ts';
import { GRACE_SECONDS } from '../src/core/config.ts';
import { VoxelWorld } from '../src/sim/VoxelWorld.ts';
import { TunnelSystem } from '../src/sim/tunnel.ts';

/** 地下水位 y=4 の小さな試験用ブロック。上半分が空、下半分が指定材質。 */
function block(material: Material, waterTableY = 4): VoxelWorld {
  const w = new VoxelWorld(5, 12, 5, waterTableY);
  for (let x = 0; x < 5; x++) {
    for (let z = 0; z < 5; z++) {
      for (let y = 0; y < 10; y++) w.initSet(x, y, z, material);
      for (let y = 10; y < 12; y++) w.initSet(x, y, z, Material.AIR);
    }
  }
  return w;
}

describe('必要支保レベル', () => {
  it('岩=0 / 土=1 / 軟弱=2', () => {
    expect(TunnelSystem.requiredLevel(Material.ROCK, false)).toBe(0);
    expect(TunnelSystem.requiredLevel(Material.DIRT, false)).toBe(1);
    expect(TunnelSystem.requiredLevel(Material.WEAK, false)).toBe(2);
  });

  it('地下水位より下ならレベル +1', () => {
    expect(TunnelSystem.requiredLevel(Material.ROCK, true)).toBe(1);
    expect(TunnelSystem.requiredLevel(Material.DIRT, true)).toBe(2);
    expect(TunnelSystem.requiredLevel(Material.WEAK, true)).toBe(3);
  });

  it('水位の判定は世界の地下水位に従う', () => {
    const w = block(Material.DIRT, 6);
    const t = new TunnelSystem(w);
    w.excavate(2, 3, 2);
    expect(t.register(2, 3, 2, Material.DIRT).required).toBe(2); // 水位下
    w.excavate(2, 8, 2);
    expect(t.register(2, 8, 2, Material.DIRT).required).toBe(1); // 水位上
  });
});

describe('劣化タイマー', () => {
  it('支保が足りているあいだはタイマーが減らない', () => {
    const w = block(Material.ROCK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    const cell = t.register(2, 8, 2, Material.ROCK); // 岩 = 支保不要
    expect(t.deficit(cell)).toBe(0);
    for (let i = 0; i < 100; i++) expect(t.update(0.5)).toHaveLength(0);
    expect(cell.timer).toBe(GRACE_SECONDS);
  });

  it('猶予は不足レベルによらず一定で、時間切れで崩落する', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    const cell = t.register(2, 8, 2, Material.WEAK); // 必要2 / 無支保 → 不足2
    expect(t.deficit(cell)).toBe(2);

    // 不足が 2 でも 1 でも、与えられる猶予は同じ長さ。
    let events = t.update(GRACE_SECONDS - 0.1);
    expect(events).toHaveLength(0);
    events = t.update(0.2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ x: 2, y: 8, z: 2, origin: Material.WEAK });
  });

  it('猶予中に支保を上げればタイマーは満タンに戻る(元に戻る)', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    const cell = t.register(2, 8, 2, Material.WEAK);
    t.update(8);
    expect(cell.timer).toBeLessThan(GRACE_SECONDS);

    t.setSupport(2, 8, 2, 'concrete'); // レベル2 = 必要量ちょうど
    expect(cell.timer).toBe(GRACE_SECONDS);
    expect(t.deficit(cell)).toBe(0);
    for (let i = 0; i < 100; i++) expect(t.update(0.5)).toHaveLength(0);
  });

  it('木枠(1)では軟弱層(2)に足りず、まだ崩れる', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    const cell = t.register(2, 8, 2, Material.WEAK);
    t.setSupport(2, 8, 2, 'timber');
    expect(t.deficit(cell)).toBe(1);
    expect(t.update(GRACE_SECONDS - 0.1)).toHaveLength(0);
    expect(t.update(0.2)).toHaveLength(1);
  });
});

describe('土被り', () => {
  it('空に開いているセル(切土)は支保が要らない', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 9, 2); // 最上層 = 空に開く
    const cell = t.register(2, 9, 2, Material.WEAK);
    expect(cell.buried).toBe(false);
    expect(t.deficit(cell)).toBe(0);
  });

  it('屋根を抜いたら支保不要に変わる', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    const cell = t.register(2, 8, 2, Material.WEAK);
    expect(cell.buried).toBe(true);
    w.excavate(2, 9, 2);
    t.refreshColumn(2, 2);
    expect(cell.buried).toBe(false);
    expect(t.deficit(cell)).toBe(0);
  });
});

describe('連鎖', () => {
  it('崩落は隣接する未対策セルのタイマーを削る', () => {
    const w = block(Material.WEAK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    w.excavate(3, 8, 2);
    t.register(2, 8, 2, Material.WEAK);
    const neighbour = t.register(3, 8, 2, Material.WEAK);
    const before = neighbour.timer;
    t.shockNeighbors(2, 8, 2);
    expect(neighbour.timer).toBeLessThan(before);
  });

  it('健全な隣接セルは衝撃を受けない', () => {
    const w = block(Material.ROCK);
    const t = new TunnelSystem(w);
    w.excavate(2, 8, 2);
    w.excavate(3, 8, 2);
    t.register(2, 8, 2, Material.ROCK);
    const neighbour = t.register(3, 8, 2, Material.ROCK);
    t.shockNeighbors(2, 8, 2);
    expect(neighbour.timer).toBe(GRACE_SECONDS);
  });
});

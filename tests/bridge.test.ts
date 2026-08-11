import { describe, expect, it } from 'vitest';
import { Material } from '../src/core/types.ts';
import { BRIDGES, LOAD_PER_UNIT } from '../src/core/config.ts';
import { VoxelWorld } from '../src/sim/VoxelWorld.ts';
import { BridgeSystem, autoPierCoords, canInstallPile, checkSpans, groundBearing } from '../src/sim/bridge.ts';
import type { BridgePlan } from '../src/sim/bridge.ts';

/**
 * x=0..31 の細長い試験地形。
 * 台地 (top y=9) の間に x=4..22 の谷 (top y=2) がある。
 */
function testWorld(valleyMaterial: Material = Material.ROCK): VoxelWorld {
  const w = new VoxelWorld(32, 20, 3, 0);
  for (let x = 0; x < 32; x++) {
    for (let z = 0; z < 3; z++) {
      const inValley = x >= 4 && x <= 22;
      const top = inValley ? 2 : 9;
      for (let y = 0; y <= top; y++) {
        w.initSet(x, y, z, inValley && y >= 1 ? valleyMaterial : Material.ROCK);
      }
      for (let y = top + 1; y < 20; y++) w.initSet(x, y, z, Material.AIR);
    }
  }
  return w;
}

const noSupports = (): number => 0;

function plan(type: BridgePlan['type'], pierCoords: number[] = []): BridgePlan {
  return { type, axis: 'x', y: 10, a: 3, b: 23, cross: 1, pierCoords, foundations: {} };
}

describe('支間は表で決め打ち', () => {
  it('支持点で区切った各区間のマス数を数える', () => {
    const c = checkSpans('truss', 0, 10, [5]);
    expect(c.supports).toEqual([0, 5, 10]);
    expect(c.spans).toEqual([4, 4]);
    expect(c.ok).toBe(true);
  });

  it('支間を超えたら ok=false になり、どの区間かも分かる', () => {
    const c = checkSpans('wood', 0, 10, []); // 木橋は3マスまで
    expect(c.spans).toEqual([9]);
    expect(c.violations).toEqual([0]);
    expect(c.ok).toBe(false);
  });

  it('橋脚を足せば同じ橋でも成立する', () => {
    expect(checkSpans('wood', 0, 10, []).ok).toBe(false); // 空間 9 マス
    expect(checkSpans('wood', 0, 10, [3, 6]).ok).toBe(true); // 空間 2,2,3 マス
  });

  it('自動配置は支間を満たす最小限の橋脚を置く', () => {
    for (const type of ['wood', 'concrete', 'steel', 'truss', 'suspension'] as const) {
      const coords = autoPierCoords(type, 3, 23);
      const c = checkSpans(type, 3, 23, coords);
      expect(c.ok, `${type}: ${JSON.stringify(c.spans)}`).toBe(true);
      // 1本減らすと成立しないこと = 最小限であること
      if (coords.length > 0) {
        expect(checkSpans(type, 3, 23, coords.slice(0, -1)).ok).toBe(false);
      }
    }
  });

  it('支間内なら橋脚は不要', () => {
    expect(autoPierCoords('suspension', 3, 22)).toEqual([]);
  });
});

describe('荷重と耐力', () => {
  it('橋脚は左右の空間の半分ずつを受け持つ', () => {
    const w = testWorld();
    const sys = new BridgeSystem(w, noSupports);
    const b = sys.commit(plan('truss', [13]));
    const loads = sys.pierLoads(b);
    const pier = loads.find((l) => !l.isAbutment);
    // 支持点は 3 / 13 / 23 → 左右の空間はどちらも 9 マス
    expect(pier?.carried).toBeCloseTo(1 + 9 / 2 + 9 / 2);
    expect(pier?.load).toBe(Math.ceil(10 / LOAD_PER_UNIT));
  });

  it('岩(耐力3)の上ならトラス橋の橋脚1本が成立する', () => {
    const w = testWorld(Material.ROCK);
    const sys = new BridgeSystem(w, noSupports);
    const status = sys.validatePlan(plan('truss', autoPierCoords('truss', 3, 23)));
    expect(status.ok).toBe(true);
  });

  it('軟弱層(耐力0)の上では橋脚が成立せず、確定を拒否する', () => {
    const w = testWorld(Material.WEAK);
    const sys = new BridgeSystem(w, noSupports);
    const status = sys.validatePlan(plan('truss', autoPierCoords('truss', 3, 23)));
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('耐力');
  });

  it('岩着杭(+3)を打てば軟弱層でも成立する', () => {
    const w = testWorld(Material.WEAK);
    const sys = new BridgeSystem(w, noSupports);
    const b = sys.commit(plan('truss', autoPierCoords('truss', 3, 23)));
    const pier = b.piers.find((p) => !p.isAbutment);
    expect(pier).toBeDefined();
    expect(sys.pierLoads(b).find((l) => !l.isAbutment)?.ok).toBe(false);
    pier!.foundation = 'pile';
    expect(sys.pierLoads(b).find((l) => !l.isAbutment)?.ok).toBe(true);
  });

  it('吊橋は支間20なので橋脚なしで谷を一気に渡せる', () => {
    const w = testWorld(Material.WEAK);
    const sys = new BridgeSystem(w, noSupports);
    const p: BridgePlan = { type: 'suspension', axis: 'x', y: 10, a: 3, b: 23, cross: 1, pierCoords: [], foundations: {} };
    const status = sys.validatePlan(p);
    expect(status.span.spans).toEqual([19]);
    expect(status.ok).toBe(true);
    // 同じ場所に木橋は架けられない
    expect(sys.validatePlan({ ...p, type: 'wood' }).ok).toBe(false);
  });

  it('支間の長い橋ほど高い', () => {
    const w = testWorld();
    const sys = new BridgeSystem(w, noSupports);
    const costs = (['wood', 'concrete', 'steel', 'truss', 'suspension'] as const).map((t) =>
      sys.planCost(plan(t, autoPierCoords(t, 3, 23))),
    );
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
    }
    expect(BRIDGES.suspension.maxSpan).toBeGreaterThan(BRIDGES.wood.maxSpan);
  });
});

describe('直下の空洞', () => {
  it('橋脚の真下に無支保の空洞があると耐力が0になる', () => {
    const w = testWorld(Material.ROCK);
    const before = groundBearing(w, 15, 2, 1, 'none', noSupports);
    expect(before.bearing).toBe(3);
    expect(before.undermined).toBe(false);

    w.excavate(15, 1, 1); // 橋脚のすぐ下を掘る
    const after = groundBearing(w, 15, 2, 1, 'none', noSupports);
    expect(after.bearing).toBe(0);
    expect(after.undermined).toBe(true);
  });

  it('覆工(レベル2以上)されたトンネルの上なら耐力の低下は1で済む', () => {
    const w = testWorld(Material.ROCK);
    w.excavate(15, 1, 1);
    const lined = groundBearing(w, 15, 2, 1, 'none', () => 2);
    expect(lined.bearing).toBe(2);
    expect(lined.undermined).toBe(true);
  });
});

describe('岩着杭の設置条件', () => {
  it('直下に岩があれば打てる', () => {
    const w = testWorld(Material.WEAK);
    expect(canInstallPile(w, 15, 2, 1)).toBe(true); // y=0 が岩
  });

  it('届く範囲に岩がなければ打てない', () => {
    const w = new VoxelWorld(8, 20, 3, 0);
    for (let x = 0; x < 8; x++) for (let z = 0; z < 3; z++) for (let y = 0; y <= 15; y++) w.initSet(x, y, z, Material.WEAK);
    expect(canInstallPile(w, 4, 15, 1)).toBe(false);
  });
});

describe('橋台', () => {
  it('地盤が抜けたら橋台が持たなくなる', () => {
    const w = testWorld();
    const sys = new BridgeSystem(w, noSupports);
    const b = sys.commit(plan('truss', autoPierCoords('truss', 3, 23)));
    expect(sys.pierLoads(b).find((l) => l.isAbutment && l.coord === 3)?.ok).toBe(true);
    w.excavate(3, 9, 1); // 橋台直下の地盤を掘る
    expect(sys.pierLoads(b).find((l) => l.isAbutment && l.coord === 3)?.ok).toBe(false);
  });
});

describe('基礎の自動提案', () => {
  it('岩の上なら直接基礎で足りる', () => {
    const w = testWorld(Material.ROCK);
    const sys = new BridgeSystem(w, noSupports);
    const p = plan('truss', autoPierCoords('truss', 3, 23));
    expect(sys.autoFoundations(p)).toEqual({ 13: 'none' });
  });

  it('軟弱層の上なら岩着杭まで上げる', () => {
    const w = testWorld(Material.WEAK);
    const sys = new BridgeSystem(w, noSupports);
    const p = plan('truss', autoPierCoords('truss', 3, 23));
    p.foundations = sys.autoFoundations(p);
    expect(p.foundations).toEqual({ 13: 'pile' });
    expect(sys.validatePlan(p).ok).toBe(true);
  });

  it('橋脚を増やして荷重を下げれば安い基礎で済む', () => {
    const w = testWorld(Material.WEAK);
    const sys = new BridgeSystem(w, noSupports);
    const p = plan('wood', autoPierCoords('wood', 3, 23));
    p.foundations = sys.autoFoundations(p);
    // 木橋は橋脚が多いぶん1本あたりの荷重が小さい → 大型基礎で足りる
    expect(Object.values(p.foundations).every((f) => f === 'wide')).toBe(true);
    expect(sys.validatePlan(p).ok).toBe(true);
  });
});

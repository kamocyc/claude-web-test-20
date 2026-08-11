import { describe, expect, it } from 'vitest';
import { Game } from '../src/sim/Game.ts';
import { Material } from '../src/core/types.ts';
import { GRACE_SECONDS, MAX_ROUTE_LENGTH, SURVEY_COST } from '../src/core/config.ts';
import { flushJobs, giveMoney, run } from './helpers.ts';

const Z = 16;
/** 谷の両岸。ここに橋を架ける。 */
const VALLEY_A = 12;
const VALLEY_B = 29;
const DECK_Y = 19;

function gameWithMoney(): Game {
  const g = new Game();
  giveMoney(g);
  return g;
}

function buildTruss(g: Game): void {
  g.startPlan('truss', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
  g.autoFillFoundations();
  expect(g.planStatus()?.ok).toBe(true);
  expect(g.commitPlan().ok).toBe(true);
  flushJobs(g);
  expect(g.bridges.bridges).toHaveLength(1);
}

describe('建てる前に分かる (支間)', () => {
  it('谷を木橋1本で渡そうとすると、橋脚が自動で入る', () => {
    const g = gameWithMoney();
    g.startPlan('wood', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    expect(g.plan!.pierCoords.length).toBeGreaterThan(0);
    expect(g.planStatus()?.span.ok).toBe(true);
  });

  it('橋脚を全部外すと支間超過になり、確定が拒否される', () => {
    const g = gameWithMoney();
    g.startPlan('wood', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    for (const c of [...g.plan!.pierCoords]) g.togglePier(c);
    const status = g.planStatus()!;
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('支間超過');

    const before = g.economy.budget;
    const res = g.commitPlan();
    expect(res.ok).toBe(false);
    expect(g.economy.budget).toBe(before); // 支払いも発生しない
    expect(g.bridges.bridges).toHaveLength(0);
  });

  it('吊橋なら同じ谷を橋脚なしで渡せる (ただし高い)', () => {
    const g = gameWithMoney();
    g.startPlan('truss', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    g.autoFillFoundations();
    const trussCost = g.planStatus()!.cost;
    g.startPlan('suspension', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    const status = g.planStatus()!;
    expect(g.plan!.pierCoords).toHaveLength(0);
    expect(status.ok).toBe(true);
    expect(status.cost).toBeGreaterThan(trussCost);
  });

  it('基礎は勝手に決まらない。谷底の橋脚はまず直接基礎で、耐力不足として赤くなる', () => {
    const g = gameWithMoney();
    g.startPlan('truss', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    const coord = g.plan!.pierCoords[0]!;
    expect(g.plan!.foundations[coord] ?? 'none').toBe('none');

    const status = g.planStatus()!;
    expect(status.span.ok).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('耐力 0');
  });

  it('基礎を補うのは明示的な操作で、値段がはっきり増える', () => {
    const g = gameWithMoney();
    g.startPlan('truss', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    const coord = g.plan!.pierCoords[0]!;
    const before = g.planStatus()!.cost;
    const delta = g.foundationFixCost();
    expect(delta).toBeGreaterThan(0);

    expect(g.autoFillFoundations().ok).toBe(true);
    expect(g.plan!.foundations[coord]).toBe('pile'); // 軟弱層なので杭まで上げる必要がある
    expect(g.planStatus()!.ok).toBe(true);
    expect(g.planStatus()!.cost).toBe(before + delta!);
    expect(g.foundationFixCost()).toBeNull(); // もう補うところがない
  });

  it('橋脚を立てない吊橋なら、軟弱な谷底に一切触らずに済む', () => {
    const g = gameWithMoney();
    g.startPlan('suspension', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    expect(g.plan!.pierCoords).toHaveLength(0);
    expect(g.planStatus()!.ok).toBe(true); // 基礎を触らなくても成立する
  });

  it('基礎を落とすと耐力が足りなくなり、支間とは別の理由で拒否される', () => {
    const g = gameWithMoney();
    g.startPlan('truss', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    const coord = g.plan!.pierCoords[0]!;
    g.autoFillFoundations();
    expect(g.planStatus()!.ok).toBe(true);

    // 岩着杭(+3) → 直接基礎(+0)。軟弱層なので耐力は 0 になる。
    while (g.plan!.foundations[coord] !== 'none') g.cyclePlanFoundation(coord);
    const status = g.planStatus()!;
    expect(status.span.ok).toBe(true); // 支間は満たしている
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('荷重');
    expect(status.reason).toContain('耐力');
    const pier = status.loads.find((l) => !l.isAbutment)!;
    expect(pier.bearing).toBe(0);
    expect(pier.load).toBeGreaterThan(0);

    // 確定は拒否され、支払いも起きない
    const before = g.economy.budget;
    expect(g.commitPlan().ok).toBe(false);
    expect(g.economy.budget).toBe(before);
    flushJobs(g);
    expect(g.bridges.bridges).toHaveLength(0);

    // 大型基礎(+1)でもまだ足りない
    g.cyclePlanFoundation(coord);
    expect(g.plan!.foundations[coord]).toBe('wide');
    expect(g.planStatus()!.ok).toBe(false);

    // 岩着杭に戻せば建てられる
    g.cyclePlanFoundation(coord);
    expect(g.plan!.foundations[coord]).toBe('pile');
    expect(g.planStatus()!.ok).toBe(true);
  });

  it('橋脚を増やして荷重を分ければ、安い基礎でも成立する', () => {
    const g = gameWithMoney();
    g.startPlan('wood', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    g.autoFillFoundations();
    // 木橋は橋脚が多いので1本あたりの荷重が小さい
    const loads = g.planStatus()!.loads.filter((l) => !l.isAbutment);
    expect(loads.every((l) => l.load === 1)).toBe(true);
    // それでも軟弱層(耐力0)の上では直接基礎は成り立たない
    for (const c of g.plan!.pierCoords) {
      while (g.plan!.foundations[c] !== 'none') g.cyclePlanFoundation(c);
    }
    const bad = g.planStatus()!;
    expect(bad.ok).toBe(false);
    expect(bad.loads.some((l) => !l.isAbutment && l.ground === Material.WEAK && !l.ok)).toBe(true);
    // 岩の上の橋脚は直接基礎のままで足りている
    expect(bad.loads.some((l) => !l.isAbutment && l.ground === Material.ROCK && l.ok)).toBe(true);
  });
});

describe('崩壊は「後から地面が変わったとき」だけ', () => {
  it('建てただけでは何も起きない', () => {
    const g = gameWithMoney();
    buildTruss(g);
    run(g, GRACE_SECONDS * 2);
    expect(g.board.count).toBe(0);
    expect(g.bridges.bridges).toHaveLength(1);
  });

  it('橋脚の下を掘ると沈下ハザードが出て、猶予内に埋め戻せば元に戻る', () => {
    const g = gameWithMoney();
    buildTruss(g);
    const bridge = g.bridges.bridges[0]!;
    const pier = bridge.piers.find((p) => !p.isAbutment)!;
    const holeY = pier.baseY - 2;

    // 地形のほうが変わる
    g.world.excavate(pier.coord, holeY, Z);
    run(g, 1);
    expect(g.board.count).toBe(1);
    const hazard = g.board.list[0]!;
    expect(hazard.kind).toBe('settlement');
    expect(hazard.reason).toContain('空洞');
    expect(pier.sink).toBeGreaterThan(0); // 目に見えて沈み始める

    // 猶予のうちに埋め戻す
    run(g, GRACE_SECONDS * 0.4);
    expect(g.bridges.bridges).toHaveLength(1);
    g.world.fill(pier.coord, holeY, Z);
    run(g, GRACE_SECONDS);
    expect(g.board.count).toBe(0);
    expect(pier.alive).toBe(true);
    expect(pier.sink).toBeCloseTo(0, 3);
  });

  it('猶予を過ぎると橋脚が落ち、受け持っていた桁も落ちる', () => {
    const g = gameWithMoney();
    buildTruss(g);
    const bridge = g.bridges.bridges[0]!;
    const pier = bridge.piers.find((p) => !p.isAbutment)!;
    g.world.excavate(pier.coord, pier.baseY - 2, Z);

    run(g, GRACE_SECONDS + 2);
    expect(pier.alive).toBe(false);
    expect(bridge.deckAlive.some((d) => !d)).toBe(true);
    expect(g.drainEvents().some((e) => e.type === 'pierFail')).toBe(true);
  });

  it('覆工したトンネルの上なら、橋脚の耐力の低下は1で済む', () => {
    const g = gameWithMoney();
    buildTruss(g);
    const bridge = g.bridges.bridges[0]!;
    const pier = bridge.piers.find((p) => !p.isAbutment)!;
    const y = pier.baseY - 2;
    const bearing = (): number => g.bridges.pierLoads(bridge).find((l) => !l.isAbutment)!.bearing;

    expect(bearing()).toBe(3); // 岩着杭
    g.dig(pier.coord, y, Z);
    flushJobs(g);
    expect(bearing()).toBe(0); // 無支保の空洞 → 緩む

    g.setSupport(pier.coord, y, Z, 'steel');
    flushJobs(g);
    expect(bearing()).toBe(2); // 覆工されていれば -1 で済む
  });

  it('荷重が小さい橋なら、覆工しておけばトンネルを下に通しても持つ', () => {
    const g = gameWithMoney();
    g.startPlan('wood', { x: VALLEY_A, y: DECK_Y, z: Z }, { x: VALLEY_B, y: DECK_Y, z: Z });
    g.autoFillFoundations();
    g.commitPlan();
    flushJobs(g);
    const bridge = g.bridges.bridges[0]!;
    const pier = bridge.piers.find((p) => !p.isAbutment && p.baseY < 8)!;
    g.setFoundation(pier.coord, DECK_Y - 2, Z, 'pile');
    flushJobs(g);

    const y = pier.baseY - 2;
    g.dig(pier.coord, y, Z);
    flushJobs(g);
    g.setSupport(pier.coord, y, Z, 'steel');
    flushJobs(g);
    run(g, 3);

    const load = g.bridges.pierLoads(bridge).find((l) => l.coord === pier.coord)!;
    expect(load.undermined).toBe(true);
    expect(load.load).toBeLessThanOrEqual(load.bearing);
    expect(g.board.count).toBe(0);
  });
});

describe('トンネル', () => {
  /** 尾根の破砕帯。無支保で掘ると崩れる。 */
  const WEAK_CELL = { x: 36, y: 19, z: Z };

  it('掘った場所の地質で必要支保レベルが決まる', () => {
    const g = gameWithMoney();
    expect(g.world.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBe(Material.WEAK);
    g.dig(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z);
    flushJobs(g);
    const cell = g.tunnels.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)!;
    expect(cell.required).toBe(2);
    expect(cell.buried).toBe(true);
  });

  it('無支保のまま放置すると崩落し、元の地質で埋め戻る', () => {
    const g = gameWithMoney();
    g.dig(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z);
    flushJobs(g);
    expect(g.world.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBe(Material.AIR);

    run(g, 2);
    expect(g.board.count).toBe(1);
    expect(g.board.list[0]!.kind).toBe('tunnel');

    run(g, GRACE_SECONDS);
    expect(g.world.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBe(Material.WEAK);
    expect(g.tunnels.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBeUndefined();
    expect(g.board.count).toBe(0);
  });

  it('猶予中にコンクリート覆工を入れれば崩れない', () => {
    const g = gameWithMoney();
    g.dig(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z);
    flushJobs(g);
    run(g, 5);
    expect(g.board.count).toBe(1);

    g.setSupport(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z, 'concrete');
    flushJobs(g);
    run(g, GRACE_SECONDS * 2);
    expect(g.world.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBe(Material.AIR);
    expect(g.board.count).toBe(0);
  });

  it('木枠では軟弱層に足りず、結局崩れる', () => {
    const g = gameWithMoney();
    g.dig(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z);
    flushJobs(g);
    g.setSupport(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z, 'timber');
    flushJobs(g);
    run(g, GRACE_SECONDS + 2);
    expect(g.world.get(WEAK_CELL.x, WEAK_CELL.y, WEAK_CELL.z)).toBe(Material.WEAK);
  });

  it('岩なら無支保で掘れる', () => {
    const g = gameWithMoney();
    const rock = { x: 44, y: 19, z: Z };
    expect(g.world.get(rock.x, rock.y, rock.z)).toBe(Material.ROCK);
    g.dig(rock.x, rock.y, rock.z);
    flushJobs(g);
    expect(g.tunnels.get(rock.x, rock.y, rock.z)!.required).toBe(0);
    run(g, GRACE_SECONDS * 2);
    expect(g.world.get(rock.x, rock.y, rock.z)).toBe(Material.AIR);
  });

  it('地下水位より下は必要支保レベルが1つ上がる', () => {
    const g = gameWithMoney();
    const deep = { x: 44, y: 8, z: Z }; // 水位 y=10 より下
    expect(g.world.isBelowWaterTable(deep.y)).toBe(true);
    const before = g.world.get(deep.x, deep.y, deep.z);
    g.dig(deep.x, deep.y, deep.z);
    flushJobs(g);
    const cell = g.tunnels.get(deep.x, deep.y, deep.z)!;
    expect(cell.required).toBe((before === Material.ROCK ? 0 : before === Material.DIRT ? 1 : 2) + 1);
  });

  it('切土(空に開いた掘削)には支保が要らない', () => {
    const g = gameWithMoney();
    const top = g.world.surfaceY(36, Z);
    g.dig(36, top, Z);
    flushJobs(g);
    const cell = g.tunnels.get(36, top, Z)!;
    expect(cell.buried).toBe(false);
    run(g, GRACE_SECONDS * 2);
    expect(g.world.get(36, top, Z)).toBe(Material.AIR);
  });
});

describe('調査と予算', () => {
  it('ボーリングを打つとその列だけ地質が見えるようになる', () => {
    const g = new Game();
    expect(g.visibleMaterial(36, 19, Z)).toBeNull();
    expect(g.doSurvey(36, Z).ok).toBe(true);
    flushJobs(g);
    expect(g.visibleMaterial(36, 19, Z)).toBe(Material.WEAK);
    expect(g.visibleMaterial(37, 19, Z)).toBeNull(); // 隣の列は見えないまま
  });

  it('調査には金がかかる', () => {
    const g = new Game();
    const before = g.economy.budget;
    g.doSurvey(36, Z);
    expect(g.economy.budget).toBe(before - SURVEY_COST);
  });

  it('予算が尽きたら行動が拒否される', () => {
    const g = new Game();
    g.economy.budget = 5;
    expect(g.doSurvey(36, Z).reason).toBe('予算不足');
    expect(g.dig(36, 19, Z).reason).toBe('予算不足');
  });
});

describe('工期', () => {
  it('岩の掘削は土より時間がかかる', () => {
    const g = gameWithMoney();
    g.dig(44, 19, Z); // 岩
    const rockTime = flushJobs(g);
    g.dig(4, 18, Z); // 土
    const dirtTime = flushJobs(g);
    expect(rockTime).toBeGreaterThan(dirtTime);
  });

  it('作業は順番に1つずつ処理される', () => {
    const g = gameWithMoney();
    g.dig(44, 19, Z);
    g.dig(44, 18, Z);
    expect(g.jobs).toHaveLength(2);
    expect(g.currentJob?.label).toContain('19');
  });
});

describe('尾根の越え方 (トレードオフ)', () => {
  it('橋を架けただけでは、尾根を回り込む経路が長すぎて開通しない', () => {
    const g = gameWithMoney();
    buildTruss(g);
    const r = g.route();
    expect(r.reachable).toBe(true); // 歩いて行くことはできる
    expect(r.connected).toBe(false); // が、道路として長すぎる
    expect(r.length).toBeGreaterThan(MAX_ROUTE_LENGTH);
  });

  it('尾根を貫けば経路が一気に短くなり、開通する', () => {
    const g = gameWithMoney();
    buildTruss(g);
    for (let x = 30; x <= 49; x++) g.dig(x, 20, Z);
    flushJobs(g, 400);
    for (const c of [...g.tunnels.cells.values()]) {
      const id = c.required >= 3 ? 'steel' : c.required === 2 ? 'concrete' : c.required === 1 ? 'timber' : null;
      if (id) g.setSupport(c.x, c.y, c.z, id);
    }
    flushJobs(g, 400);
    const r = g.route();
    expect(r.connected).toBe(true);
    expect(r.length).toBeLessThan(MAX_ROUTE_LENGTH);
  });

  it('破砕帯を避けて横にずらして掘ると、支保が要らなくなる代わりに経路が伸びる', () => {
    const dig = (z: number): { weak: number; length: number } => {
      const g = gameWithMoney();
      buildTruss(g);
      for (let x = 30; x <= 49; x++) g.dig(x, 20, z);
      flushJobs(g, 400);
      let weak = 0;
      for (const c of [...g.tunnels.cells.values()]) {
        const id = c.required >= 3 ? 'steel' : c.required === 2 ? 'concrete' : c.required === 1 ? 'timber' : null;
        if (c.required >= 2) weak++;
        if (id) g.setSupport(c.x, c.y, c.z, id);
      }
      flushJobs(g, 400);
      return { weak, length: g.route().length };
    };
    const direct = dig(Z);
    const detour = dig(10);
    expect(direct.weak).toBeGreaterThan(0); // 破砕帯を突っ切る
    expect(detour.weak).toBe(0); // 岩盤を狙う
    expect(detour.length).toBeGreaterThan(direct.length); // その代わり遠回り
    expect(detour.length).toBeLessThanOrEqual(MAX_ROUTE_LENGTH);
  });
});

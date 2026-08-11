/**
 * バランスの計測。推測でチューニングしないための道具。
 *
 *   npx tsx scripts/probe.mts
 *
 * 地形の断面、勾配条件下での到達点、代表的な解き方の経路長と費用を出す。
 * README の実測表はここの出力から書いている。
 */
import { Game } from '../src/sim/Game.ts';
import { CELL_SIZE_M, GRADE_RUN, MAX_ROUTE_LENGTH, WORLD } from '../src/core/config.ts';
import { Material } from '../src/core/types.ts';
import type { BridgeTypeId, Cell } from '../src/core/types.ts';

function flush(g: Game, max = 4000): void {
  let t = 0;
  while (g.jobs.length > 0 && t < max) {
    g.tick(0.25);
    t += 0.25;
  }
}

function heading(s: string): void {
  console.log(`\n=== ${s} ${'='.repeat(Math.max(0, 60 - s.length))}`);
}

const base = new Game();

heading('地形の断面 (z=16)');
{
  const row: string[] = [];
  for (let x = 0; x < WORLD.SX; x += 2) row.push(`${x}:${base.world.surfaceY(x, 16)}`);
  console.log(row.join(' '));
}

heading('地表の地質 (z=16)');
{
  const names: Record<number, string> = { 0: '.', 1: '土', 2: '岩', 3: '軟' };
  let s = '';
  for (let x = 0; x < WORLD.SX; x++) s += names[base.world.getOrig(x, base.world.surfaceY(x, 16), 16)] ?? '?';
  console.log(s);
}

heading(`勾配条件 (1マス上下に${GRADE_RUN}マス走る = ${((CELL_SIZE_M.V / (CELL_SIZE_M.H * GRADE_RUN)) * 100).toFixed(1)}%) での素の到達`);
{
  const r = base.route();
  console.log(`reachable=${r.reachable} connected=${r.connected} length=${r.length} visited=${r.visited}`);
  const tip = r.best.at(-1);
  console.log(`一番 GOAL に近づけた地点: ${tip ? `(${tip.x},${tip.y},${tip.z})` : 'なし'} / GOAL=(${base.goal.x},${base.goal.y},${base.goal.z})`);
  console.log(`START=(${base.start.x},${base.start.y},${base.start.z})`);
}

heading('勾配なし (旧ルール) との比較');
{
  const g = new Game();
  const r = (g as unknown as { route(): ReturnType<Game['route']> }).route();
  console.log(`勾配あり: ${r.reachable ? `到達 ${r.length}マス` : '到達できない'}`);
}

/** 台地レベルで一直線に道路を通す想定の解き方を組み立てる。 */
function solve(roadY: number, bridgeType: BridgeTypeId, tunnelZ: number): void {
  const g = new Game();
  g.economy.budget = 1e9;
  const before = g.economy.budget;

  // 1) START から谷の手前まで整地
  g.planGrade({ x: g.start.x, y: g.start.y, z: 16 }, { x: 12, y: roadY, z: 16 });
  flush(g);

  // 2) 谷を橋で渡す
  const plan = g.startPlan(bridgeType, { x: 12, y: roadY, z: 16 }, { x: 29, y: roadY, z: 16 });
  if (!plan.ok) {
    console.log(`  橋のプランが作れない: ${plan.reason}`);
    return;
  }
  g.autoFillFoundations();
  const st = g.planStatus();
  if (!st?.ok) {
    console.log(`  橋が成立しない: ${st?.reason}`);
    return;
  }
  g.commitPlan();
  flush(g);

  // 3) 尾根をトンネルで抜ける
  for (let x = 29; x <= 52; x++) {
    if (x >= 30 && x <= 51) g.dig(x, roadY, tunnelZ);
  }
  flush(g);

  // 4) 支保を必要なだけ入れる
  let supported = 0;
  for (const c of [...g.tunnels.cells.values()]) {
    const id = c.required >= 3 ? 'steel' : c.required === 2 ? 'concrete' : c.required === 1 ? 'timber' : null;
    if (!id || !c.buried) continue;
    if (g.setSupport(c.x, c.y, c.z, id).ok) supported++;
  }
  flush(g);

  // 5) 残りを整地
  g.planGrade({ x: 52, y: roadY, z: 16 }, { x: g.goal.x, y: g.goal.y, z: 16 });
  flush(g);

  const r = g.route();
  const spent = before - g.economy.budget;
  console.log(
    `  y=${roadY} ${bridgeType} tunnelZ=${tunnelZ}: ${r.reachable ? `経路 ${r.length}マス (上限 ${MAX_ROUTE_LENGTH})` : '不通'}` +
      ` / 総額 ¥${Math.round(spent).toLocaleString()} / 支保を入れたセル ${supported}` +
      ` / 最急勾配 ${(g.routeGrade() * 100).toFixed(1)}%`,
  );
}

heading('台地レベルで通す (橋 + トンネル)');
for (const y of [18, 19, 20]) {
  for (const type of ['truss', 'suspension'] as BridgeTypeId[]) {
    solve(y, type, 16);
  }
}

heading('破砕帯を避けて横にずらしたトンネル');
solve(19, 'truss', 10);

heading('軟弱層の分布 (WEAK の割合)');
{
  let weak = 0;
  let solid = 0;
  for (let x = 0; x < WORLD.SX; x++) {
    for (let y = 0; y < WORLD.SY; y++) {
      for (let z = 0; z < WORLD.SZ; z++) {
        const m = base.world.getOrig(x, y, z);
        if (m === Material.AIR) continue;
        solid++;
        if (m === Material.WEAK) weak++;
      }
    }
  }
  console.log(`${((weak / solid) * 100).toFixed(1)}%`);
}

heading('台地の起伏 (整地がどれだけ要るか)');
{
  for (const z of [16]) {
    const diffs: number[] = [];
    for (let x = 1; x < 12; x++) {
      diffs.push(Math.abs(base.world.surfaceY(x, z) - (base.world.surfaceY(x - 1, z) as number)));
    }
    console.log(`START 側 x=0..12 の段差: ${diffs.join(',')}`);
  }
  const path: Cell[] = [];
  for (let x = 52; x < 64; x++) path.push({ x, y: base.world.surfaceY(x, 16) + 1, z: 16 });
  console.log(`GOAL 側 x=52..63 の地表: ${path.map((c) => c.y).join(',')}`);
}

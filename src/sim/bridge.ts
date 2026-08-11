import { Material } from '../core/types.ts';
import type { Axis, Bridge, BridgeTypeId, Cell, FoundationId, Pier, PierLoad, SpanCheck } from '../core/types.ts';
import {
  BEARING,
  BRIDGES,
  FOUNDATION_BONUS,
  FOUNDATION_COST,
  GRACE_SECONDS,
  LINED_VOID_PENALTY,
  LOAD_PER_UNIT,
  MAX_SINK,
  PIER_COST_PER_CELL,
  PILE_REACH,
  VOID_CHECK_DEPTH,
} from '../core/config.ts';
import type { VoxelWorld } from './VoxelWorld.ts';

/** 建設前のプラン。確定するまで世界には何も置かれない。 */
export interface BridgePlan {
  type: BridgeTypeId;
  axis: Axis;
  y: number;
  a: number;
  b: number;
  cross: number;
  /** 橋台を除く、中間の橋脚の座標 */
  pierCoords: number[];
  /** 橋脚ごとの基礎。建設前に選べる (建ててから沈むのを避けるため) */
  foundations: Record<number, FoundationId>;
}

export interface BridgeFailure {
  bridgeId: number;
  coord: number;
  cell: Cell;
  isAbutment: boolean;
}

export function bridgeCell(b: { axis: Axis; cross: number }, coord: number, y: number): Cell {
  return b.axis === 'x' ? { x: coord, y, z: b.cross } : { x: b.cross, y, z: coord };
}

/**
 * 支間は表で決め打ち。支持点で区切られた各区間の「柱なしで渡すマス数」が
 * maxSpan を超えていたら、そもそも建設できない(赤く表示して確定を拒否)。
 */
export function checkSpans(type: BridgeTypeId, a: number, b: number, pierCoords: number[]): SpanCheck {
  const maxSpan = BRIDGES[type].maxSpan;
  const supports = [a, ...pierCoords.filter((c) => c > a && c < b), b].sort((p, q) => p - q);
  const spans: number[] = [];
  const violations: number[] = [];
  for (let i = 0; i + 1 < supports.length; i++) {
    const gap = (supports[i + 1] as number) - (supports[i] as number) - 1;
    spans.push(gap);
    if (gap > maxSpan) violations.push(i);
  }
  return { supports, spans, violations, ok: violations.length === 0 };
}

/** 支間を満たす最小限の橋脚を等間隔に自動配置する(プレイヤーは後から足し引きできる)。 */
export function autoPierCoords(type: BridgeTypeId, a: number, b: number): number[] {
  const maxSpan = BRIDGES[type].maxSpan;
  const inner = b - a - 1;
  if (inner <= maxSpan) return [];
  // n 本の橋脚で区間は n+1 個。inner - n マスを n+1 等分して maxSpan 以下にする。
  let n = 1;
  while (Math.ceil((inner - n) / (n + 1)) > maxSpan && n < inner) n++;
  const coords: number[] = [];
  for (let i = 1; i <= n; i++) {
    coords.push(a + Math.round(((b - a) * i) / (n + 1)));
  }
  return [...new Set(coords)].filter((c) => c > a && c < b);
}

/** その位置に橋脚を建てたときの耐力。直下の空洞は「地盤が緩んでいる」とみなす。 */
export function groundBearing(
  world: VoxelWorld,
  x: number,
  baseY: number,
  z: number,
  foundation: FoundationId,
  supportLevelAt: (x: number, y: number, z: number) => number,
): { bearing: number; ground: Material; undermined: boolean } {
  if (baseY < 0) return { bearing: 0, ground: Material.AIR, undermined: true };
  const ground = world.get(x, baseY, z);
  let bearing = (BEARING[ground] ?? 0) + FOUNDATION_BONUS[foundation];

  let undermined = false;
  for (let d = 1; d <= VOID_CHECK_DEPTH; d++) {
    const yy = baseY - d;
    if (yy < 0) break;
    if (!world.isSolid(x, yy, z)) {
      undermined = true;
      // 覆工されたトンネルの上なら、緩みはこの程度で済む。
      bearing = supportLevelAt(x, yy, z) >= 2 ? bearing - LINED_VOID_PENALTY : 0;
      break;
    }
  }
  return { bearing: Math.max(0, bearing), ground, undermined };
}

/** 岩着杭は、直下 PILE_REACH 以内に岩がある場所にしか打てない。 */
export function canInstallPile(world: VoxelWorld, x: number, baseY: number, z: number): boolean {
  for (let d = 0; d <= PILE_REACH; d++) {
    const yy = baseY - d;
    if (yy < 0) return false;
    if (world.get(x, yy, z) === Material.ROCK) return true;
  }
  return false;
}

export class BridgeSystem {
  readonly bridges: Bridge[] = [];
  private nextId = 1;

  constructor(
    private world: VoxelWorld,
    private supportLevelAt: (x: number, y: number, z: number) => number,
  ) {}

  /** 橋脚が地面に届くまでの高さを求め直す。地形が変わると毎 tick ここが動く。 */
  refreshBaseY(bridge: Bridge): void {
    for (const p of bridge.piers) {
      const c = bridgeCell(bridge, p.coord, bridge.y);
      p.baseY = this.world.solidBelow(c.x, bridge.y, c.z);
    }
  }

  /**
   * 各支持点の荷重と耐力。
   * 受け持ちマス数 = 自セル + 左右の空間の半分ずつ。
   * 荷重 = ceil(受け持ちマス数 / LOAD_PER_UNIT)。荷重 > 耐力 なら沈む。
   */
  pierLoads(bridge: Bridge): PierLoad[] {
    const alive = bridge.piers.filter((p) => p.alive).sort((p, q) => p.coord - q.coord);
    const out: PierLoad[] = [];
    for (let i = 0; i < alive.length; i++) {
      const p = alive[i] as Pier;
      const prev = alive[i - 1];
      const next = alive[i + 1];
      const gl = prev ? p.coord - prev.coord - 1 : 0;
      const gr = next ? next.coord - p.coord - 1 : 0;
      const carried = 1 + gl / 2 + gr / 2;
      const load = Math.ceil(carried / LOAD_PER_UNIT);
      const c = bridgeCell(bridge, p.coord, bridge.y);

      if (p.isAbutment) {
        // 橋台は自然地盤に載っている限り耐力を問わない。地面が抜けたら別。
        const supported = this.world.isSolid(c.x, bridge.y - 1, c.z);
        out.push({
          coord: p.coord,
          isAbutment: true,
          carried,
          load,
          bearing: supported ? 99 : 0,
          ground: this.world.get(c.x, bridge.y - 1, c.z),
          undermined: !supported,
          ok: supported,
        });
        continue;
      }

      const g = groundBearing(this.world, c.x, p.baseY, c.z, p.foundation, this.supportLevelAt);
      out.push({
        coord: p.coord,
        isAbutment: false,
        carried,
        load,
        bearing: g.bearing,
        ground: g.ground,
        undermined: g.undermined,
        ok: load <= g.bearing,
      });
    }
    return out;
  }

  /**
   * 各橋脚に、荷重を支えられる最も安い基礎を割り当てる。
   * プレイヤーは提示された案を見てから、コストと安全のどちらを取るか決められる。
   */
  autoFoundations(plan: BridgePlan): Record<number, FoundationId> {
    const out: Record<number, FoundationId> = {};
    const order: FoundationId[] = ['none', 'wide', 'pile'];
    for (const f of order) {
      const trial: BridgePlan = { ...plan, foundations: { ...out } };
      for (const c of plan.pierCoords) if (!(c in out)) trial.foundations[c] = f;
      const ghost = this.makeBridge(trial, -1);
      this.refreshBaseY(ghost);
      const loads = this.pierLoads(ghost);
      for (const l of loads) {
        if (l.isAbutment || l.coord in out) continue;
        const cell = bridgeCell(plan, l.coord, plan.y);
        const pier = ghost.piers.find((p) => p.coord === l.coord);
        if (f === 'pile' && pier && !canInstallPile(this.world, cell.x, pier.baseY, cell.z)) continue;
        if (l.ok) out[l.coord] = f;
      }
    }
    for (const c of plan.pierCoords) if (!(c in out)) out[c] = 'pile';
    return out;
  }

  /** プランを検証する。false のあいだはゴーストが赤く、確定を拒否する。 */
  validatePlan(plan: BridgePlan): { span: SpanCheck; loads: PierLoad[]; cost: number; ok: boolean; reason: string } {
    const span = checkSpans(plan.type, plan.a, plan.b, plan.pierCoords);
    const ghost = this.makeBridge(plan, -1);
    this.refreshBaseY(ghost);
    const loads = this.pierLoads(ghost);
    const cost = this.planCost(plan, ghost);

    let reason = '';
    let ok = span.ok;
    if (!span.ok) {
      const worst = Math.max(...span.spans);
      reason = `支間超過: ${worst} マス > ${BRIDGES[plan.type].maxSpan} マス (${BRIDGES[plan.type].name})`;
    } else {
      const bad = loads.find((l) => !l.ok);
      if (bad) {
        ok = false;
        reason = bad.isAbutment
          ? `橋台 ${bad.coord} の下に地盤がない`
          : `橋脚 ${bad.coord}: 荷重 ${bad.load} > 耐力 ${bad.bearing}`;
      }
    }
    return { span, loads, cost, ok, reason };
  }

  planCost(plan: BridgePlan, prepared?: Bridge): number {
    const spec = BRIDGES[plan.type];
    const deckCells = plan.b - plan.a + 1;
    let cost = spec.costPerCell * deckCells;
    const bridge = prepared ?? this.makeBridge(plan, -1);
    if (!prepared) this.refreshBaseY(bridge);
    for (const p of bridge.piers) {
      if (p.isAbutment) continue;
      const h = Math.max(0, plan.y - p.baseY - 1);
      cost += PIER_COST_PER_CELL * h;
      cost += FOUNDATION_COST[p.foundation];
    }
    return cost;
  }

  planBuildTime(plan: BridgePlan): number {
    return BRIDGES[plan.type].buildTime * (plan.b - plan.a + 1);
  }

  private makeBridge(plan: BridgePlan, id: number): Bridge {
    const piers: Pier[] = [];
    const push = (coord: number, isAbutment: boolean): void => {
      const foundation = isAbutment ? 'none' : (plan.foundations[coord] ?? 'none');
      piers.push({ coord, isAbutment, foundation, baseY: -1, sink: 0, timer: GRACE_SECONDS, alive: true });
    };
    push(plan.a, true);
    for (const c of [...new Set(plan.pierCoords)].sort((p, q) => p - q)) {
      if (c > plan.a && c < plan.b) push(c, false);
    }
    push(plan.b, true);
    return {
      id,
      type: plan.type,
      axis: plan.axis,
      y: plan.y,
      a: plan.a,
      b: plan.b,
      cross: plan.cross,
      piers,
      deckAlive: new Array(plan.b - plan.a + 1).fill(true),
    };
  }

  commit(plan: BridgePlan): Bridge {
    const bridge = this.makeBridge(plan, this.nextId++);
    this.refreshBaseY(bridge);
    this.bridges.push(bridge);
    return bridge;
  }

  remove(bridge: Bridge): void {
    const i = this.bridges.indexOf(bridge);
    if (i >= 0) this.bridges.splice(i, 1);
  }

  /** そのセルに桁があるか。 */
  deckAt(x: number, y: number, z: number): { bridge: Bridge; index: number } | undefined {
    for (const b of this.bridges) {
      if (b.y !== y) continue;
      const coord = b.axis === 'x' ? x : z;
      const cross = b.axis === 'x' ? z : x;
      if (cross !== b.cross) continue;
      if (coord < b.a || coord > b.b) continue;
      const index = coord - b.a;
      if (b.deckAlive[index]) return { bridge: b, index };
    }
    return undefined;
  }

  /** そのセルを橋脚が通っているか。 */
  pierAt(x: number, y: number, z: number): { bridge: Bridge; pier: Pier } | undefined {
    for (const b of this.bridges) {
      const coord = b.axis === 'x' ? x : z;
      const cross = b.axis === 'x' ? z : x;
      if (cross !== b.cross) continue;
      for (const p of b.piers) {
        if (p.isAbutment || !p.alive || p.coord !== coord) continue;
        if (y > p.baseY && y < b.y) return { bridge: b, pier: p };
      }
    }
    return undefined;
  }

  /** 沈下の猶予タイマーを進める。時間切れになった支持点を返す。 */
  update(dt: number): BridgeFailure[] {
    const failures: BridgeFailure[] = [];
    for (const bridge of this.bridges) {
      this.refreshBaseY(bridge);
      const loads = this.pierLoads(bridge);
      const byCoord = new Map(loads.map((l) => [l.coord, l]));
      for (const p of bridge.piers) {
        if (!p.alive) continue;
        const l = byCoord.get(p.coord);
        if (!l || l.ok) {
          p.timer = Math.min(GRACE_SECONDS, p.timer + dt * 4);
          p.sink = Math.max(0, MAX_SINK * (1 - p.timer / GRACE_SECONDS));
          continue;
        }
        p.timer -= dt; // 猶予は一定 (トンネルと同じ約束)
        p.sink = MAX_SINK * (1 - Math.max(0, p.timer) / GRACE_SECONDS);
        if (p.timer <= 0) {
          failures.push({
            bridgeId: bridge.id,
            coord: p.coord,
            cell: bridgeCell(bridge, p.coord, bridge.y),
            isAbutment: p.isAbutment,
          });
        }
      }
    }
    return failures;
  }

  /** 支持点が落ちたとき、それが受け持っていた桁を落とす。 */
  failSupport(bridge: Bridge, coord: number): void {
    const alive = bridge.piers.filter((p) => p.alive).sort((p, q) => p.coord - q.coord);
    const i = alive.findIndex((p) => p.coord === coord);
    if (i < 0) return;
    const from = i > 0 ? (alive[i - 1] as Pier).coord + 1 : bridge.a;
    const to = i + 1 < alive.length ? (alive[i + 1] as Pier).coord - 1 : bridge.b;
    for (let c = from; c <= to; c++) bridge.deckAlive[c - bridge.a] = false;
    const target = bridge.piers.find((p) => p.coord === coord);
    if (target) {
      target.alive = false;
      target.sink = 0;
      target.timer = GRACE_SECONDS;
    }
    if (!bridge.deckAlive.some(Boolean)) this.remove(bridge);
  }
}

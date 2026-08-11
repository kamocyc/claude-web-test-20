import { Material, isSolidMaterial } from '../core/types.ts';
import type { Bridge, BridgeTypeId, Cell, FoundationId, SupportId } from '../core/types.ts';
import {
  BRIDGES,
  DEMOLISH_COST,
  DIG_COST,
  DIG_TIME,
  FILL_COST,
  FILL_TIME,
  FOUNDATION_COST,
  FOUNDATION_NAMES,
  GOAL_CELL,
  GRACE_SECONDS,
  MAX_ROUTE_LENGTH,
  SINKHOLE_COVER,
  START_CELL,
  SUPPORTS,
  SURVEY_COST,
  WIN_HOLD_SECONDS,
  WORLD,
} from '../core/config.ts';
import { MATERIAL_NAMES } from '../core/types.ts';
import { generateWorld } from './worldgen.ts';
import { VoxelWorld } from './VoxelWorld.ts';
import { TunnelSystem } from './tunnel.ts';
import { BridgeSystem, autoPierCoords, bridgeCell, canInstallPile } from './bridge.ts';
import type { BridgePlan } from './bridge.ts';
import { SurveySystem } from './survey.ts';
import { Economy } from './economy.ts';
import { HazardBoard } from './hazard.ts';
import { findRoute } from './mission.ts';
import type { RouteQuery } from './mission.ts';

export interface ActionResult {
  ok: boolean;
  reason: string;
}

const OK: ActionResult = { ok: true, reason: '' };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

export interface Job {
  label: string;
  cell: Cell;
  remaining: number;
  total: number;
  apply: () => void;
}

export type GameEventType =
  | 'collapse'
  | 'sinkhole'
  | 'pierFail'
  | 'built'
  | 'dug'
  | 'filled'
  | 'surveyed'
  | 'rejected'
  | 'win';

export interface GameEvent {
  type: GameEventType;
  cell: Cell;
  text?: string;
}

/**
 * 描画から切り離したゲーム本体。テストもスモークもここを直接叩ける。
 */
export class Game {
  readonly world: VoxelWorld;
  readonly tunnels: TunnelSystem;
  readonly bridges: BridgeSystem;
  readonly survey: SurveySystem;
  readonly economy: Economy;
  readonly board = new HazardBoard();

  readonly jobs: Job[] = [];
  readonly events: GameEvent[] = [];

  /** 建設中のプラン。確定するまで世界には何も置かれない。 */
  plan: BridgePlan | null = null;

  time = 0;
  paused = false;
  won = false;
  private holdTimer = 0;
  private dirtyColumns = new Set<number>();
  /** 直近の接続判定の結果 (毎 tick 更新は重いので間引く) */
  routeConnected = false;
  /** 歩いて到達はできるが、道路として長すぎる状態を区別する */
  routeReachable = false;
  routeLength = 0;
  private routeTimer = 0;

  readonly start: Cell;
  readonly goal: Cell;

  constructor(seed: number = WORLD.SEED) {
    const gen = generateWorld(seed);
    this.world = gen.world;
    this.tunnels = new TunnelSystem(this.world);
    this.bridges = new BridgeSystem(this.world, (x, y, z) => this.tunnels.supportLevelAt(x, y, z));
    this.survey = new SurveySystem(this.world);
    this.economy = new Economy();

    this.world.onCellChange((x, _y, z) => {
      this.dirtyColumns.add(x * this.world.sz + z);
    });

    this.start = { x: START_CELL.x, y: this.world.surfaceY(START_CELL.x, START_CELL.z) + 1, z: START_CELL.z };
    this.goal = { x: GOAL_CELL.x, y: this.world.surfaceY(GOAL_CELL.x, GOAL_CELL.z) + 1, z: GOAL_CELL.z };
  }

  // ------------------------------------------------------------ 問い合わせ

  private routeQuery(): RouteQuery {
    return {
      world: this.world,
      hasDeck: (x, y, z) => this.bridges.deckAt(x, y, z) !== undefined,
    };
  }

  checkRoute(): boolean {
    return this.route().connected;
  }

  route(): ReturnType<typeof findRoute> {
    return findRoute(this.routeQuery(), this.start, this.goal, MAX_ROUTE_LENGTH);
  }

  routePath(): Cell[] {
    return this.route().path;
  }

  /** プレイヤーに見える地質。未調査なら null。 */
  visibleMaterial(x: number, y: number, z: number): Material | null {
    if (this.survey.isKnown(x, z)) return this.world.getOrig(x, y, z);
    return null;
  }

  private emit(type: GameEventType, cell: Cell, text?: string): void {
    this.events.push({ type, cell, text });
    if (this.events.length > 64) this.events.shift();
  }

  drainEvents(): GameEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  // ------------------------------------------------------------ 作業キュー

  private enqueue(label: string, cell: Cell, total: number, apply: () => void): void {
    this.jobs.push({ label, cell, remaining: Math.max(0.01, total), total: Math.max(0.01, total), apply });
  }

  get currentJob(): Job | undefined {
    return this.jobs[0];
  }

  private updateJobs(dt: number): void {
    let budget = dt;
    while (budget > 0 && this.jobs.length > 0) {
      const job = this.jobs[0] as Job;
      const step = Math.min(budget, job.remaining);
      job.remaining -= step;
      budget -= step;
      if (job.remaining <= 1e-6) {
        this.jobs.shift();
        job.apply();
      }
    }
  }

  // ------------------------------------------------------------ 操作

  /** ボーリング。縦一列だけ地層が見えるようになる。 */
  doSurvey(x: number, z: number): ActionResult {
    if (!this.world.inBounds(x, 0, z)) return fail('範囲外');
    if (this.survey.isKnown(x, z)) return fail('調査済み');
    if (!this.economy.pay(SURVEY_COST)) return fail('予算不足');
    const y = this.world.surfaceY(x, z);
    this.enqueue(`ボーリング (${x},${z})`, { x, y: y + 1, z }, 1.2, () => {
      this.survey.bore(x, z);
      this.emit('surveyed', { x, y: y + 1, z });
    });
    return OK;
  }

  /**
   * 掘削。切土もトンネル掘進も同じ操作で、土被りがあるかどうかで支保の要否が決まる。
   */
  dig(x: number, y: number, z: number): ActionResult {
    if (!this.world.inBounds(x, y, z)) return fail('範囲外');
    const m = this.world.get(x, y, z);
    if (!isSolidMaterial(m)) return fail('すでに空洞');
    if (y <= 1) return fail('岩盤は掘れない');
    if (this.bridges.pierAt(x, y, z)) return fail('橋脚がある');
    const cost = DIG_COST[m];
    if (!this.economy.pay(cost)) return fail('予算不足');
    this.enqueue(`掘削 ${MATERIAL_NAMES[m]} (${x},${y},${z})`, { x, y, z }, DIG_TIME[m], () => {
      const origin = this.world.getOrig(x, y, z);
      this.world.excavate(x, y, z);
      this.tunnels.register(x, y, z, origin);
      this.flushDirty();
      this.emit('dug', { x, y, z }, MATERIAL_NAMES[origin]);
    });
    return OK;
  }

  /** 盛土。土を置くだけ。 */
  fill(x: number, y: number, z: number): ActionResult {
    if (!this.world.inBounds(x, y, z)) return fail('範囲外');
    if (this.world.isSolid(x, y, z)) return fail('すでに地面');
    if (this.bridges.deckAt(x, y, z)) return fail('桁がある');
    if (!this.world.isSolid(x, y - 1, z) && y > 0) return fail('足元に地面がない');
    if (!this.economy.pay(FILL_COST)) return fail('予算不足');
    this.enqueue(`盛土 (${x},${y},${z})`, { x, y, z }, FILL_TIME, () => {
      this.world.fill(x, y, z);
      this.tunnels.unregister(x, y, z);
      this.flushDirty();
      this.emit('filled', { x, y, z });
    });
    return OK;
  }

  /** 支保の設置。猶予中でも間に合えば元に戻る。 */
  setSupport(x: number, y: number, z: number, support: SupportId): ActionResult {
    const cell = this.tunnels.get(x, y, z);
    if (!cell) return fail('掘削されていない');
    if (!cell.buried) return fail('空に開いているので支保は不要');
    const spec = SUPPORTS[support];
    if (SUPPORTS[cell.support].level >= spec.level) return fail('すでに同等以上の支保');
    if (!this.economy.pay(spec.cost)) return fail('予算不足');
    this.enqueue(`${spec.name} (${x},${y},${z})`, { x, y, z }, spec.buildTime, () => {
      this.tunnels.setSupport(x, y, z, support);
      this.emit('built', { x, y, z }, spec.name);
    });
    return OK;
  }

  // ------------------------------------------------------------ 橋

  /** 起点と終点から建設プランを作る。橋脚は支間を満たすように自動配置される。 */
  startPlan(type: BridgeTypeId, from: Cell, to: Cell): ActionResult {
    if (from.x !== to.x && from.z !== to.z) return fail('橋は軸に平行にのみ架けられる');
    const axis = from.x === to.x ? 'z' : 'x';
    const cross = axis === 'x' ? from.z : from.x;
    const av = axis === 'x' ? from.x : from.z;
    const bv = axis === 'x' ? to.x : to.z;
    const a = Math.min(av, bv);
    const b = Math.max(av, bv);
    if (b - a < 1) return fail('長さが足りない');
    const y = Math.max(from.y, to.y);
    const pierCoords = autoPierCoords(type, a, b);
    const draft: BridgePlan = { type, axis, y, a, b, cross, pierCoords, foundations: {} };
    draft.foundations = this.bridges.autoFoundations(draft);
    this.plan = draft;
    return OK;
  }

  cancelPlan(): void {
    this.plan = null;
  }

  /** プラン上の橋脚を足す/外す。 */
  togglePier(coord: number): ActionResult {
    const plan = this.plan;
    if (!plan) return fail('プランがない');
    if (coord <= plan.a || coord >= plan.b) return fail('橋台の位置には置けない');
    const i = plan.pierCoords.indexOf(coord);
    if (i >= 0) {
      plan.pierCoords.splice(i, 1);
      delete plan.foundations[coord];
    } else {
      plan.pierCoords.push(coord);
      plan.foundations = this.bridges.autoFoundations(plan);
    }
    return OK;
  }

  /** プラン上の橋脚の基礎を切り替える。耐力に足す整数を選ぶだけ。 */
  cyclePlanFoundation(coord: number): ActionResult {
    const plan = this.plan;
    if (!plan) return fail('プランがない');
    if (!plan.pierCoords.includes(coord)) return fail('その位置に橋脚がない');
    const order: FoundationId[] = ['none', 'wide', 'pile'];
    const cur = plan.foundations[coord] ?? 'none';
    plan.foundations[coord] = order[(order.indexOf(cur) + 1) % order.length] as FoundationId;
    return OK;
  }

  planStatus(): ReturnType<BridgeSystem['validatePlan']> | null {
    return this.plan ? this.bridges.validatePlan(this.plan) : null;
  }

  /** 確定。支間超過や耐力不足のまま建てることはできない。 */
  commitPlan(): ActionResult {
    const plan = this.plan;
    if (!plan) return fail('プランがない');
    const status = this.bridges.validatePlan(plan);
    if (!status.ok) {
      this.emit('rejected', bridgeCell(plan, plan.a, plan.y), status.reason);
      return fail(status.reason);
    }
    if (!this.economy.pay(status.cost)) return fail('予算不足');
    const captured: BridgePlan = { ...plan, pierCoords: [...plan.pierCoords], foundations: { ...plan.foundations } };
    this.plan = null;
    this.enqueue(
      `${BRIDGES[captured.type].name}の架設`,
      bridgeCell(captured, Math.round((captured.a + captured.b) / 2), captured.y),
      this.bridges.planBuildTime(captured),
      () => {
        const bridge = this.bridges.commit(captured);
        this.emit('built', bridgeCell(bridge, bridge.a, bridge.y), BRIDGES[bridge.type].name);
      },
    );
    return OK;
  }

  /** 基礎補強。耐力に整数を足すだけ。 */
  setFoundation(x: number, y: number, z: number, foundation: FoundationId): ActionResult {
    const hit = this.pierNear(x, y, z);
    if (!hit) return fail('橋脚がない');
    const { bridge, coord } = hit;
    const pier = bridge.piers.find((p) => p.coord === coord);
    if (!pier || pier.isAbutment) return fail('橋台は補強できない');
    if (pier.foundation === foundation) return fail('同じ基礎');
    const c = bridgeCell(bridge, coord, bridge.y);
    if (foundation === 'pile' && !canInstallPile(this.world, c.x, pier.baseY, c.z)) {
      return fail('直下に岩がないので杭を打てない');
    }
    const cost = FOUNDATION_COST[foundation];
    if (!this.economy.pay(cost)) return fail('予算不足');
    this.enqueue(FOUNDATION_NAMES[foundation], { x: c.x, y: pier.baseY, z: c.z }, 1.0, () => {
      pier.foundation = foundation;
      pier.timer = GRACE_SECONDS;
      this.emit('built', { x: c.x, y: pier.baseY, z: c.z }, FOUNDATION_NAMES[foundation]);
    });
    return OK;
  }

  /** そのセル、またはその真上/真下の柱に属する橋脚を探す。 */
  pierNear(x: number, y: number, z: number): { bridge: Bridge; coord: number } | undefined {
    const direct = this.bridges.pierAt(x, y, z);
    if (direct) return { bridge: direct.bridge, coord: direct.pier.coord };
    for (const b of this.bridges.bridges) {
      const coord = b.axis === 'x' ? x : z;
      const cross = b.axis === 'x' ? z : x;
      if (cross !== b.cross) continue;
      const p = b.piers.find((q) => q.alive && !q.isAbutment && q.coord === coord);
      if (p && y >= p.baseY && y <= b.y) return { bridge: b, coord };
    }
    return undefined;
  }

  /** 撤去。橋の桁または支保を取り除く。 */
  demolish(x: number, y: number, z: number): ActionResult {
    const deck = this.bridges.deckAt(x, y, z);
    if (deck) {
      if (!this.economy.pay(DEMOLISH_COST)) return fail('予算不足');
      this.bridges.remove(deck.bridge);
      this.emit('built', { x, y, z }, '橋を撤去');
      return OK;
    }
    const cell = this.tunnels.get(x, y, z);
    if (cell && cell.support !== 'none') {
      if (!this.economy.pay(DEMOLISH_COST)) return fail('予算不足');
      this.tunnels.setSupport(x, y, z, 'none');
      this.emit('built', { x, y, z }, '支保を撤去');
      return OK;
    }
    return fail('撤去できるものがない');
  }

  // ------------------------------------------------------------ 崩壊

  private flushDirty(): void {
    if (this.dirtyColumns.size === 0) return;
    for (const k of this.dirtyColumns) {
      const z = k % this.world.sz;
      const x = (k - z) / this.world.sz;
      this.tunnels.refreshColumn(x, z);
    }
    this.dirtyColumns.clear();
  }

  private destroyStructuresAt(x: number, y: number, z: number): void {
    const pier = this.bridges.pierAt(x, y, z);
    if (pier) this.bridges.failSupport(pier.bridge, pier.pier.coord);
    const deck = this.bridges.deckAt(x, y, z);
    if (deck) {
      deck.bridge.deckAlive[deck.index] = false;
      if (!deck.bridge.deckAlive.some(Boolean)) this.bridges.remove(deck.bridge);
    }
  }

  private applyCollapse(x: number, y: number, z: number): void {
    this.world.backfill(x, y, z);
    this.tunnels.unregister(x, y, z);
    this.destroyStructuresAt(x, y, z);
    this.tunnels.shockNeighbors(x, y, z);

    const cover = this.world.coverThickness(x, y, z);
    let sinkhole = false;
    if (cover > 0 && cover <= SINKHOLE_COVER) {
      const top = this.world.surfaceY(x, z);
      if (top > y) {
        this.world.excavate(x, top, z);
        this.destroyStructuresAt(x, top, z);
        sinkhole = true;
      }
    }
    this.flushDirty();
    this.emit(sinkhole ? 'sinkhole' : 'collapse', { x, y, z });
  }

  // ------------------------------------------------------------ tick

  tick(dt: number): void {
    if (this.paused) return;
    this.time += dt;
    this.updateJobs(dt);

    for (const ev of this.tunnels.update(dt)) {
      this.applyCollapse(ev.x, ev.y, ev.z);
    }
    for (const f of this.bridges.update(dt)) {
      const bridge = this.bridges.bridges.find((b) => b.id === f.bridgeId);
      if (!bridge) continue;
      this.bridges.failSupport(bridge, f.coord);
      this.emit('pierFail', f.cell, f.isAbutment ? '橋台が崩れた' : '橋脚が沈下した');
    }

    this.refreshBoard();

    this.routeTimer -= dt;
    if (this.routeTimer <= 0) {
      this.routeTimer = 0.4;
      const r = this.route();
      this.routeConnected = r.connected;
      this.routeReachable = r.reachable;
      this.routeLength = r.length;
    }

    if (this.routeConnected && this.board.count === 0 && this.jobs.length === 0) {
      this.holdTimer += dt;
      if (!this.won && this.holdTimer >= WIN_HOLD_SECONDS) {
        this.won = true;
        this.emit('win', this.goal);
      }
    } else {
      this.holdTimer = 0;
    }
  }

  private refreshBoard(): void {
    this.board.begin();
    for (const cell of this.tunnels.cells.values()) {
      const d = this.tunnels.deficit(cell);
      if (d <= 0) continue;
      const water = this.world.isBelowWaterTable(cell.y) ? ' (水位下 +1)' : '';
      this.board.add(
        `t:${cell.x},${cell.y},${cell.z}`,
        'tunnel',
        cell,
        Math.max(0, cell.timer),
        GRACE_SECONDS,
        `${MATERIAL_NAMES[cell.origin]}に支保レベル${cell.required}が必要${water} / いま${SUPPORTS[cell.support].level}`,
      );
    }
    for (const bridge of this.bridges.bridges) {
      const loads = this.bridges.pierLoads(bridge);
      for (const l of loads) {
        if (l.ok) continue;
        const pier = bridge.piers.find((p) => p.coord === l.coord);
        if (!pier || !pier.alive) continue;
        const cell = bridgeCell(bridge, l.coord, bridge.y);
        const reason = l.isAbutment
          ? '橋台の下の地盤が抜けた'
          : `荷重 ${l.load} > 耐力 ${l.bearing}${l.undermined ? ' (直下に空洞)' : ''}`;
        this.board.add(`p:${bridge.id}:${l.coord}`, 'settlement', { ...cell, y: Math.max(0, pier.baseY) }, Math.max(0, pier.timer), GRACE_SECONDS, reason);
      }
    }
  }
}

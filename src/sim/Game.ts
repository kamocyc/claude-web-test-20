import { Material, isSolidMaterial } from '../core/types.ts';
import type { Bridge, BridgeTypeId, Cell, FoundationId, SupportId } from '../core/types.ts';
import {
  BRIDGES,
  CELL_SIZE_M,
  DEMOLISH_COST,
  DIG_COST,
  DIG_TIME,
  FILL_COST,
  FILL_TIME,
  FOUNDATION_COST,
  FOUNDATION_NAMES,
  GOAL_CELL,
  GRACE_SECONDS,
  GRADE_RUN,
  GRADE_TOOL_MAX_LENGTH,
  MAX_ROUTE_LENGTH,
  SINKHOLE_COVER,
  START_CELL,
  SUPPORTS,
  SURVEY_COST,
  WIN_HOLD_SECONDS,
  WORLD,
} from '../core/config.ts';
import { MATERIAL_NAMES } from '../core/types.ts';
import { generateWorld, sampleHeight } from './worldgen.ts';
import { VoxelWorld } from './VoxelWorld.ts';
import { TunnelSystem } from './tunnel.ts';
import { BridgeSystem, autoPierCoords, bridgeCell, canInstallPile } from './bridge.ts';
import type { BridgePlan } from './bridge.ts';
import { SurveySystem } from './survey.ts';
import { Economy } from './economy.ts';
import { HazardBoard } from './hazard.ts';
import { findRoute, steepestGrade } from './mission.ts';
import type { RouteQuery, RouteResult } from './mission.ts';

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

/** 道路敷設で1列に起きること。target が路面の高さ (そこに立てるようになる)。 */
export interface GradeColumn {
  x: number;
  z: number;
  target: number;
  /** 削る y (上から) */
  dig: number[];
  /** 埋める y (下から) */
  fill: number[];
}

export type GradePlanResult =
  | { ok: true; columns: GradeColumn[]; cut: number; fill: number; cost: number; length: number }
  | { ok: false; reason: string };

/**
 * 描画から切り離したゲーム本体。テストもスモークもここを直接叩ける。
 */
export class Game {
  readonly world: VoxelWorld;
  /**
   * worldgen が作った連続の地表高さ (float)。ボクセル化する前の値。
   * 描画側は手つかずの列でこれに吸着し、階段の残らない曲面にする。
   */
  readonly heights: Float32Array;
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
  /** 直近の探索結果。道路の描画が毎フレーム BFS を回さないためのキャッシュ。 */
  private cachedRoute: RouteResult | null = null;

  readonly start: Cell;
  readonly goal: Cell;

  constructor(seed: number = WORLD.SEED) {
    const gen = generateWorld(seed);
    this.world = gen.world;
    this.heights = gen.heights;
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
    return findRoute(this.routeQuery(), this.start, this.goal, {
      maxLength: MAX_ROUTE_LENGTH,
      gradeRun: GRADE_RUN,
    });
  }

  routePath(): Cell[] {
    return this.route().path;
  }

  /**
   * 描画に渡す線形の元。開通していれば全線、していなければ届いているところまで。
   * 「どこで途切れているか」が常に見えるようにするための区別。
   *
   * 探索は毎フレームやると重いので、tick の間引きで作ったキャッシュを使う。
   */
  roadPath(): { cells: Cell[]; complete: boolean } {
    const r = this.cachedRoute ?? this.route();
    if (r.connected) return { cells: r.path, complete: true };
    return { cells: r.best, complete: false };
  }

  /** 経路の最急勾配 (0〜1)。縦断曲線で GRADE_RUN マスに広げた実効値。 */
  routeGrade(): number {
    return steepestGrade(this.roadPath().cells, GRADE_RUN, CELL_SIZE_M.H, CELL_SIZE_M.V);
  }

  /** 手つかずの地形の連続高さ。描画がボクセルの丸めを取り消すのに使う。 */
  heightAt(x: number, z: number): number {
    return sampleHeight(this.heights, this.world.sx, this.world.sz, x, z);
  }

  /**
   * そのセルで道路が乗る高さ。
   *
   * 桁の上なら桁の高さ。掘った/盛った列なら格子どおり。手つかずの地形は
   * 平滑化でボクセルの丸めが消えているので、格子の y ではなく連続高さに合わせる。
   * ここを間違えると路面が地面に潜ったり宙に浮いたりする。
   */
  roadSurfaceAt(cell: Cell): number {
    if (this.bridges.deckAt(cell.x, cell.y, cell.z)) return cell.y;
    if (this.bridges.deckAt(cell.x, cell.y - 1, cell.z)) return cell.y;
    if (this.world.isColumnModified(cell.x, cell.z)) return cell.y;
    return this.heightAt(cell.x + 0.5, cell.z + 0.5) + 1;
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
    if (!this.world.isSolid(x, y - 1, z) && y > 0) return fail('足元に地面がない');
    return this.queueFill(x, y, z);
  }

  /**
   * 盛土を工事キューに積む。
   *
   * 足元の確認をここでしないのは、道路敷設のように何段も積むときに、
   * 下の盛土がまだ「発注しただけ」の段階で上の盛土を弾いてしまうから。
   * 下から順に積む保証は呼ぶ側が持つ。
   */
  private queueFill(x: number, y: number, z: number): ActionResult {
    if (!this.world.inBounds(x, y, z)) return fail('範囲外');
    if (this.world.isSolid(x, y, z)) return fail('すでに地面');
    if (this.bridges.deckAt(x, y, z)) return fail('桁がある');
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

  // ------------------------------------------------------------ 道路敷設 (整地)

  /**
   * 起点から終点まで、勾配条件を満たす縦断形に切り盛りする計画を立てる。
   *
   * 勾配上限を入れた以上、台地の細かい起伏もそのままでは道路にならない。
   * それを1マスずつ手で均させるのは作業であって判断ではないので、まとめて発注できる
   * ようにしてある。値段は既存の掘削/盛土の単価そのままなので、
   * 「どこを削ってどこを盛るか」という判断だけがプレイヤーに残る。
   */
  gradePlan(a: Cell, b: Cell): GradePlanResult {
    if (a.x !== b.x && a.z !== b.z) return { ok: false, reason: '道路はまっすぐ引く (縦か横)' };
    const axis: 'x' | 'z' = a.x === b.x ? 'z' : 'x';
    const cross = axis === 'x' ? a.z : a.x;
    const from = axis === 'x' ? a.x : a.z;
    const to = axis === 'x' ? b.x : b.z;
    const len = Math.abs(to - from) + 1;
    if (len < 2) return { ok: false, reason: '短すぎる' };
    if (len > GRADE_TOOL_MAX_LENGTH) {
      return { ok: false, reason: `1回に敷けるのは ${GRADE_TOOL_MAX_LENGTH} マスまで` };
    }
    const rise = b.y - a.y;
    const needed = Math.abs(rise) * GRADE_RUN;
    if (needed > len - 1) {
      return {
        ok: false,
        reason: `勾配が急すぎる (${Math.abs(rise)}マス上下するには ${needed} マスの走りが要る)`,
      };
    }

    const step = to >= from ? 1 : -1;
    const columns: GradeColumn[] = [];
    let cut = 0;
    let fillCount = 0;
    let cost = 0;

    for (let i = 0; i < len; i++) {
      const v = from + step * i;
      const x = axis === 'x' ? v : cross;
      const z = axis === 'x' ? cross : v;
      const target = a.y + Math.round((rise * i) / (len - 1));
      if (!this.world.inBounds(x, target, z)) return { ok: false, reason: '範囲外' };

      const dig: number[] = [];
      const fillYs: number[] = [];
      // 路面より上を削る (切土)
      for (let y = this.world.sy - 1; y >= target; y--) {
        if (this.world.isSolid(x, y, z)) {
          if (y <= 1) return { ok: false, reason: '岩盤まで削ることになる' };
          dig.push(y);
          cost += DIG_COST[this.world.get(x, y, z)];
          cut++;
        }
      }
      // 路面の下を埋める (盛土)。下から積まないと足元が無い。
      let base = target - 1;
      while (base >= 0 && !this.world.isSolid(x, base, z)) base--;
      for (let y = base + 1; y <= target - 1; y++) {
        fillYs.push(y);
        cost += FILL_COST;
        fillCount++;
      }
      columns.push({ x, z, target, dig, fill: fillYs });
    }

    return { ok: true, columns, cut, fill: fillCount, cost, length: len };
  }

  /** 計画を工事キューに積む。費用も工期も既存の掘削/盛土の単価がそのまま効く。 */
  planGrade(a: Cell, b: Cell): ActionResult {
    const plan = this.gradePlan(a, b);
    if (!plan.ok) return fail(plan.reason);
    if (this.economy.budget < plan.cost) {
      return fail(`予算不足 (¥${plan.cost.toLocaleString()} 必要)`);
    }
    for (const col of plan.columns) {
      for (const y of col.dig) this.dig(col.x, y, col.z);
      // fill は下から順。足元の確認は gradePlan 側で済ませてある。
      for (const y of col.fill) this.queueFill(col.x, y, col.z);
    }
    return {
      ok: true,
      reason: `道路敷設 ${plan.length}マス (切土${plan.cut} / 盛土${plan.fill} / ¥${plan.cost.toLocaleString()})`,
    };
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
    // 基礎は勝手に決めない。谷底が軟弱なら、まず赤くなって「ここは耐力0だ」と伝える。
    // 何を足すか (基礎を上げる / 橋脚を増やす / 橋脚を立てない橋にする) はプレイヤーが選ぶ。
    this.plan = { type, axis, y, a, b, cross, pierCoords: autoPierCoords(type, a, b), foundations: {} };
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
    }
    return OK;
  }

  /**
   * 足りない基礎をまとめて最も安い組み合わせに引き上げる。
   * 一度「耐力が足りない」と赤で見せたうえで、値段つきで提示する近道。
   */
  autoFillFoundations(): ActionResult {
    const plan = this.plan;
    if (!plan) return fail('プランがない');
    if (plan.pierCoords.length === 0) return fail('橋脚がない');
    const before = this.bridges.planCost(plan);
    plan.foundations = this.bridges.autoFoundations(plan);
    const after = this.bridges.planCost(plan);
    return { ok: true, reason: `基礎を補強した (+¥${(after - before).toLocaleString()})` };
  }

  /** 基礎を補ったときに増える金額。ボタンに出す。 */
  foundationFixCost(): number | null {
    const plan = this.plan;
    if (!plan || plan.pierCoords.length === 0) return null;
    const trial: BridgePlan = { ...plan, foundations: this.bridges.autoFoundations(plan) };
    const delta = this.bridges.planCost(trial) - this.bridges.planCost(plan);
    return delta > 0 ? delta : null;
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
      this.cachedRoute = r;
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

import { Material } from '../core/types.ts';
import type { SupportId, TunnelCell } from '../core/types.ts';
import { GRACE_SECONDS, REQUIRED_SUPPORT, SHOCK_FACTOR, SUPPORTS, WATER_SUPPORT_PENALTY } from '../core/config.ts';
import type { VoxelWorld } from './VoxelWorld.ts';

export interface CollapseEvent {
  x: number;
  y: number;
  z: number;
  origin: Material;
  /** 土被りが薄く、地表まで陥没したか */
  sinkhole: boolean;
}

/**
 * トンネルの数字は「支保レベル」1つだけ。
 *   必要支保レベル = 地質(岩0/土1/軟弱2) + (地下水位より下なら +1)
 * 設置した支保がそれ未満なら劣化タイマーが走り、時間切れで崩落する。
 */
export class TunnelSystem {
  readonly cells = new Map<number, TunnelCell>();

  constructor(private world: VoxelWorld) {}

  static requiredLevel(origin: Material, belowWater: boolean): number {
    const base = REQUIRED_SUPPORT[origin] ?? 0;
    return base + (belowWater ? WATER_SUPPORT_PENALTY : 0);
  }

  requiredAt(y: number, origin: Material): number {
    return TunnelSystem.requiredLevel(origin, this.world.isBelowWaterTable(y));
  }

  get(x: number, y: number, z: number): TunnelCell | undefined {
    return this.cells.get(this.world.key(x, y, z));
  }

  supportLevelAt(x: number, y: number, z: number): number {
    const c = this.get(x, y, z);
    return c ? SUPPORTS[c.support].level : 0;
  }

  /** 掘削されたセルを登録する。空に開いていれば支保は要らない(切土と同じ)。 */
  register(x: number, y: number, z: number, origin: Material): TunnelCell {
    const key = this.world.key(x, y, z);
    const existing = this.cells.get(key);
    if (existing) return existing;
    const cell: TunnelCell = {
      x,
      y,
      z,
      origin,
      required: this.requiredAt(y, origin),
      support: 'none',
      timer: GRACE_SECONDS,
      buried: this.world.isBuried(x, y, z),
    };
    this.cells.set(key, cell);
    return cell;
  }

  unregister(x: number, y: number, z: number): void {
    this.cells.delete(this.world.key(x, y, z));
  }

  /** 支保を設置する。猶予中でもタイマーは満タンに戻る(元に戻せる)。 */
  setSupport(x: number, y: number, z: number, support: SupportId): boolean {
    const cell = this.get(x, y, z);
    if (!cell) return false;
    cell.support = support;
    cell.timer = GRACE_SECONDS;
    return true;
  }

  /** その列の土被り状態を再計算する(屋根を抜いたら支保が不要になる、など)。 */
  refreshColumn(x: number, z: number): void {
    for (let y = 0; y < this.world.sy; y++) {
      const cell = this.cells.get(this.world.key(x, y, z));
      if (!cell) continue;
      const buried = this.world.isBuried(x, y, z);
      if (buried !== cell.buried) {
        cell.buried = buried;
        if (!buried) cell.timer = GRACE_SECONDS;
      }
    }
  }

  /** 不足レベル。0 なら健全。大きいほど早く崩れる。 */
  deficit(cell: TunnelCell): number {
    if (!cell.buried) return 0;
    return Math.max(0, cell.required - SUPPORTS[cell.support].level);
  }

  /**
   * 劣化タイマーを進める。時間切れになったセルを崩落イベントとして返す。
   * 実際の埋め戻しと構造物の破壊は Game 側で行う (連鎖の起点になるため)。
   */
  update(dt: number): CollapseEvent[] {
    const collapsed: CollapseEvent[] = [];
    for (const cell of this.cells.values()) {
      const d = this.deficit(cell);
      if (d <= 0) {
        if (cell.timer < GRACE_SECONDS) cell.timer = Math.min(GRACE_SECONDS, cell.timer + dt * 4);
        continue;
      }
      // 猶予は不足レベルによらず一定。プレイヤーへの約束(20〜30秒)を守るため。
      // 深刻さは「直す費用」で表現し、「残り時間」では表現しない。
      cell.timer -= dt;
      if (cell.timer <= 0) {
        collapsed.push({
          x: cell.x,
          y: cell.y,
          z: cell.z,
          origin: cell.origin,
          sinkhole: false,
        });
      }
    }
    return collapsed;
  }

  /** 隣接する未対策セルに衝撃を伝える(崩落の連鎖)。 */
  shockNeighbors(x: number, y: number, z: number): void {
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const;
    for (const [dx, dy, dz] of dirs) {
      const cell = this.get(x + dx, y + dy, z + dz);
      if (!cell) continue;
      if (this.deficit(cell) > 0) cell.timer *= SHOCK_FACTOR;
    }
  }
}

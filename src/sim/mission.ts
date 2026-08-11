import type { Cell } from '../core/types.ts';
import type { VoxelWorld } from './VoxelWorld.ts';

export interface RouteQuery {
  world: VoxelWorld;
  /** そのセルに(生きている)桁があるか */
  hasDeck: (x: number, y: number, z: number) => boolean;
}

/**
 * 立てるセルの条件:
 *   - そのセル自体が空洞、または桁がある
 *   - 足元が固体地盤、または桁
 * 移動は4近傍で、上下は1マスまで。
 */
export function isStandable(q: RouteQuery, x: number, y: number, z: number): boolean {
  const { world } = q;
  if (!world.inBounds(x, y, z)) return false;
  if (q.hasDeck(x, y, z)) return true;
  if (world.isSolid(x, y, z)) return false;
  if (world.isSolid(x, y - 1, z)) return true;
  return q.hasDeck(x, y - 1, z);
}

/** その (x,z) 列で、y の近傍に立てる高さを探す。 */
function standableNear(q: RouteQuery, x: number, y: number, z: number): number | null {
  for (const dy of [0, 1, -1]) {
    if (isStandable(q, x, y + dy, z)) return y + dy;
  }
  return null;
}

export interface RouteResult {
  /** 勾配を守って到達できるか */
  reachable: boolean;
  /** 到達でき、かつ道路として使える長さに収まっているか */
  connected: boolean;
  /** 経路のマス数 */
  length: number;
  /** 見つかった経路(道路の描画に使う)。到達できなければ空 */
  path: Cell[];
  /**
   * 到達できなかったときに、GOAL に一番近いところまでの経路。
   * 「工事がどこまで進んでいて、どこで途切れているか」を出すための線。
   */
  best: Cell[];
  /** 到達できたセル数。進捗の目安 */
  visited: number;
}

export interface RouteOptions {
  /** 道路として認める最大マス数 */
  maxLength?: number;
  /** 1マス上下するのに必要な走り(マス)。1 なら段差1が連続できる */
  gradeRun?: number;
}

/**
 * START から GOAL まで、道路として通せる線が引けるか。
 *
 * 2つの制約が乗っている。
 *
 * 1. **勾配**: 1マス上下したら、次の `gradeRun - 1` マスは平坦でなければならない。
 *    1セルは横8m×縦2mなので、段差1が連続する = 25%勾配で、道路としてはありえない。
 *    この1つの数字が、橋とトンネルを「近道」から「そこを通る唯一の手段」に変える。
 * 2. **長さ**: これが無いと「遠回りはタダ」になり、トンネルも切土も選ぶ理由が消える。
 *
 * 探索の状態に「あと何マス平坦に走らないといけないか」を持たせているだけで、
 * 中身はいつもの BFS。
 */
export function findRoute(
  q: RouteQuery,
  start: Cell,
  goal: Cell,
  options: RouteOptions | number = {},
): RouteResult {
  const opts: RouteOptions = typeof options === 'number' ? { maxLength: options } : options;
  const maxLength = opts.maxLength ?? Infinity;
  const gradeRun = Math.max(1, Math.floor(opts.gradeRun ?? 1));

  const { world } = q;
  const empty: RouteResult = {
    reachable: false,
    connected: false,
    length: 0,
    path: [],
    best: [],
    visited: 0,
  };

  const startY = standableNear(q, start.x, start.y, start.z);
  if (startY === null) return empty;

  /** セルと「残りの平坦義務」をまとめた探索キー。 */
  const key = (x: number, y: number, z: number, cool: number): number =>
    ((x * world.sy + y) * world.sz + z) * gradeRun + cool;

  const cameFrom = new Map<number, number>();
  const seen = new Set<number>();
  const startKey = key(start.x, startY, start.z, 0);
  seen.add(startKey);
  let queue: { cell: Cell; cool: number }[] = [{ cell: { x: start.x, y: startY, z: start.z }, cool: 0 }];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  let goalKey = -1;
  // 到達できなかったときのために、GOAL に一番近づけた地点を覚えておく。
  let bestKey = startKey;
  let bestScore = Math.abs(start.x - goal.x) + Math.abs(start.z - goal.z);

  while (queue.length > 0 && goalKey < 0) {
    const next: { cell: Cell; cool: number }[] = [];
    for (const cur of queue) {
      for (const [dx, dz] of dirs) {
        const nx = cur.cell.x + dx;
        const nz = cur.cell.z + dz;
        const ny = standableNear(q, nx, cur.cell.y, nz);
        if (ny === null) continue;

        // 勾配: 上下したいなら平坦義務が済んでいること。
        const climbs = ny !== cur.cell.y;
        if (climbs && cur.cool > 0) continue;
        const cool = climbs ? gradeRun - 1 : Math.max(0, cur.cool - 1);

        const k = key(nx, ny, nz, cool);
        if (seen.has(k)) continue;
        seen.add(k);
        cameFrom.set(k, key(cur.cell.x, cur.cell.y, cur.cell.z, cur.cool));
        next.push({ cell: { x: nx, y: ny, z: nz }, cool });

        const score = Math.abs(nx - goal.x) + Math.abs(nz - goal.z);
        if (score < bestScore) {
          bestScore = score;
          bestKey = k;
        }
        if (nx === goal.x && nz === goal.z) {
          goalKey = k;
          break;
        }
      }
      if (goalKey >= 0) break;
    }
    queue = next;
  }

  const trace = (from: number): Cell[] => {
    const out: Cell[] = [];
    let k: number | undefined = from;
    while (k !== undefined) {
      const cool = k % gradeRun;
      const rest = (k - cool) / gradeRun;
      const z = rest % world.sz;
      const rest2 = (rest - z) / world.sz;
      const y = rest2 % world.sy;
      const x = (rest2 - y) / world.sy;
      out.push({ x, y, z });
      if (k === startKey) break;
      k = cameFrom.get(k);
    }
    out.reverse();
    return out;
  };

  const best = trace(bestKey);
  if (goalKey < 0) {
    return { reachable: false, connected: false, length: 0, path: [], best, visited: seen.size };
  }

  const path = trace(goalKey);
  return {
    reachable: true,
    connected: path.length <= maxLength,
    length: path.length,
    path,
    best: path,
    visited: seen.size,
  };
}

/**
 * 経路の最急勾配 (0〜1)。
 *
 * 1歩だけを見ると必ず 25% (1マスで1マス上がる) になってしまうが、実際の道路は
 * その上下を縦断曲線で `window` マスに広げて走る。だから勾配も同じ窓で測る。
 * 「見た目が滑らかなだけで実は崖」を防ぐために、この数字をプレイヤーに見せる。
 */
export function steepestGrade(path: Cell[], window: number, cellH: number, cellV: number): number {
  if (path.length < 2) return 0;
  // 窓が経路より長いときだけ、全体を1つの窓として測る。
  const w = Math.min(Math.max(1, Math.floor(window)), path.length - 1);
  let worst = 0;
  for (let i = 0; i + w < path.length; i++) {
    const a = path[i] as Cell;
    const b = path[i + w] as Cell;
    worst = Math.max(worst, (Math.abs(b.y - a.y) * cellV) / (w * cellH));
  }
  return worst;
}

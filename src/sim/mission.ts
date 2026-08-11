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
 * 移動は4近傍で、段差1まで。
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
  /** 段差1で歩いて到達できるか */
  reachable: boolean;
  /** 到達でき、かつ道路として使える長さに収まっているか */
  connected: boolean;
  /** 経路のマス数 */
  length: number;
  /** 見つかった経路(デバッグ表示・演出用)。connected が false なら空 */
  path: Cell[];
  /** 到達できたセル数。進捗の目安 */
  visited: number;
}

/**
 * START から GOAL まで、段差1で歩いて行けるか。
 *
 * 「行ければ何でもいい」にすると、遠回りがタダになってトンネルも切土も要らなくなる。
 * 道路として使える長さに上限を置くことで、遠回りにもきちんと値段がつく。
 */
export function findRoute(q: RouteQuery, start: Cell, goal: Cell, maxLength = Infinity): RouteResult {
  const { world } = q;
  const startY = standableNear(q, start.x, start.y, start.z);
  if (startY === null) return { reachable: false, connected: false, length: 0, path: [], visited: 0 };

  const key = (x: number, y: number, z: number): number => (x * world.sy + y) * world.sz + z;
  const cameFrom = new Map<number, number>();
  const seen = new Set<number>();
  const startKey = key(start.x, startY, start.z);
  seen.add(startKey);
  let queue: Cell[] = [{ x: start.x, y: startY, z: start.z }];
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  let goalKey = -1;
  while (queue.length > 0 && goalKey < 0) {
    const next: Cell[] = [];
    for (const cur of queue) {
      for (const [dx, dz] of dirs) {
        const nx = cur.x + dx;
        const nz = cur.z + dz;
        const ny = standableNear(q, nx, cur.y, nz);
        if (ny === null) continue;
        const k = key(nx, ny, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        cameFrom.set(k, key(cur.x, cur.y, cur.z));
        next.push({ x: nx, y: ny, z: nz });
        if (nx === goal.x && nz === goal.z) {
          goalKey = k;
          break;
        }
      }
      if (goalKey >= 0) break;
    }
    queue = next;
  }

  if (goalKey < 0) return { reachable: false, connected: false, length: 0, path: [], visited: seen.size };

  const path: Cell[] = [];
  let k: number | undefined = goalKey;
  while (k !== undefined) {
    const z = k % world.sz;
    const rest = (k - z) / world.sz;
    const y = rest % world.sy;
    const x = (rest - y) / world.sy;
    path.push({ x, y, z });
    if (k === startKey) break;
    k = cameFrom.get(k);
  }
  path.reverse();
  return {
    reachable: true,
    connected: path.length <= maxLength,
    length: path.length,
    path,
    visited: seen.size,
  };
}

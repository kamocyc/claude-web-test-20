import type { Material } from '../core/types.ts';
import type { VoxelWorld } from './VoxelWorld.ts';

/**
 * 調査もボーリング1本だけ。打った位置の地層が縦一列だけ見えるようになる。
 * マップは初期状態で地質不明なので、「調査コスト」と「勘で掘る」のトレードオフが生まれる。
 */
export class SurveySystem {
  private known: Uint8Array;

  constructor(private world: VoxelWorld) {
    this.known = new Uint8Array(world.sx * world.sz);
  }

  isKnown(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.world.sx || z >= this.world.sz) return false;
    return this.known[x * this.world.sz + z] === 1;
  }

  bore(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.world.sx || z >= this.world.sz) return false;
    const i = x * this.world.sz + z;
    if (this.known[i] === 1) return false;
    this.known[i] = 1;
    return true;
  }

  get boreCount(): number {
    let n = 0;
    for (let i = 0; i < this.known.length; i++) if (this.known[i] === 1) n++;
    return n;
  }

  /** 調査済みの列の地層を上から順に返す(ボーリングコアの描画用)。 */
  column(x: number, z: number): Material[] {
    const out: Material[] = [];
    for (let y = 0; y < this.world.sy; y++) out.push(this.world.getOrig(x, y, z));
    return out;
  }

  /** 調査済みの列を列挙する。 */
  *bores(): Generator<{ x: number; z: number }> {
    for (let x = 0; x < this.world.sx; x++) {
      for (let z = 0; z < this.world.sz; z++) {
        if (this.known[x * this.world.sz + z] === 1) yield { x, z };
      }
    }
  }
}

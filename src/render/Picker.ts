import * as THREE from 'three';
import type { Cell } from '../core/types.ts';
import { V_RENDER } from '../core/config.ts';
import type { VoxelWorld } from '../sim/VoxelWorld.ts';
import { OX, OZ } from './Scene.ts';

export interface PickResult {
  /** 当たった固体セル (掘削・調査の対象) */
  cell: Cell;
  /** その手前の空セル (盛土・橋の起点の対象) */
  place: Cell;
  point: THREE.Vector3;
}

/** これ以上は追わない。世界の対角より十分長い。 */
const MAX_STEPS = 400;

/**
 * 画面座標から、地形のセルを拾う。
 *
 * 地形を滑らかにした時点で、メッシュの面法線からセルを逆算する手は使えなくなった
 * (面はもうセルの境界に乗っていない)。なのでレイをセル座標に直してボクセル格子を
 * 直接走査する。メッシュの形から独立するので、平滑化を強めても選択がずれない。
 */
export class Picker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  pick(
    camera: THREE.Camera,
    world: VoxelWorld,
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
  ): PickResult | null {
    const rect = canvas.getBoundingClientRect();
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.ndc, camera);

    // ワールド座標 → セル座標 (縦倍率を戻す)
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    const ox = o.x - OX;
    const oy = o.y / V_RENDER;
    const oz = o.z - OZ;
    const dx = d.x;
    const dy = d.y / V_RENDER;
    const dz = d.z;

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invX = Math.abs(dx) < 1e-9 ? Infinity : 1 / Math.abs(dx);
    const invY = Math.abs(dy) < 1e-9 ? Infinity : 1 / Math.abs(dy);
    const invZ = Math.abs(dz) < 1e-9 ? Infinity : 1 / Math.abs(dz);
    let tMaxX = (dx > 0 ? x + 1 - ox : ox - x) * invX;
    let tMaxY = (dy > 0 ? y + 1 - oy : oy - y) * invY;
    let tMaxZ = (dz > 0 ? z + 1 - oz : oz - z) * invZ;

    let prev: Cell | null = null;
    let t = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      if (world.inBounds(x, y, z)) {
        if (world.isSolid(x, y, z)) {
          // 手前の空セルが取れていないなら、盛土の置き場も決められない。
          const place = prev ?? { x, y: y + 1, z };
          const point = new THREE.Vector3(
            OX + ox + dx * t,
            (oy + dy * t) * V_RENDER,
            OZ + oz + dz * t,
          );
          return { cell: { x, y, z }, place, point };
        }
        prev = { x, y, z };
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX;
        x += stepX;
        tMaxX += invX;
      } else if (tMaxY < tMaxZ) {
        t = tMaxY;
        y += stepY;
        tMaxY += invY;
      } else {
        t = tMaxZ;
        z += stepZ;
        tMaxZ += invZ;
      }

      // 世界を完全に通り過ぎたら打ち切る
      if (
        (x < 0 && stepX < 0) || (x >= world.sx && stepX > 0) ||
        (y < 0 && stepY < 0) || (y >= world.sy && stepY > 0) ||
        (z < 0 && stepZ < 0) || (z >= world.sz && stepZ > 0)
      ) {
        return null;
      }
    }
    return null;
  }
}

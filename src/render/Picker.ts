import * as THREE from 'three';
import type { Cell } from '../core/types.ts';
import { OX, OZ } from './Scene.ts';

export interface PickResult {
  /** 当たった固体セル (掘削・調査の対象) */
  cell: Cell;
  /** その手前の空セル (盛土・橋の起点の対象) */
  place: Cell;
  point: THREE.Vector3;
}

/** 画面座標から、地形のセルを拾う。 */
export class Picker {
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  pick(camera: THREE.Camera, targets: THREE.Object3D[], clientX: number, clientY: number, canvas: HTMLCanvasElement): PickResult | null {
    const rect = canvas.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, camera);
    const hits = this.ray.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;

    const n = hit.face.normal;
    const inside = hit.point.clone().addScaledVector(n, -0.5);
    const outside = hit.point.clone().addScaledVector(n, 0.5);
    return {
      cell: { x: Math.floor(inside.x - OX), y: Math.floor(inside.y), z: Math.floor(inside.z - OZ) },
      place: { x: Math.floor(outside.x - OX), y: Math.floor(outside.y), z: Math.floor(outside.z - OZ) },
      point: hit.point,
    };
  }
}

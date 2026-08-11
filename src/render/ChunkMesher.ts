import * as THREE from 'three';
import { Material } from '../core/types.ts';
import { COLORS, GRASS_COLOR, UNKNOWN_COLOR } from '../core/config.ts';
import type { VoxelWorld } from '../sim/VoxelWorld.ts';
import { OX, OZ } from './Scene.ts';

/**
 * 露出している面だけを集めて 1 つの BufferGeometry にする。
 * 通常ビュー用と地質ビュー用の2つの頂点カラーを同時に作っておき、
 * トグルのときは属性を差し替えるだけで済ませる。
 */

const FACES = [
  { dir: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], shade: 0.82 },
  { dir: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], shade: 0.72 },
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.5 },
  { dir: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], shade: 0.9 },
  { dir: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], shade: 0.64 },
] as const;

const tmp = new THREE.Color();

export interface ChunkBounds {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface MeshInput {
  world: VoxelWorld;
  /** その列の地質が判明しているか */
  isKnown: (x: number, z: number) => boolean;
}

export function buildChunkGeometry(input: MeshInput, b: ChunkBounds): THREE.BufferGeometry {
  const { world, isKnown } = input;
  const positions: number[] = [];
  const normals: number[] = [];
  const colorNormal: number[] = [];
  const colorGeo: number[] = [];
  const indices: number[] = [];

  for (let x = b.x0; x < b.x1; x++) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let z = b.z0; z < b.z1; z++) {
        const m = world.get(x, y, z);
        if (m === Material.AIR) continue;
        const known = isKnown(x, z);
        for (const face of FACES) {
          const nx = x + face.dir[0];
          const ny = y + face.dir[1];
          const nz = z + face.dir[2];
          if (world.inBounds(nx, ny, nz) && world.isSolid(nx, ny, nz)) continue;

          // 世界の縁は人工的な切り口なので、地質をタダで見せない (未調査なら無彩色)。
          // 自然にできた崖や谷壁は露頭。ここは本当の色が見える = 地形を読む価値がある。
          const isEdge = !world.inBounds(nx, ny, nz) && face.dir[1] === 0;
          const isTop = face.dir[1] === 1;
          const base = isEdge
            ? known
              ? COLORS[m]
              : UNKNOWN_COLOR
            : isTop && m === Material.DIRT
              ? GRASS_COLOR
              : COLORS[m];
          // 地質ビュー: 調査済みなら地質色、未調査なら無彩色。
          const geo = known ? COLORS[m] : UNKNOWN_COLOR;

          const start = positions.length / 3;
          for (const c of face.corners) {
            positions.push(OX + x + c[0], y + c[1], OZ + z + c[2]);
            normals.push(face.dir[0], face.dir[1], face.dir[2]);
            tmp.setHex(base).multiplyScalar(face.shade);
            colorNormal.push(tmp.r, tmp.g, tmp.b);
            tmp.setHex(geo).multiplyScalar(face.shade);
            colorGeo.push(tmp.r, tmp.g, tmp.b);
          }
          indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colorNormal, 3));
  g.setAttribute('colorGeo', new THREE.Float32BufferAttribute(colorGeo, 3));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

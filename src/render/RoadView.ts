import * as THREE from 'three';
import {
  ROAD_COLOR,
  ROAD_LINE_COLOR,
  ROAD_SHOULDER,
  ROAD_UNBUILT_COLOR,
  ROAD_WIDTH,
} from '../core/config.ts';
import { buildAlignment } from '../sim/alignment.ts';
import type { AlignmentPoint } from '../sim/alignment.ts';
import type { Game } from '../sim/Game.ts';
import { OX, OZ } from './Scene.ts';

/** 路面を地形からわずかに浮かせる量。z-fighting よけ。 */
const LIFT = 0.06;
/** 路肩の外側を下げて作るスカート。地形との隙間を隠す。 */
const SKIRT = 0.4;
/** センターラインの繰り返し間隔 (マス)。 */
const STRIPE_PERIOD = 4;

/**
 * 断面のかたち。(横方向のオフセット, 高さ, テクスチャの u)。
 * 外側2つはスカートで、テクスチャ上は路肩と同じ色になる。
 */
const SECTION: readonly [number, number, number][] = [
  [-ROAD_WIDTH / 2 - ROAD_SHOULDER, -SKIRT, 0],
  [-ROAD_WIDTH / 2 - ROAD_SHOULDER, 0, 0],
  [-ROAD_WIDTH / 2, 0.02, 0.15],
  [ROAD_WIDTH / 2, 0.02, 0.85],
  [ROAD_WIDTH / 2 + ROAD_SHOULDER, 0, 1],
  [ROAD_WIDTH / 2 + ROAD_SHOULDER, -SKIRT, 1],
];

/**
 * 道路そのものの描画。
 *
 * 経路探索が返す1マスずつの折れ線を `buildAlignment` で線形に直し、
 * その上にリボンを張る。開通していれば舗装として、まだ届いていなければ
 * 工事中の色で「今どこまで来ていて、どこで途切れているか」を出す。
 */
export class RoadView {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private material: THREE.MeshLambertMaterial;
  private signature = '';
  /** 直近の線形。HUD に勾配を出すのに使う。 */
  points: AlignmentPoint[] = [];

  constructor(private game: Game) {
    this.material = new THREE.MeshLambertMaterial({
      map: stripeTexture(),
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.group.add(this.mesh);
  }

  update(): void {
    const { cells, complete } = this.game.roadPath();
    const sig = `${complete ? 1 : 0}:${cells.length}:${cells.map((c) => `${c.x},${c.y},${c.z}`).join('|')}`;
    if (sig === this.signature) return;
    this.signature = sig;

    this.points = buildAlignment(cells, { surfaceAt: (c) => this.game.roadSurfaceAt(c) });
    this.mesh.geometry.dispose();
    if (this.points.length < 2) {
      this.mesh.geometry = new THREE.BufferGeometry();
      this.mesh.visible = false;
      return;
    }
    this.mesh.geometry = ribbon(this.points);
    this.mesh.visible = true;
    // 工事中は暖色に寄せて半透明にする。「まだ道路ではない」ことを色で言う。
    this.material.color.setHex(complete ? 0xffffff : ROAD_UNBUILT_COLOR);
    this.material.opacity = complete ? 1 : 0.72;
  }
}

/** 線形に沿ってリボンを張る。片勾配 (バンク) は断面を進行方向まわりに傾けて出す。 */
function ribbon(points: AlignmentPoint[]): THREE.BufferGeometry {
  const cols = SECTION.length;
  const positions = new Float32Array(points.length * cols * 3);
  const uvs = new Float32Array(points.length * cols * 2);
  const indices: number[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i] as AlignmentPoint;
    // 進行方向に対する「右」。
    const rx = -p.tz;
    const rz = p.tx;
    for (let c = 0; c < cols; c++) {
      const [off, dy, u] = SECTION[c] as [number, number, number];
      const k = (i * cols + c) * 3;
      positions[k] = OX + p.x + rx * off;
      positions[k + 1] = p.y + LIFT + dy + off * p.bank;
      positions[k + 2] = OZ + p.z + rz * off;
      const t = (i * cols + c) * 2;
      uvs[t] = u;
      uvs[t + 1] = p.s / STRIPE_PERIOD;
    }
    if (i > 0) {
      for (let c = 0; c + 1 < cols; c++) {
        const a = (i - 1) * cols + c;
        const b = (i - 1) * cols + c + 1;
        const d = i * cols + c;
        const e = i * cols + c + 1;
        indices.push(a, d, e, a, e, b);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * 舗装のテクスチャ。u が幅方向、v が進行方向。
 * 外側が路肩、内側の白線が車道の縁、真ん中が破線のセンターライン。
 */
function stripeTexture(): THREE.CanvasTexture {
  const W = 64;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context を作れない');

  ctx.fillStyle = `#${ROAD_COLOR.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, W, H);
  // 路肩 (砂利)
  ctx.fillStyle = '#6b6156';
  ctx.fillRect(0, 0, W * 0.13, H);
  ctx.fillRect(W * 0.87, 0, W * 0.13, H);
  // 車道外側線
  ctx.fillStyle = `#${ROAD_LINE_COLOR.toString(16).padStart(6, '0')}`;
  ctx.fillRect(W * 0.16, 0, W * 0.035, H);
  ctx.fillRect(W * 0.805, 0, W * 0.035, H);
  // センターライン (破線)
  ctx.fillRect(W * 0.482, 0, W * 0.036, H * 0.45);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

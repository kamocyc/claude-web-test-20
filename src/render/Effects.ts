import * as THREE from 'three';
import { HazardPhase } from '../core/types.ts';
import type { Hazard } from '../core/types.ts';
import { hazardProgress } from '../sim/hazard.ts';
import type { Game } from '../sim/Game.ts';
import { OX, OZ, cellToWorld } from './Scene.ts';

const MAX_HAZARDS = 256;
const SAND_COUNT = 700;

/**
 * 「地盤の怖さ」は物理精度ではなくフィードバックの質から来る。
 * ここは全部が見た目のためのコードで、シミュレーションには一切影響しない。
 */
export class Effects {
  readonly group = new THREE.Group();

  private boxes: THREE.InstancedMesh;
  private sand: THREE.Points;
  private sandPos: Float32Array;
  private sandVel: Float32Array;
  private sandLife: Float32Array;
  private cracks = new THREE.Group();
  private crackSignature = '';
  private debris: { mesh: THREE.Mesh; vy: number; life: number }[] = [];
  private time = 0;

  constructor(private game: Game) {
    const boxGeo = new THREE.BoxGeometry(1.06, 1.06, 1.06);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0xff4d4d,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.boxes = new THREE.InstancedMesh(boxGeo, boxMat, MAX_HAZARDS);
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.count = 0;
    this.boxes.frustumCulled = false;
    this.boxes.renderOrder = 6;

    this.sandPos = new Float32Array(SAND_COUNT * 3);
    this.sandVel = new Float32Array(SAND_COUNT);
    this.sandLife = new Float32Array(SAND_COUNT);
    const sandGeo = new THREE.BufferGeometry();
    sandGeo.setAttribute('position', new THREE.BufferAttribute(this.sandPos, 3));
    this.sand = new THREE.Points(
      sandGeo,
      new THREE.PointsMaterial({ color: 0xd8c9a5, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.sand.frustumCulled = false;

    this.group.add(this.boxes, this.sand, this.cracks);
  }

  /** 崩落・沈下の瞬間に土塊を飛ばす。 */
  burst(x: number, y: number, z: number, color = 0x9a7d5a): void {
    for (let i = 0; i < 14; i++) {
      const size = 0.12 + Math.random() * 0.2;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(size, size, size),
        new THREE.MeshLambertMaterial({ color }),
      );
      cellToWorld(x, y, z, mesh.position);
      mesh.position.x += (Math.random() - 0.5) * 1.4;
      mesh.position.z += (Math.random() - 0.5) * 1.4;
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.group.add(mesh);
      this.debris.push({ mesh, vy: 1.5 + Math.random() * 3, life: 1.1 + Math.random() * 0.6 });
    }
  }

  private refreshCracks(settlements: Hazard[]): void {
    const sig = settlements.map((h) => `${h.key}:${h.phase}`).join('|');
    if (sig === this.crackSignature) return;
    this.crackSignature = sig;
    for (const c of [...this.cracks.children]) {
      this.cracks.remove(c);
      (c as THREE.Line).geometry.dispose();
    }
    for (const h of settlements) {
      const pts: THREE.Vector3[] = [];
      const cx = OX + h.cell.x + 0.5;
      const cz = OZ + h.cell.z + 0.5;
      const y = h.cell.y + 1.02;
      const n = h.phase === HazardPhase.OMEN ? 11 : 6;
      const len = h.phase === HazardPhase.OMEN ? 2.4 : 1.4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r0 = 0.4;
        const r1 = r0 + len * (0.5 + ((i * 37) % 10) / 14);
        const bend = ((i * 53) % 10) / 26;
        pts.push(new THREE.Vector3(cx + Math.cos(a) * r0, y, cz + Math.sin(a) * r0));
        pts.push(new THREE.Vector3(cx + Math.cos(a + bend) * r1, y, cz + Math.sin(a + bend) * r1));
      }
      const line = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x2a1d16, transparent: true, opacity: 0.75, depthTest: false }),
      );
      line.renderOrder = 5;
      this.cracks.add(line);
    }
  }

  update(dt: number): void {
    this.time += dt;
    const hazards = this.game.board.list;

    // 危険なセルを脈打たせる。オーバーレイはこれ1種類だけ。
    const dummy = new THREE.Object3D();
    let n = 0;
    for (const h of hazards) {
      if (n >= MAX_HAZARDS) break;
      const p = hazardProgress(h.remaining, h.total);
      const pulse = 0.9 + 0.28 * Math.sin(this.time * (3 + p * 9));
      cellToWorld(h.cell.x, h.cell.y, h.cell.z, dummy.position);
      dummy.scale.setScalar(pulse * (0.6 + 0.5 * p));
      dummy.updateMatrix();
      this.boxes.setMatrixAt(n++, dummy.matrix);
    }
    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    const boxMat = this.boxes.material as THREE.MeshBasicMaterial;
    boxMat.opacity = 0.16 + 0.34 * this.game.board.maxProgress;

    // トンネル天端からぱらぱら落ちる砂。支保が足りない区間だけ。
    const tunnelHazards = hazards.filter((h) => h.kind === 'tunnel');
    for (let i = 0; i < SAND_COUNT; i++) {
      this.sandLife[i] = (this.sandLife[i] ?? 0) - dt;
      if ((this.sandLife[i] ?? 0) > 0) {
        this.sandPos[i * 3 + 1] = (this.sandPos[i * 3 + 1] ?? 0) - (this.sandVel[i] ?? 0) * dt;
        this.sandVel[i] = (this.sandVel[i] ?? 0) + 9 * dt;
        continue;
      }
      if (tunnelHazards.length === 0) {
        this.sandPos[i * 3 + 1] = -999;
        continue;
      }
      const h = tunnelHazards[(Math.random() * tunnelHazards.length) | 0]!;
      const p = hazardProgress(h.remaining, h.total);
      // 予兆フェーズほど密に落ちる
      if (Math.random() > 0.12 + p * 0.5) {
        this.sandPos[i * 3 + 1] = -999;
        continue;
      }
      this.sandPos[i * 3] = OX + h.cell.x + Math.random();
      this.sandPos[i * 3 + 1] = h.cell.y + 0.98;
      this.sandPos[i * 3 + 2] = OZ + h.cell.z + Math.random();
      this.sandVel[i] = 0.2;
      this.sandLife[i] = 0.35 + Math.random() * 0.5;
    }
    this.sand.geometry.attributes.position!.needsUpdate = true;

    this.refreshCracks(hazards.filter((h) => h.kind === 'settlement'));

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!;
      d.vy -= 16 * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.rotation.x += dt * 3;
      d.mesh.rotation.z += dt * 2;
      d.life -= dt;
      if (d.life <= 0) {
        this.group.remove(d.mesh);
        d.mesh.geometry.dispose();
        this.debris.splice(i, 1);
      }
    }
  }
}

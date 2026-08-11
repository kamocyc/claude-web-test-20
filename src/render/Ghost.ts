import * as THREE from 'three';
import type { Cell, PierLoad, SpanCheck } from '../core/types.ts';
import type { BridgePlan } from '../sim/bridge.ts';
import type { GradePlanResult } from '../sim/Game.ts';
import { bridgeCell } from '../sim/bridge.ts';
import { cellToWorld } from './Scene.ts';

const OK_COLOR = 0x8fe3b0;
const NG_COLOR = 0xff5a5a;
/** 切土 = 削る。盛土 = 埋める。 */
const CUT_COLOR = 0xe08a4a;
const FILL_COLOR = 0x5aa8e0;

/**
 * 建設プレビュー。「建ててから落ちるのではなく、建てる前に分かる」ための表示。
 * 支間超過や耐力不足の区間はここで赤くなり、確定が拒否される。
 */
export class Ghost {
  readonly group = new THREE.Group();
  private cursor: THREE.Mesh;
  private planGroup = new THREE.Group();
  private gradeGroup = new THREE.Group();
  private signature = '';
  private gradeSignature = '';

  constructor() {
    this.cursor = new THREE.Mesh(
      new THREE.BoxGeometry(1.04, 1.04, 1.04),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.85, depthTest: false }),
    );
    this.cursor.renderOrder = 8;
    this.cursor.visible = false;
    this.group.add(this.cursor, this.planGroup, this.gradeGroup);
  }

  setCursor(cell: Cell | null, ok = true): void {
    this.cursor.visible = cell !== null;
    if (!cell) return;
    cellToWorld(cell.x, cell.y, cell.z, this.cursor.position);
    (this.cursor.material as THREE.MeshBasicMaterial).color.setHex(ok ? 0xffffff : NG_COLOR);
  }

  /**
   * 道路敷設のプレビュー。削るところと埋めるところを色で分ける。
   * 「建てる前に分かる」を土工にも通すための表示。
   */
  setGrade(plan: GradePlanResult | null): void {
    const sig = plan
      ? plan.ok
        ? `g${plan.length}:${plan.cut}:${plan.fill}:${plan.columns[0]?.x},${plan.columns[0]?.z}:${plan.columns.at(-1)?.x},${plan.columns.at(-1)?.z}`
        : `x${plan.reason}`
      : '';
    if (sig === this.gradeSignature) return;
    this.gradeSignature = sig;

    for (const c of [...this.gradeGroup.children]) {
      this.gradeGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    if (!plan || !plan.ok) return;

    for (const col of plan.columns) {
      for (const y of col.dig) this.gradeGroup.add(gradeBox(col.x, y, col.z, CUT_COLOR, 0.34));
      for (const y of col.fill) this.gradeGroup.add(gradeBox(col.x, y, col.z, FILL_COLOR, 0.34));
      // 出来上がる路面
      this.gradeGroup.add(gradeBox(col.x, col.target, col.z, OK_COLOR, 0.5, 0.14));
    }
  }

  /** 起点だけ決まっている状態の表示。 */
  setAnchor(cell: Cell | null): void {
    const existing = this.group.getObjectByName('anchor');
    if (existing) {
      this.group.remove(existing);
      (existing as THREE.Mesh).geometry.dispose();
    }
    if (!cell) return;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 1.1),
      new THREE.MeshBasicMaterial({ color: 0x63d6ff, wireframe: true, depthTest: false }),
    );
    m.name = 'anchor';
    m.renderOrder = 8;
    cellToWorld(cell.x, cell.y, cell.z, m.position);
    this.group.add(m);
  }

  setPlan(plan: BridgePlan | null, span: SpanCheck | null, loads: PierLoad[]): void {
    const sig = plan
      ? `${plan.type}${plan.a}-${plan.b}@${plan.y}/${plan.cross}:${plan.pierCoords.join(',')}:${Object.entries(plan.foundations).join(',')}:${span?.ok}:${loads.map((l) => (l.ok ? 1 : 0)).join('')}`
      : '';
    if (sig === this.signature) return;
    this.signature = sig;

    for (const c of [...this.planGroup.children]) {
      this.planGroup.remove(c);
      (c as THREE.Mesh).geometry.dispose();
    }
    if (!plan || !span) return;

    const badCoords = new Set(loads.filter((l) => !l.ok).map((l) => l.coord));
    // 支間超過している区間に属する桁マスを赤くする
    const badCells = new Set<number>();
    for (const i of span.violations) {
      const from = span.supports[i] as number;
      const to = span.supports[i + 1] as number;
      for (let c = from; c <= to; c++) badCells.add(c);
    }

    for (let coord = plan.a; coord <= plan.b; coord++) {
      const cell = bridgeCell(plan, coord, plan.y);
      const bad = badCells.has(coord) || badCoords.has(coord);
      const isSupport = coord === plan.a || coord === plan.b || plan.pierCoords.includes(coord);
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.94, isSupport ? 0.42 : 0.2, 0.94),
        new THREE.MeshBasicMaterial({
          color: bad ? NG_COLOR : isSupport ? 0xffffff : OK_COLOR,
          transparent: true,
          opacity: bad ? 0.75 : 0.5,
          depthWrite: false,
        }),
      );
      cellToWorld(cell.x, cell.y, cell.z, box.position);
      box.position.y -= 0.4;
      this.planGroup.add(box);
    }

    // 橋脚の柱
    for (const l of loads) {
      if (l.isAbutment) continue;
      const cell = bridgeCell(plan, l.coord, plan.y);
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, plan.y, 0.34),
        new THREE.MeshBasicMaterial({ color: l.ok ? OK_COLOR : NG_COLOR, transparent: true, opacity: 0.45, depthWrite: false }),
      );
      cellToWorld(cell.x, cell.y, cell.z, post.position);
      post.position.y = plan.y / 2;
      this.planGroup.add(post);
    }
  }
}

function gradeBox(x: number, y: number, z: number, color: number, opacity: number, height = 0.9): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, height, 0.9),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  cellToWorld(x, y, z, m.position);
  return m;
}

import * as THREE from 'three';
import type { Bridge, Pier } from '../core/types.ts';
import { BRIDGES, SUPPORTS } from '../core/config.ts';
import type { Game } from '../sim/Game.ts';
import { bridgeCell } from '../sim/bridge.ts';
import { OX, OZ, cellToWorld } from './Scene.ts';

interface DeckPiece {
  mesh: THREE.Object3D;
  bridge: Bridge;
  coord: number;
}

interface PierPiece {
  mesh: THREE.Mesh;
  bridge: Bridge;
  pier: Pier;
}

/** 桁・橋脚・支保・目印の描画。道路そのものは RoadView が持つ。 */
export class StructureView {
  readonly group = new THREE.Group();
  private deckGroup = new THREE.Group();
  private pierGroup = new THREE.Group();
  private supportGroup = new THREE.Group();

  private decks: DeckPiece[] = [];
  private piers: PierPiece[] = [];
  private signature = '';

  constructor(private game: Game) {
    this.group.add(this.deckGroup, this.pierGroup, this.supportGroup);

    this.group.add(marker(game.start.x, game.start.y, game.start.z, 0x63d6ff));
    this.group.add(marker(game.goal.x, game.goal.y, game.goal.z, 0xffd166));
  }

  /** 構造物の集合が変わったかどうかを安く判定する。 */
  private computeSignature(): string {
    let s = '';
    for (const b of this.game.bridges.bridges) {
      s += `${b.id}:${b.type}:${b.a}-${b.b}@${b.y}/${b.cross}:`;
      s += b.deckAlive.map((d) => (d ? 1 : 0)).join('');
      s += b.piers.map((p) => `${p.coord}${p.alive ? 'a' : 'x'}${p.foundation}${p.baseY}`).join(',');
    }
    s += '|';
    for (const c of this.game.tunnels.cells.values()) {
      if (c.support !== 'none') s += `${c.x},${c.y},${c.z}:${c.support};`;
    }
    return s;
  }

  private rebuild(): void {
    for (const g of [this.deckGroup, this.pierGroup, this.supportGroup]) {
      for (const child of [...g.children]) {
        g.remove(child);
        disposeDeep(child);
      }
    }
    this.decks = [];
    this.piers = [];

    for (const bridge of this.game.bridges.bridges) {
      const spec = BRIDGES[bridge.type];
      for (let i = 0; i < bridge.deckAlive.length; i++) {
        if (!bridge.deckAlive[i]) continue;
        const coord = bridge.a + i;
        const cell = bridgeCell(bridge, coord, bridge.y);
        const piece = makeDeck(bridge, spec.color, spec.railColor);
        cellToWorld(cell.x, cell.y, cell.z, piece.position);
        piece.position.y -= 0.42;
        this.deckGroup.add(piece);
        this.decks.push({ mesh: piece, bridge, coord });
      }
      for (const pier of bridge.piers) {
        if (pier.isAbutment || !pier.alive) continue;
        const cell = bridgeCell(bridge, pier.coord, bridge.y);
        const h = Math.max(0.2, bridge.y - pier.baseY - 1);
        const geo = new THREE.BoxGeometry(pier.foundation === 'none' ? 0.5 : 0.68, h, pier.foundation === 'none' ? 0.5 : 0.68);
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: spec.railColor }));
        mesh.position.set(OX + cell.x + 0.5, pier.baseY + 1 + h / 2, OZ + cell.z + 0.5);
        this.pierGroup.add(mesh);
        this.piers.push({ mesh, bridge, pier });

        if (pier.foundation !== 'none') {
          const footing = new THREE.Mesh(
            new THREE.BoxGeometry(pier.foundation === 'pile' ? 1.0 : 1.2, 0.34, pier.foundation === 'pile' ? 1.0 : 1.2),
            new THREE.MeshLambertMaterial({ color: pier.foundation === 'pile' ? 0x8b98a6 : 0xa8a196 }),
          );
          footing.position.set(OX + cell.x + 0.5, pier.baseY + 1.05, OZ + cell.z + 0.5);
          this.pierGroup.add(footing);
        }
      }
    }

    // 支保。設置したものだけを坑内に描く。
    for (const c of this.game.tunnels.cells.values()) {
      if (c.support === 'none') continue;
      const spec = SUPPORTS[c.support];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 1.0, 1.0),
        new THREE.MeshBasicMaterial({ color: spec.color, wireframe: c.support === 'timber', transparent: true, opacity: c.support === 'timber' ? 0.95 : 0.32, side: THREE.BackSide }),
      );
      cellToWorld(c.x, c.y, c.z, mesh.position);
      this.supportGroup.add(mesh);
    }
  }

  update(): void {
    const sig = this.computeSignature();
    if (sig !== this.signature) {
      this.signature = sig;
      this.rebuild();
    }
    // 沈下は見た目に出す。橋脚が下がり、桁がそれに引きずられて傾く。
    for (const p of this.piers) p.mesh.position.y = p.pier.baseY + 1 + Math.max(0.1, p.bridge.y - p.pier.baseY - 1) / 2 - p.pier.sink;

    for (const d of this.decks) {
      const { drop, slope } = deckOffset(d.bridge, d.coord);
      const cell = bridgeCell(d.bridge, d.coord, d.bridge.y);
      cellToWorld(cell.x, cell.y, cell.z, d.mesh.position);
      d.mesh.position.y -= 0.42 + drop;
      const tilt = Math.atan(slope);
      if (d.bridge.axis === 'x') d.mesh.rotation.set(0, 0, tilt);
      else d.mesh.rotation.set(-tilt, 0, 0);
    }
  }
}

/** 桁マスの沈み量と傾き。左右の支持点の沈下から線形に決める。 */
function deckOffset(bridge: Bridge, coord: number): { drop: number; slope: number } {
  const alive = bridge.piers.filter((p) => p.alive).sort((p, q) => p.coord - q.coord);
  let left: Pier | undefined;
  let right: Pier | undefined;
  for (const p of alive) {
    if (p.coord <= coord) left = p;
    if (p.coord >= coord && !right) right = p;
  }
  if (!left || !right) return { drop: left?.sink ?? right?.sink ?? 0, slope: 0 };
  if (left === right) return { drop: left.sink, slope: 0 };
  const span = right.coord - left.coord;
  const t = (coord - left.coord) / span;
  return { drop: left.sink + (right.sink - left.sink) * t, slope: (right.sink - left.sink) / span };
}

function makeDeck(bridge: Bridge, color: number, railColor: number): THREE.Object3D {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.16, 1.0), new THREE.MeshLambertMaterial({ color }));
  g.add(deck);
  const railMat = new THREE.MeshLambertMaterial({ color: railColor });
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(bridge.axis === 'x' ? 1.0 : 0.1, 0.34, bridge.axis === 'x' ? 0.1 : 1.0), railMat);
    rail.position.set(bridge.axis === 'x' ? 0 : s * 0.45, 0.25, bridge.axis === 'x' ? s * 0.45 : 0);
    g.add(rail);
  }
  return g;
}

function marker(x: number, y: number, z: number, color: number): THREE.Object3D {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 3, 6),
    new THREE.MeshBasicMaterial({ color: 0xe8eef5 }),
  );
  pole.position.y = 1.5;
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 5), new THREE.MeshBasicMaterial({ color }));
  flag.position.y = 3.1;
  g.add(pole, flag);
  cellToWorld(x, y, z, g.position);
  g.position.y = y;
  return g;
}

function disposeDeep(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

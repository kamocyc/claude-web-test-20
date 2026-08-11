import * as THREE from 'three';
import { Material } from '../core/types.ts';
import {
  COLORS,
  CONTOUR_MAJOR,
  CONTOUR_STRENGTH,
  GEO_FADE,
  GEO_OPACITY,
  SMOOTH_PAD,
  UNKNOWN_COLOR,
  WORLD,
} from '../core/config.ts';
import type { Game } from '../sim/Game.ts';
import { buildChunkGeometry } from './ChunkMesher.ts';
import type { ChunkBounds } from './ChunkMesher.ts';
import { OX, OZ } from './Scene.ts';

const CHUNK = 16;
const WATER_TINT = new THREE.Color(0x2f6f9e);

/**
 * 地形の描画と、可視化トグル1つぶんの責務。
 *
 * 「地質ビュー」ボタンを押すと
 *   1. スライダーの位置で地面が手前から切り開かれ (クリップ面のワイプ)
 *   2. 切り口に地層の断面図が現れ
 *   3. 頂点カラーが地質色に切り替わり (調査済みの列だけ。未調査は無彩色のまま)
 *   4. ボーリングコアが立つ
 * 覚えるUIはこのトグル1つとスライダー1本だけ。
 */
export class TerrainView {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh>();
  private dirty = new Set<number>();
  private material: THREE.MeshLambertMaterial;
  private uGeoMix = { value: 0 };
  private uContour = { value: CONTOUR_STRENGTH };
  /** 地質ビューで地面を切り開くための面。通常ビューでは世界の外に逃がしておく。 */
  private clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e4);
  private coreMaterial: THREE.MeshBasicMaterial;

  private cores = new THREE.Group();
  private slice: THREE.Mesh;
  private sliceTex: THREE.DataTexture;
  private sliceZ: number;
  private coresDirty = true;

  geologyView = false;
  private mix = 0;

  private readonly nx: number;
  private readonly nz: number;

  constructor(private game: Game) {
    this.nx = Math.ceil(game.world.sx / CHUNK);
    this.nz = Math.ceil(game.world.sz / CHUNK);

    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      clippingPlanes: [this.clip],
      side: THREE.DoubleSide,
    });
    this.coreMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
      clippingPlanes: [this.clip],
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uGeoMix = this.uGeoMix;
      shader.uniforms.uContour = this.uContour;
      shader.vertexShader = `attribute vec3 colorGeo;\nuniform float uGeoMix;\nvarying float vCellY;\n${shader.vertexShader}`
        .replace(
          '#include <color_vertex>',
          '#include <color_vertex>\n\tvColor.rgb = mix( vColor.rgb, colorGeo, uGeoMix );',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvCellY = position.y;');
      // 地形を滑らかにすると高さが読めなくなるので、等高線を薄く重ねる。
      // 地図と同じで、5本ごとに計曲線を濃くする。
      shader.fragmentShader = `uniform float uContour;\nvarying float vCellY;\n${shader.fragmentShader}`.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
	{
		float e = vCellY;
		float w = max( fwidth( e ), 1e-4 ) * 0.9;
		float d = abs( e - floor( e + 0.5 ) );
		float line = 1.0 - smoothstep( 0.0, w, d );
		float major = mod( floor( e + 0.5 ), ${CONTOUR_MAJOR.toFixed(1)} ) == 0.0 ? 1.0 : 0.45;
		diffuseColor.rgb *= 1.0 - uContour * line * major;
	}`,
      );
    };

    for (let cx = 0; cx < this.nx; cx++) {
      for (let cz = 0; cz < this.nz; cz++) this.dirty.add(cx * this.nz + cz);
    }

    game.world.onCellChange((x, _y, z) => this.markDirty(x, z));

    // 断面図。地質ビューのときだけ出す。
    this.sliceZ = Math.floor(game.world.sz / 2);
    this.sliceTex = new THREE.DataTexture(
      new Uint8Array(WORLD.SX * WORLD.SY * 4),
      WORLD.SX,
      WORLD.SY,
      THREE.RGBAFormat,
    );
    this.sliceTex.magFilter = THREE.NearestFilter;
    this.sliceTex.minFilter = THREE.NearestFilter;
    this.slice = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD.SX, WORLD.SY),
      new THREE.MeshBasicMaterial({
        map: this.sliceTex,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.slice.position.set(0, WORLD.SY / 2, 0);
    this.slice.renderOrder = 3;
    this.slice.frustumCulled = false;
    this.slice.visible = false;

    this.group.add(this.cores, this.slice);
  }

  /**
   * 1セルの変更が届く範囲だけを作り直す。平滑化が近傍に効くので、
   * チャンクの縁の近くを触ったときだけ隣のチャンクも巻き込む。
   */
  markDirty(x: number, z: number): void {
    const reach = SMOOTH_PAD + 1;
    const cx0 = Math.floor((x - reach) / CHUNK);
    const cx1 = Math.floor((x + reach) / CHUNK);
    const cz0 = Math.floor((z - reach) / CHUNK);
    const cz1 = Math.floor((z + reach) / CHUNK);
    for (let ax = cx0; ax <= cx1; ax++) {
      for (let az = cz0; az <= cz1; az++) {
        if (ax < 0 || az < 0 || ax >= this.nx || az >= this.nz) continue;
        this.dirty.add(ax * this.nz + az);
      }
    }
  }

  /** 調査が入ったら地質色を作り直す必要がある。 */
  markAllDirty(): void {
    for (let cx = 0; cx < this.nx; cx++) {
      for (let cz = 0; cz < this.nz; cz++) this.dirty.add(cx * this.nz + cz);
    }
    this.coresDirty = true;
  }

  setSlice(z: number): void {
    this.sliceZ = Math.max(0, Math.min(this.game.world.sz - 1, Math.round(z)));
    this.refreshSlice();
  }

  get sliceIndex(): number {
    return this.sliceZ;
  }

  toggleGeology(on?: boolean): void {
    this.geologyView = on ?? !this.geologyView;
    if (this.geologyView) {
      this.coresDirty = true;
      this.refreshSlice();
    }
  }

  private rebuildChunk(key: number): void {
    const cz = key % this.nz;
    const cx = (key - cz) / this.nz;
    const bounds: ChunkBounds = {
      x0: cx * CHUNK,
      y0: 0,
      z0: cz * CHUNK,
      x1: Math.min((cx + 1) * CHUNK, this.game.world.sx),
      y1: this.game.world.sy,
      z1: Math.min((cz + 1) * CHUNK, this.game.world.sz),
    };
    const geo = buildChunkGeometry(
      {
        world: this.game.world,
        isKnown: (x, z) => this.game.survey.isKnown(x, z),
        heightAt: (x, z) => this.game.heightAt(x, z),
      },
      bounds,
    );
    const existing = this.meshes.get(key);
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.userData.chunk = key;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
  }

  /** ボーリングを打った列だけ、地層の色が縦に積まれた細い柱を立てる。 */
  private rebuildCores(): void {
    this.coresDirty = false;
    for (const child of [...this.cores.children]) {
      this.cores.remove(child);
      const m = child as THREE.Mesh;
      m.geometry.dispose();
    }
    const world = this.game.world;
    const boxes: THREE.BufferGeometry[] = [];
    const colors: number[] = [];
    for (const { x, z } of this.game.survey.bores()) {
      const top = world.surfaceY(x, z);
      for (let y = 0; y <= top; y++) {
        const m = world.getOrig(x, y, z);
        if (m === Material.AIR) continue;
        const g = new THREE.BoxGeometry(0.26, 1, 0.26);
        g.translate(OX + x + 0.5, y + 0.5, OZ + z + 0.5);
        boxes.push(g);
        const c = new THREE.Color(COLORS[m]);
        for (let i = 0; i < g.attributes.position!.count; i++) colors.push(c.r, c.g, c.b);
      }
    }
    if (boxes.length === 0) return;
    const merged = mergeGeometries(boxes);
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    for (const g of boxes) g.dispose();
    const mesh = new THREE.Mesh(merged, this.coreMaterial);
    mesh.renderOrder = 4;
    this.cores.add(mesh);
  }

  /**
   * 断面図テクスチャ。
   * 調査済みの列だけがはっきりした地質色になり、未調査の列は薄い影のままになる。
   * 「どこまで分かっていて、どこから勘なのか」がこの1枚で読める。
   */
  private refreshSlice(): void {
    const data = this.sliceTex.image.data as Uint8Array;
    const world = this.game.world;
    const c = new THREE.Color();
    for (let x = 0; x < world.sx; x++) {
      const known = this.game.survey.isKnown(x, this.sliceZ);
      for (let y = 0; y < world.sy; y++) {
        const i = (y * world.sx + x) * 4;
        const cur = world.get(x, y, this.sliceZ);
        const orig = world.getOrig(x, y, this.sliceZ);
        const belowWater = y < world.waterTableY;

        if (cur === Material.AIR && orig === Material.AIR) {
          data[i + 3] = 0; // もともと空
          continue;
        }
        if (cur === Material.AIR) {
          // 掘った空洞は必ずはっきり抜けて見える
          data[i] = 10;
          data[i + 1] = 13;
          data[i + 2] = 17;
          data[i + 3] = 255;
          continue;
        }
        if (!known) {
          // 未調査は薄い影。ここが「勘で掘る」領域。
          c.setHex(UNKNOWN_COLOR);
          data[i] = c.r * 255;
          data[i + 1] = c.g * 255;
          data[i + 2] = c.b * 255;
          data[i + 3] = ((x + y) & 1) === 0 ? 96 : 58;
          continue;
        }
        c.setHex(COLORS[cur]);
        if (belowWater) c.lerp(WATER_TINT, 0.28); // 水位より下はひと目で分かるように
        data[i] = c.r * 255;
        data[i + 1] = c.g * 255;
        data[i + 2] = c.b * 255;
        data[i + 3] = 255;
      }
    }
    this.sliceTex.needsUpdate = true;
    this.slice.position.z = OZ + this.sliceZ + 0.5;
  }

  update(dt: number): void {
    let budget = 2;
    for (const key of this.dirty) {
      this.rebuildChunk(key);
      this.dirty.delete(key);
      if (--budget <= 0) break;
    }
    if (this.coresDirty) this.rebuildCores();

    const target = this.geologyView ? 1 : 0;
    if (this.mix !== target) {
      const step = dt / GEO_FADE;
      this.mix = target > this.mix ? Math.min(target, this.mix + step) : Math.max(target, this.mix - step);
      this.uGeoMix.value = this.mix;
      // 地質ビューでは地層の厚みを読ませたいので、等高線を少しだけ濃くする。
      this.uContour.value = CONTOUR_STRENGTH * (1 + 0.7 * this.mix);
      this.material.opacity = 1 - (1 - GEO_OPACITY) * this.mix;
      this.material.depthWrite = true;
    }
    // 手前側を奥へ向かって拭き取るように切り開く。
    const front = OZ + this.game.world.sz + 2;
    const cut = OZ + this.sliceZ + 0.5;
    this.clip.constant = this.mix <= 0.001 ? 1e4 : front + (cut - front) * this.mix;

    this.cores.visible = this.mix > 0.05;
    this.slice.visible = this.mix > 0.05;
    const m = this.slice.material as THREE.MeshBasicMaterial;
    m.opacity = this.mix;
  }
}

/** three の BufferGeometryUtils を使わずに済ませる最小のマージ。 */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position!.count;
    indexCount += g.index ? g.index.count : 0;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    positions.set(pos.array as Float32Array, vo * 3);
    normals.set(nrm.array as Float32Array, vo * 3);
    const idx = g.index!;
    for (let i = 0; i < idx.count; i++) indices[io + i] = idx.getX(i) + vo;
    io += idx.count;
    vo += pos.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

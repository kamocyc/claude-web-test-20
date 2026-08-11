import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WORLD, WATER_COLOR, V_RENDER } from '../core/config.ts';

/** セル座標 → ワールド座標 (セルの中心)。世界は原点まわりに中央寄せする。 */
export const OX = -WORLD.SX / 2;
export const OZ = -WORLD.SZ / 2;

/**
 * セル座標系のまま置ける。縦倍率は `Scene.world` グループがまとめて掛ける。
 * ジオメトリを作る側は倍率を意識しなくていい。
 */
export function cellToWorld(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(OX + x + 0.5, y + 0.5, OZ + z + 0.5);
}

/** セル座標 → 画面上の実座標 (縦倍率込み)。カメラを寄せるときに使う。 */
export function cellToView(x: number, y: number, z: number, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(OX + x + 0.5, (y + 0.5) * V_RENDER, OZ + z + 0.5);
}

/** 平行移動の基準速度 (単位/秒)。 */
const PAN_SPEED = 26;
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const DELTA = new THREE.Vector3();

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function worldToCell(p: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: Math.floor(p.x - OX), y: Math.floor(p.y), z: Math.floor(p.z - OZ) };
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly water: THREE.Mesh;
  /**
   * 世界の中身は全部ここに入れる。セル座標のまま組み立てて、
   * 縦倍率 (V_RENDER) だけをここで一括で掛ける。
   */
  readonly world = new THREE.Group();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x0e1116);
    this.renderer.localClippingEnabled = true;

    this.scene.fog = new THREE.Fog(0x0e1116, 130, 330);

    this.world.scale.y = V_RENDER;
    this.scene.add(this.world);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600);
    this.camera.position.set(-26, 60, 58);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 11, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 220;
    this.controls.update();

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3128, 1.15);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2df, 1.5);
    sun.position.set(40, 60, 25);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x8fb7ff, 0.4);
    rim.position.set(-30, 20, -40);
    this.scene.add(rim);

    // 地下水位を示す一枚の水平面。「水位より下は面倒」を一目で分からせる。
    const waterGeo = new THREE.PlaneGeometry(WORLD.SX, WORLD.SZ);
    const waterMat = new THREE.MeshBasicMaterial({
      color: WATER_COLOR,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.water = new THREE.Mesh(waterGeo, waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(0, WORLD.WATER_TABLE_Y, 0);
    this.water.renderOrder = 2;
    this.world.add(this.water);

    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = this.renderer.domElement.clientWidth || innerWidth;
    const h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 視点を水平に平行移動する。カメラの向きを基準にするので、
   * 回してから動かしても「見えている向き」で動く。
   * 引きの絵ほど速く動かないと遠く感じるので、距離に比例させている。
   */
  pan(right: number, forward: number, dt: number): void {
    if (right === 0 && forward === 0) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const speed = PAN_SPEED * Math.max(0.35, distance / 60) * dt;

    this.camera.getWorldDirection(FORWARD);
    FORWARD.y = 0;
    if (FORWARD.lengthSq() < 1e-6) FORWARD.set(0, 0, -1);
    FORWARD.normalize();
    RIGHT.crossVectors(FORWARD, UP).normalize();

    DELTA.set(0, 0, 0).addScaledVector(RIGHT, right * speed).addScaledVector(FORWARD, forward * speed);

    // 世界の外まで飛んでいかないように注視点を閉じ込める。
    const margin = 12;
    const tx = clamp(this.controls.target.x + DELTA.x, -WORLD.SX / 2 - margin, WORLD.SX / 2 + margin);
    const tz = clamp(this.controls.target.z + DELTA.z, -WORLD.SZ / 2 - margin, WORLD.SZ / 2 + margin);
    DELTA.x = tx - this.controls.target.x;
    DELTA.z = tz - this.controls.target.z;

    this.controls.target.add(DELTA);
    this.camera.position.add(DELTA);
    this.controls.update();
  }

  /** 指定セルにカメラの注視点を寄せる (警告からのジャンプ用)。 */
  focus(x: number, y: number, z: number): void {
    const target = cellToView(x, y, z);
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset.setLength(Math.min(offset.length(), 46)));
    this.controls.update();
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

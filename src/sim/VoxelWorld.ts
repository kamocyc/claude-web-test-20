import { Material, isSolidMaterial } from '../core/types.ts';

export type CellChangeListener = (x: number, y: number, z: number, before: Material, after: Material) => void;

/**
 * 材質のボクセル格子。掘削・盛土・崩落の埋め戻しはすべてここへのセル書き換えに統一される。
 *
 * `mat`  … 現在の材質 (掘削済みは AIR)
 * `orig` … 元の地質。崩落時の埋め戻しと、必要支保レベルの判定に使う
 */
export class VoxelWorld {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly waterTableY: number;

  readonly mat: Uint8Array;
  readonly orig: Uint8Array;

  /**
   * 一度でも人の手が入った列。
   * 描画側は、手つかずの列だけを worldgen の連続高さに吸着させて完全に滑らかにし、
   * 掘った/盛った列はボクセルの形をそのまま拾う。
   */
  readonly columnModified: Uint8Array;

  /** 変更のあったセルを購読する (メッシュ再構築・構造物の再検証) */
  private listeners: CellChangeListener[] = [];

  constructor(sx: number, sy: number, sz: number, waterTableY: number) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.waterTableY = waterTableY;
    const n = sx * sy * sz;
    this.mat = new Uint8Array(n);
    this.orig = new Uint8Array(n);
    this.columnModified = new Uint8Array(sx * sz);
  }

  /** その列に人の手が入っているか。 */
  isColumnModified(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return true;
    return this.columnModified[x * this.sz + z] === 1;
  }

  onCellChange(fn: CellChangeListener): void {
    this.listeners.push(fn);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  key(x: number, y: number, z: number): number {
    return (x * this.sy + y) * this.sz + z;
  }

  unkey(k: number): { x: number; y: number; z: number } {
    const z = k % this.sz;
    const rest = (k - z) / this.sz;
    const y = rest % this.sy;
    const x = (rest - y) / this.sy;
    return { x, y, z };
  }

  /** 範囲外は AIR 扱い(ただし底面より下は岩盤として扱いたい場合は isSupported を使う)。 */
  get(x: number, y: number, z: number): Material {
    if (!this.inBounds(x, y, z)) return Material.AIR;
    return this.mat[this.key(x, y, z)] as Material;
  }

  getOrig(x: number, y: number, z: number): Material {
    if (!this.inBounds(x, y, z)) return Material.AIR;
    return this.orig[this.key(x, y, z)] as Material;
  }

  isSolid(x: number, y: number, z: number): boolean {
    return isSolidMaterial(this.get(x, y, z));
  }

  /** 生成時専用。リスナーを呼ばずに一括で書き込む。 */
  initSet(x: number, y: number, z: number, m: Material): void {
    const k = this.key(x, y, z);
    this.mat[k] = m;
    this.orig[k] = m;
  }

  set(x: number, y: number, z: number, m: Material, alsoOrig = false): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const k = this.key(x, y, z);
    const before = this.mat[k] as Material;
    if (before === m && !alsoOrig) return false;
    this.mat[k] = m;
    if (alsoOrig) this.orig[k] = m;
    this.columnModified[x * this.sz + z] = 1;
    for (const fn of this.listeners) fn(x, y, z, before, m);
    return true;
  }

  /** 掘削。元の地質は orig に残す。 */
  excavate(x: number, y: number, z: number): boolean {
    return this.set(x, y, z, Material.AIR, false);
  }

  /** 崩落による埋め戻し。元の地質に戻す。 */
  backfill(x: number, y: number, z: number): boolean {
    return this.set(x, y, z, this.getOrig(x, y, z), false);
  }

  /** 盛土。土を置く(元の地質も土になる)。 */
  fill(x: number, y: number, z: number): boolean {
    return this.set(x, y, z, Material.DIRT, true);
  }

  /** 列の最上部の固体セルの y。何も無ければ -1。 */
  surfaceY(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return -1;
    for (let y = this.sy - 1; y >= 0; y--) {
      if (this.mat[this.key(x, y, z)] !== Material.AIR) return y;
    }
    return -1;
  }

  /** y より下で最初に見つかる固体セルの y。無ければ -1。 */
  solidBelow(x: number, y: number, z: number): number {
    for (let yy = Math.min(y, this.sy) - 1; yy >= 0; yy--) {
      if (this.isSolid(x, yy, z)) return yy;
    }
    return -1;
  }

  /** そのセルより上に固体があるか = 土被りがあるか。 */
  isBuried(x: number, y: number, z: number): boolean {
    for (let yy = y + 1; yy < this.sy; yy++) {
      if (this.isSolid(x, yy, z)) return true;
    }
    return false;
  }

  /** 土被りの厚さ(そのセルより上にある固体セルの数)。 */
  coverThickness(x: number, y: number, z: number): number {
    let n = 0;
    for (let yy = y + 1; yy < this.sy; yy++) {
      if (this.isSolid(x, yy, z)) n++;
    }
    return n;
  }

  /** 地下水位より下か。 */
  isBelowWaterTable(y: number): boolean {
    return y < this.waterTableY;
  }
}

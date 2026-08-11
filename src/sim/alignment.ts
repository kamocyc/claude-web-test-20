import type { Cell } from '../core/types.ts';
import {
  CELL_SIZE_M,
  GRADE_RUN,
  ROAD_BANK,
  ROAD_CORRIDOR,
  ROAD_CURVE_WINDOW,
  ROAD_PROFILE_CLAMP,
  ROAD_PROFILE_WINDOW,
  ROAD_SAMPLE,
} from '../core/config.ts';

/**
 * マス目の経路を、道路の線形に直す。
 *
 * 経路探索が返すのは1マスずつの折れ線で、90度の角と1マスの段差がそのまま入っている。
 * 実際の道路はそこを平面曲線と縦断曲線ですりつけて走る。ここでやるのはその変換で、
 * three には一切依存しないので単体テストできる。
 *
 *   1. 角を丸める (Chaikin)
 *   2. 経路の帯から出ないように押し戻す — 道路が地形にめり込むのを防ぐ拘束
 *   3. 弧長で等間隔に取り直す
 *   4. 縦断曲線: y を移動平均ですりつける。勾配ルールのおかげで元が緩いので、
 *      これで連続勾配のすりつけになる
 *   5. 勾配・曲率・片勾配を出す
 */

export interface AlignmentPoint {
  /** セル座標 (x, z はセルの中心が .5)。 */
  x: number;
  y: number;
  z: number;
  /** 進行方向の水平単位ベクトル。 */
  tx: number;
  tz: number;
  /** 実寸の勾配 (0〜1)。 */
  grade: number;
  /** 水平曲率 (1/マス)。左カーブが正。 */
  curvature: number;
  /** 片勾配 (ラジアン)。 */
  bank: number;
  /** 起点からの弧長 (マス)。センターラインの繰り返しに使う。 */
  s: number;
}

export interface AlignmentOptions {
  /**
   * その列で道路が乗る高さ。手つかずの地形は平滑化で丸めが消えているので、
   * ボクセルの y ではなく見えている面の高さを返してもらう必要がある。
   */
  surfaceAt?: (cell: Cell) => number;
}

/**
 * 勾配を測る基線の半分の長さ (サンプル数)。前後あわせて GRADE_RUN マス。
 * 1サンプルぶんの傾きではなく、実際に走って体感する長さで測る。
 */
const GRADE_BASELINE = Math.max(1, Math.round(GRADE_RUN / ROAD_SAMPLE / 2));

interface P3 {
  x: number;
  y: number;
  z: number;
}

export function buildAlignment(cells: Cell[], options: AlignmentOptions = {}): AlignmentPoint[] {
  if (cells.length < 2) return [];
  const surfaceAt = options.surfaceAt ?? ((c: Cell) => c.y);

  const raw: P3[] = cells.map((c) => ({ x: c.x + 0.5, y: surfaceAt(c), z: c.z + 0.5 }));
  const anchors = raw.map((p) => ({ x: p.x, z: p.z }));

  let pts = resample(raw, ROAD_SAMPLE);
  if (pts.length < 2) return [];

  // 平面曲線。窓の長さがそのまま曲がりの大きさになるので、
  // 「どのくらいの半径で曲がるか」を1つの数字で決められる。
  smoothPlan(pts, ROAD_CURVE_WINDOW / ROAD_SAMPLE, anchors);
  // 縦断曲線。
  smoothProfile(pts, ROAD_PROFILE_WINDOW / ROAD_SAMPLE);
  // 端は START と GOAL のマスから動かさない。
  const head = raw[0] as P3;
  const tail = raw[raw.length - 1] as P3;
  (pts[0] as P3).x = head.x;
  (pts[0] as P3).z = head.z;
  (pts[pts.length - 1] as P3).x = tail.x;
  (pts[pts.length - 1] as P3).z = tail.z;

  // ならすと点の間隔が崩れる。曲率も勾配も間隔を前提に測るので、取り直す。
  pts = resample(pts, ROAD_SAMPLE);
  if (pts.length < 3) return [];

  const out: AlignmentPoint[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as P3;
    const prev = pts[Math.max(0, i - 1)] as P3;
    const next = pts[Math.min(pts.length - 1, i + 1)] as P3;

    if (i > 0) s += Math.hypot(p.x - prev.x, p.z - prev.z);

    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;

    // 勾配は1サンプルぶんではなく、走ってみて分かる長さ (1マス) で測る。
    const back = pts[Math.max(0, i - GRADE_BASELINE)] as P3;
    const fwd = pts[Math.min(pts.length - 1, i + GRADE_BASELINE)] as P3;
    const run = Math.hypot(fwd.x - back.x, fwd.z - back.z);
    const grade = run > 1e-6 ? (Math.abs(fwd.y - back.y) * CELL_SIZE_M.V) / (run * CELL_SIZE_M.H) : 0;
    const curvature = curvatureAt(prev, p, next);
    const bank = Math.max(-0.28, Math.min(0.28, curvature * ROAD_BANK));

    out.push({ x: p.x, y: p.y, z: p.z, tx, tz, grade, curvature, bank, s });
  }
  return out;
}

/**
 * 平面曲線。x と z を窓でならして角を丸め、そのつど経路の帯に押し戻す。
 * 窓の長さが曲がりの大きさを決める。
 */
function smoothPlan(pts: P3[], window: number, anchors: { x: number; z: number }[]): void {
  const half = Math.max(1, Math.round(window / 2));
  for (let pass = 0; pass < 2; pass++) {
    const sx = pts.map((p) => p.x);
    const sz = pts.map((p) => p.z);
    for (let i = 0; i < pts.length; i++) {
      let ax = 0;
      let az = 0;
      let n = 0;
      for (let j = i - half; j <= i + half; j++) {
        const k = Math.min(pts.length - 1, Math.max(0, j));
        ax += sx[k] as number;
        az += sz[k] as number;
        n++;
      }
      const p = pts[i] as P3;
      p.x = ax / n;
      p.z = az / n;
    }
    clampToCorridor(pts, anchors);
  }
}

function mix(a: P3, b: P3, t: number): P3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * 経路のマスから離れすぎた点を引き戻す。
 * 丸めすぎて道路が斜面にめり込んだり空中に出たりしないための拘束。
 */
function clampToCorridor(pts: P3[], anchors: { x: number; z: number }[]): void {
  for (const p of pts) {
    let bestD = Infinity;
    let bx = p.x;
    let bz = p.z;
    for (const a of anchors) {
      const d = (a.x - p.x) ** 2 + (a.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bx = a.x;
        bz = a.z;
      }
    }
    const dist = Math.sqrt(bestD);
    if (dist <= ROAD_CORRIDOR || dist < 1e-9) continue;
    const t = ROAD_CORRIDOR / dist;
    p.x = bx + (p.x - bx) * t;
    p.z = bz + (p.z - bz) * t;
  }
}

/** 弧長で等間隔に取り直す。 */
function resample(pts: P3[], step: number): P3[] {
  // 入力の点をそのまま参照に入れない。あとで平滑化が破壊的に書き換えるので、
  // 元の座標を残しておけなくなる。
  const out: P3[] = [{ ...(pts[0] as P3) }];
  // 先頭は入れ終わっているので、次のサンプルは step だけ進んだところから。
  // 0 から始めると先頭が二重になり、長さ0の区間ができて進行方向が壊れる。
  let carry = step;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as P3;
    const b = pts[i + 1] as P3;
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (len < 1e-9) continue;
    let t = carry;
    while (t < len) {
      out.push(mix(a, b, t / len));
      t += step;
    }
    carry = t - len;
  }
  // 終点は必ず入れるが、直前のサンプルと近すぎると
  // そこだけ極端に短い区間になり、勾配が跳ね上がって見える。
  const last = pts[pts.length - 1] as P3;
  const prev = out[out.length - 1] as P3;
  if (Math.hypot(last.x - prev.x, last.y - prev.y, last.z - prev.z) < step * 0.5) out.pop();
  out.push({ ...last });
  return out;
}

/**
 * 縦断曲線。y だけをならす。
 *
 * 移動平均を2回かけると、1回のときに残る細かい波が消えて勾配が一定になる
 * (箱型を2回 = 三角形の重み)。ただしそれだけだと丘や谷を無視して路面が
 * 地面から浮くので、最後に元の地表から ROAD_PROFILE_CLAMP 以内に押し戻す。
 */
function smoothProfile(pts: P3[], window: number): void {
  const raw = pts.map((p) => p.y);
  boxFilter(pts, window);
  boxFilter(pts, window);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as P3;
    const base = raw[i] as number;
    p.y = Math.max(base - ROAD_PROFILE_CLAMP, Math.min(base + ROAD_PROFILE_CLAMP, p.y));
  }
}

function boxFilter(pts: P3[], window: number): void {
  const half = Math.max(1, Math.round(window / 2));
  const src = pts.map((p) => p.y);
  for (let i = 0; i < pts.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      // 端は端点の値で埋める。線形に延長すると、端に段差があったときに
      // その傾きをそのまま外へ伸ばしてしまい、かえって急になる。
      const k = Math.min(src.length - 1, Math.max(0, j));
      sum += src[k] as number;
      n++;
    }
    (pts[i] as P3).y = sum / n;
  }
}

/** 3点から水平曲率。左カーブが正。 */
function curvatureAt(a: P3, b: P3, c: P3): number {
  const v1x = b.x - a.x;
  const v1z = b.z - a.z;
  const v2x = c.x - b.x;
  const v2z = c.z - b.z;
  const cross = v1x * v2z - v1z * v2x;
  const l1 = Math.hypot(v1x, v1z);
  const l2 = Math.hypot(v2x, v2z);
  const l3 = Math.hypot(c.x - a.x, c.z - a.z);
  if (l1 < 1e-9 || l2 < 1e-9 || l3 < 1e-9) return 0;
  return (2 * cross) / (l1 * l2 * l3);
}

/** 線形全体の最急勾配 (0〜1)。 */
export function alignmentGrade(points: AlignmentPoint[]): number {
  let worst = 0;
  for (const p of points) worst = Math.max(worst, p.grade);
  return worst;
}

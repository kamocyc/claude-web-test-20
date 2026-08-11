import { describe, expect, it } from 'vitest';
import type { Cell } from '../src/core/types.ts';
import { CELL_SIZE_M, GRADE_RUN, MAX_GRADE, ROAD_CORRIDOR } from '../src/core/config.ts';
import { alignmentGrade, buildAlignment } from '../src/sim/alignment.ts';

/** 経路セルの中心からいちばん近い距離。 */
function distanceToCorridor(p: { x: number; z: number }, cells: Cell[]): number {
  let best = Infinity;
  for (const c of cells) best = Math.min(best, Math.hypot(c.x + 0.5 - p.x, c.z + 0.5 - p.z));
  return best;
}

/** L 字に曲がる経路。マス目のままだと 90 度の角がある。 */
function lShape(): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x <= 10; x++) cells.push({ x, y: 5, z: 0 });
  for (let z = 1; z <= 10; z++) cells.push({ x: 10, y: 5, z });
  return cells;
}

describe('道路の線形', () => {
  it('2点未満なら線形にならない', () => {
    expect(buildAlignment([])).toHaveLength(0);
    expect(buildAlignment([{ x: 0, y: 5, z: 0 }])).toHaveLength(0);
  });

  it('90度の角が丸まる (マス目の折れ線がそのまま出てこない)', () => {
    const cells = lShape();
    const pts = buildAlignment(cells);
    const maxCurvature = Math.max(...pts.map((p) => Math.abs(p.curvature)));
    // 曲率が有限 = 角が丸まっている。半径 0.5 マス以上。
    expect(maxCurvature).toBeGreaterThan(0);
    expect(1 / maxCurvature).toBeGreaterThan(0.5);

    // 角のところで進行方向が連続的に変わる (どこかで一気に90度回らない)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const dot = a.tx * b.tx + a.tz * b.tz;
      expect(Math.acos(Math.min(1, Math.max(-1, dot)))).toBeLessThan(0.5); // 30度未満
    }
  });

  it('丸めても経路の帯から出ない (道路が斜面にめり込まない)', () => {
    const pts = buildAlignment(lShape());
    for (const p of pts) {
      expect(distanceToCorridor(p, lShape())).toBeLessThanOrEqual(ROAD_CORRIDOR + 1e-6);
    }
  });

  it('両端は START と GOAL のセルから動かない', () => {
    const cells = lShape();
    const pts = buildAlignment(cells);
    const first = pts[0]!;
    const last = pts.at(-1)!;
    expect(distanceToCorridor(first, [cells[0]!])).toBeLessThan(1e-6);
    expect(distanceToCorridor(last, [cells.at(-1)!])).toBeLessThan(1e-6);
  });

  it('縦断曲線ですりつけたあとも、勾配は上限を超えない', () => {
    // 勾配ルールが許すぎりぎりの経路: GRADE_RUN マスごとに1マス上がる
    const cells: Cell[] = [];
    for (let x = 0; x < 40; x++) cells.push({ x, y: 5 + Math.floor(x / GRADE_RUN), z: 0 });
    // 終点は平坦。実際の GOAL は台地の上にある。
    for (let x = 40; x < 45; x++) cells.push({ x, y: 5 + Math.floor(39 / GRADE_RUN), z: 0 });
    const pts = buildAlignment(cells);
    // 上限ちょうど。線形は弧長で測るので、格子の上で定義した上限とは
    // サンプリングのぶんだけ (1%未満) ずれる。
    expect(alignmentGrade(pts)).toBeLessThanOrEqual(MAX_GRADE * 1.01);
  });

  it('経路の最後の1マスが段差でも、生の階段よりはるかに緩くなる', () => {
    // すりつける先が無いので上限ちょうどには収まらない。それでも
    // マス目そのまま (1マスで1マス = 25%) とは比べものにならない。
    const cells: Cell[] = [];
    for (let x = 0; x < 40; x++) cells.push({ x, y: 5 + Math.floor(x / GRADE_RUN), z: 0 });
    const pts = buildAlignment(cells);
    expect(alignmentGrade(pts)).toBeLessThan(MAX_GRADE * 1.15);
    expect(alignmentGrade(pts)).toBeLessThan((CELL_SIZE_M.V / CELL_SIZE_M.H) * 0.5);
  });

  it('平坦な経路には勾配もバンクもつかない', () => {
    const cells: Cell[] = [];
    for (let x = 0; x < 20; x++) cells.push({ x, y: 5, z: 0 });
    const pts = buildAlignment(cells);
    expect(alignmentGrade(pts)).toBeCloseTo(0, 6);
    for (const p of pts) expect(Math.abs(p.bank)).toBeLessThan(1e-6);
  });

  it('カーブの外側が上がる (片勾配)', () => {
    const pts = buildAlignment(lShape());
    const curved = pts.filter((p) => Math.abs(p.curvature) > 1e-3);
    expect(curved.length).toBeGreaterThan(0);
    // 曲率とバンクの符号は一致する = 外側が持ち上がる
    for (const p of curved) expect(Math.sign(p.bank)).toBe(Math.sign(p.curvature));
  });

  it('路面の高さは surfaceAt が返す値に従う (橋の上では桁の高さに乗る)', () => {
    const cells: Cell[] = [];
    for (let x = 0; x < 12; x++) cells.push({ x, y: 20, z: 0 });
    // 谷の上に桁が架かっている想定。格子の地表は低いが、道路は桁に乗る。
    const pts = buildAlignment(cells, { surfaceAt: () => 20 });
    for (const p of pts) expect(p.y).toBeCloseTo(20, 6);
  });

  it('弧長は実際の距離になっている (センターラインの繰り返しがずれない)', () => {
    const cells: Cell[] = [];
    for (let x = 0; x < 21; x++) cells.push({ x, y: 5, z: 0 });
    const pts = buildAlignment(cells);
    expect(pts.at(-1)!.s).toBeCloseTo(20, 1);
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.s).toBeGreaterThanOrEqual(pts[i - 1]!.s);
  });

  it('1セルの実寸法から勾配が出ている', () => {
    // 横8m×縦2m なら、3マスで1マス上がって 8.3%
    expect(MAX_GRADE).toBeCloseTo(CELL_SIZE_M.V / (CELL_SIZE_M.H * GRADE_RUN), 10);
    expect(MAX_GRADE).toBeCloseTo(0.08333, 4);
  });
});

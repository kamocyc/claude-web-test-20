import type { BridgeTypeId, FoundationId, SupportId } from '../core/types.ts';
import type { Game } from '../sim/Game.ts';
import type { Scene } from '../render/Scene.ts';
import type { TerrainView } from '../render/TerrainView.ts';
import type { Hud } from '../ui/Hud.ts';
import type { Tool } from '../ui/tools.ts';

export interface DebugDeps {
  game: Game;
  view: Scene;
  terrain: TerrainView;
  hud: Hud;
  setTool: (tool: Tool) => void;
  commitPlan: () => void;
}

/**
 * スモークテストから叩くための操作 API。
 * 画面クリックを再現しなくても、同じ経路でゲームを動かせるようにしておく。
 */
export function installDebugApi(deps: DebugDeps): void {
  const { game, view, terrain, hud } = deps;

  const api = {
    game,
    survey: (x: number, z: number) => game.doSurvey(x, z),
    dig: (x: number, y: number, z: number) => game.dig(x, y, z),
    fill: (x: number, y: number, z: number) => game.fill(x, y, z),
    support: (x: number, y: number, z: number, id: SupportId) => game.setSupport(x, y, z, id),
    foundation: (x: number, y: number, z: number, id: FoundationId) => game.setFoundation(x, y, z, id),
    plan: (type: BridgeTypeId, a: [number, number, number], b: [number, number, number]) =>
      game.startPlan(type, { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }),
    planStatus: () => {
      const s = game.planStatus();
      if (!s) return null;
      return {
        ok: s.ok,
        reason: s.reason,
        cost: s.cost,
        spans: s.span.spans,
        piers: [...(game.plan?.pierCoords ?? [])],
        loads: s.loads.map((l) => ({ ...l, foundation: game.plan?.foundations[l.coord] ?? 'none' })),
      };
    },
    /** 道路敷設 (整地)。発注前の見積もりと、実際の発注。 */
    gradePlan: (a: [number, number, number], b: [number, number, number]) =>
      game.gradePlan({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }),
    grade: (a: [number, number, number], b: [number, number, number]) =>
      game.planGrade({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }),
    /** 道路の線形 (描画に渡っているもの)。 */
    road: () => {
      const { cells, complete } = game.roadPath();
      return { complete, cells: cells.length, tip: cells.at(-1) ?? null, grade: game.routeGrade() };
    },
    togglePier: (coord: number) => game.togglePier(coord),
    cycleFoundation: (coord: number) => game.cyclePlanFoundation(coord),
    autoFoundations: () => game.autoFillFoundations(),
    commit: () => deps.commitPlan(),
    cancel: () => game.cancelPlan(),
    setTool: (tool: Tool) => deps.setTool(tool),
    help: (on?: boolean) => hud.toggleHelp(on),
    geology: (on?: boolean) => {
      terrain.toggleGeology(on);
      hud.setGeologyActive(terrain.geologyView);
    },
    slice: (z: number) => terrain.setSlice(z),
    focus: (x: number, y: number, z: number) => view.focus(x, y, z),
    camera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
      view.camera.position.set(px, py, pz);
      view.controls.target.set(tx, ty, tz);
      view.controls.update();
    },
    setPaused: (p: boolean) => {
      game.paused = p;
    },
    /** ポーズ中でも決まったステップだけ時間を進める(スクリーンショットの再現性のため)。 */
    step: (seconds: number, dt = 0.05) => {
      const wasPaused = game.paused;
      game.paused = false;
      for (let t = 0; t < seconds; t += dt) game.tick(dt);
      game.paused = wasPaused;
    },
    /** 作業キューが空になるまで進める。 */
    flush: (maxSeconds = 300, dt = 0.05) => {
      const wasPaused = game.paused;
      game.paused = false;
      let t = 0;
      while (game.jobs.length > 0 && t < maxSeconds) {
        game.tick(dt);
        t += dt;
      }
      game.paused = wasPaused;
      return t;
    },
    money: (amount: number) => {
      game.economy.budget += amount;
    },
    state: () => ({
      budget: Math.round(game.economy.budget),
      time: Math.round(game.time * 10) / 10,
      connected: game.routeConnected,
      reachable: game.routeReachable,
      routeLength: game.routeLength,
      grade: Math.round(game.routeGrade() * 1000) / 10,
      won: game.won,
      hazards: game.board.list.map((h) => ({ key: h.key, kind: h.kind, phase: h.phase, remaining: Math.round(h.remaining * 10) / 10, reason: h.reason })),
      bridges: game.bridges.bridges.map((b) => ({
        id: b.id,
        type: b.type,
        deck: b.deckAlive.filter(Boolean).length,
        piers: b.piers.filter((p) => p.alive && !p.isAbutment).map((p) => ({ coord: p.coord, foundation: p.foundation, baseY: p.baseY, sink: Math.round(p.sink * 100) / 100 })),
      })),
      tunnelCells: game.tunnels.cells.size,
      bores: game.survey.boreCount,
      jobs: game.jobs.length,
      geology: terrain.geologyView,
      cameraTarget: [
        Math.round(view.controls.target.x * 100) / 100,
        Math.round(view.controls.target.y * 100) / 100,
        Math.round(view.controls.target.z * 100) / 100,
      ],
      helpOpen: hud.helpOpen,
    }),
    scene: view.scene,
    terrain,
    surfaceY: (x: number, z: number) => game.world.surfaceY(x, z),
    materialAt: (x: number, y: number, z: number) => game.world.get(x, y, z),
  };

  (globalThis as unknown as { __game: typeof api }).__game = api;
}

import './ui/styles.css';
import * as THREE from 'three';
import type { Cell } from './core/types.ts';
import { Game } from './sim/Game.ts';
import { Scene } from './render/Scene.ts';
import { TerrainView } from './render/TerrainView.ts';
import { StructureView } from './render/StructureView.ts';
import { Effects } from './render/Effects.ts';
import { Picker } from './render/Picker.ts';
import { Ghost } from './render/Ghost.ts';
import { Hud } from './ui/Hud.ts';
import type { Tool } from './ui/tools.ts';
import { installDebugApi } from './debug/api.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const game = new Game();
const view = new Scene(canvas);
const terrain = new TerrainView(game);
const structures = new StructureView(game);
const effects = new Effects(game);
const ghost = new Ghost();
const picker = new Picker();

view.scene.add(terrain.group, structures.group, effects.group, ghost.group);

let tool: Tool = { kind: 'survey' };
/** 遊び方を開いているあいだは時間を止める。 */
let pausedByUser = false;
/** 橋の起点。2クリック目でプランになる。 */
let anchor: Cell | null = null;

const hud = new Hud(uiRoot, {
  onHelp: (open) => {
    game.paused = open || pausedByUser;
  },
  onSelect: (t) => {
    tool = t;
    anchor = null;
    ghost.setAnchor(null);
  },
  onToggleGeology: () => {
    terrain.toggleGeology();
    hud.setGeologyActive(terrain.geologyView);
  },
  onSlice: (z) => terrain.setSlice(z),
  onCommit: () => commitPlan(),
  onAutoFoundation: () => {
    const res = game.autoFillFoundations();
    hud.toast(res.reason, res.ok ? 'good' : 'bad');
  },
  onCancel: () => {
    game.cancelPlan();
    anchor = null;
    ghost.setAnchor(null);
  },
  onFocus: (cell) => view.focus(cell.x, cell.y, cell.z),
});

function commitPlan(): void {
  const res = game.commitPlan();
  hud.toast(res.ok ? '着工' : res.reason, res.ok ? 'good' : 'bad');
}

// ---------------------------------------------------------------- 入力

let downX = 0;
let downY = 0;
let dragged = false;

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
  dragged = false;
});

canvas.addEventListener('pointermove', (e) => {
  if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) dragged = true;
  updateCursor(e.clientX, e.clientY);
});

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || dragged) return;
  act(e.clientX, e.clientY, e.shiftKey);
});

/** 押しっぱなしで動かしたいので、キーの状態を持っておく。 */
const held = new Set<string>();
const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, 1],
  s: [0, -1],
  a: [-1, 0],
  d: [1, 0],
  arrowup: [0, 1],
  arrowdown: [0, -1],
  arrowleft: [-1, 0],
  arrowright: [1, 0],
};

addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

function panCamera(dt: number): void {
  let right = 0;
  let forward = 0;
  for (const key of held) {
    const dir = PAN_KEYS[key];
    if (!dir) continue;
    right += dir[0];
    forward += dir[1];
  }
  if (right === 0 && forward === 0) return;
  const boost = held.has('shift') ? 2.4 : 1;
  view.pan(right * boost, forward * boost, dt);
}

addEventListener('keydown', (e) => {
  const lower = e.key.toLowerCase();
  if (lower in PAN_KEYS || lower === 'shift') {
    held.add(lower);
    if (lower.startsWith('arrow')) e.preventDefault();
    return;
  }
  if (e.key === 'g' || e.key === 'G') {
    terrain.toggleGeology();
    hud.setGeologyActive(terrain.geologyView);
    return;
  }
  if (e.key === 'h' || e.key === 'H') {
    hud.toggleHelp();
    return;
  }
  if (e.key === ' ') {
    pausedByUser = !pausedByUser;
    game.paused = pausedByUser;
    hud.toast(pausedByUser ? '一時停止' : '再開');
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && game.plan) {
    commitPlan();
    return;
  }
  if (e.key === 'Escape') {
    if (hud.helpOpen) {
      hud.toggleHelp(false);
      return;
    }
    game.cancelPlan();
    anchor = null;
    ghost.setAnchor(null);
    return;
  }
  hud.selectByKey(e.key);
});

function pick(cx: number, cy: number) {
  return picker.pick(view.camera, terrain.pickables, cx, cy, canvas);
}

/** プラン編集中に、桁マスの座標を取り出す。 */
function planCoordAt(cell: Cell): number | null {
  const plan = game.plan;
  if (!plan) return null;
  const coord = plan.axis === 'x' ? cell.x : cell.z;
  const cross = plan.axis === 'x' ? cell.z : cell.x;
  if (cross !== plan.cross || coord <= plan.a || coord >= plan.b) return null;
  return coord;
}

function updateCursor(cx: number, cy: number): void {
  const hit = pick(cx, cy);
  if (!hit) {
    ghost.setCursor(null);
    return;
  }
  const target = tool.kind === 'dig' || tool.kind === 'survey' ? hit.cell : hit.place;
  ghost.setCursor(target, true);
}

function act(cx: number, cy: number, shift: boolean): void {
  const hit = pick(cx, cy);
  if (!hit) return;
  const { cell, place } = hit;

  // プラン編集中は、橋脚の増減と基礎の切替が最優先。
  if (game.plan) {
    const coord = planCoordAt(place) ?? planCoordAt(cell);
    if (coord !== null) {
      const res = shift ? game.cyclePlanFoundation(coord) : game.togglePier(coord);
      if (!res.ok) hud.toast(res.reason, 'bad');
      return;
    }
  }

  let result = { ok: false, reason: '' };
  switch (tool.kind) {
    case 'survey':
      result = game.doSurvey(cell.x, cell.z);
      break;
    case 'dig':
      result = game.dig(cell.x, cell.y, cell.z);
      break;
    case 'fill':
      result = game.fill(place.x, place.y, place.z);
      break;
    case 'support':
      result = game.setSupport(place.x, place.y, place.z, tool.id);
      break;
    case 'foundation':
      result = game.setFoundation(place.x, place.y, place.z, tool.id);
      break;
    case 'demolish':
      result = game.demolish(place.x, place.y, place.z);
      break;
    case 'bridge': {
      if (!anchor) {
        anchor = place;
        ghost.setAnchor(place);
        hud.toast('起点を置いた。終点をクリック');
        return;
      }
      result = game.startPlan(tool.id, anchor, place);
      anchor = null;
      ghost.setAnchor(null);
      break;
    }
  }
  if (!result.ok) hud.toast(result.reason, 'bad');
}

// ---------------------------------------------------------------- ループ

let last = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  panCamera(dt);
  game.tick(dt);
  drainEvents();

  terrain.update(dt);
  structures.update();
  effects.update(dt);

  const status = game.planStatus();
  ghost.setPlan(game.plan, status?.span ?? null, status?.loads ?? []);

  hud.update(game, dt, terrain.geologyView, terrain.sliceIndex, view.camera, canvas);
  view.render();
  requestAnimationFrame(frame);
}

function drainEvents(): void {
  for (const ev of game.drainEvents()) {
    switch (ev.type) {
      case 'collapse':
        effects.burst(ev.cell.x, ev.cell.y, ev.cell.z);
        hud.toast('崩落', 'bad');
        view.focus(ev.cell.x, ev.cell.y, ev.cell.z);
        break;
      case 'sinkhole':
        effects.burst(ev.cell.x, ev.cell.y, ev.cell.z);
        hud.toast('陥没', 'bad');
        break;
      case 'pierFail':
        effects.burst(ev.cell.x, ev.cell.y, ev.cell.z, 0x8a8f96);
        hud.toast(ev.text ?? '支持を失った', 'bad');
        break;
      case 'surveyed':
        terrain.markAllDirty();
        hud.toast('ボーリング完了');
        break;
      case 'dug':
        if (terrain.geologyView) terrain.setSlice(terrain.sliceIndex);
        break;
      case 'filled':
        if (terrain.geologyView) terrain.setSlice(terrain.sliceIndex);
        break;
      case 'built':
        if (ev.text) hud.toast(`${ev.text} 完了`, 'good');
        break;
      case 'rejected':
        hud.toast(ev.text ?? '建設できない', 'bad');
        break;
      case 'win':
        hud.toast('開通', 'good');
        break;
    }
  }
}

installDebugApi({ game, view, terrain, hud, setTool: (t) => hud.select(t), commitPlan });

requestAnimationFrame(frame);

// 開発中に three が tree-shake されないようにするためではなく、型だけの利用を避けるため
export type { THREE };

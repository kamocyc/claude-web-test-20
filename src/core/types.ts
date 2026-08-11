/**
 * ゲーム全体で共有する型定義。
 * 設計方針: 数字は「耐力」と「荷重」と「支保レベル」だけ。すべて整数。
 */

/** 地質は3種類 + 空気(掘削済み/空)だけ。 */
export const Material = {
  AIR: 0,
  DIRT: 1,
  ROCK: 2,
  WEAK: 3,
} as const;
export type Material = (typeof Material)[keyof typeof Material];

export const MATERIAL_NAMES: Record<Material, string> = {
  [Material.AIR]: '空洞',
  [Material.DIRT]: '土',
  [Material.ROCK]: '岩',
  [Material.WEAK]: '軟弱層',
};

export function isSolidMaterial(m: Material): boolean {
  return m !== Material.AIR;
}

/** 支保は3種類 + 無支保。レベルがそのまま数字になる。 */
export type SupportId = 'none' | 'timber' | 'concrete' | 'steel';

/** 基礎補強。耐力に整数を足すだけ。 */
export type FoundationId = 'none' | 'wide' | 'pile';

/** 橋の種類。支間は表で決め打ち。 */
export type BridgeTypeId = 'wood' | 'concrete' | 'steel' | 'truss' | 'suspension';

export type Axis = 'x' | 'z';

/** ハザードの進行フェーズ。即死は作らない: 予兆 → 猶予 → 崩壊。 */
export const HazardPhase = {
  /** 警告が出ているが、まだ余裕がある */
  WARNING: 'warning',
  /** 予兆フェーズ。砂が落ち、ひびが入り、赤が強く脈打つ */
  OMEN: 'omen',
} as const;
export type HazardPhase = (typeof HazardPhase)[keyof typeof HazardPhase];

export type HazardKind = 'tunnel' | 'settlement';

export interface Hazard {
  /** 安定したキー (UI の行がちらつかないように) */
  key: string;
  kind: HazardKind;
  /** 猶予の残り秒数 */
  remaining: number;
  /** 猶予の総量(秒)。残り/総量 で進行度が出る */
  total: number;
  phase: HazardPhase;
  /** 代表セル(カメラのジャンプ先・エフェクトの発生源) */
  cell: { x: number; y: number; z: number };
  /** プレイヤーに見せる一行の理由 */
  reason: string;
}

export interface Cell {
  x: number;
  y: number;
  z: number;
}

export interface Pier {
  /** 橋の軸方向における座標 */
  coord: number;
  /** 両端の橋台か。橋台は地盤に載っている限り耐力を問わない */
  isAbutment: boolean;
  foundation: FoundationId;
  /** 立っている地盤面の y (柱はこの上に建つ)。地盤が無ければ -1 */
  baseY: number;
  /** 沈下の見た目量 0..1 */
  sink: number;
  /** 沈下の猶予タイマー(秒)。健全なら満タン */
  timer: number;
  alive: boolean;
}

export interface Bridge {
  id: number;
  type: BridgeTypeId;
  axis: Axis;
  /** 桁の高さ (セル y) */
  y: number;
  /** 軸方向の始点・終点 (両端は橋台。inclusive) */
  a: number;
  b: number;
  /** 軸と直交する方向の固定座標 */
  cross: number;
  piers: Pier[];
  /** 桁マスの生死。index 0 が a に対応 */
  deckAlive: boolean[];
}

/** 建設前の検証結果。赤く表示して確定を拒否するために使う。 */
export interface SpanCheck {
  /** 支持点の座標(橋台と橋脚を含む、昇順) */
  supports: number[];
  /** 各支持点間の「柱なしで渡す」マス数 */
  spans: number[];
  /** 支間超過している区間の index */
  violations: number[];
  ok: boolean;
}

export interface PierLoad {
  coord: number;
  isAbutment: boolean;
  /** 受け持つ桁マス数 */
  carried: number;
  /** 荷重(整数) */
  load: number;
  /** 耐力(整数) */
  bearing: number;
  /** 地盤の材質 */
  ground: Material;
  /** 直下に空洞があって耐力が落ちているか */
  undermined: boolean;
  ok: boolean;
}

/** 掘削されたセル1つ分の記録。トンネルの数字は支保レベル1つだけ。 */
export interface TunnelCell {
  x: number;
  y: number;
  z: number;
  /** 掘り取った地質(崩落時の埋め戻しにも使う) */
  origin: Material;
  /** 必要支保レベル */
  required: number;
  /** 設置済み支保 */
  support: SupportId;
  /** 劣化タイマーの残り秒。required <= installed のときは満タンで停止 */
  timer: number;
  /** 土被りがあるか(空に開いていれば支保不要) */
  buried: boolean;
}

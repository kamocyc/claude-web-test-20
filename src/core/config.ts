/**
 * すべてのチューニング定数をここに集める。
 * 「面白さの源泉はトレードオフの構造であって、方程式の精度ではない」ので、
 * バランス調整はこのファイルの数字を触るだけで完結するようにしてある。
 */

import { Material } from './types.ts';
import type { BridgeTypeId, FoundationId, SupportId } from './types.ts';

// ---------------------------------------------------------------- 世界

export const WORLD = {
  /** 進行方向 (START → GOAL) */
  SX: 64,
  /** 高さ */
  SY: 32,
  /** 幅。横に迂回できる余地 */
  SZ: 32,
  /** 地下水位。この y 未満は「水位より下」= 支保レベル +1 */
  WATER_TABLE_Y: 10,
  SEED: 20250811,
} as const;

export const START_CELL = { x: 4, z: 16 } as const;
export const GOAL_CELL = { x: 59, z: 16 } as const;

/**
 * 1セルの実寸法。勾配を現実の % で語るための宣言であって、格子そのものは変えない。
 *
 * 縦を細かく刻む (SY を増やす) 方法もあるが、それだと「トンネルの断面は縦1セル」
 * という前提が壊れ、支保・掘削費・掘削時間・VOID_CHECK_DEPTH・PILE_REACH・
 * SINKHOLE_COVER・水位を全部引き直すことになる。寸法を宣言し直すだけなら、
 * シミュレーションは1行も変わらずに勾配だけが現実の土俵に乗る。
 */
export const CELL_SIZE_M = { H: 8, V: 2 } as const;

/**
 * 1マス上下するのに必要な走り(マス)。これが数字その3。
 * 勾配 = V / (H * GRADE_RUN) = 2 / (8 * 3) = 8.3%。山岳道路の上限あたり。
 *
 * この1つの数字が、橋とトンネルを「近道」から「そこを通る唯一の手段」に変える。
 */
export const GRADE_RUN = 3;

/** 最急勾配 (0〜1)。表示用。 */
export const MAX_GRADE = CELL_SIZE_M.V / (CELL_SIZE_M.H * GRADE_RUN);

// ---------------------------------------------------------------- 地質

/** 地盤の耐力。これが数字その1。 */
export const BEARING: Record<Material, number> = {
  [Material.AIR]: 0,
  [Material.DIRT]: 2,
  [Material.ROCK]: 3,
  [Material.WEAK]: 0,
};

/** 基礎補強で耐力に足す整数。 */
export const FOUNDATION_BONUS: Record<FoundationId, number> = {
  none: 0,
  wide: 1,
  pile: 3,
};

export const FOUNDATION_COST: Record<FoundationId, number> = {
  none: 0,
  wide: 180,
  pile: 520,
};

export const FOUNDATION_NAMES: Record<FoundationId, string> = {
  none: '直接基礎',
  wide: '大型基礎 (+1)',
  pile: '岩着杭 (+3)',
};

/** 岩着杭を打つのに、橋脚直下この距離以内に岩がある必要がある。 */
export const PILE_REACH = 6;

// ---------------------------------------------------------------- 荷重

/**
 * 荷重 = ceil(受け持つ桁マス数 / LOAD_PER_UNIT)。
 *
 * 設計案では「荷重 = 支えている桁のマス数そのもの」だが、それだと支間20の吊橋
 * (橋脚が21マス受け持つ) と耐力3の岩が噛み合わない。除数を1つ挟むことで
 * 支間テーブル全体が耐力テーブルと同じ土俵に乗る。
 * プレイヤーから見た「マス目を数えれば予測できる」性質は維持される。
 */
export const LOAD_PER_UNIT = 4;

/**
 * 橋脚直下この深さ以内に空洞があると、地盤が緩んでいるとみなす。
 * 「トンネルを掘ったら上の橋が沈んだ」を成立させるための唯一の追加ルール。
 */
export const VOID_CHECK_DEPTH = 4;
/** 覆工(レベル2以上)されたトンネルの上なら、耐力の低下はこの分で済む。 */
export const LINED_VOID_PENALTY = 1;

// ---------------------------------------------------------------- 橋

export interface BridgeSpec {
  name: string;
  /** 柱なしで渡せる最大マス数。超えたらそもそも建設できない */
  maxSpan: number;
  costPerCell: number;
  /** 桁1マスあたりの施工秒 */
  buildTime: number;
  color: number;
  railColor: number;
}

export const BRIDGES: Record<BridgeTypeId, BridgeSpec> = {
  wood: { name: '木橋', maxSpan: 3, costPerCell: 60, buildTime: 0.35, color: 0x9a6b3f, railColor: 0x7a5230 },
  concrete: { name: 'コンクリート橋', maxSpan: 5, costPerCell: 140, buildTime: 0.8, color: 0xb8b5ad, railColor: 0x9a978f },
  steel: { name: '鋼橋', maxSpan: 6, costPerCell: 200, buildTime: 0.7, color: 0x6f8494, railColor: 0x546675 },
  truss: { name: 'トラス橋', maxSpan: 10, costPerCell: 320, buildTime: 1.2, color: 0x8e9aa6, railColor: 0x6b7783 },
  suspension: { name: '吊橋', maxSpan: 20, costPerCell: 700, buildTime: 2.0, color: 0xd8d2c4, railColor: 0xb6ae9c },
};

export const BRIDGE_ORDER: BridgeTypeId[] = ['wood', 'concrete', 'steel', 'truss', 'suspension'];

/** 橋脚1マス(高さ1)あたりの建設費。 */
export const PIER_COST_PER_CELL = 45;

// ---------------------------------------------------------------- トンネル

/** 必要支保レベル。これが数字その2。 */
export const REQUIRED_SUPPORT: Record<Material, number> = {
  [Material.AIR]: 0,
  [Material.ROCK]: 0,
  [Material.DIRT]: 1,
  [Material.WEAK]: 2,
};

/** 地下水位より下ならレベル +1。 */
export const WATER_SUPPORT_PENALTY = 1;

export interface SupportSpec {
  name: string;
  level: number;
  cost: number;
  buildTime: number;
  color: number;
}

export const SUPPORTS: Record<SupportId, SupportSpec> = {
  none: { name: '無支保', level: 0, cost: 0, buildTime: 0, color: 0x000000 },
  timber: { name: '木枠', level: 1, cost: 40, buildTime: 0.3, color: 0xa8763f },
  concrete: { name: 'コンクリート覆工', level: 2, cost: 130, buildTime: 1.1, color: 0xc9c6bd },
  steel: { name: '鋼製支保+排水', level: 3, cost: 280, buildTime: 0.6, color: 0x7f93a4 },
};

export const SUPPORT_ORDER: SupportId[] = ['timber', 'concrete', 'steel'];

/** 掘削コスト。岩は遅くて高い、軟弱は楽。 */
export const DIG_COST: Record<Material, number> = {
  [Material.AIR]: 0,
  [Material.DIRT]: 22,
  [Material.ROCK]: 75,
  [Material.WEAK]: 12,
};

export const DIG_TIME: Record<Material, number> = {
  [Material.AIR]: 0,
  [Material.DIRT]: 0.3,
  [Material.ROCK]: 1.2,
  [Material.WEAK]: 0.2,
};

/** 盛土のコストと時間。 */
export const FILL_COST = 30;
export const FILL_TIME = 0.35;

// ---------------------------------------------------------------- 崩壊

/** 猶予秒数。即死は絶対に作らない。 */
export const GRACE_SECONDS = 25;
/** 残りがこの比率を切ったら「予兆」フェーズに入る。 */
export const OMEN_RATIO = 0.6;
/** 崩落したとき、隣接する未対策セルのタイマーをこの比率まで削る(連鎖)。 */
export const SHOCK_FACTOR = 0.5;
/** 土被りがこれ以下のセルが崩落すると、地表まで陥没する。 */
export const SINKHOLE_COVER = 3;
/** 沈下ハザード中に橋脚が沈む最大量(セル単位)。 */
export const MAX_SINK = 0.45;

// ---------------------------------------------------------------- 調査と予算

export const START_BUDGET = 15000;
/** ボーリング1本の費用。縦一列だけ地層が見える。 */
export const SURVEY_COST = 260;
/** 撤去の費用(返金はしない)。 */
export const DEMOLISH_COST = 15;

/** ミッション達成に必要な「ハザード無しで接続が保たれている」秒数。 */
export const WIN_HOLD_SECONDS = 3;

/**
 * 道路として認められる経路の最大マス数。
 * これが無いと「遠回りはタダ」になってしまい、トンネルも切土も選ぶ理由が消える。
 * 遠回りにも値段をつけるための、たった1つの数字。
 */
export const MAX_ROUTE_LENGTH = 74;

// ---------------------------------------------------------------- 表示

export const COLORS = {
  [Material.AIR]: 0x000000,
  [Material.DIRT]: 0x8a6240,
  [Material.ROCK]: 0x7a7d82,
  [Material.WEAK]: 0xd6c04a,
} as const;

/** 未調査の地中はのっぺりした無彩色。 */
export const UNKNOWN_COLOR = 0x3c3f46;
/** 地表(草)の色。地質ビューでは使わない。 */
export const GRASS_COLOR = 0x5f7a4a;
export const WATER_COLOR = 0x2f6f9e;

/** 地質ビューのトランジション秒。 */
export const GEO_FADE = 0.45;
export const GEO_OPACITY = 0.82;

// ---------------------------------------------------------------- 地形の見た目

/**
 * 描画の縦倍率。1セルは横8m×縦2mなので、1.0 は縦を4倍に誇張して描いていることになる。
 * 地形図の縦断図と同じ約束事で、下げれば実寸比に近づくが起伏の迫力は落ちる。
 */
export const V_RENDER = 1;

/** 地形の平滑化の反復回数。増やすほど滑らかだが、地形が本来の位置から離れていく。 */
export const SMOOTH_ITERATIONS = 4;
/** 各頂点が自分のセルの中心から離れてよい上限。マス目の予測可能性を守るための拘束。 */
export const SMOOTH_CLAMP = 0.5;
/**
 * 頂点をここまで動かして曲面に乗るなら、手つかずの地表とみなして吸着させる。
 * これより遠いものは地中や掘った跡なので触らない。
 */
export const SURFACE_SNAP_REACH = 0.75;
/** 平滑化のときに隣接チャンクまで計算する余白。継ぎ目を割らないために要る。 */
export const SMOOTH_PAD = 5;
/** 周囲の詰まり具合から落とす陰の強さ。滑らかな面が地形に見えるかはほぼこれで決まる。 */
export const AO_STRENGTH = 0.42;

/** 等高線の濃さ。0 で消える。 */
export const CONTOUR_STRENGTH = 0.3;
/** 何本ごとに計曲線 (濃い線) にするか。 */
export const CONTOUR_MAJOR = 5;

// ---------------------------------------------------------------- 道路

/** 車道の幅(マス)。1セル8mなので 0.8 で約6.4m = 2車線。 */
export const ROAD_WIDTH = 0.8;
/** 路肩の張り出し(片側・マス)。 */
export const ROAD_SHOULDER = 0.12;
/** 線形をこの間隔(マス)で再サンプルする。 */
export const ROAD_SAMPLE = 0.25;
/**
 * 平面曲線をすりつける窓の長さ (マス)。これがそのまま曲がりの大きさになる。
 * 大きくすると角が緩くなるが、ROAD_CORRIDOR に阻まれてそれ以上は曲がらない。
 */
export const ROAD_CURVE_WINDOW = 2.5;
/** 線形が経路セルの中心から離れてよい距離(マス)。道路が地形にめり込まないための拘束。 */
export const ROAD_CORRIDOR = 0.62;
/**
 * 縦断曲線をすりつける窓の長さ (マス)。
 * 幅 W の移動平均は1マスの段差を勾配 1/W に均すので、GRADE_RUN と揃えておけば
 * すりつけたあとの勾配が上限とほぼ一致する。
 */
export const ROAD_PROFILE_WINDOW = GRADE_RUN;
/**
 * すりつけた路面が、元の地表から離れてよい上限(マス)。
 * これが無いと縦断曲線が谷や丘を無視して、道路が地面から浮く/潜る。
 */
export const ROAD_PROFILE_CLAMP = 0.5;
/** 曲率から片勾配 (バンク) をつける係数。 */
export const ROAD_BANK = 0.5;
/** 路面の色と、未開通区間 (工事中) の色。 */
export const ROAD_COLOR = 0x3a3d42;
export const ROAD_LINE_COLOR = 0xe8e2cf;
export const ROAD_UNBUILT_COLOR = 0xb8862f;

/** 道路敷設 (整地) 1回で扱える長さ(マス)。 */
export const GRADE_TOOL_MAX_LENGTH = 26;

import { HazardPhase } from '../core/types.ts';
import type { Hazard, HazardKind } from '../core/types.ts';
import { OMEN_RATIO } from '../core/config.ts';

/**
 * 予兆 → 猶予 → 崩壊 は、トンネル崩落も橋脚沈下も同じ形にする。
 * 猶予中に対策すれば必ず元に戻る。即死は作らない。
 */
export function hazardPhase(remaining: number, total: number): HazardPhase {
  return remaining / total <= OMEN_RATIO ? HazardPhase.OMEN : HazardPhase.WARNING;
}

/** 進行度 0(健全) .. 1(崩壊直前) */
export function hazardProgress(remaining: number, total: number): number {
  return Math.min(1, Math.max(0, 1 - remaining / total));
}

/**
 * 進行中のハザードを毎 tick 集める掲示板。
 * タイマーの実体はトンネルセルと橋脚が持っているので、ここは表示用の集約に徹する。
 */
export class HazardBoard {
  private map = new Map<string, Hazard>();

  begin(): void {
    this.map.clear();
  }

  add(key: string, kind: HazardKind, cell: { x: number; y: number; z: number }, remaining: number, total: number, reason: string): void {
    this.map.set(key, {
      key,
      kind,
      remaining,
      total,
      phase: hazardPhase(remaining, total),
      cell: { ...cell },
      reason,
    });
  }

  get list(): Hazard[] {
    return [...this.map.values()].sort((a, b) => a.remaining - b.remaining);
  }

  get count(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** いま最も切迫しているハザードの進行度 (画面端のビネットに使う)。 */
  get maxProgress(): number {
    let p = 0;
    for (const h of this.map.values()) p = Math.max(p, hazardProgress(h.remaining, h.total));
    return p;
  }
}

import { START_BUDGET } from '../core/config.ts';

/** 予算は1本だけ。すべての行為に価格がついている。 */
export class Economy {
  budget: number;
  spent = 0;

  constructor(start: number = START_BUDGET) {
    this.budget = start;
  }

  canAfford(cost: number): boolean {
    return cost <= this.budget;
  }

  /** 支払えたら true。足りなければ何もせず false。 */
  pay(cost: number): boolean {
    if (!this.canAfford(cost)) return false;
    this.budget -= cost;
    this.spent += cost;
    return true;
  }
}

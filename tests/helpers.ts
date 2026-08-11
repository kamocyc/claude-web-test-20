import type { Game } from '../src/sim/Game.ts';

/** 作業キューが空になるまで進める(上限つき)。 */
export function flushJobs(game: Game, maxSeconds = 120, dt = 0.05): number {
  let t = 0;
  while (game.jobs.length > 0 && t < maxSeconds) {
    game.tick(dt);
    t += dt;
  }
  return t;
}

/** 指定秒数だけ進める。 */
export function run(game: Game, seconds: number, dt = 0.05): void {
  for (let t = 0; t < seconds; t += dt) game.tick(dt);
}

/** 予算を気にせずテストしたいとき。 */
export function giveMoney(game: Game, amount = 1_000_000): void {
  game.economy.budget += amount;
}

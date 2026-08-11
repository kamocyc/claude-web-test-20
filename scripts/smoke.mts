/**
 * E2E スモーク。
 * `window.__game` 経由で一連のプレイを再現し、各段階のスクリーンショットを artifacts/ に残す。
 *
 *   npm run build && npm run smoke
 *
 * 目的は「見た目の確認」だけでなく、設計案の主張が実際に成立しているかの確認:
 *   - 支間を超えた橋は建設前に拒否される
 *   - 無支保で軟弱層を掘ると予兆を経て崩落する
 *   - 橋脚の下を掘ると沈下し、猶予中に補強すれば戻る
 *   - 谷を渡し、尾根を貫き、START から GOAL まで開通できる
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { Page } from 'playwright';

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = 'artifacts';
const CHROMIUM = '/opt/pw-browsers/chromium';

const Z = 16;
const VALLEY_A = 12;
const VALLEY_B = 29;
const DECK_Y = 19;
const TUNNEL_Y = 20;
const TUNNEL_FROM = 31;
const TUNNEL_TO = 48;

interface Api {
  survey(x: number, z: number): unknown;
  dig(x: number, y: number, z: number): unknown;
  fill(x: number, y: number, z: number): unknown;
  support(x: number, y: number, z: number, id: string): unknown;
  foundation(x: number, y: number, z: number, id: string): unknown;
  plan(type: string, a: [number, number, number], b: [number, number, number]): unknown;
  planStatus(): { ok: boolean; reason: string; cost: number; spans: number[]; piers: number[] } | null;
  togglePier(coord: number): unknown;
  commit(): void;
  cancel(): void;
  geology(on?: boolean): void;
  slice(z: number): void;
  focus(x: number, y: number, z: number): void;
  camera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
  step(seconds: number): void;
  flush(): number;
  state(): Record<string, unknown>;
  surfaceY(x: number, z: number): number;
  materialAt(x: number, y: number, z: number): number;
  game: { tunnels: { cells: Map<number, { x: number; y: number; z: number; required: number; support: string }> } };
}

declare global {
  // eslint-disable-next-line no-var
  var __game: Api;
}

let step = 0;
const failures: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  step++;
  const file = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  📷 ${file}`);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    stdio: 'ignore',
  });
  const stop = (): void => {
    server.kill();
  };
  process.on('exit', stop);

  await waitForServer();

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => globalThis.__game !== undefined, null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  console.log('\n1. 初期状態 — 地質は不明、谷と尾根に阻まれて未通');
  const start = (await page.evaluate(() => globalThis.__game.state())) as { connected: boolean; budget: number };
  check('初期状態では未通', start.connected === false);
  await shot(page, 'start');

  console.log('\n2. 調査 — ボーリングを打った列だけ地層が見える');
  await page.evaluate(
    ([z]) => {
      for (const x of [12, 20, 29, 33, 36, 40, 44, 48]) globalThis.__game.survey(x, z as number);
      globalThis.__game.flush();
      globalThis.__game.geology(true);
      globalThis.__game.slice(z as number);
    },
    [Z],
  );
  await page.waitForTimeout(1400);
  await shot(page, 'survey-geology');
  const surveyed = (await page.evaluate(() => globalThis.__game.state())) as { bores: number; budget: number };
  check('8本の調査が反映される', surveyed.bores === 8);
  check('調査に費用がかかる', surveyed.budget < start.budget);

  console.log('\n3. 支間超過 — 木橋で谷を一気に渡そうとすると、建てる前に拒否される');
  await page.evaluate(() => globalThis.__game.geology(false));
  const rejected = await page.evaluate(
    ([a, b, y, z]) => {
      const g = globalThis.__game;
      g.plan('wood', [a as number, y as number, z as number], [b as number, y as number, z as number]);
      const before = g.planStatus();
      // 自動で入った橋脚を全部外す = 柱なしで渡す
      for (const c of before?.piers ?? []) g.togglePier(c);
      return { before, after: g.planStatus() };
    },
    [VALLEY_A, VALLEY_B, DECK_Y, Z],
  );
  await page.waitForTimeout(600);
  check('橋脚ありなら木橋でも成立する', rejected.before?.ok === true);
  check('橋脚を外すと支間超過で拒否される', rejected.after?.ok === false, JSON.stringify(rejected.after));
  check('理由が支間超過だと分かる', (rejected.after?.reason ?? '').includes('支間超過'));
  await shot(page, 'span-rejected');

  console.log('\n4. トラス橋 — 谷底が軟弱なので橋脚には岩着杭が要る');
  const trussPlan = await page.evaluate(
    ([a, b, y, z]) => {
      globalThis.__game.cancel();
      globalThis.__game.plan('truss', [a as number, y as number, z as number], [b as number, y as number, z as number]);
      return globalThis.__game.planStatus();
    },
    [VALLEY_A, VALLEY_B, DECK_Y, Z],
  );
  check('トラス橋のプランは成立する', trussPlan?.ok === true, JSON.stringify(trussPlan));
  await page.waitForTimeout(500);
  await shot(page, 'truss-plan');

  await page.evaluate(() => {
    globalThis.__game.commit();
    globalThis.__game.flush();
  });
  await page.waitForTimeout(800);
  const built = (await page.evaluate(() => globalThis.__game.state())) as {
    bridges: { deck: number; piers: { foundation: string }[] }[];
  };
  check('橋が架かった', built.bridges.length === 1 && built.bridges[0]!.deck > 0);
  check('谷底の橋脚は岩着杭になっている', built.bridges[0]!.piers.some((p) => p.foundation === 'pile'));
  await shot(page, 'truss-built');

  console.log('\n5. 無支保のトンネル — 破砕帯を掘って放置すると予兆を経て崩落する');
  await page.evaluate(
    ([x, y, z]) => {
      globalThis.__game.camera(-6, 30, 34, 6, 22, 0);
      globalThis.__game.dig(x as number, y as number, z as number);
      globalThis.__game.flush();
    },
    [36, TUNNEL_Y, Z],
  );
  await page.evaluate(() => globalThis.__game.step(14));
  await page.waitForTimeout(700);
  const omen = (await page.evaluate(() => globalThis.__game.state())) as {
    hazards: { kind: string; phase: string; reason: string }[];
  };
  check('無支保の掘削が警告になる', omen.hazards.length === 1, JSON.stringify(omen.hazards));
  check('予兆フェーズに入っている', omen.hazards[0]?.phase === 'omen', JSON.stringify(omen.hazards[0]));
  await shot(page, 'omen');

  await page.evaluate(() => globalThis.__game.step(13));
  await page.waitForTimeout(900);
  const collapsed = (await page.evaluate(
    ([x, y, z]) => ({
      material: globalThis.__game.materialAt(x as number, y as number, z as number),
      state: globalThis.__game.state(),
    }),
    [36, TUNNEL_Y, Z],
  )) as { material: number; state: { hazards: unknown[] } };
  check('崩落して元の地質で埋め戻った', collapsed.material !== 0, `material=${collapsed.material}`);
  check('崩落したので警告も消える', collapsed.state.hazards.length === 0);
  await shot(page, 'collapse');

  console.log('\n6. 支保を入れて掘り直す — 尾根を貫通させる');
  await page.evaluate(
    ([from, to, y, z]) => {
      const g = globalThis.__game;
      for (let x = from as number; x <= (to as number); x++) g.dig(x, y as number, z as number);
      g.flush();
      // 掘った各セルに、必要なだけの支保を入れる
      for (const cell of g.game.tunnels.cells.values()) {
        const id = cell.required >= 3 ? 'steel' : cell.required === 2 ? 'concrete' : cell.required === 1 ? 'timber' : null;
        if (id) g.support(cell.x, cell.y, cell.z, id);
      }
      g.flush();
    },
    [TUNNEL_FROM, TUNNEL_TO, TUNNEL_Y, Z],
  );
  await page.evaluate(() => globalThis.__game.step(30));
  await page.waitForTimeout(900);
  const tunnel = (await page.evaluate(() => globalThis.__game.state())) as {
    hazards: unknown[];
    tunnelCells: number;
    connected: boolean;
  };
  check('支保を入れたトンネルは崩れない', tunnel.hazards.length === 0, JSON.stringify(tunnel.hazards));
  check('トンネルが掘れている', tunnel.tunnelCells > 10, String(tunnel.tunnelCells));
  await page.evaluate(() => {
    globalThis.__game.camera(-34, 26, 30, 0, 20, 0);
    globalThis.__game.geology(true);
  });
  await page.waitForTimeout(1200);
  await shot(page, 'tunnel-supported');

  console.log('\n7. 開通判定');
  await page.evaluate(() => {
    globalThis.__game.geology(false);
    globalThis.__game.camera(-22, 58, 52, 4, 10, 0);
    globalThis.__game.step(6);
  });
  await page.waitForTimeout(1000);
  const opened = (await page.evaluate(() => globalThis.__game.state())) as {
    connected: boolean;
    won: boolean;
    budget: number;
  };
  check('START から GOAL まで開通した', opened.connected === true);
  check('ミッション達成', opened.won === true);
  check('予算内に収まっている', opened.budget >= 0, String(opened.budget));
  await shot(page, 'connected');

  console.log('\n8. 後から地面が変わると壊れる — 橋脚の下にトンネルを掘る');
  const pierCoord = (await page.evaluate(() => {
    const s = globalThis.__game.state() as { bridges: { piers: { coord: number; baseY: number }[] }[] };
    return s.bridges[0]!.piers[0]!;
  })) as { coord: number; baseY: number };

  await page.evaluate(
    ([x, y, z]) => {
      globalThis.__game.camera(-14, 20, 30, -4, 8, 0);
      globalThis.__game.dig(x as number, y as number, z as number);
      globalThis.__game.flush();
      globalThis.__game.step(6);
    },
    [pierCoord.coord, pierCoord.baseY - 2, Z],
  );
  await page.waitForTimeout(900);
  const settling = (await page.evaluate(() => globalThis.__game.state())) as {
    hazards: { kind: string; reason: string }[];
    bridges: { piers: { sink: number }[] }[];
  };
  check('橋脚が沈下ハザードになる', settling.hazards.some((h) => h.kind === 'settlement'), JSON.stringify(settling.hazards));
  check('目に見えて沈み始める', (settling.bridges[0]?.piers[0]?.sink ?? 0) > 0);
  await shot(page, 'settlement');

  console.log('\n9. 覆工しても足りない — 耐力は戻るが、この橋脚の荷重には届かない');
  const lined = (await page.evaluate(
    ([x, y, z]) => {
      const g = globalThis.__game;
      g.support(x as number, y as number, z as number, 'steel');
      g.flush();
      g.step(4);
      return g.state();
    },
    [pierCoord.coord, pierCoord.baseY - 2, Z],
  )) as { hazards: { reason: string }[] };
  await page.waitForTimeout(700);
  check('覆工で耐力は0から2に戻る', (lined.hazards[0]?.reason ?? '').includes('耐力 2'), JSON.stringify(lined.hazards));
  check('それでも荷重3には足りず、警告は続く', lined.hazards.length === 1);
  await shot(page, 'lined-still-warning');

  console.log('\n10. 猶予中に埋め戻せば元に戻る');
  const recovered = (await page.evaluate(
    ([x, y, z]) => {
      const g = globalThis.__game;
      g.fill(x as number, y as number, z as number);
      g.flush();
      g.step(8);
      return g.state();
    },
    [pierCoord.coord, pierCoord.baseY - 2, Z],
  )) as {
    hazards: unknown[];
    bridges: { piers: { sink: number }[] }[];
    connected: boolean;
  };
  await page.waitForTimeout(900);
  check('埋め戻したので沈下が止まった', recovered.hazards.length === 0, JSON.stringify(recovered.hazards));
  check('沈下が戻った (猶予中なら必ず元に戻る)', (recovered.bridges[0]?.piers[0]?.sink ?? 1) < 0.02);
  check('開通が保たれている', recovered.connected === true);
  await shot(page, 'recovered');

  check('JS エラーが出ていない', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  stop();

  console.log(`\n${failures.length === 0 ? '✅ すべて成立' : `❌ ${failures.length} 件失敗: ${failures.join(', ')}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {
      /* まだ起動していない */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('preview サーバーが起動しなかった');
}

await main();

import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 860 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.waitForFunction(() => (globalThis as any).__game !== undefined, null, { timeout: 20000 });
await p.waitForTimeout(1200);
await p.screenshot({ path: process.argv[2] + '-a.png' });
// ボーリングを数本
await p.evaluate(() => { const g:any=(globalThis as any).__game; g.money(50000); for (const x of [12,20,29,33,36,40,44,48]) g.survey(x,16); g.flush(); g.geology(true); g.slice(16); });
await p.waitForTimeout(1500);
await p.screenshot({ path: process.argv[2] + '-b.png' });
console.log(JSON.stringify(await p.evaluate(() => (globalThis as any).__game.state())));
await b.close();

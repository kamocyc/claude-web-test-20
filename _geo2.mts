import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 860 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.waitForFunction(() => (globalThis as any).__game !== undefined, null, { timeout: 20000 });
await p.evaluate(() => { const g:any=(globalThis as any).__game; g.money(9e6);
  for (let x=0;x<64;x++) for (let z=0;z<32;z+=1) { g.game.survey.bore(x,z); }
  g.game.economy.budget = 26000;
  g.geology(true); g.slice(16); });
await p.evaluate(() => (globalThis as any).__game.game.events.push({type:'surveyed',cell:{x:0,y:0,z:0}}));
await p.waitForTimeout(3000);
await p.screenshot({ path: process.argv[2] + '-all.png' });
await b.close();

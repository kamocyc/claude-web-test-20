import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 860 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await p.waitForFunction(() => (globalThis as any).__game !== undefined, null, { timeout: 20000 });
await p.evaluate(() => { const g:any=(globalThis as any).__game; g.geology(true); g.slice(16); });
await p.waitForTimeout(1500);
console.log(await p.evaluate(() => {
  const t:any = (globalThis as any).__game.terrain;
  const s = t.slice;
  const d = s.material.map.image.data;
  let nonzero = 0; for (let i=3;i<d.length;i+=4) if (d[i]>0) nonzero++;
  return JSON.stringify({ visible: s.visible, opacity: s.material.opacity, pos: s.position.toArray(), nonzeroAlpha: nonzero, total: d.length/4, parent: !!s.parent, mapNeedsUpdate: s.material.map.version });
}));
await b.close();

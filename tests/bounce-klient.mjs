// Diagnostyka „skakania” formularza klienta po wyborze celu: co 100 ms zapisuje położenie arkusza, wysokość ekranu, klasy widoku.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
const SITE = 'https://zielona-taxi.netlify.app', URL = process.env.SB_URL, KEY = process.env.SB_KEY, PASS = process.env.LOAD_PASS;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email: '48999100001@klient.zielonataxi.pl', password: PASS });
if (error) { console.log('login', error.message); process.exit(1); }
const out = [];
const b = await chromium.launch();
for (const dest of ['Suwalska 2B', 'Lotnisko Poznań']) {
  const ctx = await b.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pl-PL', timezoneId: 'Europe/Warsaw',
    geolocation: { latitude: 51.9356, longitude: 15.5064 }, permissions: ['geolocation'] });
  await ctx.addInitScript(s => { try { localStorage.setItem('zt-auth-klient', s); } catch { } }, JSON.stringify(data.session));
  const p = await ctx.newPage();
  p.on('console', m => out.push(`[console ${m.type()}] ${m.text()}`.slice(0, 300)));
  p.on('request', r => { const u = r.url(); if (/route\/v1|photon|nominatim|functions\/v1\/geo|rpc\/quote|price/.test(u)) out.push(`[req ${Date.now() % 100000}] ${u.slice(0, 160)}`); });
  await p.goto(SITE + '/klient/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#to', { timeout: 40000 });
  await p.waitForTimeout(4000);
  await p.evaluate(() => document.querySelectorAll('.modal,.rate-modal,[data-modal]').forEach(x => x.remove()));
  await p.tap('#to');
  await p.setViewportSize({ width: 360, height: 480 });
  await p.waitForTimeout(800);
  await p.type('#to', dest, { delay: 60 });
  await p.waitForTimeout(3000);
  await p.evaluate(() => {
    window.__log = []; const t0 = performance.now();
    const snap = why => { const s = document.querySelector('.sheet'), v = document.querySelector('#view'), a = document.querySelector('.app'), m = document.querySelector('.mapwrap');
      const r = s?.getBoundingClientRect();
      window.__log.push(`${Math.round(performance.now() - t0)}ms ${why} sheetTop=${Math.round(r?.top)} sheetH=${Math.round(r?.height)} mapH=${Math.round(m?.getBoundingClientRect().height)} app=${a?.style.height || '-'} cls=${v?.className} vv=${Math.round(visualViewport.height)} inner=${innerHeight} act=${document.activeElement?.id || document.activeElement?.tagName}`); };
    setInterval(() => snap('t'), 100);
    new MutationObserver(ms => ms.forEach(m => snap('mut:' + (m.target.id || m.target.className || m.target.tagName).toString().slice(0, 40) + ':' + m.attributeName))).observe(document.querySelector('#view'), { attributes: true, subtree: true, attributeFilter: ['class', 'hidden', 'style'] });
    visualViewport.addEventListener('resize', () => snap('vv-resize'));
  });
  await p.click('#sgTo button:not([disabled])', { timeout: 8000 }).catch(e => out.push('click ' + e.message));
  await p.setViewportSize({ width: 360, height: 780 });
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.waitForTimeout(10000);
  const log = await p.evaluate(() => window.__log);
  // tylko zmiany (bez powtórzeń tych samych wartości)
  let prev = ''; out.push(`===== ${dest}`);
  for (const l of log) { const k = l.replace(/^\d+ms \S+ /, ''); if (k !== prev || !l.includes(' t ')) out.push(l); prev = k; }
  await p.screenshot({ path: `shots/bounce-${dest.replace(/\W+/g, '_')}.png` });
  await ctx.close();
}
fs.writeFileSync('shots/bounce.txt', out.join('\n'));
await b.close(); process.exit(0);

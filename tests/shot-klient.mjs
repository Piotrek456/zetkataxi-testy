// Zrzuty ekranu aplikacji klienta na telefonie ~300 ppi (360×780 pkt, DPR 2): przed i po dotknięciu „Dokąd” (klawiatura ~300 pkt).
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
const SITE = 'https://zielona-taxi.netlify.app', URL = process.env.SB_URL, KEY = process.env.SB_KEY, PASS = process.env.LOAD_PASS;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email: '48999100001@klient.zielonataxi.pl', password: PASS });
if (error) { console.log('login', error.message); process.exit(1); }
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pl-PL', timezoneId: 'Europe/Warsaw',
  geolocation: { latitude: 51.9356, longitude: 15.5064 }, permissions: ['geolocation'] });
await ctx.addInitScript(s => { try { localStorage.setItem('zt-auth-klient', s); } catch { } }, JSON.stringify(data.session));
const p = await ctx.newPage();
await p.goto(SITE + '/klient/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#to', { timeout: 40000 });
await p.waitForTimeout(4000);
await p.evaluate(() => document.querySelectorAll('.modal,.rate-modal,[data-modal]').forEach(x => x.remove()));
await p.screenshot({ path: 'shots/klient-1-start.png' });
await p.tap('#to');
await p.setViewportSize({ width: 360, height: 480 });   // klawiatura zajmuje dół ekranu
await p.waitForTimeout(1200);
await p.screenshot({ path: 'shots/klient-2-dokad.png' });
await p.type('#to', 'Kupiecka', { delay: 60 });
await p.waitForTimeout(2500);
await p.screenshot({ path: 'shots/klient-3-podpowiedzi.png' });
await b.close(); process.exit(0);

// Sprawdzenie tras i adresów: które zapytania idą do naszego serwera map, a które do publicznych (prawdziwa przeglądarka, kod z produkcji).
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
const SITE = 'https://zielona-taxi.netlify.app', URL = process.env.SB_URL, KEY = process.env.SB_KEY;
const rep0 = createClient(URL, KEY, { auth: { persistSession: false } });
const say = async t => { const { error } = await rep0.rpc('log_crash', { p_app: 'klient', p_source: 'mapy', p_kind: 'test', p_version: 'start', p_device: 'mapy-start', p_info: t }); if (error) console.log('log_crash', error.message); };
process.on('uncaughtException', async e => { await say('uncaught ' + String(e && e.stack || e).slice(0, 1500)); process.exit(1); });
process.on('unhandledRejection', async e => { await say('unhandled ' + String(e && e.message || e).slice(0, 800)); process.exit(1); });
await say('start key=' + (KEY ? KEY.length : 0));
const b = await chromium.launch(); const p = await b.newPage();
const hosts = []; p.on('request', r => { try { const h = new URL(r.url()).host; if (!/netlify|supabase|jsdelivr|unpkg|openfreemap/.test(h)) hosts.push(h + new URL(r.url()).pathname.slice(0, 20)); } catch { } });
const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
let out = {};
try {
await p.goto(SITE + '/klient/', { waitUntil: 'domcontentloaded' });
out = await p.evaluate(async () => {
  const c = await import('/shared/core.js'); const res = {};
  const t = async (k, f) => { const s = performance.now(); try { res[k] = await f(); } catch (e) { res[k] = 'BŁĄD ' + e.message; } res[k + '_ms'] = Math.round(performance.now() - s); };
  await t('trasa_zg', async () => { const r = await c.routeBetween({ lat: 51.9356, lng: 15.5064 }, { lat: 51.9145, lng: 15.4830 }); return `${r.km.toFixed(2)} km, ${r.min} min${r.approx ? ' (przybliżona)' : ''}`; });
  await t('trasa_poznan', async () => { const r = await c.routeBetween({ lat: 51.9356, lng: 15.5064 }, { lat: 52.4064, lng: 16.9252 }); return `${r.km.toFixed(1)} km${r.approx ? ' (przybliżona)' : ''}`; });
  await t('adres_kupiecka', async () => (await c.searchAddr('Kupiecka 63', { lat: 51.94, lng: 15.5 })).slice(0, 3).map(h => h.label));
  await t('adres_nowa_sol', async () => (await c.searchAddr('Wrocławska Nowa Sól', { lat: 51.94, lng: 15.5 })).slice(0, 3).map(h => h.label));
  await t('adres_poznan', async () => (await c.searchAddr('Poznań Ławica lotnisko', { lat: 51.94, lng: 15.5 })).slice(0, 3).map(h => h.label));
  await t('reverse_swiebodzin', async () => await c.reverseAddrOrNull(52.2475, 15.5330));
  return res;
});
} catch (e) { out.blad = String(e.message || e).slice(0, 600); }
out.zapytania = hosts; out.bledy_strony = errs;
await b.close();
const text = JSON.stringify(out); console.log(text); await say('koniec ' + text.length);
const rep = createClient(URL, KEY, { auth: { persistSession: false } });
for (let i = 0, k = 0; i < text.length; i += 2900, k++) await rep.rpc('log_crash', { p_app: 'klient', p_source: 'mapy', p_kind: 'test', p_version: 'czesc-' + k, p_device: 'mapy-test', p_info: text.slice(i, i + 2900) });
process.exit(0);

// Sprawdzenie ekranów po teście: ZT Flota (Zarobki, Historia, pliki CSV, zatwierdzanie aut i kierowców) i aplikacja kierowcy (Zarobki).
// Wynik trafia do tabeli crash_log (app=flota, kind=test, source=verify) — Claude porównuje go z bazą.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const SITE = 'https://zielona-taxi.netlify.app', PASS = process.env.LOAD_PASS, URL = process.env.SB_URL, KEY = process.env.SB_KEY;
const DO_APPROVAL = process.env.APPROVAL === '1';
const out = { errors: [] };
const b = await chromium.launch();
async function newPage() {
  const ctx = await b.newContext({ viewport: { width: 430, height: 900 }, acceptDownloads: true, locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  const p = await ctx.newPage();
  p.on('pageerror', e => out.errors.push(String(e).slice(0, 200)));
  p.on('console', m => { if (m.type() === 'error' && !/WebSocket|favicon|net::/.test(m.text())) out.errors.push('console: ' + m.text().slice(0, 200)); });
  return p;
}
async function login(p, path, phone) {
  await p.goto(SITE + path, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#pwPhone', { timeout: 30000 });
  await p.fill('#pwPhone', phone); await p.fill('#pwPass', PASS);
  await p.click('form.auth button[type=submit]');
}
const num = s => +String(s).replace(/\s|zł/g, '').replace(',', '.');
function parseCsv(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map(l => {
    const r = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ';') { r.push(cur); cur = ''; } else cur += ch; }
    r.push(cur); return r;
  });
}
async function csv(p) {
  await p.evaluate(() => { window.showSaveFilePicker = undefined; try { navigator.canShare = undefined; } catch { } });
  const [d] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.click('[data-csv]')]);
  return { name: d.suggestedFilename(), rows: parseCsv(fs.readFileSync(await d.path(), 'utf8')) };
}
const step = async (name, fn) => { try { await fn(); out[name + '_ok'] = true; } catch (e) { out[name + '_ok'] = false; out.errors.push(name + ': ' + String(e.message || e).slice(0, 300)); } };

// ---------------------------------------------------------------- ZT Flota
const f = await newPage();
await step('flota_login', async () => { await login(f, '/flota/', '999300000'); await f.waitForSelector('.mrow', { timeout: 40000 }); out.flota_menu = (await f.innerText('#view')).replace(/\s+/g, ' ').slice(0, 600); });
await step('flota_zarobki', async () => {
  await f.click('.mrow b:text-is("Zarobki")'); await f.waitForSelector('[data-rngp="today"]', { timeout: 30000 });
  await f.click('[data-rngp="today"]'); await f.waitForSelector('.tbl tbody tr', { timeout: 40000 }); await f.waitForTimeout(1500);
  out.zarobki_kafelki = (await f.innerText('.tiles')).replace(/\s+/g, ' ');
  const tables = await f.$$eval('.tbl', ts => ts.map(t => [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.innerText.trim()))));
  out.zarobki_tabela = tables[tables.length - 1];
  const c = await csv(f); out.zarobki_csv_nazwa = c.name; out.zarobki_csv = c.rows;
});
await step('flota_historia', async () => {
  await f.click('[data-back]'); await f.waitForSelector('.mrow', { timeout: 20000 });
  await f.click('.mrow b:text-is("Historia kursów")'); await f.waitForSelector('[data-rngp="today"]', { timeout: 30000 });
  await f.click('[data-rngp="today"]'); await f.waitForTimeout(4000);
  out.historia_kafelki = (await f.innerText('.tiles')).replace(/\s+/g, ' ');
  out.historia_wiersze = await f.$$eval('.hrow2', rs => rs.length);
  out.historia_przyklad = (await f.$$eval('.hrow2', rs => rs.slice(0, 2).map(r => r.innerText.replace(/\s+/g, ' '))));
  out.historia_dane_klienta_widoczne = await f.$$eval('.hrow2 .h-cl', x => x.length);   // flota nie może widzieć klienta
  const c = await csv(f); out.historia_csv_nazwa = c.name;
  const [head, ...rows] = c.rows; out.historia_csv_naglowek = head; out.historia_csv_wierszy = rows.length;
  const ip = head.indexOf('Cena (zł)'), ic = head.indexOf('Prowizja (zł)'), ik = head.indexOf('Kierowca');
  const per = {}; let sum = 0, fee = 0;
  for (const r of rows) { const p = num(r[ip]), q = num(r[ic]); sum += p; fee += q; per[r[ik]] = per[r[ik]] || { n: 0, sum: 0 }; per[r[ik]].n++; per[r[ik]].sum += p; }
  out.historia_csv_suma = { sum: Math.round(sum * 100) / 100, fee: Math.round(fee * 100) / 100, per };
  out.historia_csv_pusta_godzina = rows.filter(r => !r[1] || !r[2]).length;
});
if (DO_APPROVAL) {
  await step('flota_dodaj_auto', async () => {
    await f.click('[data-back]'); await f.waitForSelector('.mrow', { timeout: 20000 });
    await f.click('.mrow b:text-is("Samochody")'); await f.click('[data-addopen="car"]');
    await f.fill('#ncModel', 'TEST zatwierdzania'); await f.fill('#ncPlate', 'TST 999');
    await f.click('#addCar button[type=submit]'); await f.waitForTimeout(3000);
    out.auto_po_dodaniu = (await f.innerText('#view')).replace(/\s+/g, ' ').slice(0, 500);
  });
  await step('flota_dodaj_kierowce', async () => {
    await f.click('[data-back]'); await f.waitForSelector('.mrow', { timeout: 20000 });
    await f.click('.mrow b:text-is("Kierowcy")'); await f.click('[data-addopen="driver"]');
    await f.fill('#ndName', 'Test Zatwierdzania'); await f.fill('#ndPhone', '999200099'); await f.fill('#ndPass', 'Zt-Test#2026x');
    await f.click('#addDriver button[type=submit]'); await f.waitForTimeout(5000);
    out.kierowca_po_dodaniu = (await f.innerText('#view')).replace(/\s+/g, ' ').slice(0, 500);
  });
}

// ---------------------------------------------------------------- aplikacja kierowcy (2 kierowców)
for (const i of [1, 2]) {
  const d = await newPage();
  await step('kierowca' + i, async () => {
    await login(d, '/kierowca/', '999200' + String(i).padStart(3, '0'));
    await d.waitForSelector('[data-tab="earn"]', { timeout: 40000 });
    await d.click('[data-tab="earn"]'); await d.waitForTimeout(3000);
    out['kierowca' + i + '_zarobki'] = (await d.innerText('#view')).replace(/\s+/g, ' ').slice(0, 700);
  });
  await d.close();
}
await b.close();

const text = JSON.stringify(out);
console.log(text);
const rep = createClient(URL, KEY, { auth: { persistSession: false } });
for (let i = 0, k = 0; i < text.length; i += 2900, k++) {
  await rep.rpc('log_crash', { p_app: 'flota', p_source: 'verify', p_kind: 'test', p_version: 'czesc-' + k, p_device: 'sprawdzenie', p_info: text.slice(i, i + 2900) });
}
process.exit(0);

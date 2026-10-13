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
const ONLY = process.env.ONLY || '';
if (ONLY === 'settings') {
  // ZT Flota → Ustawienia: formularz, walidacja NIP, zapis, odczyt po odświeżeniu (dane floty testowej)
  await step('ust_wejscie', async () => {
    await f.click('.mrow b:text-is("Ustawienia")'); await f.waitForSelector('#fleetSettings', { timeout: 20000 });
    out.ust_tytul = await f.innerText('#hdTitle');
    out.ust_pola = await f.$$eval('#fleetSettings input, #fleetSettings select', x => x.map(i => i.id));
    out.ust_naglowki = await f.$$eval('#fleetSettings h3', x => x.map(h => h.textContent));
    out.ust_stawki = await f.$$eval('#fs_kasa_tax_rate option', x => x.map(o => o.textContent));
    out.ust_prowizja_widoczna = /prowizj/i.test(await f.innerText('#view'));
  });
  await step('ust_walidacja', async () => {
    await f.fill('#fs_company_nip', '123'); await f.click('#fleetSettings [type=submit]');
    await f.waitForSelector('#fsErr:not([hidden])', { timeout: 5000 }); out.ust_blad_nip = await f.innerText('#fsErr');
  });
  await step('ust_zapis', async () => {
    const v = { contact_addr: 'ul. Testowa 1, 65-001 Zielona Góra', contact_email: 'test@zetka.pl', contact_phone: '600 100 200', company_name: 'Test Obciążenia Sp. z o.o.',
      company_nip: '123-456-32-18', company_regon: '123456785', company_addr: 'ul. Firmowa 2, Zielona Góra', license_no: '99/TX/2026' };
    for (const [k, x] of Object.entries(v)) await f.fill('#fs_' + k, x);
    await f.selectOption('#fs_kasa_tax_rate', 'B');
    await f.click('[data-kasacopy]');
    out.ust_kopiowanie = await f.inputValue('#fs_kasa_nip');
    await f.click('#fleetSettings [type=submit]');
    await f.waitForFunction(() => /zapisane/i.test(document.body.innerText), null, { timeout: 15000 });
    await f.reload({ waitUntil: 'domcontentloaded' }); await f.waitForSelector('.mrow', { timeout: 40000 });
    out.ust_menu_po = (await f.innerText('#view')).replace(/\s+/g, ' ').slice(0, 400);
    await f.click('.mrow b:text-is("Ustawienia")'); await f.waitForSelector('#fleetSettings', { timeout: 20000 });
    out.ust_po_odczycie = await f.$$eval('#fleetSettings input, #fleetSettings select', x => Object.fromEntries(x.map(i => [i.id, i.value])));
    await f.screenshot({ path: 'ustawienia.png', fullPage: true });
  });
  await f.close();
} else {
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
    await d.waitForTimeout(3000);
    out['kierowca' + i + '_okno'] = await d.evaluate(() => [...document.querySelectorAll('.modal')].map(m => m.innerText.replace(/\s+/g, ' ').slice(0, 160)));
    await d.evaluate(() => document.querySelectorAll('.modal').forEach(m => m.remove()));
    await d.evaluate(() => document.querySelector('[data-tab="earn"]').click()); await d.waitForTimeout(3000);
    out['kierowca' + i + '_zarobki'] = (await d.innerText('#view')).replace(/\s+/g, ' ').slice(0, 700);
  });
  await d.close();
}
}
await b.close();

const text = JSON.stringify(out);
console.log(text);
const rep = createClient(URL, KEY, { auth: { persistSession: false } });
for (let i = 0, k = 0; i < text.length; i += 2900, k++) {
  await rep.rpc('log_crash', { p_app: 'flota', p_source: 'verify', p_kind: 'test', p_version: 'czesc-' + k, p_device: 'sprawdzenie', p_info: text.slice(i, i + 2900) });
}
process.exit(0);

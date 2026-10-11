// Test obciążenia Zetka Taxi: N kierowców i M klientów działa jednocześnie, tak jak aplikacje na telefonach.
// Kierowcy: logowanie, online, pozycja GPS (co 5 s w jeździe, co 30 s na postoju), sygnał „aplikacja otwarta” co 60 s,
//           kanały na żywo (ja, kursy, pozycje), odświeżanie co 10 s, przyjmowanie kursów i ich realizacja.
// Klienci:  logowanie, kanały na żywo (moje kursy, pozycje aut, ustawienia, auta offline), odświeżanie co 10 s i 30 s,
//           „aplikacja otwarta” co 60 s, zamówienie kursu w losowej chwili okna zamówień.
// Usługi map (trasy, adresy) NIE są używane — adresy i współrzędne są wylosowane w Zielonej Górze.
// Wynik: raport w tabeli crash_log (app=flota, kind=test, source=load) + wypis w logu.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SB_URL, KEY = process.env.SB_KEY, PASS = process.env.LOAD_PASS;
const ND = +process.env.DRIVERS || 40, NC = +process.env.CLIENTS || 80;
const ORDER_WINDOW = (+process.env.ORDER_MIN || 4) * 60e3;   // w tym czasie klienci składają zamówienia
const TOTAL = (+process.env.TOTAL_MIN || 12) * 60e3;         // cały test
if (!URL || !KEY || !PASS) { console.error('Brak SB_URL / SB_KEY / LOAD_PASS'); process.exit(1); }

const T0 = Date.now(), now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const CENTER = [51.9356, 15.5062];
const spot = (km = 4) => { const r = km * Math.sqrt(Math.random()) / 111, a = Math.random() * 2 * Math.PI; return { lat: CENTER[0] + r * Math.cos(a), lng: CENTER[1] + r * Math.sin(a) / Math.cos(CENTER[0] * Math.PI / 180) }; };
const kmBetween = (a, b) => { const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };

// ---------------------------------------------------------------- pomiary
const M = { calls: {}, errors: {}, rt: { msgs: 0, byKind: {}, statuses: {} }, rides: {}, claim: { ok: 0, lost: 0, err: 0 }, offers: { got: 0, accepted: 0, declined: 0 }, login: { ok: 0, err: 0, ms: [] } };
const errKey = (name, e) => { const k = name + ': ' + String(e && (e.message || e.code || e)).slice(0, 90); M.errors[k] = (M.errors[k] || 0) + 1; };
async function timed(name, fn) {
  const t = now();
  try { const r = await fn(); const ms = now() - t; (M.calls[name] ||= []).push(ms); if (r && r.error) { errKey(name, r.error); } return r; }
  catch (e) { (M.calls[name] ||= []).push(now() - t); errKey(name, e); return { error: e }; }
}
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function chanStatus(who, s, err) { M.rt.statuses[s] = (M.rt.statuses[s] || 0) + 1; if (s !== 'SUBSCRIBED' && s !== 'CLOSED') errKey('kanał ' + who, err || s); }
const rtMsg = kind => { M.rt.msgs++; M.rt.byKind[kind] = (M.rt.byKind[kind] || 0) + 1; };

function mkClient() {
  return createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: true }, realtime: { params: { eventsPerSecond: 20 } } });
}
async function login(sb, email) {
  const t = now();
  for (let a = 0; a < 3; a++) {
    const { error } = await sb.auth.signInWithPassword({ email, password: PASS });
    if (!error) { M.login.ok++; M.login.ms.push(now() - t); const { data } = await sb.auth.getSession(); sb.realtime.setAuth(data.session.access_token); return data.session.user.id; }
    errKey('logowanie', error); await sleep(1500 * (a + 1));
  }
  M.login.err++; return null;
}

// ---------------------------------------------------------------- kierowca
async function driver(i) {
  await sleep(rnd(0, 30e3));   // kierowcy włączają aplikację w ciągu 30 s
  const sb = mkClient(), id = await login(sb, `48999200${String(i).padStart(3, '0')}@konto.zielonataxi.pl`);
  if (!id) return;
  let pos = spot(4), target = null, active = null, busy = false, lastSent = 0;
  const timers = [];
  const ch = [
    sb.channel('me').on('postgres_changes', { event: '*', schema: 'public', table: 'drivers', filter: `id=eq.${id}` }, () => rtMsg('kierowca: ja')).subscribe((s, e) => chanStatus('kierowca/me', s, e)),
    sb.channel('rides').on('postgres_changes', { event: '*', schema: 'public', table: 'rides' }, ({ new: r }) => { rtMsg('kierowca: kursy'); onRide(r); }).subscribe((s, e) => chanStatus('kierowca/rides', s, e)),
    sb.channel('positions').on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, () => rtMsg('kierowca: pozycje')).subscribe((s, e) => chanStatus('kierowca/positions', s, e)),
  ];
  await timed('driver_set_online', () => sb.rpc('driver_set_online', { p_online: true }));
  const sendPos = () => { lastSent = now(); return timed('driver_location', () => sb.rpc('driver_location', { p_lat: pos.lat, p_lng: pos.lng })); };
  await sendPos();
  timers.push(setInterval(() => timed('driver_heartbeat', () => sb.rpc('driver_heartbeat')), 60e3));
  // ruch: w kursie 1 krok/5 s (~40 km/h), na postoju pozycja co 30 s
  timers.push(setInterval(() => {
    if (target) { const d = kmBetween(pos, target), step = 0.055; if (d <= step) pos = { ...target }; else { pos = { lat: pos.lat + (target.lat - pos.lat) * step / d, lng: pos.lng + (target.lng - pos.lng) * step / d }; } sendPos(); }
    else if (now() - lastSent > 30e3) sendPos();
  }, 5e3));
  // odświeżanie jak w aplikacji: co 10 s aktywny kurs + giełda
  timers.push(setInterval(async () => {
    await timed('kierowca: mój kurs', () => sb.from('rides').select('*').eq('driver_id', id).in('status', ['taken', 'arrived', 'ride']).limit(2));
    const r = await timed('kierowca: giełda', () => sb.from('rides').select('*').eq('status', 'open').order('created_at').limit(50));
    if (!busy && r && r.data) for (const x of r.data) onRide(x);
  }, 10e3));

  const seen = new Set();
  function onRide(r) {
    if (!r || !r.id || busy || r.status !== 'open') return;
    const mine = r.offered_to === id, offerLive = r.offered_to && r.offer_until && new Date(r.offer_until) > new Date();
    if (mine && !seen.has('o' + r.id)) {
      seen.add('o' + r.id); M.offers.got++;
      setTimeout(() => { if (busy) return; if (Math.random() < 0.85) { M.offers.accepted++; claim(r); } else { M.offers.declined++; timed('decline_offer', () => sb.rpc('decline_offer', { p_ride: r.id })); } }, rnd(2e3, 6e3));
      return;
    }
    if (offerLive && !mine) return;   // najpierw ma go kierowca najbliżej
    if (seen.has('c' + r.id)) return;
    seen.add('c' + r.id);
    if (kmBetween(pos, { lat: r.from_lat, lng: r.from_lng }) > 6) return;   // daleki kurs — kierowca nie bierze
    setTimeout(() => claim(r), rnd(1e3, 8e3));
  }
  async function claim(r) {
    if (busy) return;
    busy = true;
    const res = await timed('claim_ride', () => sb.rpc('claim_ride', { p_ride: r.id }));
    if (res.error) { M.claim.err++; busy = false; return; }
    if (!res.data) { M.claim.lost++; busy = false; return; }
    M.claim.ok++; active = r.id;
    // dojazd do klienta → czekanie → kurs → koniec → płatność (czasy skrócone)
    target = { lat: r.from_lat, lng: r.from_lng };
    await sleep(Math.min(90e3, 5e3 * Math.ceil(kmBetween(pos, target) / 0.055)) + rnd(0, 5e3));
    await timed('driver_ride_step', () => sb.rpc('driver_ride_step', { p_ride: r.id, p_step: 'arrived' }));
    await sleep(rnd(5e3, 15e3));
    await timed('driver_ride_step', () => sb.rpc('driver_ride_step', { p_ride: r.id, p_step: 'ride' }));
    target = { lat: r.to_lat, lng: r.to_lng };
    await sleep(Math.min(90e3, 5e3 * Math.ceil(kmBetween(pos, target) / 0.055)));
    await timed('driver_ride_step', () => sb.rpc('driver_ride_step', { p_ride: r.id, p_step: 'done' }));
    await sleep(rnd(2e3, 6e3));
    await timed('confirm_payment', () => sb.rpc('confirm_payment', { p_ride: r.id }));
    target = null; active = null; busy = false;
  }
  await sleep(TOTAL - (now() - T0) - 20e3);
  timers.forEach(clearInterval);
  if (!active) await timed('driver_set_online', () => sb.rpc('driver_set_online', { p_online: false }));
  ch.forEach(c => sb.removeChannel(c));
}

// ---------------------------------------------------------------- klient
async function client(i) {
  await sleep(rnd(0, 40e3));   // klienci otwierają aplikację w ciągu 40 s
  const sb = mkClient(), id = await login(sb, `48999100${String(i).padStart(3, '0')}@klient.zielonataxi.pl`);
  if (!id) return;
  const timers = [];
  let ride = null, ordered = 0;
  const ch = [
    sb.channel('my-rides').on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: `client_id=eq.${id}` }, ({ new: r }) => { rtMsg('klient: moje kursy'); onMine(r); }).subscribe((s, e) => chanStatus('klient/my-rides', s, e)),
    sb.channel('positions').on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, () => rtMsg('klient: pozycje aut')).subscribe((s, e) => chanStatus('klient/positions', s, e)),
    sb.channel('settings').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, () => rtMsg('klient: ustawienia')).subscribe((s, e) => chanStatus('klient/settings', s, e)),
    sb.channel('zt-cars', { config: { broadcast: { self: false } } }).on('broadcast', { event: '*' }, () => rtMsg('klient: auta offline')).subscribe((s, e) => chanStatus('klient/zt-cars', s, e)),
  ];
  await timed('klient: pozycje aut', () => sb.from('positions').select('*').eq('online', true));
  timers.push(setInterval(() => timed('klient: odświeżenie', () => sb.from('rides').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(1)), 10e3));
  timers.push(setInterval(() => timed('klient: pozycje aut', () => sb.from('positions').select('*').eq('online', true)), 30e3));
  timers.push(setInterval(() => { const p = spot(4); timed('client_ping', () => sb.rpc('client_ping', { p_lat: p.lat, p_lng: p.lng })); }, 60e3));

  function onMine(r) {
    if (!r || !ride || r.id !== ride.id) return;
    const s = M.rides[r.id]; if (!s) return;
    if (r.status === 'taken' && !s.taken) { s.taken = now(); s.offeredFirst = !!r.offered_to; }
    if (r.status === 'arrived' && !s.arrived) s.arrived = now();
    if (r.status === 'done' && !s.done) s.done = now();
    if (r.status === 'cancelled') s.cancelled = now();
  }
  // zamówienie w losowej chwili okna zamówień
  await sleep(Math.max(0, rnd(45e3, 45e3 + ORDER_WINDOW) - (now() - T0)));
  const from = spot(4), to = spot(6);
  const res = await timed('create_ride', () => sb.rpc('create_ride', { p: {
    from_addr: `Test start ${i}`, to_addr: `Test cel ${i}`, from_lat: from.lat, from_lng: from.lng, to_lat: to.lat, to_lng: to.lng,
    km: Math.round(kmBetween(from, to) * 1.3 * 100) / 100, minutes: Math.round(kmBetween(from, to) * 2.2), pay: ['Gotówka', 'Karta u kierowcy', 'BLIK u kierowcy'][i % 3], pax: '1', note: 'TEST OBCIĄŻENIA' } }));
  if (res && res.data && res.data.id) { ride = res.data; ordered = now(); M.rides[ride.id] = { at: ordered, client: i, offered: !!ride.offered_to }; }
  // klient czeka max 4 min na kierowcę, potem anuluje (jak zniecierpliwiony człowiek)
  while (ride && now() - T0 < TOTAL - 25e3) {
    await sleep(5e3);
    const s = M.rides[ride.id];
    if (s.taken || s.cancelled) break;
    if (now() - ordered > 240e3) { await timed('cancel_ride', () => sb.rpc('cancel_ride', { p_ride: ride.id })); s.gaveUp = now(); break; }
  }
  await sleep(Math.max(0, TOTAL - (now() - T0) - 15e3));
  timers.forEach(clearInterval);
  ch.forEach(c => sb.removeChannel(c));
}

// ---------------------------------------------------------------- start
console.log(`Start: ${ND} kierowców, ${NC} klientów, zamówienia przez ${ORDER_WINDOW / 60e3} min, test ${TOTAL / 60e3} min`);
const tick = setInterval(() => console.log(`${Math.round((now() - T0) / 1000)} s · logowania ${M.login.ok}/${ND + NC} · kursy ${Object.keys(M.rides).length} · przyjęte ${M.claim.ok} · wiadomości na żywo ${M.rt.msgs} · błędy ${Object.values(M.errors).reduce((a, b) => a + b, 0)}`), 30e3);
await Promise.all([...Array.from({ length: ND }, (_, i) => driver(i + 1)), ...Array.from({ length: NC }, (_, i) => client(i + 1))]);
clearInterval(tick);

// ---------------------------------------------------------------- raport
const R = Object.values(M.rides), wait = R.filter(r => r.taken).map(r => (r.taken - r.at) / 1000);
const lines = [];
lines.push(`OBCIĄŻENIE ${ND} kierowców / ${NC} klientów, ${Math.round((now() - T0) / 60e3)} min`);
lines.push(`logowania: ${M.login.ok} ok, ${M.login.err} błędów, p95 ${pct(M.login.ms, .95)} ms`);
lines.push(`kursy: zamówione ${R.length}/${NC}, przyjęte ${wait.length}, zakończone ${R.filter(r => r.done).length}, klient zrezygnował ${R.filter(r => r.gaveUp).length}`);
lines.push(`czas do przyjęcia [s]: mediana ${pct(wait, .5).toFixed(0)}, p90 ${pct(wait, .9).toFixed(0)}, max ${Math.max(0, ...wait).toFixed(0)}`);
lines.push(`oferty dla najbliższego: ${M.offers.got} (przyjęte ${M.offers.accepted}, odrzucone ${M.offers.declined}); claim: ok ${M.claim.ok}, przegrane wyścigi ${M.claim.lost}, błędy ${M.claim.err}`);
lines.push(`na żywo: ${M.rt.msgs} wiadomości (${Math.round(M.rt.msgs / ((now() - T0) / 1000))}/s); ` + Object.entries(M.rt.byKind).map(([k, v]) => `${k} ${v}`).join(', '));
lines.push(`kanały: ` + Object.entries(M.rt.statuses).map(([k, v]) => `${k} ${v}`).join(', '));
lines.push(`czasy odpowiedzi [ms] (mediana/p95/max, liczba): ` + Object.entries(M.calls).map(([k, v]) => `${k} ${pct(v, .5)}/${pct(v, .95)}/${Math.max(...v)} (${v.length})`).join('; '));
const errs = Object.entries(M.errors).sort((a, b) => b[1] - a[1]);
lines.push(`błędy (${errs.reduce((a, b) => a + b[1], 0)}): ` + (errs.slice(0, 12).map(([k, v]) => `${v}× ${k}`).join(' | ') || 'brak'));
const text = lines.join('\n');
console.log('\n' + text);
// raport do bazy (kilka wpisów po 2900 znaków)
const rep = createClient(URL, KEY, { auth: { persistSession: false } });
for (let i = 0; i < text.length; i += 2900) {
  await rep.rpc('log_crash', { p_app: 'flota', p_source: 'load', p_kind: 'test', p_version: 'obciazenie', p_device: 'test-obciazenia', p_info: text.slice(i, i + 2900) });
}
process.exit(0);

#!/usr/bin/env bash
# Zetka Taxi · przekaźnik SMS na serwerze OVH.
# Aplikacja (Supabase) nie łączy się już z SMSAPI bezpośrednio — wysyła prośbę o SMS do tego serwera (podpisaną kluczem przekaźnika),
# a serwer wysyła SMS przez SMSAPI ze swojego stałego adresu IP. Token SMSAPI jest TYLKO na tym serwerze (/etc/zetka-sms.conf, dostęp tylko root).
# Dzięki temu w SMSAPI można zezwolić na połączenia wyłącznie z IP tego serwera — token skradziony gdziekolwiek indziej jest bezużyteczny.
#   - POST /sms/send    {to, message, from?}  → SMS przez SMSAPI (tylko numery polskie 48XXXXXXXXX, limity dzienne)
#   - POST /sms/profile {}                    → stan konta SMSAPI (punkty) — do „Stanu systemu”
# Każde zapytanie: nagłówki X-Ts (czas) i X-Sig = HMAC-SHA256(klucz przekaźnika, "<X-Ts>.<treść>"); ważne 2 minuty (bez powtórek).
# Uruchomienie (klucz przekaźnika tworzysz w ZT Właściciel → Stan systemu → „Przekaźnik SMS”):
#   curl -fsSL https://raw.githubusercontent.com/Piotrek456/zetkataxi-testy/main/tests/server-sms.sh -o sms.sh && sudo bash sms.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Uruchom przez sudo"; exit 1; }
CONF=/etc/zetka-sms.conf; BASE=/opt/zetka/sms; mkdir -p "$BASE"; chmod 700 "$BASE"
apt-get install -y -qq python3 curl >/dev/null 2>&1 || true

old_token=""; old_key=""
[ -f "$CONF" ] && { old_token=$(grep -oP '^SMSAPI_TOKEN=\K.*' "$CONF" || true); old_key=$(grep -oP '^RELAY_KEY=\K.*' "$CONF" || true); }
read -r -s -p "Wklej klucz przekaźnika z aplikacji ZT Właściciel${old_key:+ (Enter = bez zmian)}: " KEY < /dev/tty; echo
KEY=${KEY:-$old_key}; [ ${#KEY} -ge 32 ] || { echo "Nieprawidłowy klucz przekaźnika"; exit 1; }
read -r -s -p "Wklej token SMSAPI (panel SMSAPI → API → Tokeny)${old_token:+ (Enter = bez zmian)}: " TOKEN < /dev/tty; echo
TOKEN=${TOKEN:-$old_token}; [ -n "$TOKEN" ] || { echo "Brak tokenu SMSAPI"; exit 1; }
umask 077
printf 'RELAY_KEY=%s\nSMSAPI_TOKEN=%s\nDAILY_LIMIT=%s\nPHONE_DAY_LIMIT=%s\n' "$KEY" "$TOKEN" "${DAILY_LIMIT:-300}" "${PHONE_DAY_LIMIT:-10}" > "$CONF"; chmod 600 "$CONF"

cat > "$BASE/relay.py" <<'PY'
#!/usr/bin/env python3
# Zetka Taxi · przekaźnik SMS (tylko biblioteka standardowa Pythona). Nasłuchuje na 127.0.0.1:5090, z zewnątrz przez Caddy (HTTPS) pod /sms/.
import hmac, hashlib, json, os, re, time, urllib.parse, urllib.request, threading, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
CONF = {}
for line in open(os.environ.get('ZETKA_SMS_CONF', '/etc/zetka-sms.conf')):
    if '=' in line: k, v = line.rstrip('\n').split('=', 1); CONF[k] = v
KEY = CONF['RELAY_KEY'].encode(); TOKEN = CONF['SMSAPI_TOKEN']
DAILY = int(CONF.get('DAILY_LIMIT', 300)); PHONE_DAY = int(CONF.get('PHONE_DAY_LIMIT', 10))
STATE = os.environ.get('ZETKA_SMS_STATE', '/opt/zetka/sms/state.json'); LOG = os.environ.get('ZETKA_SMS_LOG', '/var/log/zetka-sms.log'); lock = threading.Lock(); seen = {}
def log(msg):
    with open(LOG, 'a') as f: f.write(datetime.datetime.now().isoformat(timespec='seconds') + ' ' + msg + '\n')
def load():
    try: s = json.load(open(STATE))
    except Exception: s = {}
    day = time.strftime('%Y-%m-%d')
    if s.get('day') != day: s = {'day': day, 'all': 0, 'phones': {}}
    return s
def smsapi(path, data=None):
    req = urllib.request.Request('https://api.smsapi.pl' + path, data=urllib.parse.urlencode(data).encode() if data else None,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b'{}')
        except Exception: return e.code, {}
    except Exception as e:
        return 599, {'error': 'brak połączenia z SMSAPI', 'message': str(e)[:120]}
class H(BaseHTTPRequestHandler):
    def reply(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 4000: return self.reply(413, {'error': 'za duże'})
        body = self.rfile.read(n); ts = self.headers.get('X-Ts', ''); sig = self.headers.get('X-Sig', '')
        if not ts.isdigit() or abs(time.time() * 1000 - int(ts)) > 120000: return self.reply(401, {'error': 'zły czas'})
        good = hmac.new(KEY, ts.encode() + b'.' + body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(good, sig): log('ODRZUCONO: zły podpis od ' + (self.headers.get('X-Forwarded-For') or '?')); return self.reply(401, {'error': 'zły podpis'})
        with lock:
            if sig in seen: return self.reply(409, {'error': 'powtórzone zapytanie'})
            seen[sig] = time.time()
            for k in [k for k, t in seen.items() if time.time() - t > 300]: seen.pop(k, None)
        try: d = json.loads(body or b'{}')
        except Exception: return self.reply(400, {'error': 'błędne dane'})
        if self.path.rstrip('/') == '/sms/profile':
            code, j = smsapi('/profile'); return self.reply(200 if code == 200 else 502, {'status': code, 'points': j.get('points')})
        if self.path.rstrip('/') != '/sms/send': return self.reply(404, {'error': 'nie ma'})
        to = re.sub(r'\D', '', str(d.get('to', ''))); msg = str(d.get('message', ''))[:320]
        if not re.fullmatch(r'48\d{9}', to) or not msg: return self.reply(400, {'error': 'tylko polskie numery 48XXXXXXXXX i treść'})
        with lock:
            s = load()
            if s['all'] >= DAILY: log('LIMIT dzienny'); return self.reply(429, {'error': 'dzienny limit SMS-ów przekaźnika'})
            if s['phones'].get(to, 0) >= PHONE_DAY: return self.reply(429, {'error': 'limit SMS-ów na ten numer'})
            s['all'] += 1; s['phones'][to] = s['phones'].get(to, 0) + 1; json.dump(s, open(STATE, 'w'))
        form = {'to': to, 'message': msg, 'format': 'json', 'encoding': 'utf-8'}
        if d.get('from'): form['from'] = str(d['from'])[:11]
        code, j = smsapi('/sms.do', form)
        ok = code == 200 and not j.get('error') and (j.get('count') or 0) > 0
        log(('OK ' if ok else 'BŁĄD ') + to[:5] + '****' + to[-2:] + ('' if ok else ' ' + str(j.get('error')) + ' ' + str(j.get('message'))))
        return self.reply(200, j)
ThreadingHTTPServer(('127.0.0.1', int(os.environ.get('ZETKA_SMS_PORT', 5090))), H).serve_forever()
PY
chmod 700 "$BASE/relay.py"

cat > /etc/systemd/system/zetka-sms.service <<EOF
[Unit]
Description=Zetka Taxi - przekaźnik SMS (SMSAPI ze stałego IP)
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 $BASE/relay.py
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload; systemctl enable zetka-sms >/dev/null 2>&1; systemctl restart zetka-sms

# Caddy: /sms/* → przekaźnik (dopisane raz, przed /health)
CF=/etc/caddy/Caddyfile
if [ -f "$CF" ] && ! grep -q "handle /sms/\*" "$CF"; then
  cp "$CF" "$CF.bak-$(date +%s)"
  python3 - "$CF" <<'PY'
import sys; p = sys.argv[1]; s = open(p).read()
s = s.replace("  handle /health {", "  handle /sms/* {\n    reverse_proxy 127.0.0.1:5090\n  }\n  handle /health {", 1)
open(p, 'w').write(s)
PY
  systemctl reload caddy || systemctl restart caddy
fi

sleep 2
IP=$(curl -fsS4 https://api.ipify.org || echo "?")
systemctl is-active --quiet zetka-sms && echo -e "\n\033[1;32mPrzekaźnik SMS działa.\033[0m" || { echo "Przekaźnik nie wystartował — journalctl -u zetka-sms"; exit 1; }
echo "Adres IP tego serwera: $IP"
echo "1) W ZT Właściciel → Stan systemu → Przekaźnik SMS kliknij „Sprawdź przekaźnik”."
echo "2) Gdy działa: w panelu SMSAPI (Ustawienia → API / Bezpieczeństwo) zezwól na połączenia API tylko z IP $IP."
echo "3) W ZT Właściciel usuń token SMSAPI z Supabase („Usuń token z Supabase”) — od teraz jest tylko na tym serwerze."
echo "Dziennik wysyłek (bez pełnych numerów): /var/log/zetka-sms.log"

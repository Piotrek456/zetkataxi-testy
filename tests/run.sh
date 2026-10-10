#!/usr/bin/env bash
# Test aplikacji APK w emulatorze: start, zabicie procesu strony (WebView), awaria Javy.
# Wynik trafia do bazy (crash_log, rodzaj "test" — niewidoczny w panelu), skąd go czyta Claude.
# Użycie: run.sh <plik.apk> <pakiet> <nazwa>
APK="$1"; PKG="$2"; NAME="$3"
URL="https://bmulsxfdpkaqogyfgygo.supabase.co"
KEY=$(curl -fsS https://zielona-taxi.netlify.app/shared/config.js | grep -o "SUPABASE_ANON_KEY: '[^']*" | sed "s/.*'//")
RES=""
note() { RES="$RES$1; "; echo "== $1"; }
report() {
  python3 - "$NAME" "$RES" "$URL" "$KEY" <<'PY'
import sys, json, urllib.request
name, res, url, key = sys.argv[1:5]
body = json.dumps({"p_app": name, "p_source": "ci", "p_kind": "test", "p_version": name, "p_device": "emulator", "p_info": res}).encode()
r = urllib.request.Request(url + "/rest/v1/rpc/log_crash", body, {"Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key})
try: print(urllib.request.urlopen(r, timeout=20).status)
except Exception as e: print("raport nieudany:", e)
PY
}
adb root >/dev/null 2>&1; sleep 2
adb logcat -c
if adb install -r -g "$APK" >/tmp/inst.txt 2>&1; then note "instalacja=OK"; else note "instalacja=BŁĄD $(tr '\n' ' ' </tmp/inst.txt | cut -c1-150)"; report; exit 1; fi
adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
sleep 30
P1=$(adb shell pidof "$PKG" | tr -d '\r')
if [ -n "$P1" ]; then note "start=OK(pid $P1)"; else note "start=BŁĄD(aplikacja nie działa)"; fi
adb exec-out screencap -p > "shot-$NAME-1.png" 2>/dev/null

# 1) zabicie procesu, który wyświetla stronę
R=$(adb shell ps -A | grep -E "sandboxed_process" | awk '{print $2}' | tr '\n' ' ')
if [ -n "$R" ]; then
  adb shell kill -9 $R
  note "zabito proces strony: $R"
  sleep 20
  P2=$(adb shell pidof "$PKG" | tr -d '\r')
  R2=$(adb shell ps -A | grep -E "sandboxed_process" | awk '{print $2}' | tr '\n' ' ')
  if [ -n "$P2" ] && [ "$P2" = "$P1" ]; then note "po zabiciu strony: aplikacja żyje (ten sam proces)"; else note "po zabiciu strony: aplikacja padła lub się zrestartowała (pid '$P2')"; fi
  if [ -n "$R2" ] && [ "$R2" != "$R" ]; then note "nowy proces strony: $R2"; else note "brak nowego procesu strony"; fi
else
  note "nie znaleziono procesu strony"
fi
adb exec-out screencap -p > "shot-$NAME-2.png" 2>/dev/null

# 2) wyjątek Javy (zabicie całej aplikacji sygnałem nie jest wyjątkiem, więc tylko sprawdzamy logi systemu)
FATAL=$(adb logcat -d -s AndroidRuntime:E | grep -c "FATAL EXCEPTION")
note "wyjątki FATAL w logu: $FATAL"
adb logcat -d -s AndroidRuntime:E | grep -A8 "FATAL EXCEPTION" | head -20 | tr '\n' ' ' | cut -c1-400 > /tmp/fatal.txt
[ "$FATAL" != "0" ] && note "$(cat /tmp/fatal.txt)"
report
adb shell am force-stop "$PKG"   # następna aplikacja testowana osobno

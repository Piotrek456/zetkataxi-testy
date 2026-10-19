#!/usr/bin/env bash
# Zetka Taxi · codzienna kopia rejestrów i zdjęć na serwer OVH (dodatkowe zabezpieczenie poza Supabase).
#   - co noc: pełna kopia bazy z rejestrami (zleceń, przewoźników, kierowców, zdarzeń, weryfikacji, selfie…) → zaszyfrowany plik
#   - co noc: tylko NOWE pliki ze schowka (zdjęcia z weryfikacji, skany dokumentów, selfie, dokumenty flot) → zaszyfrowane
#   - kopie bazy: ostatnie 60 dni + kopia z 1. dnia każdego miesiąca na zawsze; plików nie usuwamy (archiwum 6 lat)
#   - wszystko szyfrowane AES-256 hasłem, które widzisz tylko raz przy instalacji — zapisz je w bezpiecznym miejscu
# Uruchomienie na serwerze (klucz serwera tworzysz w aplikacji ZT Właściciel → Właściciel → Kopia zapasowa → „Kopia na serwer OVH”):
#   curl -fsSL https://raw.githubusercontent.com/Piotrek456/zetkataxi-testy/main/tests/server-backup.sh -o backup.sh && sudo bash backup.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Uruchom przez sudo"; exit 1; }
BASE=/opt/zetka/backup; DATA=/var/backups/zetka; CONF=/etc/zetka-backup.conf; KEY=/root/.zetka-backup-key
URL="https://bmulsxfdpkaqogyfgygo.supabase.co"
ANON="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtdWxzeGZkcGthcW9neWZneWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMjA1MDQsImV4cCI6MjEwNjY5NjUwNH0.7bIqRuI2McBuGpkfRXWnyIEh0iVGNSG5ApZsXYkYh1w"

apt-get install -y -qq curl jq openssl >/dev/null 2>&1 || true
mkdir -p "$BASE" "$DATA"/{db,files,state}; chmod 700 "$DATA" "$BASE"

TOKEN="${TOKEN:-}"
if [ -z "$TOKEN" ]; then
  read -r -s -p "Wklej klucz serwera z aplikacji ZT Właściciel (nie będzie widoczny): " TOKEN < /dev/tty; echo
fi
[ -n "$TOKEN" ] || { echo "Brak klucza"; exit 1; }
umask 077
printf 'URL=%q\nANON=%q\nTOKEN=%q\n' "$URL" "$ANON" "$TOKEN" > "$CONF"; chmod 600 "$CONF"

NEWKEY=0
if [ ! -s "$KEY" ]; then head -c 32 /dev/urandom | base64 | tr -d '\n=' > "$KEY"; chmod 600 "$KEY"; NEWKEY=1; fi

cat > "$BASE/zetka-backup.sh" <<'EOS'
#!/usr/bin/env bash
# Zetka Taxi · nocna kopia na serwer: baza z rejestrami + nowe pliki (zaszyfrowane)
set -uo pipefail
. /etc/zetka-backup.conf
DATA=/var/backups/zetka; KEY=/root/.zetka-backup-key; umask 077
H=(-H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Content-Type: application/json")
enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" -in "$1" -out "$2"; }
report() {   # ok, notatka
  local files bytes db; files=$(find "$DATA/files" -type f | wc -l); bytes=$(du -sb "$DATA" | cut -f1); db=${DBB:-0}
  curl -fsS "${H[@]}" -X POST "$URL/rest/v1/rpc/backup_server_report" -d "$(jq -nc --arg t "$TOKEN" --argjson db "$db" --argjson nw "${NEW:-0}" --argjson ft "$files" --argjson bt "$bytes" --argjson ok "$1" --arg n "$2" \
    '{p_token:$t,p_db_bytes:$db,p_files_new:$nw,p_files_total:$ft,p_bytes_total:$bt,p_ok:$ok,p_note:$n}')" >/dev/null || true
}
fail() { echo "$(date -Is) BŁĄD: $1"; report false "$1"; exit 1; }
DAY=$(date +%F); NEW=0; DBB=0

# 1) baza z rejestrami
T=$(mktemp)
curl -fsS --max-time 900 "${H[@]}" -X POST "$URL/rest/v1/rpc/backup_by_server_token" -d "$(jq -nc --arg t "$TOKEN" '{p_token:$t}')" -o "$T" || { rm -f "$T"; fail "pobranie bazy"; }
jq -e '.app == "Zetka Taxi" and (.reg_orders | type == "array")' "$T" >/dev/null || { rm -f "$T"; fail "niepełna kopia bazy"; }
DBB=$(stat -c%s "$T"); gzip -9 -c "$T" > "$T.gz" && enc "$T.gz" "$DATA/db/zetka-$DAY.json.gz.enc"; rm -f "$T" "$T.gz"
find "$DATA/db" -name 'zetka-*.json.gz.enc' ! -name 'zetka-*-01.json.gz.enc' -mtime +60 -delete

# 2) nowe pliki ze schowka (zdjęcia, skany, selfie) — pliki w archiwum są niezmienne, więc wystarczą nowe
SINCE=$(cat "$DATA/state/since" 2>/dev/null || echo "1970-01-01T00:00:00Z")
while :; do
  LIST=$(curl -fsS --max-time 120 "${H[@]}" -X POST "$URL/rest/v1/rpc/backup_file_list" -d "$(jq -nc --arg t "$TOKEN" --arg s "$SINCE" '{p_token:$t,p_since:$s,p_limit:200}')") || fail "lista plików"
  N=$(jq length <<<"$LIST"); [ "$N" -gt 0 ] || break
  NAMES=$(jq -c '[.[].name]' <<<"$LIST")
  URLS=$(curl -fsS --max-time 120 -X POST "$URL/functions/v1/backup-files" -H "Content-Type: application/json" -d "$(jq -nc --arg t "$TOKEN" --argjson n "$NAMES" '{token:$t,names:$n}')") || fail "linki do plików"
  while IFS=$'\t' read -r NAME LINK; do
    [ -n "$NAME" ] || continue
    OUT="$DATA/files/$NAME.enc"; [ -f "$OUT" ] && continue
    mkdir -p "$(dirname "$OUT")"; F=$(mktemp)
    if curl -fsS --max-time 300 "$LINK" -o "$F" && enc "$F" "$OUT"; then NEW=$((NEW+1)); else rm -f "$OUT"; rm -f "$F"; fail "pobranie pliku $NAME"; fi
    rm -f "$F"
  done < <(jq -r '.files[] | select(.url != null) | [.name, .url] | @tsv' <<<"$URLS")
  SINCE=$(jq -r '.[-1].created_at' <<<"$LIST"); echo "$SINCE" > "$DATA/state/since"
  [ "$N" -lt 200 ] && break
done

report true "baza $(numfmt --to=iec "$DBB" 2>/dev/null || echo "$DBB B"), nowe pliki: $NEW"
echo "$(date -Is) OK: baza $DBB B, nowe pliki $NEW"
EOS

cat > "$BASE/odszyfruj.sh" <<'EOS'
#!/usr/bin/env bash
# Odszyfrowanie pliku z kopii: sudo /opt/zetka/backup/odszyfruj.sh /var/backups/zetka/db/zetka-2026-10-19.json.gz.enc  → plik obok bez .enc
# Na innym komputerze: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in PLIK.enc -out PLIK  (podaj hasło kopii)
set -euo pipefail
IN="$1"; OUT="${IN%.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/root/.zetka-backup-key -in "$IN" -out "$OUT"
echo "Zapisano: $OUT"
EOS
chmod 700 "$BASE"/*.sh

echo "30 2 * * * root $BASE/zetka-backup.sh >> /var/log/zetka-backup.log 2>&1" > /etc/cron.d/zetka-backup; chmod 644 /etc/cron.d/zetka-backup

echo "Pierwsza kopia (może potrwać kilka minut)…"
"$BASE/zetka-backup.sh" | tail -3
echo
echo "Gotowe. Kopia wykonuje się codziennie o 2:30 (czas serwera). Pliki: $DATA (dostęp tylko dla administratora serwera)."
if [ "$NEWKEY" = 1 ]; then
  echo
  echo "================ HASŁO DO ODSZYFROWANIA KOPII — ZAPISZ JE TERAZ ================"
  cat "$KEY"; echo
  echo "Bez tego hasła kopii nie da się odczytać na innym komputerze. Nie wysyłaj go nikomu."
  echo "================================================================================"
fi

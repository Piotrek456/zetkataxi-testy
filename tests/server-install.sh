#!/usr/bin/env bash
# Zetka Taxi · własny serwer tras i adresów (VPS z Ubuntu 24.04, 8 GB RAM).
#   - OSRM: trasy, kilometry, nawigacja — tylko województwo lubuskie
#   - Photon: podpowiedzi adresów i adres z pozycji GPS — tylko województwo lubuskie (budowany z Nominatim, który działa tylko podczas aktualizacji)
#   - kursy i adresy poza lubuskim aplikacja liczy przez publiczne serwery (jak dotąd)
#   - Caddy: HTTPS (certyfikat Let's Encrypt) pod adresem <ip>.sslip.io albo własną domeną (DOMAIN=...)
#   - co tydzień (noc z soboty na niedzielę) automatyczna aktualizacja map
# Uruchomienie na serwerze:  curl -fsSL https://raw.githubusercontent.com/Piotrek456/Zetkataxi/main/server/install.sh | sudo bash
# Bez HTTPS (test):           sudo NO_TLS=1 bash install.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

BASE=/opt/zetka
PBF="https://download.geofabrik.de/europe/poland/lubuskie-latest.osm.pbf"
NOMI_IMG="mediagis/nominatim:4.5"
NOMI_PW="$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)"
OSRM_IMG="ghcr.io/project-osrm/osrm-backend:v5.27.1"
log() { echo -e "\n\033[1;32m== $*\033[0m"; }

[ "$(id -u)" = 0 ] || { echo "Uruchom przez sudo"; exit 1; }
mkdir -p "$BASE"/{osrm,photon,bin}

log "Pakiety systemowe"
apt-get update -qq
apt-get install -y -qq ca-certificates curl openjdk-21-jre-headless docker.io ufw jq >/dev/null
systemctl enable --now docker >/dev/null

if [ -z "${NO_TLS:-}" ]; then
  log "Zapora (SSH, HTTP, HTTPS)"
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null
fi

# ------------------------------------------------------------------ skrypt aktualizacji (też pierwsza instalacja)
cat > "$BASE/bin/update-osrm.sh" <<EOF
#!/usr/bin/env bash
# pobiera mapę lubuskiego z Geofabrik, liczy graf OSRM w nowym katalogu i podmienia działający serwer
set -euo pipefail
NEW=$BASE/osrm/build-\$(date +%Y%m%d%H%M); mkdir -p \$NEW
curl -fsSL -o \$NEW/map.osm.pbf "$PBF"
docker run --rm -v \$NEW:/data $OSRM_IMG osrm-extract -p /opt/car.lua /data/map.osm.pbf
docker run --rm -v \$NEW:/data $OSRM_IMG osrm-partition /data/map.osrm
docker run --rm -v \$NEW:/data $OSRM_IMG osrm-customize /data/map.osrm
rm -f \$NEW/map.osm.pbf
ln -sfn \$NEW $BASE/osrm/current
docker rm -f osrm >/dev/null 2>&1 || true
docker run -d --name osrm --restart unless-stopped -p 127.0.0.1:5000:5000 -v $BASE/osrm/current:/data $OSRM_IMG \\
  osrm-routed --algorithm mld --max-table-size 200 /data/map.osrm
ls -d $BASE/osrm/build-* | sort | head -n -2 | xargs -r rm -rf     # zostają 2 ostatnie wersje
echo "OSRM gotowy: \$NEW"
EOF

cat > "$BASE/bin/update-photon.sh" <<EOF
#!/usr/bin/env bash
# adresy lubuskiego: świeży import Nominatim (tymczasowo, w Dockerze) -> indeks Photon -> podmiana; Nominatim potem wyłączany (oszczędza RAM)
set -euo pipefail
cd $BASE/photon
JAR_URL=\$(curl -fsSL https://api.github.com/repos/komoot/photon/releases/latest | jq -r '.assets[].browser_download_url' | grep -E '/photon(-opensearch)?-[0-9.]+[.]jar\$' | sort -r | head -1)
curl -fsSL -o photon.jar.new "\$JAR_URL" && mv photon.jar.new photon.jar
docker rm -f nominatim >/dev/null 2>&1 || true
docker volume rm -f nominatim-data >/dev/null 2>&1 || true
docker run -d --name nominatim --shm-size=1g -e PBF_URL="$PBF" -e NOMINATIM_PASSWORD="$NOMI_PW" \\
  -e POSTGRES_SHARED_BUFFERS=512MB -e POSTGRES_MAINTENANCE_WORK_MEM=1GB -e THREADS=4 \\
  -v nominatim-data:/var/lib/postgresql/16/main -p 127.0.0.1:5432:5432 -p 127.0.0.1:8080:8080 $NOMI_IMG
for i in \$(seq 1 180); do curl -fsS http://127.0.0.1:8080/status >/dev/null 2>&1 && break; sleep 20; done
curl -fsS http://127.0.0.1:8080/status
NEW=$BASE/photon/data-\$(date +%Y%m%d%H%M); mkdir -p \$NEW
java -Xmx2g -jar photon.jar -nominatim-import -host 127.0.0.1 -port 5432 -database nominatim -user nominatim -password "$NOMI_PW" -languages pl,en,de -data-dir \$NEW
docker rm -f nominatim >/dev/null; docker volume rm -f nominatim-data >/dev/null
ln -sfn \$NEW $BASE/photon/current
systemctl restart zetka-photon
ls -d $BASE/photon/data-* | sort | head -n -2 | xargs -r rm -rf
echo "Photon gotowy: \$NEW"
EOF
chmod +x "$BASE"/bin/*.sh

cat > /etc/systemd/system/zetka-photon.service <<EOF
[Unit]
Description=Zetka Taxi Photon (adresy)
After=network.target
[Service]
WorkingDirectory=$BASE/photon/current
ExecStart=/usr/bin/java -Xmx2g -jar $BASE/photon/photon.jar -data-dir $BASE/photon/current -listen-ip 127.0.0.1 -listen-port 2322
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload; systemctl enable zetka-photon >/dev/null

log "Trasy (OSRM) — pobieranie i przeliczanie mapy lubuskiego, kilka minut"
"$BASE/bin/update-osrm.sh"
log "Adresy (Photon) — import adresów lubuskiego, ok. 20–40 minut"
"$BASE/bin/update-photon.sh"

# ------------------------------------------------------------------ HTTPS
if [ -z "${NO_TLS:-}" ]; then
  log "HTTPS (Caddy)"
  IP=$(curl -fsS4 https://api.ipify.org)
  HOST=${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
  apt-get install -y -qq caddy >/dev/null
  cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  @cors_preflight method OPTIONS
  header >Access-Control-Allow-Origin "*"
  header >Access-Control-Allow-Methods "GET, OPTIONS"
  respond @cors_preflight 204
  handle /route/* { reverse_proxy 127.0.0.1:5000 }
  handle /api* { reverse_proxy 127.0.0.1:2322 }
  handle /reverse* { reverse_proxy 127.0.0.1:2322 }
  handle /health { respond "ok" 200 }
  handle { respond 404 }
}
EOF
  systemctl reload caddy || systemctl restart caddy
fi

log "Cotygodniowa aktualizacja map (niedziela 3:00)"
cat > /etc/cron.d/zetka-maps <<EOF
0 3 * * 0 root $BASE/bin/update-osrm.sh >> /var/log/zetka-osrm.log 2>&1
30 4 * * 0 root $BASE/bin/update-photon.sh >> /var/log/zetka-photon.log 2>&1
EOF

log "Sprawdzenie"
sleep 20
curl -fsS "http://127.0.0.1:5000/route/v1/driving/15.5064,51.9356;15.5130,51.9450?overview=false" | head -c 300; echo
curl -fsS "http://127.0.0.1:2322/api?q=Bohater%C3%B3w%20Westerplatte%20Zielona%20G%C3%B3ra&limit=1" | head -c 300; echo
[ -z "${NO_TLS:-}" ] && echo -e "\n\033[1;32mGOTOWE. Adres serwera: https://$HOST\033[0m  — przekaż go Claude."

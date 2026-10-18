#!/usr/bin/env bash
# Zetka Taxi · rozszerzenie mapy tras na serwerze, który już działa (bez ponownej instalacji):
#   trasy (OSRM): lubuskie + wielkopolskie, dolnośląskie, zachodniopomorskie, łódzkie, mazowieckie; adresy (Photon) bez zmian — lubuskie.
# Uruchomienie (Termius):
#   curl -fsSL https://raw.githubusercontent.com/Piotrek456/zetkataxi-testy/main/tests/server-regions.sh -o regions.sh && sudo nohup bash regions.sh > regions.log 2>&1 &
#   postęp: tail -f regions.log      (ok. 30–40 minut; stara mapa działa do końca)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BASE=/opt/zetka
OSRM_IMG="ghcr.io/project-osrm/osrm-backend:v5.27.1"
REGIONS="lubuskie wielkopolskie dolnoslaskie zachodniopomorskie lodzkie mazowieckie"
[ "$(id -u)" = 0 ] || { echo "Uruchom przez sudo"; exit 1; }
echo "== Pakiet osmium (łączenie map)"
apt-get update -qq && apt-get install -y -qq osmium-tool >/dev/null
echo "== Wolne miejsce i pamięć"; df -h / | tail -1; free -h | head -2
cat > "$BASE/bin/update-osrm.sh" <<EOF
#!/usr/bin/env bash
# trasy: lubuskie + wielkopolskie, dolnośląskie, zachodniopomorskie, łódzkie, mazowieckie (Geofabrik) -> jedna mapa -> graf OSRM w nowym katalogu -> podmiana działającego serwera
# aplikacja pyta z exclude=toll (bez płatnych odcinków) — profil car.lua to obsługuje
set -euo pipefail
NEW=$BASE/osrm/build-\$(date +%Y%m%d%H%M); mkdir -p \$NEW/src
for W in $REGIONS; do curl -fsSL -o \$NEW/src/\$W.osm.pbf "https://download.geofabrik.de/europe/poland/\$W-latest.osm.pbf"; done
osmium merge --overwrite -o \$NEW/map.osm.pbf \$NEW/src/*.osm.pbf
rm -rf \$NEW/src
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
chmod +x "$BASE/bin/update-osrm.sh"
echo "== Przeliczanie tras dla 6 województw (stara mapa działa do końca)"
"$BASE/bin/update-osrm.sh"
sleep 15
echo "== Sprawdzenie: Zielona Góra -> lotnisko Poznań, bez płatnych odcinków"
curl -fsS "http://127.0.0.1:5000/route/v1/driving/15.5064,51.9356;16.8263,52.4211?overview=false&exclude=toll" | head -c 300; echo
echo "== Sprawdzenie: Zielona Góra -> Warszawa"
curl -fsS "http://127.0.0.1:5000/route/v1/driving/15.5064,51.9356;21.0122,52.2297?overview=false&exclude=toll" | head -c 300; echo
df -h / | tail -1; free -h | head -2
echo -e "\n\033[1;32mGOTOWE — napisz Claude: mapa gotowa\033[0m"

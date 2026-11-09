#!/usr/bin/env bash
# [P4] Локальная проверка .osm до отправки на сервер. Флаги подгоните под настройки организаторов
# (спросите их или посмотрите в логах прогона example.osm).
# Использование: scripts/check-osm.sh team1.osm
set -u
F="${1:?укажите файл .osm}"; OUT="${2:-/tmp/osm-check}"; mkdir -p "$OUT"

echo "== SUMO: netconvert =="
netconvert --osm-files "$F" -o "$OUT/net.net.xml" \
  --geometry.remove --roundabouts.guess --ramps.guess --junctions.join \
  --tls.guess-signals --tls.discard-simple --keep-edges.by-vclass passenger 2>&1 | tee "$OUT/netconvert.log" | tail -25
grep -ciE "warning|error" "$OUT/netconvert.log" | xargs echo "предупреждений/ошибок:"
# визуально: sumo-gui -n "$OUT/net.net.xml"   (или netedit)

echo "== MatSim: OsmNetworkReader =="
echo "TODO: запустите свой класс/скрипт (org.matsim.core.utils.io.OsmNetworkReader или osm2matsim) на $F"
echo "      и проверьте число узлов/рёбер и отсутствие изолированных кусков."

echo "== Webots: osm_importer =="
if [ -n "${WEBOTS_HOME:-}" ]; then
  python3 "$WEBOTS_HOME/resources/osm_importer/importer.py" --input="$F" --output="$OUT/world.wbt" 2>&1 | tail -15
else
  echo "WEBOTS_HOME не задан — пропуск (проверьте: importer.py --help)"
fi

// Обновляет stations.json: заправки Актобе из OpenStreetMap + заправки из manual.json
const fs = require('fs');

const query =
  '[out:json][timeout:90];(' +
  'node["amenity"="fuel"](50.20,57.05,50.36,57.30);' +
  'way["amenity"="fuel"](50.20,57.05,50.36,57.30);' +
  ');out center tags;';

const servers = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

async function tryServer(url) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'gas-aktobe-sync/1.0 (GitHub Actions, weekly)'
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.trim()[0] !== '{') throw new Error('server busy (not JSON)');
  return JSON.parse(text);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

(async () => {
  let data = null;
  for (let round = 1; round <= 4 && !data; round++) {
    for (const url of servers) {
      try {
        console.log(`Trying ${url} (round ${round})...`);
        data = await tryServer(url);
        if (data.elements && data.elements.length) break;
        data = null;
      } catch (e) {
        console.log('  error: ' + (e.cause?.code || e.message));
        data = null;
      }
    }
    if (!data) await new Promise(res => setTimeout(res, 20000));
  }
  if (!data) { console.error('Overpass unavailable, keeping old stations.json'); process.exit(1); }

  const osm = data.elements
    .map(e => {
      const t = e.tags || {};
      return {
        id: e.type + '/' + e.id,
        name: t.name || t.brand || 'Заправка',
        lat: e.lat ?? e.center?.lat,
        lon: e.lon ?? e.center?.lon,
        hasGas: t['fuel:lpg'] === 'yes' || t['fuel:cng'] === 'yes'
      };
    })
    .filter(s => typeof s.lat === 'number' && typeof s.lon === 'number');

  // Заправки, добавленные вручную (которых ещё нет в OSM): id вида "manual/1"
  const manual = readJson('manual.json', [])
    .filter(s => s && typeof s.lat === 'number' && typeof s.lon === 'number' && s.id)
    .map(s => ({ id: String(s.id), name: s.name || 'Заправка', lat: s.lat, lon: s.lon, hasGas: !!s.hasGas }));

  const byId = new Map();
  osm.forEach(s => byId.set(s.id, s));
  manual.forEach(s => byId.set(s.id, s));      // ручные записи главнее
  const list = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Защита от неполного ответа: не затирать список, если заправок стало сильно меньше
  const prev = readJson('stations.json', []);
  if (prev.length >= 10 && list.length < prev.length * 0.6) {
    console.error(`Suspicious result: ${list.length} vs ${prev.length}, keeping old file`);
    process.exit(1);
  }

  fs.writeFileSync('stations.json', JSON.stringify(list, null, 1) + '\n', 'utf8');
  console.log(`Done: ${list.length} stations (OSM ${osm.length}, manual ${manual.length}), with gas: ${list.filter(s => s.hasGas).length}`);
})();

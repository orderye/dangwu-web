import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = '/tmp/dangwu-geonames';
const OUTPUT = resolve(ROOT, 'src/data/cities.json');
const META = resolve(ROOT, 'src/data/cities.meta.json');
const SNAPSHOT = '2026-09-11';
const SOURCES = {
  cities: {
    url: 'https://download.geonames.org/export/dump/cities15000.zip',
    file: resolve(TMP, 'cities15000.zip'),
    sha256: '9943935d4169b44736173c48bd494195cf9f776ecff2e9c82bade740165a85c9',
  },
  aliases: {
    url: 'https://download.geonames.org/export/dump/alternateNamesV2.zip',
    file: resolve(TMP, 'alternateNamesV2.zip'),
    sha256: 'cd875d6a58e7efc32b9e26154af0c7f88f6e8ec31cd11ce0144d0edcf79d635a',
  },
};

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex'))).on('error', reject);
  });
}

async function ensureSource(source) {
  mkdirSync(dirname(source.file), { recursive: true });
  if (!existsSync(source.file)) {
    const result = spawnSync('curl', ['-fL', '--retry', '3', '-o', source.file, source.url], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`下载失败：${source.url}`);
  }
  const actual = await sha256(source.file);
  if (actual !== source.sha256) throw new Error(`${basename(source.file)} checksum 不匹配：${actual}`);
}

function zippedLines(zipFile, entry) {
  const child = spawn('unzip', ['-p', zipFile, entry], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.on('error', (error) => { throw error; });
  return createInterface({ input: child.stdout, crlfDelay: Infinity });
}

const started = performance.now();
await Promise.all(Object.values(SOURCES).map(ensureSource));

const cities = [];
const byId = new Map();
for await (const line of zippedLines(SOURCES.cities.file, 'cities15000.txt')) {
  const f = line.split('\t');
  if (f.length < 19) continue;
  const city = {
    geonameId: Number(f[0]),
    name: f[1],
    asciiName: f[2],
    aliases: [],
    lat: Number(f[4]),
    lon: Number(f[5]),
    countryCode: f[8],
    population: Number(f[14]) || 0,
    timeZoneId: f[17] || null,
  };
  const builtIn = f[3].split(',').map((x) => x.trim()).filter(Boolean);
  city.aliases = [...new Set(builtIn.filter((x) => x !== city.name && x !== city.asciiName))].slice(0, 4);
  cities.push(city);
  byId.set(city.geonameId, city);
}

const selected = new Map();
for await (const line of zippedLines(SOURCES.aliases.file, 'alternateNamesV2.txt')) {
  const f = line.split('\t');
  const id = Number(f[1]);
  if (!byId.has(id) || !['zh', 'en'].includes(f[2]) || !f[3]) continue;
  const key = `${id}:${f[2]}`;
  const rows = selected.get(key) || [];
  rows.push({ value: f[3], preferred: f[4] === '1', short: f[5] === '1' });
  selected.set(key, rows);
}

for (const city of cities) {
  for (const lang of ['zh', 'en']) {
    const rows = selected.get(`${city.geonameId}:${lang}`) || [];
    rows.sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.short) - Number(a.short) || a.value.length - b.value.length);
    for (const row of rows.slice(0, 3)) city.aliases.push(row.value);
  }
  city.aliases = [...new Set(city.aliases.filter((x) => x !== city.name && x !== city.asciiName))].slice(0, 8);
}

cities.sort((a, b) => b.population - a.population || a.geonameId - b.geonameId);
const json = JSON.stringify(cities);
writeFileSync(OUTPUT, json);
const metadata = {
  snapshotDate: SNAPSHOT,
  generatedAt: new Date().toISOString(),
  count: cities.length,
  bytes: Buffer.byteLength(json),
  license: 'GeoNames data is licensed under CC BY 4.0',
  sources: Object.fromEntries(Object.entries(SOURCES).map(([key, value]) => [key, { url: value.url, sha256: value.sha256 }])),
  aliasLanguages: ['zh', 'en'],
  maxAliasesPerCity: 8,
};
writeFileSync(META, JSON.stringify(metadata, null, 2) + '\n');
console.log(`GeoNames: ${cities.length} cities, ${metadata.bytes} bytes, ${(performance.now() - started).toFixed(0)} ms`);

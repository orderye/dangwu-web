/**
 * 下载并校验 8192×4096 地球昼/夜贴图（Solar System Scope，CC BY 4.0），
 * 输出 assets/earth_day_8192.jpg 与 assets/earth_night_8192.jpg。
 * 用法：node tools/build-textures.mjs
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TMP = '/tmp/dangwu-textures';
const SOURCES = {
  day: {
    url: 'https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg',
    file: resolve(TMP, '8k_earth_daymap.jpg'),
    output: resolve(ROOT, 'assets/earth_day_8192.jpg'),
    sha256: '88ab060b6e7d241cfc590c69f528fab2b3247b738d40124cb590999a6fe44abc',
  },
  night: {
    url: 'https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg',
    file: resolve(TMP, '8k_earth_nightmap.jpg'),
    output: resolve(ROOT, 'assets/earth_night_8192.jpg'),
    sha256: '9894e83a585a22c1c425e7ca4f987a9ba625bf08ecee45d3c9dcacae3c2ad5f7',
  },
};

function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex'))).on('error', reject);
  });
}

/** 解析 JPEG SOF0/SOF2 段读取像素尺寸，避免引入图像库。 */
function jpegSize(file) {
  return new Promise((resolveSize, reject) => {
    const chunks = [];
    let read = 0;
    const stream = createReadStream(file, { highWaterMark: 1 << 16 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    const buf = () => Buffer.concat(chunks);
    // SOF 段一般在文件头部 1~2 MB 内，读够 512 KB 即可判定
    stream.on('end', () => resolveSize(null));
    stream.on('data', () => {
      if (read) return;
      const b = buf();
      if (b.length < 512 * 1024 && !stream.readableEnded) return;
      read = 1;
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return resolveSize({ height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) });
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
      resolveSize(null);
    });
  });
}

const started = performance.now();
for (const [key, source] of Object.entries(SOURCES)) {
  if (existsSync(source.output)) {
    console.log(`${basename(source.output)} 已存在，跳过（删除后可重新下载）`);
    continue;
  }
  mkdirSync(dirname(source.file), { recursive: true });
  if (!existsSync(source.file)) {
    const result = spawnSync('curl', ['-fL', '--retry', '3', '-o', source.file, source.url], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`下载失败：${source.url}`);
  }
  const actual = await sha256(source.file);
  if (actual !== source.sha256) throw new Error(`${basename(source.file)} checksum 不匹配：${actual}`);
  const size = await jpegSize(source.file);
  if (!size || size.width !== 8192 || size.height !== 4096) {
    throw new Error(`${basename(source.file)} 尺寸异常：${JSON.stringify(size)}，期望 8192×4096`);
  }
  mkdirSync(dirname(source.output), { recursive: true });
  copyFileSync(source.file, source.output);
  console.log(`${key}: ${basename(source.output)} ${statSync(source.output).size} bytes, 8192×4096`);
}
console.log(`完成，耗时 ${(performance.now() - started).toFixed(0)} ms`);

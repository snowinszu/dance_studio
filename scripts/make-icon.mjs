// 生成应用图标：品牌红「圆角方块 + 四角星火花」，256×256。
// 纯 Node（zlib 手写 PNG + ICO 封装），不引第三方依赖。
// 产物：build/icon.png（源）、build/icon.ico（Windows 打包用，PNG-in-ICO，Vista+ 支持）。
//
// 颜色取自设计系统 --accent（小红书红 ≈ #FF2442，见 DESIGN.md）。此处是位图像素值，
// 不是 CSS，故直接写死 RGB。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const ACCENT = [0xff, 0x24, 0x42]; // 品牌红
const WHITE = [0xff, 0xff, 0xff];

// 超采样抗锯齿：每个像素取 3×3 子样本平均
const SS = 3;
const cx = SIZE / 2;
const cy = SIZE / 2;
const squareHalf = 100; // 圆角方块半边长 → 200×200 居中
const corner = 52; // 圆角半径
const starR = 74; // 星形外接半径

// 点是否落在圆角方块内
function inRoundedSquare(x, y) {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  if (dx > squareHalf || dy > squareHalf) return false;
  const ix = dx - (squareHalf - corner);
  const iy = dy - (squareHalf - corner);
  if (ix <= 0 || iy <= 0) return true; // 在直边区域内
  return ix * ix + iy * iy <= corner * corner; // 圆角区域
}

// 点是否落在四角星（星形曲线：|x|^k + |y|^k <= r^k，k<1 → 内凹四角星）内
function inStar(x, y) {
  const dx = Math.abs(x - cx) / starR;
  const dy = Math.abs(y - cy) / starR;
  const k = 0.62;
  return Math.pow(dx, k) + Math.pow(dy, k) <= 1;
}

// 生成 RGBA 像素缓冲
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let inSq = 0;
    let inSt = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (inRoundedSquare(px, py)) inSq++;
        if (inStar(px, py)) inSt++;
      }
    }
    const total = SS * SS;
    const sqA = inSq / total; // 方块覆盖率
    const stA = inSt / total; // 星形覆盖率
    // 先铺红方块，再把白星叠上去
    const r = WHITE[0] * stA + ACCENT[0] * (1 - stA);
    const g = WHITE[1] * stA + ACCENT[1] * (1 - stA);
    const b = WHITE[2] * stA + ACCENT[2] * (1 - stA);
    const a = Math.max(sqA, stA); // 方块外、星形也外 → 透明
    const o = (y * SIZE + x) * 4;
    rgba[o] = Math.round(r);
    rgba[o + 1] = Math.round(g);
    rgba[o + 2] = Math.round(b);
    rgba[o + 3] = Math.round(a * 255);
  }
}

// ---- 最小 PNG 编码器（RGBA / 8bit / color type 6）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgbaBuf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // 每行前置 1 字节 filter(0)
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgbaBuf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- PNG → ICO（单张 256px，PNG 压缩条目）----
function pngToIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 0 => 256
  entry[1] = 0; // height 0 => 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // size of image data
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(outDir, { recursive: true });
const png = encodePng(SIZE, SIZE, rgba);
writeFileSync(join(outDir, 'icon.png'), png);
writeFileSync(join(outDir, 'icon.ico'), pngToIco(png));
console.log(`wrote build/icon.png (${png.length} B) and build/icon.ico`);

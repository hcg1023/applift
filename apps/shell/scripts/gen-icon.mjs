/**
 * 应用图标源生成（零依赖）：1024×1024 PNG——圆角深底 + 白色 applift 上箭头（与托盘 template 图标同形）。
 * 产出 apps/shell/app-icon.png，供 `pnpm tauri icon` 派生全套平台图标（icns/ico/png 集合）。
 * 美术定位：占位升级（不追求品牌终稿）；4x 超采样 + 盒式降采样抗锯齿。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 4; // 超采样倍数
const N = SIZE * SS;

// -- 几何（归一化坐标，与 src-tauri/src/tray.rs 同形）--------------------------------
// 箭头 = 实心三角头（顶点 (0.5,0.10)、底边 y=0.52 跨 [0.14,0.86]）+ 矩形杆（x 跨 [0.42,0.58]、y 跨 [0.30,0.90]）
const inArrow = (nx, ny) => {
  if (ny >= 0.3 && ny <= 0.9 && nx >= 0.42 && nx <= 0.58) return true; // 杆
  if (ny >= 0.1 && ny <= 0.52) {
    const half = (0.86 - 0.14) * 0.5; // 三角头底半宽
    const t = (ny - 0.1) / (0.52 - 0.1); // 顶点→底边进度
    const w = half * t;
    return Math.abs(nx - 0.5) <= w;
  }
  return false;
};

// 圆角正方形 SDF（半径 22.5%——macOS Big Sur 比例）：角外点距角圆心 > R
const R = 0.225;
const insideRounded = (nx, ny) => {
  const qx = Math.abs(nx - 0.5) - (0.5 - R);
  const qy = Math.abs(ny - 0.5) - (0.5 - R);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  return d <= 0;
};

const BG = [30, 41, 59]; // slate-800
const FG = [248, 250, 252]; // slate-50

const rgba = new Uint8Array(SIZE * SIZE * 4);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let hitRound = 0;
    let hitArrow = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const nx = (x * SS + sx + 0.5) / N;
        const ny = (y * SS + sy + 0.5) / N;
        if (insideRounded(nx, ny)) {
          hitRound++;
          if (inArrow(nx, ny)) hitArrow++;
        }
      }
    }
    const total = SS * SS;
    const cov = hitRound / total;
    const fg = hitArrow / total;
    rgba[p++] = Math.round(BG[0] * (1 - fg) + FG[0] * fg);
    rgba[p++] = Math.round(BG[1] * (1 - fg) + FG[1] * fg);
    rgba[p++] = Math.round(BG[2] * (1 - fg) + FG[2] * fg);
    rgba[p++] = Math.round(255 * cov);
  }
}

// -- 极简 PNG 编码（RGBA8，filter 0）------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "app-icon.png");
writeFileSync(out, png);
console.log(`[shell] icon source written: ${out}（${SIZE}×${SIZE}，${png.length}B）`);

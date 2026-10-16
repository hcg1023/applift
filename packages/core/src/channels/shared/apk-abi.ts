/**
 * APK（zip）CPU ABI 探测——纯 Node 解析 zip 中央目录（零依赖、不解压内容）。
 * 用途：应用宝 update_app 的 apk32_flag/apk64_flag 分支（apkgo tencent.go isAPK64BitOnly 同构）。
 */
import fs from "node:fs";

const EOCD_MAGIC = 0x06054b50;
const CEN_MAGIC = 0x02014b50;

/** 列出 APK 内 lib/<abi>/ 出现过的 ABI 名；非 zip/无 lib 段返回空数组（按 32/64 兼容处理） */
export function listApkLibAbis(apkPath: string): string[] {
  const fd = fs.openSync(apkPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // EOCD 固定 22 字节 + 注释上限 65535
    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_MAGIC) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];
    const count = tail.readUInt16LE(eocd + 10);
    let offset = tail.readUInt32LE(eocd + 16);
    const abis = new Set<string>();
    for (let i = 0; i < count; i++) {
      const hdr = Buffer.alloc(46);
      if (fs.readSync(fd, hdr, 0, 46, offset) < 46) break;
      if (hdr.readUInt32LE(0) !== CEN_MAGIC) break;
      const nameLen = hdr.readUInt16LE(28);
      const extraLen = hdr.readUInt16LE(30);
      const commentLen = hdr.readUInt16LE(32);
      const nameBuf = Buffer.alloc(nameLen);
      if (fs.readSync(fd, nameBuf, 0, nameLen, offset + 46) < nameLen) break;
      const m = nameBuf.toString("utf8").match(/^lib\/([^/]+)\//);
      if (m?.[1]) abis.add(m[1]);
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return [...abis];
  } finally {
    fs.closeSync(fd);
  }
}

/** 是否 arm64-only 包：含 lib/ 且全部为 arm64-v8a（apkgo isAPK64BitOnly 同构；无 native 库返回 false） */
export function isApkArm64Only(apkPath: string): boolean {
  const abis = listApkLibAbis(apkPath);
  if (abis.length === 0) return false;
  return abis.every((a) => a === "arm64-v8a");
}

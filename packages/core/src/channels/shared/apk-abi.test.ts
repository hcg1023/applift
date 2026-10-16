/**
 * APK ABI 探测契约测试：最小 zip 中央目录解析（零依赖）、lib/ 提取与 arm64-only 判定。
 * buildZip 同时供 yyb.test.ts 复用（构造 arm64-only / 通用包夹具）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listApkLibAbis, isApkArm64Only } from "./apk-abi.js";

/** 构造最小合法 zip（STORED、零长内容）：本地头 + 中央目录 + EOCD，条目名即全部语义 */
export function buildZip(entryNames: string[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of entryNames) {
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(nameBuf.length, 28); // 文件名长
    cen.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entryNames.length, 8); // 本盘条目数
  eocd.writeUInt16LE(entryNames.length, 10); // 总条目数
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

function writeTmpZip(entries: string[]): string {
  const p = path.join(
    os.tmpdir(),
    `apk-abi-${process.pid}-${Math.random().toString(36).slice(2)}.apk`,
  );
  fs.writeFileSync(p, buildZip(entries));
  return p;
}

describe("listApkLibAbis", () => {
  it("提取 lib/<abi>/ 的 ABI 集合（去重、忽略非 lib 条目）", () => {
    const apk = writeTmpZip([
      "lib/arm64-v8a/libapp.so",
      "lib/arm64-v8a/libc++_shared.so",
      "lib/armeabi-v7a/libapp.so",
      "META-INF/MANIFEST.MF",
      "AndroidManifest.xml",
    ]);
    expect(listApkLibAbis(apk).sort()).toEqual(["arm64-v8a", "armeabi-v7a"]);
  });

  it("无 lib 段 → 空数组", () => {
    const apk = writeTmpZip(["AndroidManifest.xml", "classes.dex"]);
    expect(listApkLibAbis(apk)).toEqual([]);
  });

  it("非 zip 内容 → 空数组（按 32/64 兼容降级，不抛错）", () => {
    const p = path.join(os.tmpdir(), `apk-abi-plain-${process.pid}.apk`);
    fs.writeFileSync(p, Buffer.from("plain-bytes-not-a-zip"));
    expect(listApkLibAbis(p)).toEqual([]);
  });
});

describe("isApkArm64Only", () => {
  it("仅 arm64-v8a → true", () => {
    expect(isApkArm64Only(writeTmpZip(["lib/arm64-v8a/libapp.so"]))).toBe(true);
  });

  it("双 ABI / 无 native 库 → false", () => {
    expect(isApkArm64Only(writeTmpZip(["lib/arm64-v8a/a.so", "lib/armeabi-v7a/a.so"]))).toBe(false);
    expect(isApkArm64Only(writeTmpZip(["classes.dex"]))).toBe(false);
  });
});

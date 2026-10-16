import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readArtifactVersion } from "./version.js";

// 模块级 mock：version.ts 内 import 的 spawnSync 被替换
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawnMock = vi.mocked(spawnSync);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "applift-ver-"));
}

beforeEach(() => {
  spawnMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("readArtifactVersion — 来源正确性", () => {
  it(".apk 经 aapt 读包内 AndroidManifest（aapt 不可用时 undefined，不猜）", () => {
    const d = tmpDir();
    const apk = path.join(d, "app.apk");
    fs.writeFileSync(apk, "fake");
    const saved = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(d, "no-such-sdk");
    try {
      // aapt 探测全部失败（ANDROID_HOME 指向不存在目录）
      expect(readArtifactVersion(apk)).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = saved;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it(".apk aapt 可用时读包内版本（source 标注工具名）", () => {
    const d = tmpDir();
    const apk = path.join(d, "app.apk");
    fs.writeFileSync(apk, "fake");
    const fakeSdk = path.join(d, "sdk", "build-tools", "34.0.0");
    fs.mkdirSync(fakeSdk, { recursive: true });
    const tool = path.join(fakeSdk, "aapt2");
    fs.writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
    process.env.ANDROID_HOME = path.join(d, "sdk");
    spawnMock.mockReturnValue({
      status: 0,
      stdout: "package: name='com.x' versionCode='4235' versionName='4.0.0'",
    } as never);
    try {
      const v = readArtifactVersion(apk);
      expect(v).toEqual({ versionName: "4.0.0", versionCode: "4235", source: "aapt2" });
    } finally {
      delete process.env.ANDROID_HOME;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it(".hap 优先包内 pack.info（unzip -p），source 标注「包内」；同目录过期文件不干扰", () => {
    const d = tmpDir();
    const hap = path.join(d, "entry.hap");
    fs.writeFileSync(hap, "fake-zip");
    // 同目录过期 1.0.0，包内 2.0.0——必须读包内的
    fs.writeFileSync(
      path.join(d, "pack.info"),
      JSON.stringify({ versionName: "1.0.0", versionCode: 100 }),
    );
    spawnMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ versionName: "2.0.0", versionCode: 200 }),
    } as never);
    try {
      const v = readArtifactVersion(hap);
      expect(v).toEqual({ versionName: "2.0.0", versionCode: "200", source: "pack.info(包内)" });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it(".hap unzip 失败回退同目录 pack.info，source 标注「可能过期」", () => {
    const d = tmpDir();
    const hap = path.join(d, "entry.hap");
    fs.writeFileSync(hap, "fake-zip");
    fs.writeFileSync(
      path.join(d, "pack.info"),
      JSON.stringify({ versionName: "1.0.0", versionCode: 100 }),
    );
    spawnMock.mockReturnValue({ status: 1, error: new Error("no unzip") } as never);
    try {
      const v = readArtifactVersion(hap);
      expect(v).toEqual({
        versionName: "1.0.0",
        versionCode: "100",
        source: "pack.info(同目录,可能过期)",
      });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it(".ipa 不支持自动读（undefined 不误报）", () => {
    spawnMock.mockReturnValue({ status: 1 } as never);
    expect(readArtifactVersion("/tmp/app.ipa")).toBeUndefined();
  });
});

describe("版本读取扩展名边界", () => {
  it("未知扩展名（.exe 等桌面产物）返回 undefined 不抛", () => {
    spawnMock.mockReturnValue({ status: 1 } as never);
    expect(readArtifactVersion("/tmp/app.exe")).toBeUndefined();
    expect(readArtifactVersion("/tmp/app.dmg")).toBeUndefined();
  });
  it(".app 鸿蒙整包同样走 pack.info 路径", () => {
    spawnMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ versionName: "1.2.3", versionCode: 9 }),
    } as never);
    expect(readArtifactVersion("/tmp/entry-default-signed.app")).toEqual({
      versionName: "1.2.3",
      versionCode: "9",
      source: "pack.info(包内)",
    });
  });
});

describe("版本读取容错分支", () => {
  it("pack.info 内容损坏（非 JSON）→ 回退链继续", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "applift-badpi-"));
    const hap = path.join(d, "e.hap");
    fs.writeFileSync(hap, "x");
    fs.writeFileSync(path.join(d, "pack.info"), "{broken json");
    spawnMock.mockReturnValue({ status: 1, error: new Error("x") } as never);
    try {
      expect(readArtifactVersion(hap)).toBeUndefined();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("aapt 成功但输出无版本字段 → 尝试下一个工具", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "applift-nover-"));
    const apk = path.join(d, "a.apk");
    fs.writeFileSync(apk, "x");
    const fakeSdk = path.join(d, "sdk", "build-tools", "34.0.0");
    fs.mkdirSync(fakeSdk, { recursive: true });
    fs.writeFileSync(path.join(fakeSdk, "aapt2"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(fakeSdk, "aapt"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.ANDROID_HOME = path.join(d, "sdk");
    // 第一次输出无版本（走 continue），第二次带版本
    spawnMock
      .mockReturnValueOnce({ status: 0, stdout: "package: name=com.x" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "versionCode='7' versionName='0.7'" } as never);
    try {
      const v2 = readArtifactVersion(apk);
      expect(v2).toEqual({ versionName: "0.7", versionCode: "7", source: "aapt" });
    } finally {
      delete process.env.ANDROID_HOME;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

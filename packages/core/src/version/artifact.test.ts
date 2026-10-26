import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readArtifactBuildTime, readArtifactVersion } from "./artifact.js";

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
    const savedHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(d, "sdk");
    spawnMock.mockReturnValue({
      status: 0,
      stdout: "package: name='com.x' versionCode='4235' versionName='4.0.0'",
    } as never);
    try {
      const v = readArtifactVersion(apk);
      expect(v).toEqual({ versionName: "4.0.0", versionCode: "4235", source: "aapt2" });
    } finally {
      if (savedHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = savedHome;
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

  it("真实鸿蒙 schema（qy-driver 实测样本 summary.app.version.{name,code}）——顶层形态双兼容", () => {
    const d = tmpDir();
    const hap = path.join(d, "entry-default-signed.hap");
    fs.writeFileSync(hap, "fake-zip");
    // qy-driver harmony/build/outputs/default/pack.info 的真实结构（截取版本相关）
    spawnMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        summary: {
          app: {
            bundleName: "com.thclouds.driver.hm",
            version: { code: 4000000, name: "4.0.0", build: "1" },
          },
        },
        packages: [{ name: "entry-default" }],
      }),
    } as never);
    try {
      const v = readArtifactVersion(hap);
      expect(v).toEqual({
        versionName: "4.0.0",
        versionCode: "4000000",
        source: "pack.info(包内)",
      });
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
    const savedHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(d, "sdk");
    // 第一次输出无版本（走 continue），第二次带版本
    spawnMock
      .mockReturnValueOnce({ status: 0, stdout: "package: name=com.x" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "versionCode='7' versionName='0.7'" } as never);
    try {
      const v2 = readArtifactVersion(apk);
      expect(v2).toEqual({ versionName: "0.7", versionCode: "7", source: "aapt" });
    } finally {
      if (savedHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = savedHome;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

/** spawnSync mock 的 argv 提取：参数数组逐项校验为 string 后收窄（未知形态返回 undefined） */
function mockArgv(args: unknown[]): string[] | undefined {
  const a = args[1];
  if (Array.isArray(a) && a.every((x) => typeof x === "string")) {
    const argv = a as string[]; // 已逐项校验为 string
    return argv;
  }
  return undefined;
}

describe("readArtifactBuildTime — pushy 构建时间戳（须与设备上报精确一致）", () => {
  it(".hap/.app 顶层 meta.json → pushy_build_time", () => {
    spawnMock.mockImplementation(((...args: unknown[]) => {
      const argv = mockArgv(args);
      if (argv?.[0] === "-p" && argv.includes("resources/rawfile/meta.json")) {
        return { status: 0, stdout: JSON.stringify({ pushy_build_time: "1792939052087" }) };
      }
      return { status: 1 };
    }) as never);
    expect(readArtifactBuildTime("/tmp/e.hap")).toBe("1792939052087");
  });

  it(".app 整包嵌套 hap：顶层无 meta.json → 列目录取 hap 再读", () => {
    const d = tmpDir();
    const nestedHap = path.join(d, "nested.hap");
    fs.writeFileSync(nestedHap, "fake-hap");
    const hapBin = fs.readFileSync(nestedHap);
    spawnMock.mockImplementation(((...args: unknown[]) => {
      const argv = mockArgv(args);
      if (argv?.[0] === "-Z1") return { status: 0, stdout: "pack.info\nentry-default.hap\n" };
      if (argv?.[0] === "-p" && argv.at(-1) === "entry-default.hap") {
        return { status: 0, stdout: hapBin };
      }
      if (argv?.[0] === "-p" && argv.at(-1) === "resources/rawfile/meta.json") {
        // 第一次（.app 顶层）失败，第二次（解出的 hap）成功
        const metaCalls = spawnMock.mock.calls.filter((c) => {
          const a = mockArgv(c);
          return a?.at(-1) === "resources/rawfile/meta.json";
        }).length;
        return metaCalls > 1
          ? {
              status: 0,
              stdout: JSON.stringify({ pushy_build_time: 123, versionName: "4.0.1000" }),
            }
          : { status: 1 };
      }
      return { status: 1 };
    }) as never);
    try {
      // 数字型 pushy_build_time 也归一为字符串
      expect(readArtifactBuildTime("/tmp/entry.app")).toBe("123");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("meta.json 无 pushy_build_time / unzip 失败 → undefined（不猜测）", () => {
    spawnMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ versionName: "4.0.0" }),
    } as never);
    expect(readArtifactBuildTime("/tmp/e.hap")).toBeUndefined();
    spawnMock.mockReturnValue({ status: 1 } as never);
    expect(readArtifactBuildTime("/tmp/e.hap")).toBeUndefined();
  });

  it(".apk：aapt xmltree 输出含 pushy_build_time → 提取；.ipa：pushy_build_time.txt → trim", () => {
    const d = tmpDir();
    const fakeSdk = path.join(d, "sdk", "build-tools", "34.0.0");
    fs.mkdirSync(fakeSdk, { recursive: true });
    fs.writeFileSync(path.join(fakeSdk, "aapt2"), "#!/bin/sh\n", { mode: 0o755 });
    const saved = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(d, "sdk");
    spawnMock.mockImplementation(((...args: unknown[]) => {
      const argv = mockArgv(args);
      if (argv?.includes("xmltree")) {
        return {
          status: 0,
          stdout:
            'E: meta-data\n  A: android:name="pushy_build_time"\n  A: android:value="1792939052087"',
        };
      }
      if (argv?.[0] === "-p") return { status: 0, stdout: " 1792939052087 \n" };
      return { status: 1 };
    }) as never);
    try {
      const apk = path.join(d, "a.apk");
      fs.writeFileSync(apk, "x");
      expect(readArtifactBuildTime(apk)).toBe("1792939052087");
      expect(readArtifactBuildTime("/tmp/app.ipa")).toBe("1792939052087");
    } finally {
      if (saved === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = saved;
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

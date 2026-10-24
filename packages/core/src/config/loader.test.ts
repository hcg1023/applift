import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadCredentials,
  saveCredentials,
  resolveProfile,
  loadGlobalConfig,
  loadCredentialsLayered,
  CREDENTIALS_PATH,
} from "./loader.js";

function tmpFile(name: string): string {
  return path.join(os.tmpdir(), `applift-test-${name}.json`);
}

describe("credentials.json", () => {
  it("save → load 往返一致，且权限 0600", () => {
    const p = tmpFile("creds");
    saveCredentials(
      {
        profiles: {
          default: { PGYER_API_KEY: "abc def", AGC_CLIENT_ID: "id#1" },
          "company-b": { PGYER_API_KEY: "another" },
        },
      },
      p,
    );
    try {
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      const loaded = loadCredentials(p);
      expect(loaded.profiles.default?.AGC_CLIENT_ID).toBe("id#1");
      expect(loaded.profiles["company-b"]?.PGYER_API_KEY).toBe("another");
      // 含空格/引号语义的值往返
      expect(loaded.profiles.default?.PGYER_API_KEY).toBe("abc def");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("文件不存在 → 空 profiles", () => {
    expect(loadCredentials(tmpFile("nonexist"))).toEqual({ profiles: {} });
  });

  it("过宽权限被自动修复为 0600", () => {
    const p = tmpFile("perms");
    fs.writeFileSync(p, '{"profiles":{"default":{"K":"v"}}}', { mode: 0o644 });
    try {
      loadCredentials(p);
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("profile 名与键名不再受限（JSON 允许任意字符串）", () => {
    const p = tmpFile("any-keys");
    saveCredentials({ profiles: { "bad=name": { "bad#key": "v" } } }, p);
    try {
      expect(loadCredentials(p)).toEqual({ profiles: { "bad=name": { "bad#key": "v" } } });
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("resolveProfile", () => {
  const creds = { profiles: { default: { K: "v" } } };

  it("命中返回 profile 内容", () => {
    expect(resolveProfile(creds, "default")).toEqual({ K: "v" });
  });

  it("未命中报错并列出可用 profiles", () => {
    expect(() => resolveProfile(creds, "nope")).toThrow(/nope.*default/s);
  });

  it("profiles 为空时报 (无) 而非空列表", () => {
    expect(() => resolveProfile({ profiles: {} }, "nope")).toThrow(/可用: \(无\)/);
  });
});

describe("resolveProfile env 覆盖（优先级公理的 env 层）", () => {
  it("APPLIFT_* 前缀 > profile 文件值；裸 knownKey 次之；未知裸键不捡", () => {
    const file = tmpFile("env-override");
    saveCredentials(
      { profiles: { default: { PGYER_API_KEY: "file-key", AGC_CLIENT_ID: "file-agc" } } },
      file,
    );
    const saved = { ...process.env };
    process.env.APPLIFT_PGYER_API_KEY = "env-applift";
    process.env.AGC_CLIENT_ID = "env-bare";
    process.env.SOME_RANDOM_SECRET = "noise";
    try {
      const merged = resolveProfile(loadCredentials(file), "default", [
        "PGYER_API_KEY",
        "AGC_CLIENT_ID",
      ]);
      expect(merged.PGYER_API_KEY).toBe("env-applift"); // APPLIFT_* 最高
      expect(merged.AGC_CLIENT_ID).toBe("env-bare"); // 裸键在 knownKeys 内 → 覆盖
      expect(merged.SOME_RANDOM_SECRET).toBeUndefined(); // 未知裸键不误吸
    } finally {
      for (const k of ["APPLIFT_PGYER_API_KEY", "AGC_CLIENT_ID", "SOME_RANDOM_SECRET"])
        delete process.env[k];
      Object.assign(process.env, saved);
      fs.unlinkSync(file);
    }
  });

  it("未提供 knownKeys 时裸键不认，仅 APPLIFT_* 生效（避免误吸无关变量）", () => {
    const file = tmpFile("env-nokeys");
    saveCredentials({ profiles: { default: { PGYER_API_KEY: "file-key" } } }, file);
    process.env.PGYER_API_KEY = "env-bare";
    try {
      const merged = resolveProfile(loadCredentials(file), "default");
      expect(merged.PGYER_API_KEY).toBe("file-key");
    } finally {
      delete process.env.PGYER_API_KEY;
      fs.unlinkSync(file);
    }
  });
});

describe("loadGlobalConfig", () => {
  it("文件不存在 → 全默认值，无警告", () => {
    const { config: cfg, warning } = loadGlobalConfig(tmpFile("nonexist"));
    expect(cfg.concurrency).toBe(4);
    expect(cfg.assumeYes).toBe(false);
    expect(warning).toBeUndefined();
  });
});

describe("CREDENTIALS_PATH 落在 ~/.applift", () => {
  it("路径约定", () => {
    expect(CREDENTIALS_PATH).toBe(path.join(os.homedir(), ".applift", "credentials.json"));
  });
});

describe("loadGlobalConfig 容错", () => {
  it("损坏 TOML 降级全默认值（警告经返回值给出，不抛错不写流）", () => {
    const p = tmpFile("broken");
    fs.writeFileSync(p, "not [valid toml ===");
    try {
      const { config: cfg, warning } = loadGlobalConfig(p);
      expect(cfg.concurrency).toBe(4);
      expect(cfg.assumeYes).toBe(false);
      expect(warning).toContain("全局配置解析失败");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("有效 TOML 全字段解析", () => {
    const p = tmpFile("valid");
    fs.writeFileSync(
      p,
      'defaultProfile = "company-b"\nconcurrency = 2\nuploadTimeoutMs = 1000\nassumeYes = true\n',
    );
    try {
      const { config: cfg } = loadGlobalConfig(p);
      expect(cfg).toEqual({
        defaultProfile: "company-b",
        concurrency: 2,
        uploadTimeoutMs: 1000,
        assumeYes: true,
      });
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("loadCredentialsLayered 逐级凭据", () => {
  it("项目键就近优先，缺失键回退全局；同名 profile 逐键覆盖", () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-layered-"));
    const localDir = path.join(projDir, ".applift");
    fs.mkdirSync(localDir);
    const globalFile = tmpFile("layered-global");
    const projFile = path.join(localDir, "credentials.json");
    saveCredentials(
      { profiles: { default: { PGYER_API_KEY: "g-key", AGC_CLIENT_ID: "g-agc" } } },
      globalFile,
    );
    saveCredentials({ profiles: { default: { PGYER_API_KEY: "p-key" } } }, projFile);
    try {
      const merged = loadCredentialsLayered(projDir, globalFile);
      expect(merged.profiles.default?.PGYER_API_KEY).toBe("p-key"); // 项目覆盖
      expect(merged.profiles.default?.AGC_CLIENT_ID).toBe("g-agc"); // 回退全局
      // 项目独立 profile：仅项目有则直接可用
      saveCredentials(
        { profiles: { default: { PGYER_API_KEY: "p-key" }, ci: { PGYER_API_KEY: "ci-key" } } },
        projFile,
      );
      const m2 = loadCredentialsLayered(projDir, globalFile);
      expect(m2.profiles.ci?.PGYER_API_KEY).toBe("ci-key");
      expect(m2.profiles.default?.AGC_CLIENT_ID).toBe("g-agc");
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.unlinkSync(globalFile);
    }
  });

  it("无项目级文件时等价全局", () => {
    const globalFile = tmpFile("layered-global2");
    saveCredentials({ profiles: { default: { K: "v" } } }, globalFile);
    try {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "applift-nolocal-"));
      const merged = loadCredentialsLayered(empty, globalFile);
      expect(merged.profiles.default).toEqual({ K: "v" });
      fs.rmSync(empty, { recursive: true, force: true });
    } finally {
      fs.unlinkSync(globalFile);
    }
  });

  it("未提供 projectRoot（undefined）→ 直接返回全局，不查找项目级文件", () => {
    const globalFile = tmpFile("layered-global3");
    saveCredentials({ profiles: { default: { K: "v" } } }, globalFile);
    try {
      const merged = loadCredentialsLayered(undefined, globalFile);
      expect(merged).toEqual({ profiles: { default: { K: "v" } } });
    } finally {
      fs.unlinkSync(globalFile);
    }
  });
});

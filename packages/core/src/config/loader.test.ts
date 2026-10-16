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
  return path.join(os.tmpdir(), `applift-test-${name}.toml`);
}

describe("credentials.toml", () => {
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
    fs.writeFileSync(p, '[profiles.default]\nK = "v"\n', { mode: 0o644 });
    try {
      loadCredentials(p);
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("profile 名含裸键非法字符（如 = / 空格）→ 抛错且不写文件", () => {
    const p = tmpFile("bad-profile");
    expect(() => saveCredentials({ profiles: { "bad=name": { K: "v" } } }, p)).toThrow(
      /bad=name.*非法字符/,
    );
    expect(fs.existsSync(p)).toBe(false);
  });

  it("键名含 # 等非法字符 → 抛错点名键名", () => {
    expect(() =>
      saveCredentials({ profiles: { ok: { "bad#key": "v" } } }, tmpFile("bad-key")),
    ).toThrow(/bad#key.*非法字符/);
  });

  it("合法字符集边界（- 与 _）正常往返", () => {
    const p = tmpFile("legal-keys");
    saveCredentials({ profiles: { "my-profile_1": { "CLIENT_KEY-X": "v" } } }, p);
    try {
      expect(loadCredentials(p)).toEqual({ profiles: { "my-profile_1": { "CLIENT_KEY-X": "v" } } });
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

describe("loadGlobalConfig", () => {
  it("文件不存在 → 全默认值", () => {
    const cfg = loadGlobalConfig(tmpFile("nonexist"));
    expect(cfg.concurrency).toBe(4);
    expect(cfg.assumeYes).toBe(false);
  });
});

describe("CREDENTIALS_PATH 落在 ~/.applift", () => {
  it("路径约定", () => {
    expect(CREDENTIALS_PATH).toBe(path.join(os.homedir(), ".applift", "credentials.toml"));
  });
});

describe("loadGlobalConfig 容错", () => {
  it("损坏 TOML 降级全默认值（stderr 警告不抛错）", () => {
    const p = tmpFile("broken");
    fs.writeFileSync(p, "not [valid toml ===");
    try {
      const cfg = loadGlobalConfig(p);
      expect(cfg.concurrency).toBe(4);
      expect(cfg.assumeYes).toBe(false);
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
      const cfg = loadGlobalConfig(p);
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
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "qypub-layered-"));
    const localDir = path.join(projDir, ".applift");
    fs.mkdirSync(localDir);
    const globalFile = tmpFile("layered-global");
    const projFile = path.join(localDir, "credentials.toml");
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
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), "qypub-nolocal-"));
      const merged = loadCredentialsLayered(empty, globalFile);
      expect(merged.profiles.default).toEqual({ K: "v" });
      fs.rmSync(empty, { recursive: true, force: true });
    } finally {
      fs.unlinkSync(globalFile);
    }
  });
});

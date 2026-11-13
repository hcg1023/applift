/**
 * init 凭据组一致性（静态对拍）：
 * - CREDENTIAL_GROUPS 每组每个键都在 CREDENTIAL_FIELDS 有条目（向导能给出 label/where 指引，find 不会落空）
 * - huawei 组 ⊇ 渠道元数据 REQUIRED_KEYS_BY_CHANNEL 的 huawei+agc 键（安卓 HW_* 与鸿蒙 AGC_* 一组配齐）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { CREDENTIAL_FIELDS, CREDENTIAL_GROUPS } from "./lifecycle.js";
import { REQUIRED_KEYS_BY_CHANNEL } from "./channel-meta.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

describe("init 凭据组一致性", () => {
  it("每组每个键都存在于 CREDENTIAL_FIELDS", () => {
    for (const [group, keys] of Object.entries(CREDENTIAL_GROUPS)) {
      for (const key of keys) {
        expect(
          CREDENTIAL_FIELDS.some((f) => f.key === key),
          `${group} 组的 ${key} 缺少 CREDENTIAL_FIELDS 条目`,
        ).toBe(true);
      }
    }
  });

  it("huawei 组 ⊇ REQUIRED_KEYS_BY_CHANNEL 的 huawei+agc 键", () => {
    const need = [
      ...(REQUIRED_KEYS_BY_CHANNEL.huawei ?? []),
      ...(REQUIRED_KEYS_BY_CHANNEL.agc ?? []),
    ];
    for (const key of need) {
      expect(CREDENTIAL_GROUPS.huawei, `huawei 组缺 ${key}`).toContain(key);
    }
  });
});

describe("status --json 契约（StatusReport 包装）", () => {
  // 与 commands.test.ts 同模式：spawn dist/bin.mjs（globalSetup 单次构建）+ HOME 隔离
  let home: string;
  let proj: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-home-"));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), "applift-proj-"));
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({ name: "status-json", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/core";\nexport default defineConfig({ android: { pkgName: "com.status.json", stores: { nope: {} } } });\n`,
    );
    fs.mkdirSync(path.join(proj, ".applift"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".applift", "credentials.json"),
      `{"profiles":{"default":{}}}`,
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  });

  function cli(args: string[]) {
    const r = spawnSync("node", [BIN, ...args], {
      cwd: proj,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        APPLIFT_HOME: path.join(home, ".applift"),
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") };
  }

  it("status --json 契约快照（含 platform/fetchedAt）", () => {
    const r = cli(["status", "--json"]);
    expect(r.code).toBe(1); // nope 是未知渠道：JSON 正常输出但 exit 1
    const report = JSON.parse(r.out) as {
      fetchedAt: string;
      results: Array<{ channel: string; platform?: string; state: string; fetchedAt?: string }>;
    };
    expect(report.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.results.every((x) => x.platform && x.state && x.fetchedAt)).toBe(true);
    expect(report.results.map((x) => x.channel)).toMatchInlineSnapshot(`
      [
        "nope",
      ]
    `);
    expect(report.results.every((x) => x.platform === "android")).toBe(true); // 一期：storeIds 全来自 config.android.stores
    expect(report.results.every((x) => !("version" in x) || x.version === undefined)).toBe(true); // 一期不造 version 数据
  });
});

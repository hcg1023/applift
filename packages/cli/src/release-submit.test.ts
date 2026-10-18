/**
 * release L3 提审路径进程内测试（桩渠道，照 use.test 模式：config 插件注册 + globalThis 捕获）。
 * 锁定：--dry-run --json 计划形态 / --skip-stage 的 sha 反向守卫（防提审旧草稿）/ stage 失败 exit 1 /
 * dry-run 零副作用（不改文件不落 history）。
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelContext } from "@applift/core";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rel-home-"));
process.env.APPLIFT_HOME = home;
// 最小凭据（default 空 profile）：release 非 dry-run 需要 profile 存在
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "credentials.json"), `{"profiles":{"default":{}}}`);
const { program } = await import("./index.js");
const core = await import("@applift/core");

afterAll(() => {
  delete process.env.APPLIFT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});
const slot = globalThis as unknown as {
  __relCaptured?: { stageResults: Array<{ ok: boolean; ctx?: ChannelContext }> };
  __relStageOk?: boolean;
  __relStageError?: string;
};
slot.__relCaptured = { stageResults: [] };

function makeProj(stageOk = true, stageError = "桩渠道 stage 失败") {
  // 桩 stage 行为走 globalThis 开关（registry 是模块单例：多用例共用一个桩，行为随用例切换）
  slot.__relStageOk = stageOk;
  slot.__relStageError = stageError;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rel-proj-"));
  fs.writeFileSync(
    path.join(dir, "applift.config.ts"),
    [
      "export default {",
      "  android: { pkgName: 'com.rel.demo', stores: { 'rel-stub': {} } },",
      "  plugins: [{",
      "    name: 'capture',",
      "    'channel:register': (registry) => {",
      "      if (registry.get('rel-stub')) return;",
      "      registry.register({",
      "        id: 'rel-stub', label: '桩渠道',",
      `        capabilities: { stage: true, submit: true, scheduled: false, status: false },`,
      "        plan: async () => ({ channel: 'rel-stub', platform: 'android', artifactVersion: '1.0.0', action: 'two-phase', afterApproval: 'auto-publish' }),",
      `        stage: async (ctx) => { const ok = globalThis.__relStageOk !== false; globalThis.__relCaptured.stageResults.push({ ok, ctx }); return { ok, ...(ok ? { ref: 'rel-stub-ref' } : { error: globalThis.__relStageError ?? '桩渠道 stage 失败' }) }; },`,
      "        submit: async () => ({ ok: true }),",
      "        status: async () => ({ state: 'unknown' }),",
      "      });",
      "    },",
      "  }],",
      "};",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "demo.apk"), `apk-bytes-${Math.random()}`);
  return dir;
}

function capture(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((b) => {
    writes.push(String(b));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((b) => {
    writes.push(String(b));
    return true;
  });
  return writes;
}

describe("release L3 提审路径（桩渠道进程内）", () => {
  it("--dry-run --json：计划含目标渠道、无 errors、零副作用", async () => {
    const dir = makeProj();
    const histPath = path.join(home, "history.jsonl");
    const out = capture();
    try {
      await program.parseAsync(
        ["release", "android", "--cwd", dir, "--stores", "rel-stub", "--dry-run", "--json"],
        { from: "user" },
      );
      const json = JSON.parse(out.join("")) as {
        dryRun?: unknown;
        plans?: Array<{ channel: string; error?: string }>;
      };
      expect(JSON.stringify(json)).toContain("rel-stub");
      expect(slot.__relCaptured?.stageResults).toHaveLength(0); // dry-run 渠道零调用
      expect(fs.existsSync(histPath)).toBe(false); // 不落 history
      expect(fs.readdirSync(dir).sort()).toEqual(["applift.config.ts", "demo.apk"]); // 不写任何文件
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--submit --skip-stage：最近草稿是另一个包 → sha 反向守卫警告", async () => {
    const dir = makeProj();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "history.jsonl"),
      `${JSON.stringify({ ts: 1, channel: "rel-stub", action: "stage", artifactSha256: "deadbeef", ok: true, cwd: dir })}\n`,
    );
    const out = capture();
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--submit",
          "--skip-stage",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
        ],
        { from: "user" },
      );
      expect(out.join("")).toMatch(/最近草稿是另一个包/);
    } finally {
      fs.rmSync(path.join(home, "history.jsonl"), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stage-only 桩渠道失败：exitCode 置 1（CI 可判失败）", async () => {
    const dir = makeProj(false);
    capture();
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
        ],
        { from: "user" },
      );
      expect(process.exitCode).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--submit 正常链路：stage→submit 全走、history 落两条", async () => {
    const dir = makeProj(true);
    capture();
    const histPath = path.join(home, "history.jsonl");
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--submit",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
        ],
        { from: "user" },
      );
      expect(slot.__relCaptured?.stageResults).toHaveLength(2); // --submit 一条龙：stage + submit 流程内再 stage
      const entries = core.readEntries({ channel: "rel-stub" }, histPath);
      expect(entries.filter((e) => e.ok)).toHaveLength(2); // stage + submit
      expect(entries.every((e) => e.artifactSha256.length > 0)).toBe(true);
    } finally {
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stage-only --json：ref 字段显式出现并透出桩渠道 ref", async () => {
    const dir = makeProj();
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      out.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const histPath = path.join(home, "history.jsonl");
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
          "--json",
        ],
        { from: "user" },
      );
      // stdout 纯 JSON（stderr 抑制捕获）：ref 字段必须显式出现（null 也不被 stringify 丢弃）
      const json = JSON.parse(out.join("")) as {
        stage: Array<{ channel: string; ok: boolean; ref: string | null }>;
      };
      expect(json.stage).toHaveLength(1);
      expect(json.stage[0]).toMatchObject({ channel: "rel-stub", ok: true });
      expect(json.stage[0]!.ref).toBe("rel-stub-ref");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("渠道错误消息内嵌凭据（Authorization=token）→ 渲染前脱敏为 [REDACTED…", async () => {
    const dir = makeProj(false, "上传失败：Authorization=abc123xyz 被渠道拒绝");
    const out = capture();
    const histPath = path.join(home, "history.jsonl");
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
        ],
        { from: "user" },
      );
      const text = out.join("");
      expect(text).toContain("[REDACTED"); // 汇总渲染先过 redactText
      expect(text).not.toContain("abc123xyz"); // 原始 token 不落任何输出
      expect(process.exitCode).toBe(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
  __d3Touched?: string[];
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
      "      registry.register({",
      "        id: 'rel-nostage', label: '无草稿桩渠道',",
      "        capabilities: { stage: false, submit: true, scheduled: false, status: false },",
      "        plan: async () => ({ channel: 'rel-nostage', platform: 'android', artifactVersion: '1.0.0', action: 'submit-only', afterApproval: 'auto-publish' }),",
      "        stage: async () => ({ ok: false, error: '该渠道不支持只传包' }),",
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

  it("stage-only 含 stage:false 渠道：排除并提示，exit 0、无「部分渠道传包失败」", async () => {
    const dir = makeProj(true);
    slot.__relCaptured!.stageResults.length = 0; // 桩渠道 stage 计数为跨用例累积，重置避免影响后续断言
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
          "rel-stub,rel-nostage",
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
        ],
        { from: "user" },
      );
      const text = out.join("");
      expect(text).toContain("「无草稿桩渠道」上传即提审、无草稿区，已从本次传包排除");
      expect(text).toContain("需提审请用 --submit");
      expect(text).not.toContain("部分渠道传包失败");
      expect(process.exitCode).toBe(0);
      // 被排除渠道不进 pipeline：history 无其任何记录
      expect(core.readEntries({ channel: "rel-nostage" }, histPath)).toHaveLength(0);
    } finally {
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--submit 正常链路：stage→submit 全走、history 落两条", async () => {
    const dir = makeProj(true);
    capture();
    slot.__relCaptured = { stageResults: [] }; // 用例内重置：断言自身实际值，不依赖前序用例污染
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
      expect(slot.__relCaptured?.stageResults).toHaveLength(1); // --submit 一条龙：skipStage=false 流程内 stage 一次
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

  it("--json：错误出口同样脱敏（error 字段含 [REDACTED、不含原始 token）", async () => {
    const dir = makeProj(false, "上传失败：Authorization=abc123xyz 被渠道拒绝");
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
      // stdout 纯 JSON（stderr 抑制捕获）：error 字段必须过 redactText
      const json = JSON.parse(out.join("")) as {
        stage: Array<{ channel: string; ok: boolean; error?: string }>;
      };
      expect(json.stage).toHaveLength(1);
      expect(json.stage[0]).toMatchObject({ channel: "rel-stub", ok: false });
      expect(json.stage[0]!.error).toContain("[REDACTED");
      expect(json.stage[0]!.error).not.toContain("abc123xyz");
      expect(process.exitCode).toBe(1);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("凭据只在项目级 .applift/（全局无 default profile）→ release 仍可用（分层凭据链回归）", async () => {
    const dir = makeProj();
    // 全局凭据置空 profiles：旧实现（loadCredentials 仅全局）会抛"凭据 profile 不存在"
    const globalCreds = path.join(home, "credentials.json");
    const original = fs.readFileSync(globalCreds, "utf8");
    fs.writeFileSync(globalCreds, `{"profiles":{}}`);
    fs.mkdirSync(path.join(dir, ".applift"));
    fs.writeFileSync(
      path.join(dir, ".applift", "credentials.json"),
      `{"profiles":{"default":{"REL_STUB_KEY":"v"}}}`,
    );
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
          "--json",
        ],
        { from: "user" },
      );
      const json = JSON.parse(out.join("")) as { stage?: Array<{ channel: string; ok: boolean }> };
      expect(json.stage?.[0]).toMatchObject({ channel: "rel-stub", ok: true });
    } finally {
      vi.restoreAllMocks();
      fs.writeFileSync(globalCreds, original);
      fs.rmSync(histPath, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--submit --json 无 --yes（非 TTY）→ fail-fast 拒绝并给出 --yes 出路（P0 门控）", async () => {
    const dir = makeProj();
    slot.__relCaptured = { stageResults: [] }; // 捕获器跨用例共享，重置后再断言零触达
    try {
      await expect(
        program.parseAsync(
          ["release", "android", "--cwd", dir, "--stores", "rel-stub", "--submit", "--json"],
          { from: "user" },
        ),
      ).rejects.toThrow(/提审需显式授权：加 --yes/);
      expect(slot.__relCaptured?.stageResults).toHaveLength(0); // 渠道零触达
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run --submit --json：零副作用预览不被提审门控误拦", async () => {
    const dir = makeProj();
    const out = capture();
    try {
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "rel-stub",
          "--dry-run",
          "--submit",
          "--json",
        ],
        { from: "user" },
      );
      const json = JSON.parse(out.join("")) as { dryRun?: boolean; plans?: unknown[] };
      expect(json.plans?.length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 --stores 且配置无 stores：默认渠道按平台+可提审过滤（pgyer 型与 ios 渠道不进默认集）", async () => {
    // 桩渠道矩阵：两安卓 submit 型 + 一 ios submit 型 + 一安卓 pgyer 型（submit=false）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rel-default-"));
    const mk = (id: string, platform: string, submit: boolean) =>
      [
        `registry.register({`,
        `  id: '${id}', label: '${id}',`,
        `  capabilities: { stage: true, submit: ${submit}, scheduled: false, status: false },`,
        `  plan: async () => ({ channel: '${id}', platform: '${platform}', artifactVersion: '1.0.0', action: 'two-phase', afterApproval: 'auto-publish' }),`,
        `  stage: async () => { (globalThis.__d3Touched ??= []).push('${id}'); return { ok: true, ref: '${id}-ref' }; },`,
        `  submit: async () => ({ ok: true }),`,
        `  status: async () => ({ state: 'unknown' }),`,
        `});`,
      ].join("\n");
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "export default {",
        "  plugins: [{",
        "    name: 'matrix',",
        "    'channel:register': (registry) => {",
        `      if (registry.get('droid-a')) return;`,
        ...["droid-a", "droid-b"].map((id) => mk(id, "android", true)),
        mk("ios-c", "ios", true),
        mk("pgyer-like", "android", false),
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "demo.apk"), `apk-${Math.random()}`);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      out.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    slot.__relCaptured = { stageResults: [] };
    slot.__d3Touched = [];
    try {
      process.exitCode = 0;
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--artifact",
          path.join(dir, "demo.apk"),
          "--yes",
          "--json",
        ],
        { from: "user" },
      );
      const json = JSON.parse(out.join("")) as { stage: Array<{ channel: string; ok: boolean }> };
      // 默认集只含安卓可提审渠道：桩矩阵中 ios-c / pgyer-like 零触达（真实安卓渠道可进默认集，缺配置本地快速失败）
      const stubIds = json.stage
        .map((e) => e.channel)
        .filter((id) => id.startsWith("droid") || id === "ios-c" || id === "pgyer-like");
      expect(stubIds.sort()).toEqual(["droid-a", "droid-b"]);
      expect(
        json.stage.some(
          (e) =>
            e.channel === "ios-c" ||
            e.channel === "pgyer-like" ||
            e.channel === "pgyer" ||
            e.channel === "agc" ||
            e.channel === "asc",
        ),
      ).toBe(false);
      expect(slot.__d3Touched ?? []).toEqual(["droid-a", "droid-b"]); // 桩 stage 只触达两安卓 submit 渠道
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

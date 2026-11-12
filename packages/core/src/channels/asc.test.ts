/**
 * AscChannel 单元测试：spawnSync 用 vi.mock('node:child_process')；submit/status 走 fetch 契约 mock。
 * p8 用真实生成的 EC 密钥（makeAscJwt 需可读 PEM）。上传双引擎（iTMSTransporter/altool）
 * 经 spyOn resolveTransporterPath 注入分别覆盖。
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelContext } from "../channel.js";
import type { MockInstance } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AscChannel } from "./asc.js";
import { mockFetch } from "../test-utils.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn(), spawn: vi.fn() }));
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";

const spawnMock = vi.mocked(spawn);
const spawnSyncRaw = vi.mocked(spawnSync);
void spawnSyncRaw;

/**
 * spawnSync 风格 facade：上传引擎已异步化（spawnAsyncCapture 用 spawn），但既有用例的
 * mockReturnValue / mock.calls[0] 断言写法全部保留——mockReturnValue 设定下一次 spawn 的
 * 回放结果（stdout/stderr data 事件 + close/error），mock.calls 记录 spawn 调用参数。
 */
/** 挂起哨兵：设为 HANG 时 spawn 永不回放（真实超时路径用例专用） */
const HANG = Symbol("hang");
let nextResult:
  | {
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error;
    }
  | typeof HANG
  | undefined;
const spawnCalls: Array<[string, string[], Record<string, unknown>]> = [];
const spawnSyncMock = {
  mockReturnValue(r: typeof nextResult) {
    nextResult = r;
  },
  mockReset() {
    nextResult = undefined;
    spawnCalls.length = 0;
  },
  toHaveBeenCalledTimes(n: number) {
    if (spawnCalls.length !== n)
      throw new Error(`expected ${n} spawn calls, got ${spawnCalls.length}`);
  },
  toHaveBeenCalled() {
    if (spawnCalls.length === 0) throw new Error("expected spawn to have been called");
  },
  not: {
    toHaveBeenCalled() {
      if (spawnCalls.length > 0)
        throw new Error(`expected no spawn calls, got ${spawnCalls.length}`);
    },
  },
  get mock() {
    return { calls: spawnCalls };
  },
};
spawnMock.mockImplementation(((cmd: string, args: string[], opts: Record<string, unknown>) => {
  spawnCalls.push([cmd, args, opts]);
  // 手写同步流：setEncoding 后 Readable 的 data 分发是异步的（close 会先到丢输出），
  // 业务侧只消费 setEncoding/on("data")/on("end")——同步回放保序
  const mkStream = () => {
    const handlers: Record<string, Array<(v?: string) => void>> = {};
    return {
      setEncoding: () => {},
      on: (ev: string, fn: (v?: string) => void) => {
        (handlers[ev] ??= []).push(fn);
      },
      emitData: (s: string) => (handlers.data ?? []).forEach((f) => f(s)),
      emitEnd: () => (handlers.end ?? []).forEach((f) => f()),
    };
  };
  const stdout = mkStream();
  const stderr = mkStream();
  const em = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill: (sig?: string) => void;
  };
  em.stdout = stdout;
  em.stderr = stderr;
  // 真实超时路径用：SIGKILL 后进程 close（status null）——spawnAsyncCapture 的 timer 分支覆盖
  em.kill = () => {
    em.emit("close", null);
  };
  const r = nextResult;
  if (r !== HANG) {
    queueMicrotask(() => {
      if (r?.error) {
        em.emit("error", r.error);
        return;
      }
      if (r?.stdout) stdout.emitData(r.stdout);
      if (r?.stderr) stderr.emitData(r.stderr);
      stdout.emitEnd();
      stderr.emitEnd();
      em.emit("close", r === undefined ? 0 : r.status);
    });
  }
  return em;
}) as never);

// 产物版本读取 mock：默认 undefined（产物读不出→跳过预检/退回最新 VALID），新用例按需覆写
vi.mock("../version/artifact.js", () => ({ readArtifactVersion: vi.fn() }));
import { readArtifactVersion } from "../version/artifact.js";
const readArtifactVersionMock = vi.mocked(readArtifactVersion);

type Ev = { type: string; phase?: string; detail?: string; message?: string };

/** 收集事件的 emit 替身 */
function evCollector(events: Ev[]) {
  return (e: Ev) => {
    events.push(e);
  };
}

let keyDir = "";
let p8Path = "";
/** p8 放进名为 private_keys 的目录，避免 stage 走临时目录软链分支 */
let pkDir = "";
let p8InPkDir = "";

beforeAll(() => {
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "asc-chan-test-"));
  p8Path = path.join(keyDir, "AuthKey_KEYID1.p8");
  fs.writeFileSync(p8Path, key.export({ type: "pkcs8", format: "pem" }));

  const key2 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  pkDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asc-pk-")), "private_keys");
  fs.mkdirSync(pkDir);
  p8InPkDir = path.join(pkDir, "AuthKey_KEYID1.p8");
  fs.writeFileSync(p8InPkDir, key2.export({ type: "pkcs8", format: "pem" }));
});

afterAll(() => {
  fs.rmSync(keyDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(pkDir), { recursive: true, force: true });
});

beforeEach(() => {
  readArtifactVersionMock.mockReset();
  readArtifactVersionMock.mockReturnValue(undefined);
  spawnSyncMock.mockReset();
});

function makeCtx(
  overrides: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    releaseTime?: string;
    releaseMode?: "auto" | "manual";
    exportCompliance?: { usesNonExemptEncryption: boolean };
    phasedRelease?: boolean;
    artifactPath?: string;
    artifactVersion?: { versionName?: string; versionCode?: string };
    updateDescription?: string;
  } = {},
): ChannelContext {
  if (overrides.artifactVersion)
    readArtifactVersionMock.mockReturnValue(overrides.artifactVersion as never);
  return {
    credentials: overrides.credentials ?? {
      ASC_KEY_ID: "KEYID1",
      ASC_ISSUER_ID: "ISS1",
      ASC_P8_PATH: p8Path,
    },
    target: overrides.target ?? { bundleId: "com.example.app" },
    artifactPath: overrides.artifactPath ?? "/tmp/app-release.ipa",
    releaseTime: overrides.releaseTime,
    releaseMode: overrides.releaseMode,
    exportCompliance: overrides.exportCompliance,
    phasedRelease: overrides.phasedRelease,
    updateDescription: overrides.updateDescription,
    emit: () => {},
  } as unknown as ChannelContext;
}

describe("AscChannel 元数据", () => {
  const ch = new AscChannel();
  it("id/label/capabilities", () => {
    expect(ch.id).toBe("asc");
    expect(ch.label).toBe("App Store Connect");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: true });
  });

  it("plan 默认自动发布，manual 时手动，releaseTime 时定时", async () => {
    const p1 = await ch.plan(makeCtx());
    expect(p1).toMatchObject({
      channel: "asc",
      platform: "ios",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
    expect((await ch.plan(makeCtx({ releaseMode: "manual" }))).afterApproval).toBe("manual");
    const p2 = await ch.plan(makeCtx({ releaseTime: "2026-11-01T10:00:00Z" }));
    expect(p2.afterApproval).toBe("scheduled");
  });
});

describe("resolveP8Path / resolveAuth", () => {
  const ch = new AscChannel();

  it("缺 ASC_KEY_ID / ASC_ISSUER_ID 抛错并指明键名", async () => {
    await expect(ch.stage(makeCtx({ credentials: {} }))).rejects.toThrow("ASC 渠道缺少 ASC_KEY_ID");
    await expect(ch.stage(makeCtx({ credentials: { ASC_KEY_ID: "KEYID1" } }))).rejects.toThrow(
      "ASC 渠道缺少 ASC_ISSUER_ID",
    );
  });

  it("ASC_P8_PATH 支持 ~ 展开；缺省时落到 ~/.applift/private_keys/AuthKey_<KeyID>.p8", async () => {
    // p8 不存在（~ 路径指到不存在的文件），用抛错信息反推解析结果
    await expect(
      ch.stage(
        makeCtx({
          credentials: { ASC_KEY_ID: "KEYID1", ASC_ISSUER_ID: "ISS1", ASC_P8_PATH: "~/no/such.p8" },
        }),
      ),
    ).rejects.toThrow(`p8 私钥不存在: ${path.join(os.homedir(), "no/such.p8")}`);
    await expect(
      ch.stage(makeCtx({ credentials: { ASC_KEY_ID: "KX", ASC_ISSUER_ID: "ISS1" }, target: {} })),
    ).rejects.toThrow(
      `p8 私钥不存在: ${path.join(os.homedir(), ".applift", "private_keys", "AuthKey_KX.p8")}`,
    );
  });
});

describe("stage altool 引擎（无 Transporter 时兜底）", () => {
  const ch = new AscChannel();
  let tpSpy: MockInstance<(ctx: Pick<ChannelContext, "credentials">) => string | undefined>;

  beforeEach(() => {
    // 强制走 altool：上传引擎探测返回 undefined
    tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue(undefined);
  });
  afterEach(() => {
    tpSpy.mockRestore();
  });

  it("p8 目录名为 private_keys 时：altool 参数形状正确、cwd 为其上级", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "success", stderr: "" } as never);
    const events: Ev[] = [];
    const ctx = makeCtx({
      credentials: { ASC_KEY_ID: "KEYID1", ASC_ISSUER_ID: "ISS1", ASC_P8_PATH: p8InPkDir },
      artifactPath: "/tmp/app.ipa",
    });
    ctx.emit = evCollector(events) as typeof ctx.emit;

    const r = await ch.stage(ctx);
    expect(r).toEqual({ ok: true });
    expect(spawnSyncMock.mock.calls.length).toBe(1);
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0]! as unknown as [
      string,
      string[],
      { cwd: string; encoding: string },
    ];
    expect(cmd).toBe("xcrun");
    expect(args).toEqual([
      "altool",
      "--upload-app",
      "--type",
      "ios",
      "-f",
      "/tmp/app.ipa",
      "--apiKey",
      "KEYID1",
      "--apiIssuer",
      "ISS1",
    ]);
    // encoding 不再是 spawn 选项：异步捕获层 stream.setEncoding("utf8") 承担
    // cwd = private_keys 的上级目录
    expect(opts.cwd).toBe(path.dirname(pkDir));
    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
    expect(events.some((e) => e.type === "progress" && e.detail?.includes("success"))).toBe(true);
  });

  it("p8 在任意目录时：建临时目录 + private_keys 软链，跑完即删", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    await ch.stage(makeCtx());
    const opts = spawnSyncMock.mock.calls[0]![2] as { cwd: string };
    expect(opts.cwd).toMatch(/applift-asc-/);
    // 临时目录已清理
    expect(fs.existsSync(opts.cwd)).toBe(false);
  });

  it("altool 退出非 0 抛错并带输出", async () => {
    spawnSyncMock.mockReturnValue({ status: 70, stdout: "", stderr: "Unable to upload" } as never);
    await expect(ch.stage(makeCtx())).rejects.toThrow(
      "altool 上传失败（exit 70）: Unable to upload",
    );
  });

  it("spawn 报 error（无 xcrun）抛错", async () => {
    spawnSyncMock.mockReturnValue({ error: new Error("ENOENT"), status: null } as never);
    await expect(ch.stage(makeCtx())).rejects.toThrow("无法执行 xcrun: ENOENT");
  });

  it("上传挂起 → 真实 30min 超时 SIGKILL → ETIMEDOUT 文案（spawnAsyncCapture timer 分支）", async () => {
    vi.useFakeTimers();
    spawnSyncMock.mockReturnValue(HANG as never);
    // 先挂 catch（防 unhandled rejection 泄漏）→ advance 触发 timer → kill → timedOut 分支
    const guard = ch.stage(makeCtx()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000);
    await expect(guard).resolves.toMatchObject({
      message: expect.stringContaining("xcrun altool 超时（30min）"),
    });
    vi.useRealTimers();
  });

  it("spawn 结果无 stdout/stderr 字段 → 输出按空串处理仍成功", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 } as never);
    await expect(ch.stage(makeCtx())).resolves.toEqual({ ok: true });
  });

  it('altool 退出非 0 且无输出 → 报"无输出"', async () => {
    spawnSyncMock.mockReturnValue({ status: 71, stdout: "", stderr: "" } as never);
    await expect(ch.stage(makeCtx())).rejects.toThrow("altool 上传失败（exit 71）: 无输出");
  });

  it("spawn 异步上传（事件循环不冻结；超时由 spawnAsyncCapture 的 setTimeout+SIGKILL 承担，30min）", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    // spawn 第三参只带 cwd（超时不再是 spawn 选项——异步模型下由 helper 的定时器兜底）
    await expect(ch.stage(makeCtx())).resolves.toEqual({ ok: true });
    expect(spawnSyncMock.mock.calls.length).toBe(1);
  });

  it("altool 超时（ETIMEDOUT）→ 报 30min 超时并指向网络/钥匙串/CI 无 TTY", async () => {
    const err: Error & { code?: string } = new Error("spawnSync xcrun ETIMEDOUT");
    err.code = "ETIMEDOUT";
    spawnSyncMock.mockReturnValue({ error: err, status: null } as never);
    await expect(ch.stage(makeCtx())).rejects.toThrow(
      "xcrun altool 超时（30min）——检查网络/钥匙串/CI 无 TTY 弹窗",
    );
  });

  it("凭据键可从 target 兜底（credentials 缺 ASC_KEY_ID 时读 target）", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const ctx = makeCtx({
      credentials: { ASC_ISSUER_ID: "ISS1", ASC_P8_PATH: p8Path },
      target: { bundleId: "com.example.app", ASC_KEY_ID: "KEYID1" },
    });
    await expect(ch.stage(ctx)).resolves.toEqual({ ok: true });
  });
});

describe("stage iTMSTransporter 引擎（装了 Transporter.app 时首选）", () => {
  const ch = new AscChannel();
  let tpSpy: MockInstance<(ctx: Pick<ChannelContext, "credentials">) => string | undefined>;
  let tmpRoot = "";
  let ipaFile = "";

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asc-itms-test-"));
    // 多字节文件名：验证复制改随机 ASCII 名的防御（fastlane 实证多字节名上传失败）
    ipaFile = path.join(tmpRoot, "司机端-release.ipa");
    fs.writeFileSync(ipaFile, Buffer.from("fake-ipa-bytes"));
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue("/fake/itms/iTMSTransporter");
  });
  afterEach(() => {
    tpSpy.mockRestore();
  });

  it("JWT 认证上传：-m upload -jwt -assetFile（复制到临时随机 ASCII 名）+ -k 100000", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Package uploaded\n> DBG-X: Returning 0",
      stderr: "",
    } as never);
    const events: Ev[] = [];
    const ctx = makeCtx({ artifactPath: ipaFile });
    ctx.emit = evCollector(events) as typeof ctx.emit;

    const r = await ch.stage(ctx);
    expect(r).toEqual({ ok: true });

    const [cmd, args] = spawnSyncMock.mock.calls[0]! as unknown as [string, string[]];
    expect(cmd).toBe("/fake/itms/iTMSTransporter");
    expect(args.slice(0, 3)).toEqual(["-m", "upload", "-jwt"]);
    expect(args).toContain("-k");
    expect(args).toContain("100000");
    // assetFile 是临时随机 ASCII 名（uuid.ipa，非原路径、位于 applift-asc-itms- 临时目录）
    const assetPath = args[args.indexOf("-assetFile") + 1]!;
    expect(assetPath).toMatch(/applift-asc-itms-[^/\\]+[/\\][0-9a-f-]{36}\.ipa$/);
    expect(assetPath).not.toBe(ipaFile);
    // 原产物未被 -assetFile 删除语义波及（复制防御）；临时目录已清理
    expect(fs.existsSync(ipaFile)).toBe(true);
    expect(fs.existsSync(path.dirname(assetPath))).toBe(false);
    // JWT 与 REST API 同源：kid/iss 与凭据一致
    const jwt = args[args.indexOf("-jwt") + 1]!;
    const [h, p] = jwt.split(".");
    const dec = (seg: string | undefined) =>
      JSON.parse(
        Buffer.from((seg ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
    expect(dec(h)).toEqual({ alg: "ES256", kid: "KEYID1" });
    expect(dec(p).iss).toBe("ISS1");
    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
  });

  it("exit 0 但 DBG-X Returning 非 0 → 失败（fastlane 返回值语义）", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "DBG-X: Returning 1", stderr: "" } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(
      /iTMSTransporter 上传失败（exit 0，Returning 1）/,
    );
  });

  it("exit 非 0 → 失败信息优先取 ERROR 行", async () => {
    spawnSyncMock.mockReturnValue({
      status: 70,
      stdout: "preparing...\n> ERROR: code=1234 description=Unable to authenticate",
      stderr: "",
    } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(/ERROR: code=1234/);
  });

  it("上传失败路径同样清理临时副本（不抛 ENOENT）", async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "boom" } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(
      /iTMSTransporter 上传失败（exit 1）: boom/,
    );
  });

  it("iTMSTransporter spawn 报 ETIMEDOUT → 30min 超时报错", async () => {
    const err: Error & { code?: string } = new Error("spawnSync ETIMEDOUT");
    err.code = "ETIMEDOUT";
    spawnSyncMock.mockReturnValue({ error: err, status: null } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(
      "iTMSTransporter 超时（30min）",
    );
  });

  it("iTMSTransporter spawn 报其他 error → 无法执行报错", async () => {
    spawnSyncMock.mockReturnValue({ error: new Error("ENOENT"), status: null } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(
      /无法执行 iTMSTransporter: ENOENT/,
    );
  });

  it("ASC_TRANSPORTER_PATH 显式指定且存在 → 返回该路径", () => {
    const fresh = new AscChannel();
    // 真实存在的临时文件（探测只校验存在性）
    const p = path.join(tmpRoot, "itms-bin");
    fs.writeFileSync(p, "");
    expect(fresh.resolveTransporterPath({ credentials: { ASC_TRANSPORTER_PATH: p } })).toBe(p);
  });

  it("ASC_TRANSPORTER_PATH 显式指定但不存在 → 报错（不静默回退 altool）", () => {
    const fresh = new AscChannel();
    expect(() =>
      fresh.resolveTransporterPath({ credentials: { ASC_TRANSPORTER_PATH: "/no/such/itms" } }),
    ).toThrow(/ASC_TRANSPORTER_PATH 指向的 iTMSTransporter 不存在/);
  });
  it("ASC_TRANSPORTER_PATH ~/ 前缀展开到 homedir 后校验存在性", () => {
    const fresh = new AscChannel();
    expect(() =>
      fresh.resolveTransporterPath({ credentials: { ASC_TRANSPORTER_PATH: "~/no/such/itms-bin" } }),
    ).toThrow(
      `ASC_TRANSPORTER_PATH 指向的 iTMSTransporter 不存在: ${path.join(os.homedir(), "no/such/itms-bin")}`,
    );
  });

  it("缺省探测默认安装路径：默认路径不存在 → undefined（回退 altool）", () => {
    const fresh = new AscChannel();
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      expect(fresh.resolveTransporterPath({ credentials: {} })).toBeUndefined();
    } finally {
      existsSpy.mockRestore();
    }
    // 默认路径存在（等价装了 Transporter.app）→ 返回默认安装路径
    const existsSpyInstalled = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    try {
      expect(fresh.resolveTransporterPath({ credentials: {} })).toBe(
        "/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter",
      );
    } finally {
      existsSpyInstalled.mockRestore();
    }
  });

  it("stdout/stderr 均缺省（null/undefined）→ 拼接按空串处理，exit 0 成功", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: undefined, stderr: undefined } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).resolves.toEqual({ ok: true });
  });

  it("exit null（无 error、无输出）→ 报错文案 exit ? 且提示无输出", async () => {
    spawnSyncMock.mockReturnValue({ status: null, stdout: "", stderr: "" } as never);
    await expect(ch.stage(makeCtx({ artifactPath: ipaFile }))).rejects.toThrow(
      "iTMSTransporter 上传失败（exit ?）: 无输出",
    );
  });

  it("上传期间 ERROR 行流式透传（含末尾无换行的残留行 flush）", async () => {
    // 末行无换行：走 stream end 的 pending flush 分支，onLine 仍收到
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "uploading...\nDBG-X: Returning 0\nERROR: code=1102 partial",
      stderr: "",
    } as never);
    const events: Ev[] = [];
    const ctx = makeCtx({ artifactPath: ipaFile });
    ctx.emit = evCollector(events) as typeof ctx.emit;
    await expect(ch.stage(ctx)).resolves.toEqual({ ok: true });
    expect(
      events.some((e) => e.type === "progress" && e.detail === "ERROR: code=1102 partial"),
    ).toBe(true);
  });

  it("缺省探测默认安装路径：装了返回路径，未装返回 undefined（回退 altool）", () => {
    const fresh = new AscChannel();
    const r = fresh.resolveTransporterPath({ credentials: {} });
    expect(r === undefined || r.includes("Transporter.app")).toBe(true);
  });
});

describe("submit（ASC REST 提审）", () => {
  const ch = new AscChannel();

  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const _buildProcessing = {
    type: "builds",
    id: "B1",
    attributes: { version: "41", processingState: "PROCESSING" },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function submitRoutes(
    overrides: {
      versions?: unknown;
      createdVersion?: unknown;
      /** reviewSubmissions GET（三查）响应 */
      reviewSubs?: unknown;
      builds?: unknown;
      /** builds 动态响应（响应回调按调用序分流，oppo taskStateSequence 同款） */
      buildsFn?: () => unknown;
      /** preReleaseVersions 查询响应（锚定链路） */
      preVersions?: unknown;
      localizations?: unknown;
    } = {},
  ) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/preReleaseVersions\?/,
        response: { status: 200, json: overrides.preVersions ?? { data: [] } },
      },
      {
        match: /\/v1\/builds\?/,
        response: overrides.buildsFn
          ? () => ({ status: 200, json: overrides.buildsFn!() })
          : {
              status: 200,
              json: overrides.builds ?? { data: [buildValid], included: [pre] },
            },
      },
      {
        match: /\/v1\/builds\/[^/]+$/,
        method: "PATCH",
        response: { status: 200, json: { data: { id: "B2" } } },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: overrides.versions ?? { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "V1" } } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: {
          status: 201,
          json: overrides.createdVersion ?? {
            data: { id: "VNEW", attributes: { versionString: "1.2.3" } },
          },
        },
      },
      {
        match: /appStoreVersionLocalizations/,
        method: "GET",
        response: {
          status: 200,
          json: overrides.localizations ?? {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "企业司机端描述" },
              },
              // 无 locale：预检通过提示中 locale 兜底用 id（description 必须齐备以通过预检）
              {
                type: "appStoreVersionLocalizations",
                id: "L2",
                attributes: { description: "描述" },
              },
            ],
          },
        },
      },
      {
        // whatsNew 写入：PATCH appStoreVersionLocalizations/{id}
        match: /\/v1\/appStoreVersionLocalizations\/[^/]+$/,
        method: "PATCH",
        response: { status: 200, json: { data: { id: "L1" } } },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1", attributes: { submitted: true } } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: overrides.reviewSubs ?? { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("无既有版本：查 app→找 VALID 构建→创建版本（AFTER_APPROVAL）→绑构建→提审", async () => {
    const m = mockFetch(submitRoutes());
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      const r = await ch.submit(ctx);
      expect(r).toEqual({ ok: true, ref: "SUB1" });

      // 1) apps 查询按 bundleId 过滤
      expect(m.find("/v1/apps?")!.url).toContain("filter[bundleId]=com.example.app");
      // 2) builds 查询按 app id、按上传时间倒序
      expect(m.find("/v1/builds?")!.url).toContain("filter[app]=APP1");
      expect(m.find("/v1/builds?")!.url).toContain("sort=-uploadedDate");
      // 3) 可编辑版本查询
      expect(m.find("appStoreVersions?filter[platform]")!.url).toContain(
        "filter[appVersionState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY",
      );
      // 4) 创建版本 POST：AFTER_APPROVAL + 构建版本号 + app 关系
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions"),
      )!;
      expect(JSON.parse(post.body as string)).toEqual({
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: "1.2.3", releaseType: "AFTER_APPROVAL" },
          relationships: { app: { data: { type: "apps", id: "APP1" } } },
        },
      });
      // 5) 绑定构建（to-many，data 为数组）
      const bind = m.calls.find(
        (c) => c.method === "PATCH" && /\/v1\/appStoreVersions\/[^/]+$/.test(c.url),
      )!;
      {
        const bindBody = JSON.parse(bind.body as string);
        // id 与请求 URL 上的版本 id 一致（既有版本 V1 或新建版本 VNEW，由用例路径决定）
        expect(bind.url).toContain(`/v1/appStoreVersions/${bindBody.data.id}`);
        expect(bindBody.data.type).toBe("appStoreVersions");
        expect(bindBody.data.relationships).toEqual({
          build: { data: { type: "builds", id: "B2" } },
        });
      }
      // 6) 提审三步流：POST reviewSubmissions（关联 App）
      const rs = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissions"),
      )!;
      expect(JSON.parse(rs.body as string)).toEqual({
        data: {
          type: "reviewSubmissions",
          attributes: {},
          relationships: { app: { data: { type: "apps", id: "APP1" } } },
        },
      });
      // 7) POST reviewSubmissionItems（关联 appStoreVersion）
      const item = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissionItems"),
      )!;
      expect(JSON.parse(item.body as string)).toEqual({
        data: {
          type: "reviewSubmissionItems",
          attributes: {},
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: "SUB1" } },
            appStoreVersion: { data: { type: "appStoreVersions", id: "VNEW" } },
          },
        },
      });
      // 8) PATCH reviewSubmissions action=SUBMIT
      const confirm = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/reviewSubmissions/SUB1"),
      )!;
      expect(JSON.parse(confirm.body as string)).toEqual({
        data: { type: "reviewSubmissions", id: "SUB1", attributes: { submitted: true } },
      });
      // 所有请求带 Bearer JWT
      for (const c of m.calls) expect(c.headers.Authorization).toMatch(/^Bearer ey/);
      // 9) 提审预检通过 emit；出口合规 buildValid 已声明（usesNonExemptEncryption=false）
      //    → 零合规 PATCH、零提示（幂等跳过）
      expect(events.some((e) => e.type === "progress" && e.detail?.includes("提审预检通过"))).toBe(
        true,
      );
      expect(m.calls.some((c) => c.method === "PATCH" && /\/v1\/builds\//.test(c.url))).toBe(false);
    } finally {
      m.restore();
    }
  });

  it("--note 提供时：PATCH 每个本地化的 whatsNew（版本更新说明），预检与绑构建之间执行", async () => {
    const m = mockFetch(submitRoutes());
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ updateDescription: "修复若干问题，优化体验" });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await ch.submit(ctx);

      // 两条本地化各一次 PATCH，body 形状 = JSON:API whatsNew
      const patches = m.calls.filter(
        (c) => c.method === "PATCH" && /\/v1\/appStoreVersionLocalizations\/[^/]+$/.test(c.url),
      );
      expect(patches.map((c) => c.url)).toEqual([
        expect.stringContaining("/v1/appStoreVersionLocalizations/L1"),
        expect.stringContaining("/v1/appStoreVersionLocalizations/L2"),
      ]);
      for (const p of patches) {
        expect(JSON.parse(p.body as string)).toEqual({
          data: {
            type: "appStoreVersionLocalizations",
            id: p.url.split("/").pop(),
            attributes: { whatsNew: "修复若干问题，优化体验" },
          },
        });
      }
      // emit 逐本地化确认（无 locale 兜底显示 id）
      expect(events.some((e) => e.detail?.includes("zh-Hans"))).toBe(true);
      expect(events.some((e) => e.detail?.includes("L2"))).toBe(true);
      // 顺序：whatsNew 写入在预检之后、绑构建之前
      const idxPatch = m.calls.findIndex(
        (c) => c.method === "PATCH" && c.url.includes("/v1/appStoreVersionLocalizations/"),
      );
      const idxBind = m.calls.findIndex(
        (c) => c.method === "PATCH" && /\/v1\/appStoreVersions\/[^/]+$/.test(c.url),
      );
      expect(idxPatch).toBeGreaterThan(-1);
      expect(idxPatch).toBeLessThan(idxBind);
    } finally {
      m.restore();
    }
  });

  it("未提供 --note：不产生 whatsNew PATCH（不动 ASC 后台手填文案）", async () => {
    const m = mockFetch(submitRoutes());
    try {
      await ch.submit(makeCtx());
      expect(
        m.calls.filter(
          (c) => c.method === "PATCH" && /\/v1\/appStoreVersionLocalizations\/[^/]+$/.test(c.url),
        ),
      ).toHaveLength(0);
    } finally {
      m.restore();
    }
  });

  it("bundleId 查不到对应 App → 报错含 bundleId", async () => {
    const m = mockFetch([{ match: /\/v1\/apps\?/, response: { status: 200, json: { data: [] } } }]);
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(
        "ASC 未找到 bundleId=com.example.app 对应的 App",
      );
    } finally {
      m.restore();
    }
  });

  it("有可编辑版本：PATCH 复用版本并设 releaseType", async () => {
    const m = mockFetch(
      submitRoutes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.2.3", appVersionState: "PREPARE_FOR_SUBMISSION" },
            },
          ],
        },
      }),
    );
    try {
      await ch.submit(makeCtx());
      const patch = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/appStoreVersions/V1"),
      )!;
      expect(JSON.parse(patch.body as string)).toEqual({
        data: { type: "appStoreVersions", id: "V1", attributes: { releaseType: "AFTER_APPROVAL" } },
      });
      // 未再 POST 创建版本
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions")),
      ).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("releaseTime 提供时：SCHEDULED + earlyReleaseDate", async () => {
    const m = mockFetch(submitRoutes());
    try {
      await ch.submit(makeCtx({ releaseTime: "2026-11-01T10:00:00Z" }));
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions"),
      )!;
      expect(JSON.parse(post.body as string).data.attributes).toEqual({
        platform: "IOS",
        versionString: "1.2.3",
        releaseType: "SCHEDULED",
        earliestReleaseDate: "2026-11-01T10:00:00Z",
      });
    } finally {
      m.restore();
    }
  });

  it("releaseMode=manual 时创建版本 MANUAL（配置 ios.release / 旗标解析进 ctx 后的渠道侧行为）", async () => {
    const m = mockFetch(submitRoutes());
    try {
      await ch.submit(makeCtx({ releaseMode: "manual" }));
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions"),
      )!;
      expect(JSON.parse(post.body as string).data.attributes).toEqual({
        platform: "IOS",
        versionString: "1.2.3",
        releaseType: "MANUAL",
      });
    } finally {
      m.restore();
    }
  });

  it("锚定后构建 INVALID：立即报错（不再等满 30 分钟）", async () => {
    const buildInvalid = {
      type: "builds",
      id: "B1",
      attributes: { version: "42", processingState: "INVALID" },
    };
    const m = mockFetch(
      submitRoutes({
        preVersions: { data: [pre] },
        buildsFn: () => ({ data: [buildInvalid], included: [pre] }),
      }),
    );
    try {
      await expect(
        ch.submit(makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } })),
      ).rejects.toThrow(/构建处理失败（INVALID/);
    } finally {
      m.restore();
    }
  });

  it("产物读不出（--skip-stage 无产物场景语义）：不发 preReleaseVersions 查询，直接 builds 取最新 VALID", async () => {
    // mock 默认返回 undefined（beforeEach 已设），即产物读不出路径
    const m = mockFetch(submitRoutes());
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(m.calls.every((c) => !c.url.includes("/v1/preReleaseVersions"))).toBe(true);
      expect(m.find("/v1/builds?")!.url).toContain("sort=-uploadedDate");
    } finally {
      m.restore();
    }
  });

  it("出口合规未声明：build usesNonExemptEncryption=null 时自动 PATCH false；已声明则不再重写", async () => {
    const m = mockFetch(
      submitRoutes({
        builds: {
          data: [
            {
              type: "builds",
              id: "B2",
              attributes: {
                version: "42",
                processingState: "VALID",
                usesNonExemptEncryption: null,
              },
              relationships: {
                preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } },
              },
            },
          ],
          included: [pre],
        },
      }),
    );
    try {
      const ctx = makeCtx();
      await ch.submit(ctx as unknown as ChannelContext);
      const compliance = m.calls.find(
        (c) => c.method === "PATCH" && /\/v1\/builds\/B2$/.test(c.url),
      )!;
      expect(JSON.parse(compliance.body as string)).toEqual({
        data: { type: "builds", id: "B2", attributes: { usesNonExemptEncryption: false } },
      });
      // 已声明场景（submitRoutes 默认 buildValid 已带 false）无 builds PATCH
    } finally {
      expect(
        m.calls.filter((c) => c.method === "PATCH" && /\/v1\/builds\//.test(c.url)),
      ).toHaveLength(1);
    }
  });

  it("VALID 构建缺 version 字段 → progress 文案版本段为空但流程成功", async () => {
    const noVersionBuild = {
      type: "builds",
      id: "B3",
      attributes: { processingState: "VALID", usesNonExemptEncryption: false },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
    };
    const m = mockFetch(submitRoutes({ builds: { data: [noVersionBuild], included: [pre] } }));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        events.some(
          (e) => e.type === "progress" && e.detail === "构建处理完成 build （版本 1.2.3）",
        ),
      ).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("可编辑版本缺 attributes → 复用文案版本段为空但流程成功", async () => {
    const m = mockFetch(
      submitRoutes({ versions: { data: [{ type: "appStoreVersions", id: "V1" }] } }),
    );
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        events.some(
          (e) =>
            e.type === "phase" &&
            e.phase === "bind" &&
            e.message === "续用版本记录并改名  → 1.2.3（state=）",
        ),
      ).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("多 train 并存：included[0] 非该构建所属版本时按 relationships 取正确 versionString", async () => {
    // 两个 train：PR1=1.9.9（included 首位，旧实现会误取）+ PR2=2.0.0；最新 VALID 构建属 PR2
    const pre199 = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.9.9" } };
    const pre200 = { type: "preReleaseVersions", id: "PR2", attributes: { version: "2.0.0" } };
    const build2 = {
      type: "builds",
      id: "B9",
      attributes: { version: "43", processingState: "VALID" },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR2" } } },
    };
    const m = mockFetch(submitRoutes({ builds: { data: [build2], included: [pre199, pre200] } }));
    try {
      await ch.submit(makeCtx());
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions"),
      )!;
      expect(JSON.parse(post.body as string).data.attributes.versionString).toBe("2.0.0");
    } finally {
      m.restore();
    }
  });

  it("构建的 preReleaseVersion 关系在 included 中无匹配条目时抛错", async () => {
    // buildValid 关联 PR1，included 里只有 PR9 → 匹配失败
    const mismatched = {
      data: [buildValid],
      included: [{ type: "preReleaseVersions", id: "PR9", attributes: { version: "9.9.9" } }],
    };
    const m = mockFetch(submitRoutes({ builds: mismatched }));
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("缺少 preReleaseVersion 版本号");
    } finally {
      m.restore();
    }
  });

  it("构建缺失 preReleaseVersion 版本号时抛错", async () => {
    const m = mockFetch(submitRoutes({ builds: { data: [buildValid], included: [] } }));
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("缺少 preReleaseVersion 版本号");
    } finally {
      m.restore();
    }
  });

  it("apps 未命中 bundleId 时抛错", async () => {
    const m = mockFetch([{ match: /\/v1\/apps\?/, response: { status: 200, json: { data: [] } } }]);
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("未找到 bundleId=com.example.app");
    } finally {
      m.restore();
    }
  });

  it("创建版本未返回 id 时抛错", async () => {
    const m = mockFetch(submitRoutes({ createdVersion: { data: null } }));
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("未返回 id");
    } finally {
      m.restore();
    }
  });

  it("缺 bundleId 抛错", async () => {
    await expect(ch.submit(makeCtx({ target: {} }))).rejects.toThrow("缺少 bundleId");
  });

  it("提审前预检：本地化 description 为空 → 提前报错并列出 locale，不进入绑构建/提审", async () => {
    const m = mockFetch(
      submitRoutes({
        localizations: {
          data: [
            {
              type: "appStoreVersionLocalizations",
              id: "L1",
              attributes: { locale: "zh-Hans", description: "有描述" },
            },
            {
              type: "appStoreVersionLocalizations",
              id: "L2",
              attributes: { locale: "en-US", description: "" },
            },
            // 无 attributes：locale 兜底用 id 呈现
            { type: "appStoreVersionLocalizations", id: "L3" },
          ],
        },
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(
        /缺少商店描述（description），无法提审: en-US, L3/,
      );
      expect(
        m.calls.find((c) => c.method === "PATCH" && /\/v1\/appStoreVersions\/[^/]+$/.test(c.url)),
      ).toBeUndefined();
      expect(m.calls.find((c) => c.url.includes("reviewSubmissions"))).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("提审前预检：无任何本地化记录 → 报错并指引补元数据", async () => {
    const m = mockFetch(submitRoutes({ localizations: { data: [] } }));
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("无任何本地化记录");
    } finally {
      m.restore();
    }
  });

  it("apps 返回 bundleId 不完全匹配 → 兜底取首条 App 继续提审链路", async () => {
    const m = mockFetch([
      {
        match: /\/v1\/apps\?/,
        response: {
          status: 200,
          json: { data: [{ type: "apps", id: "APPX", attributes: { bundleId: "other.app" } }] },
        },
      },
      ...submitRoutes().slice(1),
    ]);
    try {
      const r = await ch.submit(makeCtx());
      expect(r).toEqual({ ok: true, ref: "SUB1" });
      // builds 查询用兜底 App id
      expect(m.find("/v1/builds?")!.url).toContain("filter[app]=APPX");
    } finally {
      m.restore();
    }
  });
});

describe("出口合规代答（§6）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildUndeclared = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: null },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const buildDeclared = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function routes(builds: unknown) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      { match: /\/v1\/preReleaseVersions\?/, response: { status: 200, json: { data: [] } } },
      { match: /\/v1\/builds\?/, response: { status: 200, json: builds } },
      { match: /\/v1\/builds\/B2$/, response: { status: 200, json: { data: { id: "B2" } } } },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "V1" } } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: {
          status: 201,
          json: { data: { id: "VNEW", attributes: { versionString: "1.2.3" } } },
        },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "企业司机端描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        // 条目创建走顶层 reviewSubmissionItems（/{id}/items 只读，main 实测）
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("配置代答 + build usesNonExemptEncryption 为 null：PATCH builds/<id> 补写；非 null 跳过", async () => {
    const m = mockFetch(routes({ data: [buildUndeclared], included: [pre] }));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ exportCompliance: { usesNonExemptEncryption: false } });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      const patch = m.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/builds/B2"))!;
      expect(JSON.parse(patch.body as string)).toEqual({
        data: { type: "builds", id: "B2", attributes: { usesNonExemptEncryption: false } },
      });
      expect(
        events.some(
          (e) =>
            e.type === "progress" &&
            e.detail?.startsWith("已代答出口合规（usesNonExemptEncryption=false"),
        ),
      ).toBe(true);

      // 非 null：零 PATCH（同配置下幂等跳过）
      m.restore();
      const m2 = mockFetch(routes({ data: [buildDeclared], included: [pre] }));
      try {
        await expect(
          ch.submit(makeCtx({ exportCompliance: { usesNonExemptEncryption: false } })),
        ).resolves.toEqual({ ok: true, ref: "SUB1" });
        expect(
          m2.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/builds/B2")),
        ).toBeUndefined();
      } finally {
        m2.restore();
      }
    } finally {
      m.restore();
    }
  });

  it("未配置代答 + null：自动声明 false（标准 HTTPS 豁免默认值，main 实测 409 REQUIRED 语义）", async () => {
    const m = mockFetch(routes({ data: [buildUndeclared], included: [pre] }));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      const patch = m.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/builds/B2"))!;
      expect(JSON.parse(patch.body as string).data.attributes).toEqual({
        usesNonExemptEncryption: false,
      });
      expect(
        events.some((e) => e.type === "progress" && e.detail?.includes("已自动声明出口合规")),
      ).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("已声明（非 null）：零请求零提示", async () => {
    const m = mockFetch(routes({ data: [buildDeclared], included: [pre] }));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        m.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/builds/B2")),
      ).toBeUndefined();
      expect(
        events.some((e) => e.detail?.includes("出口合规") || e.message?.includes("出口合规")),
      ).toBe(false);
    } finally {
      m.restore();
    }
  });
});

describe("phased release（§7）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  /** 首版判定查询（limit=2）专属路由，置于通用 appStoreVersions 路由之前（首个命中生效） */
  function phasedRoutes(versionCount: number) {
    return [
      {
        match: /appStoreVersions\?filter\[platform\]=IOS&limit=2/,
        response: {
          status: 200,
          json: {
            data: Array.from({ length: versionCount }, (_, i) => ({
              type: "appStoreVersions",
              id: `VP${i}`,
              attributes: { versionString: `1.2.${i}` },
            })),
          },
        },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersions",
                id: "V1",
                attributes: { versionString: "1.2.3", appVersionState: "PREPARE_FOR_SUBMISSION" },
              },
            ],
          },
        },
      },
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      { match: /\/v1\/preReleaseVersions\?/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/builds\?/,
        response: { status: 200, json: { data: [buildValid], included: [pre] } },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "V1" } } },
      },
      {
        match: /appStoreVersionPhasedReleases/,
        method: "POST",
        response: { status: 201, json: { data: { id: "PR-REL-1" } } },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "企业司机端描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1", attributes: { action: "SUBMIT" } } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("配置开启 + 非首版：POST /v1/appStoreVersionPhasedReleases 关联 versionId", async () => {
    const m = mockFetch(phasedRoutes(2));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ phasedRelease: true });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersionPhasedReleases"),
      )!;
      expect(JSON.parse(post.body as string)).toEqual({
        data: {
          type: "appStoreVersionPhasedReleases",
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } },
          },
        },
      });
      expect(
        events.some((e) => e.type === "progress" && e.detail?.includes("已开启分阶段发布")),
      ).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("配置开启 + 首版（仅 1 条版本记录）：emit warn 跳过，不 POST", async () => {
    const m = mockFetch(phasedRoutes(1));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ phasedRelease: true });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        m.calls.find(
          (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersionPhasedReleases"),
        ),
      ).toBeUndefined();
      expect(events.some((e) => e.type === "warn" && e.message?.includes("首版不可用"))).toBe(true);
    } finally {
      m.restore();
    }
  });

  it("配置开启 + 非首版但 Apple 拒绝（409）：warn 降级不阻断提审，三查照常", async () => {
    const routes = phasedRoutes(2).map((r) =>
      r.match instanceof RegExp && /appStoreVersionPhasedReleases/.test(r.match.source)
        ? { ...r, response: { status: 409, json: { errors: [{ detail: "conflict" }] } } }
        : r,
    );
    const m = mockFetch(routes);
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ phasedRelease: true });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        events.some((e) => e.type === "warn" && e.message?.includes("分阶段发布开启失败")),
      ).toBe(true);
      // 三查照常发生：GET reviewSubmissions → POST items → PATCH SUBMIT
      expect(
        m.calls.find((c) => c.method === "GET" && c.url.includes("/v1/reviewSubmissions?")),
      ).toBeDefined();
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissionItems")),
      ).toBeDefined();
      expect(
        m.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/v1/reviewSubmissions/SUB1")),
      ).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("未配置：零 phased 请求", async () => {
    const m = mockFetch(phasedRoutes(2));
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(m.calls.find((c) => c.url.endsWith("limit=2"))).toBeUndefined();
      expect(
        m.calls.find((c) => c.url.includes("/v1/appStoreVersionPhasedReleases")),
      ).toBeUndefined();
    } finally {
      m.restore();
    }
  });
});

describe("preflight 规则引擎（§8）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function routes(overrides: { versions?: unknown; localizations?: unknown } = {}) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      { match: /\/v1\/preReleaseVersions\?/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/builds\?/,
        response: { status: 200, json: { data: [buildValid], included: [pre] } },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: overrides.versions ?? { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "V1" } } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: {
          status: 201,
          json: { data: { id: "VNEW", attributes: { versionString: "1.2.3" } } },
        },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: overrides.localizations ?? {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "企业司机端描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("error 级阻断：localizations 缺描述仍抛（迁移后语义不变）", async () => {
    const m = mockFetch(
      routes({
        localizations: {
          data: [
            {
              type: "appStoreVersionLocalizations",
              id: "L1",
              attributes: { locale: "zh-Hans", description: "有描述" },
            },
            {
              type: "appStoreVersionLocalizations",
              id: "L2",
              attributes: { locale: "en-US", description: "" },
            },
          ],
        },
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(
        /缺少商店描述（description），无法提审: en-US/,
      );
      expect(m.calls.find((c) => c.url.includes("relationships/builds"))).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("warn 级不阻断：被拒版本续用时 emit warn", async () => {
    const m = mockFetch(
      routes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.2.3", appVersionState: "REJECTED" },
            },
          ],
        },
      }),
    );
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        events.some(
          (e) => e.type === "warn" && e.message === "续用被拒版本记录：请确认拒审原因已解决",
        ),
      ).toBe(true);
      // warn 不阻断：绑定/提审照常
      const bind = m.calls.find(
        (c) =>
          c.method === "PATCH" &&
          /\/v1\/appStoreVersions\/[^/]+$/.test(c.url) &&
          JSON.parse(c.body as string).data.relationships?.build !== undefined,
      );
      expect(bind?.url).toContain("/v1/appStoreVersions/V1");
      expect(JSON.parse(bind!.body as string).data.relationships.build.data.id).toBe("B2");
    } finally {
      m.restore();
    }
  });
});

describe("submit 等构建处理完成（docs/fastlane-adoption §2）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const buildProcessing = {
    type: "builds",
    id: "B1",
    attributes: { version: "42", processingState: "PROCESSING" },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function routes(buildsFn: () => unknown, preVersions: unknown = { data: [pre] }) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      { match: /\/v1\/preReleaseVersions\?/, response: { status: 200, json: preVersions } },
      { match: /\/v1\/builds\?/, response: () => ({ status: 200, json: buildsFn() }) },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: { status: 201, json: { data: { id: "VNEW" } } },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "企业司机端描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        // 绑构建走 PATCH 本体 relationships.build（单数关系，main 实测）
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "VNEW" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
    ];
  }

  it("PROCESSING→VALID 两轮后继续提审；请求按产物锚定（preReleaseVersions 查询在先）", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const m = mockFetch(
      routes(() => {
        pollCount += 1;
        return pollCount === 1
          ? { data: [buildProcessing], included: [pre] }
          : { data: [buildValid], included: [pre] };
      }),
    );
    try {
      const ctx = makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } });
      const p = ch.submit(ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(m.calls.some((c) => c.url.includes("filter[preReleaseVersion]=PR1"))).toBe(true);
      expect(m.calls.some((c) => c.url.includes("filter[version]=42"))).toBe(true);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("持续 PROCESSING 超时：报错文案指引 --skip-stage 重跑", async () => {
    vi.useFakeTimers();
    const m = mockFetch(routes(() => ({ data: [buildProcessing], included: [pre] })));
    try {
      const ctx = makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } });
      const p = ch.submit(ctx);
      const expectP = expect(p).rejects.toThrow(/构建处理超时.*--skip-stage/);
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 60_000);
      await expectP;
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("train 双格式查询（X.Y 与 X.Y.0 都查）+ preVersions 查询失败 → 退回最新 VALID 兜底", async () => {
    let pvCalls = 0;
    const m = mockFetch([
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/preReleaseVersions\?/,
        response: () => {
          pvCalls += 1;
          return { status: 500, json: {} }; // 锚定查询失败 → resolveTrainIds 返回 []
        },
      },
      {
        match: /\/v1\/builds\?/,
        response: { status: 200, json: { data: [buildValid], included: [pre] } },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: { status: 201, json: { data: { id: "VNEW" } } },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "描述" },
              },
            ],
          },
        },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "VNEW" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
    ]);
    try {
      const ctx = makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } });
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      // 兜底路径：builds 查询退回 sort=-uploadedDate（不带锚定 filter）
      const buildsCall = m.calls.find((c) => c.url.includes("/v1/builds?"));
      expect(buildsCall?.url).toContain("sort=-uploadedDate");
      expect(pvCalls).toBeGreaterThanOrEqual(1);
    } finally {
      m.restore();
    }
  });

  it("三段 train 版本名（1.2.3）：alt 走砍尾 1.2；VALID 缺 attrs → 空对象兼容仍成功", async () => {
    const noAttrsBuild = {
      type: "builds",
      id: "B5",
      attributes: undefined,
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
    };
    const m = mockFetch(
      routes(() => ({
        data: [{ ...noAttrsBuild, attributes: { processingState: "PROCESSING" } }],
        included: [pre],
      })),
    );
    try {
      const ctx = makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } });
      // 首轮 PROCESSING 会一直等到超时——改为一轮直接给 VALID（attributes 缺 version 字段）
      m.restore();
      const m2 = mockFetch([
        ...routes(() => ({
          data: [
            {
              type: "builds",
              id: "B5",
              attributes: { processingState: "VALID" },
              relationships: {
                preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } },
              },
            },
          ],
          included: [pre],
        })),
        {
          match: /\/v1\/builds\/[^/]+$/,
          method: "PATCH",
          response: { status: 200, json: { data: { id: "B5" } } },
        },
      ]);
      try {
        await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
        // 三段名 1.2.3：alt 分支走砍尾（1.2）
        expect(
          m2.calls.some(
            (c) => c.url.includes("filter[version]=1.2&") || c.url.includes("filter[version]=1.2"),
          ),
        ).toBe(true);
      } finally {
        m2.restore();
      }
    } finally {
      m.restore();
    }
  });
});

describe("版本状态机扩展（docs/fastlane-adoption §4）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function routes(overrides: { versions?: unknown } = {}) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/builds\?/,
        response: { status: 200, json: { data: [buildValid], included: [pre] } },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: overrides.versions ?? { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "V1" } } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: { status: 201, json: { data: { id: "VNEW" } } },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: { data: [], included: [] } },
      },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("editable 集合含被拒四态：filter[appVersionState] 五值逗号列表", async () => {
    const m = mockFetch(routes());
    try {
      await ch.submit(makeCtx());
      expect(m.find("appStoreVersions?filter[platform]")!.url).toContain(
        "filter[appVersionState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY",
      );
    } finally {
      m.restore();
    }
  });

  it("REJECTED 同号：复用 PATCH，不 POST 新版本", async () => {
    const m = mockFetch(
      routes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.2.3", appVersionState: "REJECTED" },
            },
          ],
        },
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions")),
      ).toBeUndefined();
      const patch = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/appStoreVersions/V1"),
      )!;
      expect(JSON.parse(patch.body as string)).toEqual({
        data: { type: "appStoreVersions", id: "V1", attributes: { releaseType: "AFTER_APPROVAL" } },
      });
    } finally {
      m.restore();
    }
  });

  it("PREPARE 异号：PATCH versionString 改名续用（ensure_version! 语义）", async () => {
    const m = mockFetch(
      routes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.0.0", appVersionState: "PREPARE_FOR_SUBMISSION" },
            },
          ],
        },
      }),
    );
    try {
      await ch.submit(makeCtx());
      const patch = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/appStoreVersions/V1"),
      )!;
      expect(JSON.parse(patch.body as string).data.attributes).toEqual({
        versionString: "1.2.3",
        releaseType: "AFTER_APPROVAL",
      });
      // 条目关联的是续用的 V1（改名未换记录）
      const item = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissionItems"),
      )!;
      expect(JSON.parse(item.body as string).data.relationships.appStoreVersion.data.id).toBe("V1");
    } finally {
      m.restore();
    }
  });

  it("REJECTED 异号：报错人话（不自动改名），提示控制台人工处置", async () => {
    const m = mockFetch(
      routes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V1",
              attributes: { versionString: "1.0.0", appVersionState: "REJECTED" },
            },
          ],
        },
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(/被拒.*人工|控制台/);
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions")),
      ).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("多 editable 版本并存：取 versionString 最大者（cmpVersion 分段数值比较），INVALID_BINARY 异号走改名", async () => {
    const m = mockFetch(
      routes({
        versions: {
          data: [
            {
              type: "appStoreVersions",
              id: "V-LOW",
              attributes: { versionString: "1.9.9", appVersionState: "INVALID_BINARY" },
            },
            {
              type: "appStoreVersions",
              id: "V-HIGH",
              attributes: { versionString: "1.10.0", appVersionState: "PREPARE_FOR_SUBMISSION" },
            },
          ],
        },
      }),
    );
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      // 1.10.0 > 1.9.9（数值比较而非字典序）；选中 V-HIGH 且同号 → 复用 PATCH
      const patch = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/appStoreVersions/V-HIGH"),
      )!;
      expect(JSON.parse(patch.body as string).data.attributes).toEqual({
        versionString: "1.2.3",
        releaseType: "AFTER_APPROVAL",
      });
      expect(
        events.some((e) => e.type === "phase" && e.message?.includes("改名 1.10.0 → 1.2.3")),
      ).toBe(true);
    } finally {
      m.restore();
    }
  });
});

describe("提审三查（docs/fastlane-adoption §3）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };
  const buildValid = {
    type: "builds",
    id: "B2",
    attributes: { version: "42", processingState: "VALID", usesNonExemptEncryption: false },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function routes(reviewSubs: unknown) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/builds\?/,
        response: { status: 200, json: { data: [buildValid], included: [pre] } },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: { data: [] } },
      },
      {
        match: /\/v1\/appStoreVersions$/,
        response: { status: 201, json: { data: { id: "VNEW" } } },
      },
      {
        // 绑构建走 PATCH 本体 relationships.build（单数关系，main 实测）
        match: /\/v1\/appStoreVersions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "VNEW" } } },
      },
      {
        match: /appStoreVersionLocalizations/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersionLocalizations",
                id: "L1",
                attributes: { locale: "zh-Hans", description: "描述" },
              },
            ],
          },
        },
      },
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissions\?/,
        response: { status: 200, json: reviewSubs },
      },
      {
        match: /\/v1\/reviewSubmissionItems$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("已有进行中 reviewSubmission 且含本版本：报错勿重复提交", async () => {
    const m = mockFetch(
      routes({
        data: [
          { type: "reviewSubmissions", id: "RS9", attributes: { state: "WAITING_FOR_REVIEW" } },
        ],
        included: [
          {
            type: "reviewSubmissionItems",
            id: "RSI9",
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "VNEW" } } },
          },
        ],
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(/已在审核流程中.*勿重复提交/);
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissions")),
      ).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("存在 items 为空的草稿 submission：复用其 id，不再 POST 创建", async () => {
    const m = mockFetch(
      routes({
        data: [{ type: "reviewSubmissions", id: "RS-DRAFT", attributes: { state: "READY" } }],
        included: [],
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "RS-DRAFT" });
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissions")),
      ).toBeUndefined();
      // POST items 用旧 id
      const item = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissionItems"),
      );
      expect(JSON.parse(item!.body as string).data.relationships.reviewSubmission?.data?.id).toBe(
        "RS-DRAFT",
      );
      // 确认提交 PATCH 也打在旧 id 上
      expect(
        m.calls.find(
          (c) => c.method === "PATCH" && c.url.endsWith("/v1/reviewSubmissions/RS-DRAFT"),
        ),
      ).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("READY 草稿已含本版本条目：零 items POST，直接 PATCH SUBMIT", async () => {
    const m = mockFetch(
      routes({
        data: [{ type: "reviewSubmissions", id: "RS-DRAFT", attributes: { state: "READY" } }],
        included: [
          {
            type: "reviewSubmissionItems",
            id: "RSI-MINE",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: "VNEW" } },
            },
          },
        ],
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "RS-DRAFT" });
      // 零 items POST（草稿已含本版本条目，重复 POST 会被 Apple 拒）
      expect(m.calls.find((c) => c.method === "POST" && c.url.endsWith("/items"))).toBeUndefined();
      expect(m.find("reviewSubmissions", "POST")).toBeUndefined();
      expect(
        m.calls.find(
          (c) => c.method === "PATCH" && c.url.endsWith("/v1/reviewSubmissions/RS-DRAFT"),
        ),
      ).toBeDefined();
    } finally {
      m.restore();
    }
  });

  it("草稿含其他条目：报错引导网页处理", async () => {
    const m = mockFetch(
      routes({
        data: [{ type: "reviewSubmissions", id: "RS-DRAFT", attributes: { state: "READY" } }],
        included: [
          {
            type: "reviewSubmissionItems",
            id: "RSI8",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: "VOTHER" } },
            },
          },
        ],
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow(/ASC 网页.*人工/);
      expect(
        m.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissions")),
      ).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("active 判定过滤终态（COMPLETED）：已完成 submission 后有新草稿 → 复用新草稿；无 included 字段 → items 空数组", async () => {
    const m = mockFetch(
      routes({
        // 终态在前（被过滤）、READY 草稿在后（active）；included 缺失（items=[]，!mine 且无他人条目 → 复用）
        data: [
          {
            type: "reviewSubmissions",
            id: "RS-DONE",
            attributes: { state: "COMPLETED" },
          },
          { type: "reviewSubmissions", id: "RS-DRAFT", attributes: { state: "READY" } },
        ],
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).resolves.toEqual({ ok: true, ref: "RS-DRAFT" });
      // 复用草稿（无条目 → POST items 到顶层端点关联 RS-DRAFT）
      const item = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/reviewSubmissionItems"),
      );
      expect(JSON.parse(item!.body as string).data.relationships.reviewSubmission.data.id).toBe(
        "RS-DRAFT",
      );
      expect(m.find("reviewSubmissions", "POST")).toBeUndefined();
    } finally {
      m.restore();
    }
  });
});

describe("stage build 号预检（§9）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };

  it("产物 versionCode 已存在于 ASC：上传前报错", async () => {
    const m = mockFetch([
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/builds\?/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "builds",
                id: "B9",
                attributes: {
                  version: "42",
                  processingState: "VALID",
                  usesNonExemptEncryption: false,
                },
              },
            ],
          },
        },
      },
    ]);
    try {
      await expect(
        ch.stage(makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } })),
      ).rejects.toThrow(/build 号已被占用.*42/);
      expect(m.find("/v1/builds?")!.url).toContain("filter[version]=42");
      expect(spawnSyncMock.mock.calls.length).toBe(0);
    } finally {
      m.restore();
    }
  });

  it("无占用：正常走上传引擎（altool 桩）", async () => {
    const tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue(undefined);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "success", stderr: "" } as never);
    const m = mockFetch([
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      { match: /\/v1\/builds\?/, response: { status: 200, json: { data: [] } } },
    ]);
    try {
      await expect(
        ch.stage(makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } })),
      ).resolves.toEqual({ ok: true });
      expect(m.find("/v1/builds?")!.url).toContain("filter[version]=42");
      expect(spawnSyncMock.mock.calls.length).toBe(1);
    } finally {
      m.restore();
      tpSpy.mockRestore();
    }
  });

  it("无 artifactPath（--skip-stage 语义）→ 跳过预检零请求；versionName 缺失仅 versionCode 时文案 ?", async () => {
    const m = mockFetch([]);
    const tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue(undefined);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    try {
      // 测试替身：artifactPath 置空字符串（falsy）模拟无产物路径——避免对非可选字段 cast 删改
      const bare: ChannelContext = { ...makeCtx(), artifactPath: "" };
      await expect(ch.stage(bare)).resolves.toEqual({ ok: true });
      expect(m.calls.length).toBe(0);
    } finally {
      tpSpy.mockRestore();
      m.restore();
    }
  });

  it("占用时报错含 versionName（可读文案全字段）", async () => {
    const m = mockFetch([
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/builds\?/,
        response: {
          status: 200,
          json: {
            data: [
              { type: "builds", id: "B9", attributes: { version: "7", processingState: "VALID" } },
            ],
          },
        },
      },
    ]);
    try {
      await expect(
        ch.stage(makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "7" } })),
      ).rejects.toThrow(/版本 1\.2\.3 构建号 7 已在/);
    } finally {
      m.restore();
    }
  });

  it("预检查询抛错 → 预检跳过（best-effort），继续上传", async () => {
    const tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue(undefined);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const m = mockFetch([{ match: /\/v1\/apps\?/, response: { status: 500, json: {} } }]);
    try {
      await expect(
        ch.stage(makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } })),
      ).resolves.toEqual({ ok: true });
    } finally {
      tpSpy.mockRestore();
      m.restore();
    }
  });

  it("预检失败 warn 后上传继续（warn 文案断言）", async () => {
    const tpSpy = vi.spyOn(ch, "resolveTransporterPath").mockReturnValue(undefined);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const m = mockFetch([{ match: /\/v1\/apps\?/, response: { status: 500, json: {} } }]);
    try {
      const events: Ev[] = [];
      const ctx = makeCtx({ artifactVersion: { versionName: "1.2.3", versionCode: "42" } });
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.stage(ctx)).resolves.toEqual({ ok: true });
      expect(events.some((e) => e.type === "warn" && e.message?.includes("build 号预检跳过"))).toBe(
        true,
      );
    } finally {
      tpSpy.mockRestore();
      m.restore();
    }
  });
});

describe("status（appVersionState → ReviewStatus 映射）", () => {
  const ch = new AscChannel();
  const app = { type: "apps", id: "APP1", attributes: { bundleId: "com.example.app" } };

  function statusRoutes(data: unknown) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: { status: 200, json: { data } },
      },
    ];
  }

  it.each([
    ["IN_REVIEW", { state: "reviewing" }],
    ["WAITING_FOR_REVIEW", { state: "reviewing" }],
    ["READY_FOR_DISTRIBUTION", { state: "approved", live: true }],
    ["PENDING_DEVELOPER_RELEASE", { state: "approved", live: false }],
    ["ACCEPTED", { state: "approved", live: false }],
  ])("%s → %j", async (state, expected) => {
    const m = mockFetch(
      statusRoutes([
        {
          type: "appStoreVersions",
          id: "V1",
          attributes: { versionString: "2.4.0", appVersionState: state },
        },
      ]),
    );
    try {
      expect(await ch.status(makeCtx())).toEqual(expected);
    } finally {
      m.restore();
    }
  });

  it("apps 查询命中空（bundleId 不匹配）→ 报「未找到 bundleId 对应的 App」", async () => {
    const m = mockFetch([{ match: /\/v1\/apps\?/, response: { status: 200, json: { data: [] } } }]);
    try {
      await expect(ch.status(makeCtx())).rejects.toThrow("ASC 未找到 bundleId=com.example.app");
    } finally {
      m.restore();
    }
  });

  it("apps 返回 bundleId 不完全匹配 → 兜底取首条 App", async () => {
    const m = mockFetch([
      {
        match: /\/v1\/apps\?/,
        response: {
          status: 200,
          json: { data: [{ type: "apps", id: "APPX", attributes: { bundleId: "other.app" } }] },
        },
      },
      {
        match: /appStoreVersions\?filter\[platform\]/,
        response: {
          status: 200,
          json: {
            data: [
              {
                type: "appStoreVersions",
                id: "V1",
                attributes: { versionString: "2.4.0", appVersionState: "READY_FOR_DISTRIBUTION" },
              },
            ],
          },
        },
      },
    ]);
    try {
      expect(await ch.status(makeCtx())).toEqual({ state: "approved", live: true });
    } finally {
      m.restore();
    }
  });

  it("REJECTED → rejected 带版本与状态 reason", async () => {
    const m = mockFetch(
      statusRoutes([
        {
          type: "appStoreVersions",
          id: "V1",
          attributes: { versionString: "2.4.0", appVersionState: "REJECTED" },
        },
      ]),
    );
    try {
      expect(await ch.status(makeCtx())).toEqual({
        state: "rejected",
        reason: "2.4.0（REJECTED）",
      });
    } finally {
      m.restore();
    }
  });

  it("跳过 PREPARE_FOR_SUBMISSION / REPLACED_WITH_NEW_VERSION，取活跃提审版本", async () => {
    const m = mockFetch(
      statusRoutes([
        {
          type: "appStoreVersions",
          id: "VD",
          attributes: { versionString: "3.0.0", appVersionState: "PREPARE_FOR_SUBMISSION" },
        },
        {
          type: "appStoreVersions",
          id: "V2",
          attributes: { versionString: "2.4.0", appVersionState: "IN_REVIEW" },
        },
      ]),
    );
    try {
      expect(await ch.status(makeCtx())).toEqual({ state: "reviewing" });
      // 查询按 app id + IOS 平台过滤
      expect(m.find("appStoreVersions?filter[platform]")!.url).toContain("filter[platform]=IOS");
    } finally {
      m.restore();
    }
  });

  it("版本记录缺 attributes（无 appVersionState/versionString）→ 兜底 UNKNOWN 归 unknown", async () => {
    const m = mockFetch(statusRoutes([{ type: "appStoreVersions", id: "V1" }]));
    try {
      expect(await ch.status(makeCtx())).toEqual({ state: "unknown", raw: "?（UNKNOWN）" });
    } finally {
      m.restore();
    }
  });

  it("全部为非活跃版本时兜底取首条：REPLACED_WITH_NEW_VERSION → unknown（raw 带版本与状态）", async () => {
    const m = mockFetch(
      statusRoutes([
        {
          type: "appStoreVersions",
          id: "VR",
          attributes: { versionString: "1.9.0", appVersionState: "REPLACED_WITH_NEW_VERSION" },
        },
      ]),
    );
    try {
      expect(await ch.status(makeCtx())).toEqual({
        state: "unknown",
        raw: "1.9.0（REPLACED_WITH_NEW_VERSION）",
      });
    } finally {
      m.restore();
    }
  });

  it("无版本记录 → unknown", async () => {
    const m = mockFetch(statusRoutes([]));
    try {
      expect(await ch.status(makeCtx())).toEqual({
        state: "unknown",
        raw: "ASC 无 IOS appStoreVersion 记录",
      });
    } finally {
      m.restore();
    }
  });

  it("缺 bundleId → 人话报错", async () => {
    await expect(ch.status(makeCtx({ target: {} }))).rejects.toThrow("缺少 bundleId");
  });
});

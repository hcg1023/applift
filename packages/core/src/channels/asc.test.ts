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

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
import { spawnSync } from "node:child_process";

const spawnSyncMock = vi.mocked(spawnSync);

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
  spawnSyncMock.mockReset();
});

function makeCtx(
  overrides: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    releaseTime?: string;
    artifactPath?: string;
  } = {},
): ChannelContext {
  return {
    credentials: overrides.credentials ?? {
      ASC_KEY_ID: "KEYID1",
      ASC_ISSUER_ID: "ISS1",
      ASC_P8_PATH: p8Path,
    },
    target: overrides.target ?? { bundleId: "com.example.app" },
    artifactPath: overrides.artifactPath ?? "/tmp/app-release.ipa",
    releaseTime: overrides.releaseTime,
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

  it("plan 默认手动发布，releaseTime 时定时", async () => {
    const p1 = await ch.plan(makeCtx());
    expect(p1).toMatchObject({
      channel: "asc",
      platform: "ios",
      action: "stage+submit",
      afterApproval: "manual",
    });
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
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
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
    expect(opts.encoding).toBe("utf8");
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

  it("spawn 结果无 stdout/stderr 字段 → 输出按空串处理仍成功", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 } as never);
    await expect(ch.stage(makeCtx())).resolves.toEqual({ ok: true });
  });

  it('altool 退出非 0 且无输出 → 报"无输出"', async () => {
    spawnSyncMock.mockReturnValue({ status: 71, stdout: "", stderr: "" } as never);
    await expect(ch.stage(makeCtx())).rejects.toThrow("altool 上传失败（exit 71）: 无输出");
  });

  it("spawnSync 带 30 分钟 timeout（CI 卡死不无限挂起）", async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    await ch.stage(makeCtx());
    const opts = spawnSyncMock.mock.calls[0]![2] as { timeout?: number };
    expect(opts.timeout).toBe(30 * 60 * 1000);
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

    const [cmd, args, opts] = spawnSyncMock.mock.calls[0]! as unknown as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(cmd).toBe("/fake/itms/iTMSTransporter");
    expect(args.slice(0, 3)).toEqual(["-m", "upload", "-jwt"]);
    expect(args).toContain("-k");
    expect(args).toContain("100000");
    expect(opts.timeout).toBe(30 * 60 * 1000);
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
    attributes: { version: "42", processingState: "VALID" },
    relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
  };
  const buildProcessing = {
    type: "builds",
    id: "B1",
    attributes: { version: "41", processingState: "PROCESSING" },
  };
  const pre = { type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } };

  function submitRoutes(
    overrides: {
      versions?: unknown;
      createdVersion?: unknown;
      builds?: unknown;
      localizations?: unknown;
    } = {},
  ) {
    return [
      { match: /\/v1\/apps\?/, response: { status: 200, json: { data: [app] } } },
      {
        match: /\/v1\/builds\?/,
        response: {
          status: 200,
          json: overrides.builds ?? { data: [buildValid], included: [pre] },
        },
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
      { match: /relationships\/builds/, response: { status: 200, json: { data: [] } } },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+\/items$/,
        response: { status: 201, json: { data: { id: "RSI1" } } },
      },
      {
        match: /\/v1\/reviewSubmissions\/[^/]+$/,
        response: { status: 200, json: { data: { id: "RS1", attributes: { action: "SUBMIT" } } } },
      },
      {
        match: /\/v1\/reviewSubmissions$/,
        response: { status: 201, json: { data: { id: "SUB1" } } },
      },
    ];
  }

  it("无既有版本：查 app→找 VALID 构建→创建版本（MANUAL）→绑构建→提审", async () => {
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
        "filter[appVersionState]=PREPARE_FOR_SUBMISSION",
      );
      // 4) 创建版本 POST：MANUAL + 构建版本号 + app 关系
      const post = m.calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/v1/appStoreVersions"),
      )!;
      expect(JSON.parse(post.body as string)).toEqual({
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString: "1.2.3", releaseType: "MANUAL" },
          relationships: { app: { data: { type: "apps", id: "APP1" } } },
        },
      });
      // 5) 绑定构建（to-many，data 为数组）
      const bind = m.find("relationships/builds")!;
      expect(bind.method).toBe("PATCH");
      expect(JSON.parse(bind.body as string)).toEqual({ data: [{ type: "builds", id: "B2" }] });
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
        (c) => c.method === "POST" && c.url.includes("/v1/reviewSubmissions/SUB1/items"),
      )!;
      expect(JSON.parse(item.body as string)).toEqual({
        data: {
          type: "reviewSubmissionItems",
          attributes: {},
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: "VNEW" } },
          },
        },
      });
      // 8) PATCH reviewSubmissions action=SUBMIT
      const confirm = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/reviewSubmissions/SUB1"),
      )!;
      expect(JSON.parse(confirm.body as string)).toEqual({
        data: { type: "reviewSubmissions", attributes: { action: "SUBMIT" } },
      });
      // 所有请求带 Bearer JWT
      for (const c of m.calls) expect(c.headers.Authorization).toMatch(/^Bearer ey/);
      // 9) 提审前预检通过 + 出口合规提示均 emit
      expect(events.some((e) => e.type === "progress" && e.detail?.includes("提审预检通过"))).toBe(
        true,
      );
      expect(events.some((e) => e.type === "progress" && e.detail?.includes("出口合规提示"))).toBe(
        true,
      );
    } finally {
      m.restore();
    }
  });

  it("有可编辑版本：PATCH 复用版本并设 releaseType", async () => {
    const m = mockFetch(
      submitRoutes({
        versions: {
          data: [{ type: "appStoreVersions", id: "V1", attributes: { versionString: "1.0.0" } }],
        },
      }),
    );
    try {
      await ch.submit(makeCtx());
      const patch = m.calls.find(
        (c) => c.method === "PATCH" && c.url.endsWith("/v1/appStoreVersions/V1"),
      )!;
      expect(JSON.parse(patch.body as string)).toEqual({
        data: { type: "appStoreVersions", id: "V1", attributes: { releaseType: "MANUAL" } },
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

  it("无 VALID 构建时抛错并列出最近状态", async () => {
    const m = mockFetch(
      submitRoutes({
        builds: {
          data: [
            buildProcessing,
            { type: "builds", id: "B0", attributes: { processingState: "FAILED" } },
          ],
          included: [pre],
        },
      }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("最近状态: PROCESSING, FAILED");
    } finally {
      m.restore();
    }
  });

  it('构建列表为空 → 报"无构建"', async () => {
    const m = mockFetch(submitRoutes({ builds: { data: [] } }));
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("最近状态: 无构建");
    } finally {
      m.restore();
    }
  });

  it("构建缺 processingState 字段 → 状态列表回退 UNKNOWN", async () => {
    const m = mockFetch(
      submitRoutes({ builds: { data: [{ type: "builds", id: "B1", attributes: {} }] } }),
    );
    try {
      await expect(ch.submit(makeCtx())).rejects.toThrow("最近状态: UNKNOWN");
    } finally {
      m.restore();
    }
  });

  it("VALID 构建缺 version 字段 → progress 文案版本段为空但流程成功", async () => {
    const noVersionBuild = {
      type: "builds",
      id: "B3",
      attributes: { processingState: "VALID" },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "PR1" } } },
    };
    const m = mockFetch(submitRoutes({ builds: { data: [noVersionBuild], included: [pre] } }));
    try {
      const events: Ev[] = [];
      const ctx = makeCtx();
      ctx.emit = evCollector(events) as typeof ctx.emit;
      await expect(ch.submit(ctx)).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(
        events.some((e) => e.type === "progress" && e.detail === "最新构建 build （版本 1.2.3）"),
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
            e.message === "复用可编辑版本 （releaseType=MANUAL）",
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
      expect(m.calls.find((c) => c.url.includes("relationships/builds"))).toBeUndefined();
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

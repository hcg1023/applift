/**
 * AscChannel 单元测试：spawnSync 用 vi.mock('node:child_process')；submit 走 fetch 契约 mock。
 * p8 用真实生成的 EC 密钥（makeAscJwt 需可读 PEM）。
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
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
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: false });
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

  it("status 返回 unknown（M2 未接入）", async () => {
    expect(await ch.status()).toMatchObject({ state: "unknown" });
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

describe("stage（altool 上传）", () => {
  const ch = new AscChannel();

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
    overrides: { versions?: unknown; createdVersion?: unknown; builds?: unknown } = {},
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
      expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
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
});

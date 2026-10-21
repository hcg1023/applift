/**
 * pushy OpenAPI 客户端契约：端点、载荷、鉴权头与错误语义。
 * 端点面钉在 react-native-update-cli 2.29.3 的参考调用上（服务端 OpenAPI 只声明路径无 schema，
 * 此处断言的就是载荷契约本体——服务端改字段时在此显式失败）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPushyApi, PUSHY_DEFAULT_BASE_URL, type FetchImpl } from "./pushy-api.js";

interface Req {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** 按路径分流的 fetch mock；OSS 直传（非 API 域）单独分流 */
function mockFetch(
  routes: Record<string, unknown>,
  oss?: (req: Req) => Response | undefined,
): { fetchImpl: FetchImpl; calls: Req[] } {
  const calls: Req[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    const u = new URL(String(url));
    const req: Req = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    };
    calls.push(req);
    const route = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    if (route) return Response.json(routes[route]);
    const ossRes = oss?.(req);
    if (ossRes) return ossRes;
    throw new Error(`mock fetch 未配置路由：${req.url}`);
  };
  return { fetchImpl, calls };
}

function ppkFile(content = "ppk-bytes"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-pushyapi-"));
  const f = path.join(dir, "harmony.pp123.pk");
  fs.writeFileSync(f, content);
  return f;
}

const UPLOAD_ROUTE = {
  url: "https://oss.example.com/bucket",
  formData: { key: "hashKey123", policy: "p" },
};

describe("publish（热更发布：上传 → version/create → 绑定偏移测试版本）", () => {
  it("三步链路载荷齐全，x-api-token 每请求都在", async () => {
    const file = ppkFile();
    const { fetchImpl, calls } = mockFetch(
      {
        "/upload": UPLOAD_ROUTE,
        "/app/34166/package/list": { data: [{ id: 100266, name: "1004.0.0" }] },
        "/app/34166/version/create": { id: 303353 },
        "/app/34166/binding": { ok: true },
      },
      (req) =>
        req.url.startsWith("https://oss.example.com")
          ? new Response(null, { status: 204 })
          : undefined,
    );
    const cli = createPushyApi({ token: "tok-1", fetchImpl });
    const r = await cli.publish({
      appId: 34166,
      ppk: file,
      platform: "harmony",
      name: "4.0.0-patch.1",
      description: "修复登录",
      packageVersion: "1004.0.0",
    });
    expect(r).toEqual({ versionId: 303353 });

    // 1. /upload 指令请求
    const upload = calls.find((c) => c.url.endsWith("/upload"))!;
    expect(upload.method).toBe("POST");
    expect(upload.headers["x-api-token"]).toBe("tok-1");
    expect(JSON.parse(String(upload.body))).toEqual({ ext: ".pk", appId: 34166, size: 9 });

    // 2. OSS multipart 直传：formData 字段在前、file part 在后（filename 带后缀）
    const oss = calls.find((c) => c.url.startsWith("https://oss.example.com"))!;
    expect(oss.method).toBe("POST");
    expect(oss.headers["content-type"]).toMatch(/^multipart\/form-data;boundary=/);
    const body = Buffer.from(oss.body as Uint8Array).toString();
    expect(body).toContain('name="key"\r\n\r\nhashKey123');
    expect(body).toContain('name="policy"\r\n\r\np');
    expect(body).toContain(`name="file"; filename="harmony.pp123.pk"`);
    expect(body).toContain("ppk-bytes");

    // 3. version/create + binding（packageVersion 精确匹配 packageId）
    const create = calls.find((c) => c.url.endsWith("/version/create"))!;
    expect(JSON.parse(String(create.body))).toMatchObject({
      name: "4.0.0-patch.1",
      hash: "hashKey123",
      description: "修复登录",
    });
    const binding = calls.find((c) => c.url.endsWith("/binding"))!;
    expect(JSON.parse(String(binding.body))).toEqual({
      versionId: 303353,
      rollout: undefined,
      packageId: 100266,
    });
  });

  it("publish 带 rollout → binding 携带灰度比例", async () => {
    const file = ppkFile();
    const { fetchImpl, calls } = mockFetch(
      {
        "/upload": UPLOAD_ROUTE,
        "/app/34166/package/list": { data: [{ id: 100266, name: "1004.0.0" }] },
        "/app/34166/version/create": { id: 1 },
        "/app/34166/binding": {},
      },
      () => new Response(null, { status: 204 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await cli.publish({
      appId: 34166,
      ppk: file,
      platform: "harmony",
      name: "n",
      packageVersion: "1004.0.0",
      rollout: 20,
    });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/binding"))!.body))).toMatchObject({
      rollout: 20,
    });
  });
});

describe("uploadApp（原生基线上传）", () => {
  it("上传 → package/create（name = 调用方传入的 versionName）", async () => {
    const file = ppkFile("app-bytes");
    const { fetchImpl, calls } = mockFetch(
      {
        "/upload": UPLOAD_ROUTE,
        "/app/34166/package/create": { id: 100266 },
      },
      () => new Response(null, { status: 204 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    const r = await cli.uploadApp(34166, file, "4.0.0");
    expect(r).toEqual({ packageId: 100266, version: "4.0.0" });
    const create = calls.find((c) => c.url.endsWith("/package/create"))!;
    const body = JSON.parse(String(create.body)) as {
      name: string;
      hash: string;
      buildTime: string;
    };
    expect(body.name).toBe("4.0.0");
    expect(body.hash).toBe("hashKey123");
    expect(body.buildTime).toMatch(/^\d+$/);
  });

  it("自托管节点预签名 PUT 直传 → 返回指令 key 作为 hash", async () => {
    const file = ppkFile("app-bytes");
    const { fetchImpl, calls } = mockFetch(
      {
        "/upload": { method: "PUT", url: "https://s3.example.com/presigned", key: "s3Key" },
        "/app/34166/package/create": { id: 7 },
      },
      (req) =>
        req.url.startsWith("https://s3.example.com")
          ? new Response(null, { status: 200 })
          : undefined,
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await cli.uploadApp(34166, file, "4.0.0");
    const put = calls.find((c) => c.url.startsWith("https://s3.example.com"))!;
    expect(put.method).toBe("PUT");
    expect(Buffer.from(put.body as Uint8Array).toString()).toBe("app-bytes");
    expect(
      (
        JSON.parse(String(calls.find((c) => c.url.endsWith("/package/create"))!.body)) as {
          hash: string;
        }
      ).hash,
    ).toBe("s3Key");
  });
});

describe("rebind（promote 重绑）", () => {
  it("packageVersion 精确匹配 → binding {versionId, rollout, packageId}", async () => {
    const { fetchImpl, calls } = mockFetch({
      "/app/34166/package/list": {
        data: [
          { id: 100100, name: "3.9.9" },
          { id: 100266, name: "4.0.0" },
        ],
      },
      "/app/34166/binding": {},
    });
    const cli = createPushyApi({ token: "t", fetchImpl });
    await cli.rebind({ appId: 34166, versionId: 303353, packageVersion: "4.0.0", rollout: 30 });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith("/binding"))!.body))).toEqual({
      versionId: 303353,
      rollout: 30,
      packageId: 100266,
    });
  });

  it("无匹配原生包版本 → 报错并引导先发原生版", async () => {
    const { fetchImpl } = mockFetch({
      "/app/34166/package/list": { data: [{ id: 100100, name: "3.9.9" }] },
    });
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(
      cli.rebind({ appId: 34166, versionId: 1, packageVersion: "4.0.0" }),
    ).rejects.toThrow(/未找到原生包版本 4\.0\.0/);
  });
});

describe("versions（取号列表）", () => {
  it("分页取尽（服务端封顶 limit=100），解析 id/hash/name", async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ id: i, hash: `h${i}`, name: `n${i}` }));
    const calls: Req[] = [];
    // 动态路由：按 offset 参数返回两页
    const dynamic: FetchImpl = async (url, init) => {
      const u = new URL(String(url));
      if (!u.pathname.endsWith("/version/list")) throw new Error("unexpected " + url);
      const offset = Number(u.searchParams.get("offset"));
      const data = offset === 0 ? first : [{ id: 100, hash: "h100", name: "4.0.0-patch.1" }];
      calls.push({ url: String(url), method: init?.method ?? "GET", headers: {} });
      return Response.json({ data });
    };
    const cli = createPushyApi({ token: "t", fetchImpl: dynamic });
    const vs = await cli.versions(1);
    expect(vs).toHaveLength(101);
    expect(vs[100]).toEqual({ id: 100, hash: "h100", name: "4.0.0-patch.1" });
    expect(calls).toHaveLength(2);
  });
});

describe("错误语义与配置", () => {
  it("非 200 → 抛服务端 json.message", async () => {
    const fetchImpl: FetchImpl = async () =>
      Response.json({ message: "app not found" }, { status: 404 });
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(cli.versions(1)).rejects.toThrow(/HTTP 404[\s\S]*app not found/);
  });

  it("rebind：package/list 分页取尽（基线 >100 不假报缺失）", async () => {
    let calls = 0;
    const dynamic: FetchImpl = async (url) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/binding")) return Response.json({ ok: true });
      if (!u.pathname.endsWith("/package/list")) throw new Error("unexpected " + url);
      calls++;
      const offset = Number(u.searchParams.get("offset"));
      // 第一页整页 100 条 + 第二页 1 条目标（id 999 在第二页——不分页会漏掉它）
      const data =
        offset === 0
          ? Array.from({ length: 100 }, (_, i) => ({ id: i, name: `3.${i}.0` }))
          : [{ id: 999, name: "4.0.0" }];
      return Response.json({ data });
    };
    const cli = createPushyApi({ token: "t", fetchImpl: dynamic });
    await expect(
      cli.rebind({ appId: 34166, versionId: 1, packageVersion: "4.0.0" }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("401 → 提示更新 PUSHY_API_TOKEN", async () => {
    const fetchImpl: FetchImpl = async () =>
      Response.json({ message: "invalid token" }, { status: 401 });
    const cli = createPushyApi({ token: "bad", fetchImpl });
    await expect(cli.versions(1)).rejects.toThrow(/PUSHY_API_TOKEN/);
  });

  it("200 但非 JSON → 显式报错（网关劫持防线）", async () => {
    const fetchImpl: FetchImpl = async () => new Response("<html>gateway</html>", { status: 200 });
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(cli.versions(1)).rejects.toThrow(/非 JSON/);
  });

  it("上传文件不存在 → 明确报错", async () => {
    const { fetchImpl } = mockFetch({});
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(
      cli.publish({
        appId: 1,
        ppk: "/no/such.ppk",
        platform: "harmony",
        name: "n",
        packageVersion: "1.0.0",
      }),
    ).rejects.toThrow(/不存在/);
  });

  it("缺省 baseUrl 用 pushy 官方；serverUrl 覆盖生效（cresc 自建）", async () => {
    const { fetchImpl, calls } = mockFetch({ "/app/1/version/list": { data: [] } });
    await createPushyApi({ token: "t", fetchImpl }).versions(1);
    expect(calls[0]!.url).toBe(`${PUSHY_DEFAULT_BASE_URL}/app/1/version/list?offset=0&limit=100`);
    const { fetchImpl: f2, calls: c2 } = mockFetch({ "/version/list": { data: [] } });
    await createPushyApi({
      token: "t",
      baseUrl: "https://cresc.example.com/api",
      fetchImpl: f2,
    }).versions(1);
    expect(c2[0]!.url).toBe("https://cresc.example.com/api/app/1/version/list?offset=0&limit=100");
  });

  it("fetch 网络层异常（DNS/断连）→ 显式网络错误而非裸异常", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error("getaddrinfo ENOTFOUND update.reactnative.cn");
    };
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(cli.versions(1)).rejects.toThrow(/网络错误[\s\S]*ENOTFOUND/);
  });

  it("multipart 直传被对象存储拒绝（HTTP 500）→ 报直传失败", async () => {
    const file = ppkFile();
    const { fetchImpl } = mockFetch(
      { "/upload": UPLOAD_ROUTE },
      () => new Response(null, { status: 500 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(
      cli.publish({ appId: 1, ppk: file, platform: "harmony", name: "n", packageVersion: "1.0.0" }),
    ).rejects.toThrow(/文件直传失败（HTTP 500）/);
  });

  it("预签名 PUT 直传失败（HTTP 403）→ 报基线直传失败", async () => {
    const file = ppkFile();
    const { fetchImpl } = mockFetch(
      { "/upload": { method: "PUT", url: "https://s3.example.com/presigned", key: "k" } },
      () => new Response(null, { status: 403 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await expect(cli.uploadApp(1, file, "4.0.0")).rejects.toThrow(/基线直传失败（HTTP 403）/);
  });

  it("文件 part 的 Content-Type 按扩展名映射（.apk → android 包类型）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-pushyapi-apk-"));
    const file = path.join(dir, "app-release.apk");
    fs.writeFileSync(file, "apk-bytes");
    const { fetchImpl, calls } = mockFetch(
      { "/upload": UPLOAD_ROUTE, "/app/1/package/create": { id: 2 } },
      () => new Response(null, { status: 204 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await cli.uploadApp(1, file, "4.0.0");
    const oss = calls.find((c) => c.url.startsWith("https://oss.example.com"))!;
    const body = Buffer.from(oss.body as Uint8Array).toString();
    expect(body).toContain("Content-Type: application/vnd.android.package-archive");
  });

  it("文件 part 的 Content-Type：.zip → application/zip（映射表分支）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-pushyapi-zip-"));
    const file = path.join(dir, "bundle.zip");
    fs.writeFileSync(file, "zip-bytes");
    const { fetchImpl, calls } = mockFetch(
      { "/upload": UPLOAD_ROUTE, "/app/1/package/create": { id: 3 } },
      () => new Response(null, { status: 204 }),
    );
    const cli = createPushyApi({ token: "t", fetchImpl });
    await cli.uploadApp(1, file, "4.0.0");
    const oss = calls.find((c) => c.url.startsWith("https://oss.example.com"))!;
    expect(Buffer.from(oss.body as Uint8Array).toString()).toContain(
      "Content-Type: application/zip",
    );
  });
});

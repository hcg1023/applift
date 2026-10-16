import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveListing, loadListingFile, assertListingFiles } from "./listing.js";

describe("resolveListing", () => {
  it("无覆盖时透传基础值", () => {
    expect(
      resolveListing(
        { brief: "b", description: "d", iconPath: "/i.png", screenshots: ["/s.png"] },
        "huawei",
      ),
    ).toEqual({ brief: "b", description: "d", iconPath: "/i.png", screenshots: ["/s.png"] });
  });

  it("渠道覆盖优先，未覆盖字段保留基础值", () => {
    expect(
      resolveListing(
        { brief: "base", description: "base-desc", stores: { huawei: { brief: "hw" } } },
        "huawei",
      ),
    ).toEqual({ brief: "hw", description: "base-desc" });
  });

  it("其他渠道的覆盖不影响本渠道", () => {
    expect(
      resolveListing({ brief: "base", stores: { xiaomi: { brief: "mi" } } }, "huawei"),
    ).toEqual({ brief: "base" });
  });

  it("空输入返回空对象", () => {
    expect(resolveListing({}, "huawei")).toEqual({});
  });

  it("仅覆盖存在（基础值缺省）时也取覆盖值", () => {
    expect(
      resolveListing({ stores: { vivo: { brief: "vivo-only", iconPath: "/v.png" } } }, "vivo"),
    ).toEqual({ brief: "vivo-only", iconPath: "/v.png" });
  });

  it("覆盖 screenshots/description 全字段：覆盖逐字段生效，未覆盖字段走基础值", () => {
    expect(
      resolveListing(
        {
          brief: "b",
          description: "d",
          iconPath: "/base.png",
          screenshots: ["/base-1.png"],
          stores: {
            oppo: { description: "oppo-desc", screenshots: ["/oppo-1.png", "/oppo-2.png"] },
          },
        },
        "oppo",
      ),
    ).toEqual({
      brief: "b",
      description: "oppo-desc",
      iconPath: "/base.png",
      screenshots: ["/oppo-1.png", "/oppo-2.png"],
    });
  });

  it("stores 存在但本渠道无条目 → 覆盖为空对象，透传基础值", () => {
    expect(resolveListing({ brief: "b", stores: { xiaomi: { brief: "mi" } } }, "huawei")).toEqual({
      brief: "b",
    });
  });
});

function tmpListingDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-listing-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("loadListingFile", () => {
  it("加载 TS 默认导出并把相对 iconPath/screenshots 解析为配置所在目录的绝对路径", async () => {
    const dir = tmpListingDir({
      "listing.config.ts": [
        "export default {",
        "  brief: '一句话简介',",
        "  description: '长描述',",
        "  iconPath: './icons/icon.png',",
        "  screenshots: ['shots/a.png', '../shared/b.png'],",
        "};",
      ].join("\n"),
    });
    const listing = await loadListingFile(path.join(dir, "listing.config.ts"));
    expect(listing.brief).toBe("一句话简介");
    expect(listing.description).toBe("长描述");
    expect(listing.iconPath).toBe(path.join(dir, "icons/icon.png"));
    expect(listing.screenshots).toEqual([
      path.join(dir, "shots/a.png"),
      path.join(dir, "../shared/b.png"),
    ]);
  });

  it("iconPath/screenshots 缺省时保持 undefined（不解析不造路径）", async () => {
    const dir = tmpListingDir({
      "listing.config.ts": "export default { brief: 'only-brief' };",
    });
    const listing = await loadListingFile(path.join(dir, "listing.config.ts"));
    expect(listing).toEqual({ brief: "only-brief", iconPath: undefined, screenshots: undefined });
  });

  it("默认导出非对象（数组）抛缺少默认导出对象", async () => {
    const dir = tmpListingDir({
      "listing.config.ts": "export default [1, 2];",
    });
    const file = path.join(dir, "listing.config.ts");
    await expect(loadListingFile(file)).rejects.toThrow(`listing 配置 ${file} 缺少默认导出对象`);
  });

  it("c12 返回非对象 config（标量）抛缺少默认导出对象", async () => {
    vi.resetModules();
    // 动态 import 是必须的：vi.doMock 只影响其后新加载的模块实例（同 project.test.ts）
    vi.doMock("c12", () => ({ loadConfig: vi.fn(async () => ({ config: 42 })) }));
    try {
      const { loadListingFile: load } = await import("./listing.js");
      await expect(load("/tmp/any/listing.config.ts")).rejects.toThrow("缺少默认导出对象");
    } finally {
      vi.doUnmock("c12");
      vi.resetModules();
    }
  });

  it("c12 返回空 config 抛缺少默认导出对象", async () => {
    vi.resetModules();
    // 动态 import 是必须的：vi.doMock 只影响其后新加载的模块实例（同 project.test.ts）
    vi.doMock("c12", () => ({ loadConfig: vi.fn(async () => ({ config: undefined })) }));
    try {
      const { loadListingFile: load } = await import("./listing.js");
      await expect(load("/tmp/any/listing.config.ts")).rejects.toThrow("缺少默认导出对象");
    } finally {
      vi.doUnmock("c12");
      vi.resetModules();
    }
  });
});

describe("assertListingFiles", () => {
  it("icon 与截图全部存在时通过", () => {
    const dir = tmpListingDir({ "icon.png": "x", "s1.png": "x", "s2.png": "x" });
    expect(() =>
      assertListingFiles({
        iconPath: path.join(dir, "icon.png"),
        screenshots: [path.join(dir, "s1.png"), path.join(dir, "s2.png")],
      }),
    ).not.toThrow();
  });

  it("icon 不存在时抛错并带路径", () => {
    expect(() => assertListingFiles({ iconPath: "/nonexistent/icon.png" })).toThrow(
      "listing 引用的文件不存在: /nonexistent/icon.png",
    );
  });

  it("截图不存在时抛错", () => {
    expect(() => assertListingFiles({ screenshots: ["/nonexistent/s1.png"] })).toThrow(
      "listing 引用的文件不存在: /nonexistent/s1.png",
    );
  });

  it("icon/screenshots 均缺省（含空数组）时跳过校验", () => {
    expect(() => assertListingFiles({})).not.toThrow();
    expect(() => assertListingFiles({ screenshots: [] })).not.toThrow();
  });
});

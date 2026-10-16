import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectProfileMap,
  saveProjectProfileMap,
  setProjectProfile,
  resolveProfileFor,
  PROJECTS_MAP_PATH,
} from "./profile-map.js";

function tmpMap(name: string): string {
  return path.join(os.tmpdir(), `applift-test-${name}-projects.json`);
}

describe("resolveProfileFor 优先级链", () => {
  it("projects.json 映射命中 → 优先于项目配置 profile（个人选择 > 项目默认）", () => {
    const p = tmpMap("hit");
    setProjectProfile("/proj/a", "personal", p);
    try {
      expect(resolveProfileFor("/proj/a", "team-default", p)).toBe("personal");
      // 相对路径 / 尾斜杠归一到同一绝对键
      expect(resolveProfileFor("/proj/a/", "team-default", p)).toBe("personal");
      expect(resolveProfileFor("/proj/a/sub/..", "team-default", p)).toBe("personal");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("映射未命中 → 回退项目配置 profile（团队默认）", () => {
    expect(resolveProfileFor("/proj/none", "company-b", tmpMap("miss"))).toBe("company-b");
  });

  it("项目配置也缺省（undefined/空串）→ 全局默认 default", () => {
    expect(resolveProfileFor("/proj/none", undefined, tmpMap("d1"))).toBe("default");
    expect(resolveProfileFor("/proj/none", "", tmpMap("d2"))).toBe("default");
  });
});

describe("loadProjectProfileMap 容错", () => {
  it("文件不存在 → 空映射", () => {
    expect(loadProjectProfileMap(tmpMap("nonexist"))).toEqual({});
  });

  it("损坏 JSON → 空映射不抛错，回退链继续走项目配置", () => {
    const p = tmpMap("corrupt");
    fs.writeFileSync(p, "{oops");
    try {
      expect(loadProjectProfileMap(p)).toEqual({});
      expect(resolveProfileFor("/proj/x", "team", p)).toBe("team");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("顶层非对象（数组/字符串）→ 空映射；混合形状只留合法 string 条目", () => {
    const arr = tmpMap("shape-arr");
    const str = tmpMap("shape-str");
    const mixed = tmpMap("shape-mixed");
    fs.writeFileSync(arr, '["a","b"]');
    fs.writeFileSync(str, '"hello"');
    fs.writeFileSync(
      mixed,
      JSON.stringify({ "/ok": "yes", bad: 1, empty: "", nested: { k: "v" } }),
    );
    try {
      expect(loadProjectProfileMap(arr)).toEqual({});
      expect(loadProjectProfileMap(str)).toEqual({});
      expect(loadProjectProfileMap(mixed)).toEqual({ "/ok": "yes" });
    } finally {
      fs.unlinkSync(arr);
      fs.unlinkSync(str);
      fs.unlinkSync(mixed);
    }
  });
});

describe("写读往返", () => {
  it("setProjectProfile 合并保留其他项目、覆盖同项目（键统一绝对路径）", () => {
    const p = tmpMap("roundtrip");
    setProjectProfile("/proj/a", "first", p);
    setProjectProfile("/proj/b", "second", p);
    setProjectProfile("/proj/a", "updated", p);
    setProjectProfile("/proj/a/sub", "other", p);
    try {
      expect(loadProjectProfileMap(p)).toEqual({
        "/proj/a": "updated",
        "/proj/b": "second",
        "/proj/a/sub": "other",
      });
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("saveProjectProfileMap 覆盖写 + 目录自动创建", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-pm-"));
    const p = path.join(dir, "not-exist-sub", "projects.json");
    try {
      saveProjectProfileMap({ "/x": "y" }, p);
      expect(loadProjectProfileMap(p)).toEqual({ "/x": "y" });
      saveProjectProfileMap({}, p);
      expect(loadProjectProfileMap(p)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PROJECTS_MAP_PATH 落在 ~/.applift", () => {
  it("路径约定", () => {
    expect(PROJECTS_MAP_PATH).toBe(path.join(os.homedir(), ".applift", "projects.json"));
  });
});

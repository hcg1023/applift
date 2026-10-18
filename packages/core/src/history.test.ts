/**
 * history 契约测试：append/read/query/损坏行容错。文件落临时目录，不污染真实 ~/.applift。
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendEntry, readEntries, HISTORY_PATH, type HistoryEntry } from "./history.js";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    ts: 1700000000000,
    channel: "huawei",
    action: "stage",
    artifactSha256: "a".repeat(64),
    artifactVersion: "1.2.3",
    ok: true,
    ref: "release-123",
    cwd: "/tmp/proj",
    ...overrides,
  };
}

let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "applift-history-")), "history.jsonl");
});

describe("appendEntry / readEntries", () => {
  it("不存在的文件读取返回空数组", () => {
    expect(readEntries({}, file)).toEqual([]);
  });

  it("追加后按写入顺序读回，字段完整", () => {
    appendEntry(makeEntry(), file);
    appendEntry(
      makeEntry({ channel: "yyb", action: "submit", ok: false, ts: 1700000001000 }),
      file,
    );
    const entries = readEntries({}, file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      channel: "huawei",
      action: "stage",
      ok: true,
      ref: "release-123",
      artifactVersion: "1.2.3",
    });
    expect(entries[1]).toMatchObject({ channel: "yyb", action: "submit", ok: false });
  });

  it("每行一条 JSON（jsonl 格式）", () => {
    appendEntry(makeEntry(), file);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ channel: "huawei" });
  });
});

describe("readEntries query", () => {
  beforeEach(() => {
    appendEntry(
      makeEntry({ artifactSha256: "aaa", channel: "huawei", action: "stage", ok: true }),
      file,
    );
    appendEntry(
      makeEntry({ artifactSha256: "aaa", channel: "yyb", action: "stage", ok: true }),
      file,
    );
    appendEntry(
      makeEntry({ artifactSha256: "bbb", channel: "huawei", action: "submit", ok: true }),
      file,
    );
  });

  it("按 sha256 过滤", () => {
    expect(readEntries({ sha256: "aaa" }, file).map((e) => e.channel)).toEqual(["huawei", "yyb"]);
  });

  it("按 channel 过滤", () => {
    expect(readEntries({ channel: "huawei" }, file).map((e) => e.action)).toEqual([
      "stage",
      "submit",
    ]);
  });

  it("sha256+channel 组合过滤", () => {
    const r = readEntries({ sha256: "aaa", channel: "yyb" }, file);
    expect(r).toHaveLength(1);
    expect(r[0]?.channel).toBe("yyb");
  });

  it("无命中返回空数组", () => {
    expect(readEntries({ sha256: "zzz" }, file)).toEqual([]);
  });
});

describe("损坏行容错", () => {
  it("非法 JSON / 缺关键字段的行被跳过，好行保留", () => {
    fs.writeFileSync(
      file,
      [
        JSON.stringify(makeEntry({ channel: "good1" })),
        "{not valid json",
        "",
        JSON.stringify({ channel: "no-ts", action: "stage" }), // 缺 ts/artifactSha256 等
        JSON.stringify(makeEntry({ channel: "good2" })),
        "null",
      ].join("\n") + "\n",
      "utf8",
    );
    const entries = readEntries({}, file);
    expect(entries.map((e) => e.channel)).toEqual(["good1", "good2"]);
  });
});

describe("HISTORY_PATH", () => {
  it("位于 ~/.applift 下", () => {
    expect(HISTORY_PATH).toBe(path.join(os.homedir(), ".applift", "history.jsonl"));
  });
});

describe("多进程并发追加", () => {
  it("两进程各 20 条并发写同一 jsonl → 40 条全部完整可解析（append 原子性契约）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-history-conc-"));
    const target = path.join(dir, "history.jsonl");
    // 经构建产物 dist/index.mjs 起 worker（src 的 .js 扩展名映射 node 直跑不了）；
    // vitest 下 import.meta.url 基准不可靠，按运行目录显式探测
    const dist =
      [path.resolve("packages/core/dist/index.mjs"), path.resolve("dist/index.mjs")].find((p) =>
        fs.existsSync(p),
      ) ?? "";
    if (!dist)
      throw new Error("未找到 packages/core/dist/index.mjs（测试脚本前置 build 保证了它存在）");
    const worker = (tag: string) =>
      new Promise<void>((resolve, reject) => {
        let errTail = "";
        const child = spawn(
          process.execPath,
          [
            "-e",
            `import(${JSON.stringify(dist)}).then((m) => {
              for (let i = 0; i < 20; i++)
                m.appendEntry({ ts: Date.now(), channel: ${JSON.stringify(tag)}, action: "stage", artifactSha256: "x", ok: true, cwd: "/tmp" }, ${JSON.stringify(target)});
            }).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        child.stderr?.on("data", (d) => {
          errTail += d.toString();
        });
        child.on("exit", (c) =>
          c === 0
            ? resolve()
            : reject(new Error(`worker ${tag} exit ${c}: ${errTail.slice(0, 400)}`)),
        );
      });
    await Promise.all([worker("conc-a"), worker("conc-b")]);
    const entries = readEntries({}, target);
    expect(entries).toHaveLength(40);
    expect(entries.filter((e) => e.channel === "conc-a")).toHaveLength(20);
    expect(entries.filter((e) => e.channel === "conc-b")).toHaveLength(20);
  }, 30_000);
});

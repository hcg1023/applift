/**
 * 发版历史：~/.applift/history.jsonl，每行一条 JSON（HistoryEntry）。
 * 用于幂等提示（同 sha256+channel 已 stage 成功 → 提示 --skip-stage）与审计回溯。
 * 容错：损坏行（非法 JSON / 缺关键字段）跳过，不让单条脏数据毁掉整个历史读取。
 */
import fs from "node:fs";
import path from "node:path";
import { APPLIFT_HOME } from "./config/loader.js";

export interface HistoryEntry {
  /** Unix 毫秒时间戳 */
  ts: number;
  channel: string;
  action: "stage" | "submit";
  artifactSha256: string;
  artifactVersion?: string;
  ok: boolean;
  /** 渠道返回的草稿/任务引用（如华为 releaseId） */
  ref?: string;
  cwd: string;
}

/** pipeline → sink 的事件载荷（CLI 补 ts/cwd/artifactSha256 后 appendEntry） */
export interface HistoryEvent {
  channel: string;
  action: "stage" | "submit";
  ok: boolean;
  ref?: string;
  artifactVersion?: string;
}

export interface HistoryQuery {
  sha256?: string;
  channel?: string;
}

export const HISTORY_PATH = path.join(APPLIFT_HOME, "history.jsonl");

function isValidEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<HistoryEntry>;
  return (
    typeof e.ts === "number" &&
    typeof e.channel === "string" &&
    (e.action === "stage" || e.action === "submit") &&
    typeof e.artifactSha256 === "string" &&
    typeof e.ok === "boolean" &&
    typeof e.cwd === "string"
  );
}

/** 追加一条历史（自动建目录与文件） */
export function appendEntry(entry: HistoryEntry, filePath: string = HISTORY_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}

/** 读取历史（损坏行跳过），按 query 过滤；返回按写入顺序（旧→新） */
export function readEntries(
  query: HistoryQuery = {},
  filePath: string = HISTORY_PATH,
): HistoryEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const out: HistoryEntry[] = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 损坏行：跳过
    }
    if (!isValidEntry(parsed)) continue;
    if (query.sha256 !== undefined && parsed.artifactSha256 !== query.sha256) continue;
    if (query.channel !== undefined && parsed.channel !== query.channel) continue;
    out.push(parsed);
  }
  return out;
}

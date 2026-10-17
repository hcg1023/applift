/**
 * 产物版本读取（只读不写——版本号变更属开发提交，发版工具只负责读版本防回退）。
 * .hap/.app：pack.info 是纯 JSON，零依赖直接读；
 * .apk：aapt2/aapt dump badging（ANDROID_HOME/SDK 探测，同 oppo 渠道逻辑）；
 * .ipa：二进制 plist 解析成本高，不支持自动读（返回 undefined，doctor 提示用 --version/配置）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

export interface ArtifactVersion {
  versionName?: string;
  versionCode?: string;
  /** 读取方式说明（doctor 展示溯源） */
  source: string;
}

export function readArtifactVersion(artifactPath: string): ArtifactVersion | undefined {
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === ".hap" || ext === ".app") return fromPackInfo(artifactPath);
  if (ext === ".apk") return fromAapt(artifactPath);
  return undefined;
}

/** 鸿蒙包版本读取：优先包内 pack.info（zip 容器内的权威数据），回退同目录 pack.info（标注可能过期） */
function fromPackInfo(artifactPath: string): ArtifactVersion | undefined {
  // 权威：包内 pack.info（unzip -p 提取；macOS/Linux 自带 unzip）
  const r = spawnSync("unzip", ["-p", artifactPath, "pack.info"], {
    timeout: 10_000,
    encoding: "utf8",
  });
  if (!r.error && r.status === 0 && r.stdout) {
    const v = parsePackInfo(r.stdout, "pack.info(包内)");
    if (v) return v;
  }
  // 回退：同目录 pack.info（构建伴生文件，可能过期——source 标注提醒）
  const side = path.join(path.dirname(artifactPath), "pack.info");
  if (fs.existsSync(side)) {
    try {
      const v = parsePackInfo(fs.readFileSync(side, "utf8"), "pack.info(同目录,可能过期)");
      if (v) return v;
    } catch {
      // 损坏忽略
    }
  }
  return undefined;
}

/** 真实鸿蒙 pack.info schema（qy-driver 实测样本）：summary.app.version.{name,code,build}；
 *  顶层 versionName/versionCode 为历史兼容形态。 */
function parsePackInfo(text: string, source: string): ArtifactVersion | undefined {
  try {
    const info = JSON.parse(text) as {
      versionName?: string;
      versionCode?: string | number;
      summary?: { app?: { version?: { name?: string; code?: number } } };
    };
    const nested = info.summary?.app?.version;
    const versionName = nested?.name ?? info.versionName;
    const versionCode = nested?.code ?? info.versionCode;
    if (versionName || versionCode !== undefined) {
      return { versionName, versionCode: String(versionCode ?? ""), source };
    }
  } catch {
    // 非 JSON 忽略
  }
  return undefined;
}

/** APK：aapt2/aapt dump badging（versionCode/versionName） */
function fromAapt(artifactPath: string): ArtifactVersion | undefined {
  const tools: string[] = [];
  const sdkDir = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
  const btDir = path.join(sdkDir, "build-tools");
  if (fs.existsSync(btDir)) {
    for (const bt of fs.readdirSync(btDir).sort().reverse()) {
      for (const tool of ["aapt2", "aapt"]) {
        const p = path.join(btDir, bt, tool);
        if (fs.existsSync(p)) tools.push(p);
      }
    }
  }
  for (const tool of tools) {
    const r = spawnSync(tool, ["dump", "badging", artifactPath], {
      timeout: 10_000,
      encoding: "utf8",
    });
    if (r.error || r.status !== 0) continue;
    const name = /versionName='([^']*)'/.exec(r.stdout ?? "")?.[1];
    const code = /versionCode='(\d+)'/.exec(r.stdout ?? "")?.[1];
    if (name || code) return { versionName: name, versionCode: code, source: path.basename(tool) };
  }
  return undefined;
}

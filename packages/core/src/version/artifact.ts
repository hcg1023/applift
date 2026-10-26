/**
 * 产物版本读取（只读不写——版本号变更属开发提交，发版工具只负责读版本防回退）。
 * .hap/.app：pack.info 是纯 JSON，零依赖直接读；
 * .apk：aapt2/aapt dump badging（ANDROID_HOME/SDK 探测，同 oppo 渠道逻辑）；
 * .hap/.app 的 pushy 构建时间戳在包内 resources/rawfile/meta.json（pushy hvigor 插件写入），
 * 由 readArtifactBuildTime 读取——基线 buildTime 必须与设备上报精确一致（不匹配服务端封锁 6h）。
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

/** 产物 pushy 构建时间戳读取（buildTime 与设备上报必须精确一致，读不出返回 undefined，
 *  由调用方决定拒绝上传而非猜测）。
 *  .hap/.app：包内（.app 可能嵌套 hap）resources/rawfile/meta.json 的 pushy_build_time；
 *  .apk：AndroidManifest meta-data pushy_build_time（aapt2/aapt xmltree）；
 *  .ipa：Payload/*.app/pushy_build_time.txt（官方 Xcode 构建 phase 产物）。 */
export function readArtifactBuildTime(artifactPath: string): string | undefined {
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === ".hap" || ext === ".app") return harmonyBuildTime(artifactPath);
  if (ext === ".apk") return apkBuildTime(artifactPath);
  if (ext === ".ipa") return ipaBuildTime(artifactPath);
  return undefined;
}

/** unzip 子进程 stdout（失败/超时返回 undefined，调用方按读不出处理） */
function unzipStdout(args: string[]): string | undefined {
  const r = spawnSync("unzip", args, {
    timeout: 20_000,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return !r.error && r.status === 0 ? r.stdout : undefined;
}

function metaJsonBuildTime(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return undefined; // 非 JSON 忽略
  }
  if (meta && typeof meta === "object" && "pushy_build_time" in meta) {
    const v = (meta as Record<string, unknown>).pushy_build_time;
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return undefined;
}

/** 鸿蒙：先按顶层 resources/rawfile/meta.json 读（hap 或直排 hap 内容的 .app）；
 *  .app 整包的 hap 嵌套在 zip 里，取出后再读（对照官方 CLI getAppInfo 的嵌套提取）。 */
function harmonyBuildTime(artifactPath: string): string | undefined {
  const direct = metaJsonBuildTime(
    unzipStdout(["-p", artifactPath, "resources/rawfile/meta.json"]),
  );
  if (direct) return direct;
  const list = unzipStdout(["-Z1", artifactPath]);
  const hapEntry = list
    ?.split("\n")
    .map((s) => s.trim())
    .find((s) => s.endsWith(".hap"));
  if (!hapEntry) return undefined;
  const tmp = path.join(os.tmpdir(), `applift-meta-hap-${process.pid}-${Date.now()}`);
  try {
    // 二进制提取不能带 encoding:"utf8"（会破坏字节流）
    const ex = spawnSync("unzip", ["-p", artifactPath, hapEntry], {
      timeout: 60_000,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (ex.error || ex.status !== 0 || !ex.stdout) return undefined;
    fs.writeFileSync(tmp, ex.stdout);
    return metaJsonBuildTime(unzipStdout(["-p", tmp, "resources/rawfile/meta.json"]));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** APK：AndroidManifest meta-data pushy_build_time（对照官方 CLI getApkInfo 的 meta 读取） */
function apkBuildTime(artifactPath: string): string | undefined {
  for (const tool of aaptTools()) {
    const args = path.basename(tool).startsWith("aapt2")
      ? ["dump", "xmltree", "--file", "AndroidManifest.xml", artifactPath]
      : ["dump", "xmltree", artifactPath, "AndroidManifest.xml"];
    const r = spawnSync(tool, args, { timeout: 10_000, encoding: "utf8" });
    if (r.error || r.status !== 0) continue;
    const m = /pushy_build_time"[\s\S]{0,400}?="(\d+)"/.exec(r.stdout ?? "");
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** iOS：Payload/*.app/pushy_build_time.txt（官方 Xcode 构建 phase 产物） */
function ipaBuildTime(artifactPath: string): string | undefined {
  const text = unzipStdout(["-p", artifactPath, "Payload/*.app/pushy_build_time.txt"]);
  return text?.trim() || undefined;
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

/** aapt 工具探测（ANDROID_HOME/SDK build-tools 下新版优先，aapt2 先于 aapt） */
function aaptTools(): string[] {
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
  return tools;
}

/** APK：aapt2/aapt dump badging（versionCode/versionName） */
function fromAapt(artifactPath: string): ArtifactVersion | undefined {
  const tools = aaptTools();
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

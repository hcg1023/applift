/**
 * 工程文件版本读写（可接管模式：版本事实源永远是工程文件，applift 只代读代写）。
 * 只认标准模板形态（AGP/Xcode/DevEco/pubspec/package.json/tauri.conf）；行级改写、
 * 幂等（字段定位 + 写死目标值，不依赖旧值，跑 N 次 diff 不变——qy-driver sync-app-identity 同款模式）。
 * version catalog 引用形态（libs.versions.xxx.get()）读侧识别并标注 problem，不代写。
 */
import fs from "node:fs";
import path from "node:path";
import type { FrameworkAdapter } from "../framework.js";

export type VersionFileKind =
  | "gradle"
  | "pbxproj"
  | "app-json5"
  | "pubspec"
  | "package-json"
  | "tauri"
  | "expo-app-json";

export interface PlatformVersionInfo {
  platform: string;
  versionName?: string;
  versionCode?: string;
  file: string;
  kind: VersionFileKind;
  /** 非标准形态说明（读出但不代写，提示改造） */
  problem?: string;
}

export interface VersionWrite {
  platform: string;
  versionName: string;
  versionCode: number;
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function firstExisting(...paths: string[]): string | undefined {
  return paths.find((p) => fs.existsSync(p));
}

// ---------- 定位（标准模板布局；RN 的 android/ ios/ harmony/ 子目录优先） ----------

interface Located {
  android?: string; // app/build.gradle(.kts)
  ios?: string; // project.pbxproj
  plist?: string; // Info.plist（字面量兜底）
  harmony?: string; // AppScope/app.json5
  pubspec?: string;
  packageJson?: string;
  tauri?: string;
  expoAppJson?: string;
}

function locateIosProject(dir: string): { pbxproj?: string; plist?: string } {
  // 本层与一层子目录找 *.xcodeproj（跳过隐藏与 Pods/_DERIVEDDATA；原生工程常嵌套两层：
  // newdriver-ios/clouddriver/clouddriver.xcodeproj）
  const find = (d: string): fs.Dirent | undefined => {
    try {
      return fs
        .readdirSync(d, { withFileTypes: true })
        .find(
          (e) =>
            e.isDirectory() &&
            e.name.endsWith(".xcodeproj") &&
            !e.name.startsWith(".") &&
            e.name !== "Pods.xcodeproj",
        );
    } catch {
      return undefined;
    }
  };
  let xcodeproj = find(dir);
  let base = dir;
  if (!xcodeproj) {
    // 一层子目录（跳过隐藏/node_modules/Pods）
    try {
      const subs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith(".") &&
            e.name !== "node_modules" &&
            e.name !== "Pods",
        );
      for (const s of subs) {
        xcodeproj = find(path.join(dir, s.name));
        if (xcodeproj) {
          base = path.join(dir, s.name);
          break;
        }
      }
    } catch {
      // 忽略
    }
  }
  const pbxproj = xcodeproj ? path.join(base, xcodeproj.name, "project.pbxproj") : undefined;
  // Info.plist：<proj>/<Name>/Info.plist（xcodeproj 去后缀同名目录）
  const projDir = xcodeproj?.name.replace(/\.xcodeproj$/, "");
  const plist =
    projDir && fs.existsSync(path.join(base, projDir, "Info.plist"))
      ? path.join(base, projDir, "Info.plist")
      : undefined;
  return { pbxproj: pbxproj && fs.existsSync(pbxproj) ? pbxproj : undefined, plist };
}

function locateVersionFiles(cwd: string, framework: FrameworkAdapter | null): Located {
  const loc: Located = {};
  const id = framework?.id ?? "";
  const tryAll = framework === null; // 未识别框架：按全部标准位置探测（readProjectVersions 兜底承诺）
  if (tryAll || id === "rn" || id === "native-android" || id === "flutter") {
    loc.android = firstExisting(
      path.join(cwd, "android", "app", "build.gradle.kts"),
      path.join(cwd, "android", "app", "build.gradle"),
      path.join(cwd, "app", "build.gradle.kts"),
      path.join(cwd, "app", "build.gradle"),
    );
  }
  if (tryAll || id === "rn" || id === "native-ios" || id === "flutter") {
    const sub = locateIosProject(path.join(cwd, "ios"));
    const root = sub.pbxproj ? sub : locateIosProject(cwd);
    loc.ios = root.pbxproj;
    loc.plist = root.plist;
  }
  if (tryAll || id === "rn" || id === "native-harmony" || id === "flutter") {
    loc.harmony = firstExisting(
      path.join(cwd, "harmony", "AppScope", "app.json5"),
      path.join(cwd, "AppScope", "app.json5"),
    );
  }
  if (tryAll || id === "flutter") {
    loc.pubspec = fs.existsSync(path.join(cwd, "pubspec.yaml"))
      ? path.join(cwd, "pubspec.yaml")
      : undefined;
  }
  if (tryAll || id === "rn" || id === "electron") {
    loc.packageJson = fs.existsSync(path.join(cwd, "package.json"))
      ? path.join(cwd, "package.json")
      : undefined;
  }
  if (tryAll || id === "tauri") {
    loc.tauri = firstExisting(
      path.join(cwd, "src-tauri", "tauri.conf.json"),
      path.join(cwd, "src-tauri", "tauri.conf.json5"),
    );
    loc.packageJson = fs.existsSync(path.join(cwd, "package.json"))
      ? path.join(cwd, "package.json")
      : undefined;
  }
  if (id === "rn") {
    // Expo：app.json 含 "expo" 段（expoAwareLabel 的探测思路）
    const appJson = readText(path.join(cwd, "app.json"));
    if (appJson && /"expo"\s*:/.test(appJson)) loc.expoAppJson = path.join(cwd, "app.json");
  }
  return loc;
}

// ---------- 读（宽容：字面量 / $(VAR) 变量引用 / catalog 引用三形态） ----------

function readGradle(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  const out: Partial<PlatformVersionInfo> = {};
  // 与写侧正则同构：数字组 / 引号组——\S+ 会吞行内分号（versionCode 4000; → "4000;"）导致解析失败
  // (?!Suffix)：versionNameSuffix/versionCodeSuffix 是独立字段，不能误当版本本体（写侧同）
  const codeM = /(versionCode(?!Suffix)\s*=?\s*)(\d+)/.exec(text);
  const nameM = /(versionName(?!Suffix)\s*=?\s*)("[^"]*"|'[^']*'|[\w.+-]+)/.exec(text);
  if (codeM) {
    out.versionCode = codeM[2]!;
  }
  if (nameM) {
    const nameVal = nameM[2]!.replace(/^["']|["']$/g, "");
    if (nameVal.startsWith("libs.versions."))
      out.problem =
        "versionName 走 version catalog 引用（libs.versions.*）：非标准形态，请把版本字段搬回 app/build.gradle(.kts) 字面量";
    else out.versionName = nameVal;
  }
  // catalog 引用形态识别（versionCode = libs.versions.versionCode.get() 的值不在数字组里）
  if (/(versionCode|versionName)\s*=?\s*libs\.versions\./.test(text) && !out.problem) {
    out.problem =
      "版本字段走 version catalog 引用（libs.versions.*）：非标准形态，请把版本字段搬回 app/build.gradle(.kts) 字面量";
  }
  return out;
}

function readPbxproj(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  const names = [...text.matchAll(/MARKETING_VERSION\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
  const name = names[0];
  const code = /CURRENT_PROJECT_VERSION\s*=\s*([^;]+);/.exec(text)?.[1]?.trim();
  // 多 target（app + extension）版本不一致：取第一个（app 通常在前）并标注——写侧全量同步替换
  const problem =
    new Set(names).size > 1
      ? `多 target MARKETING_VERSION 不一致（${[...new Set(names)].join(" / ")}）：读第一个，bump 时将全部同步`
      : undefined;
  return { versionName: name, versionCode: code, problem };
}

function readPlist(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  const name = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  const code = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  // $(VAR) 引用说明事实源在 pbxproj，不作为版本来源
  if (name && !name.startsWith("$")) return { versionName: name, versionCode: code };
  return {};
}

function readAppJson5(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  const name = /"versionName"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const code = /"versionCode"\s*:\s*(\d+)/.exec(text)?.[1];
  return { versionName: name, versionCode: code };
}

function readPubspec(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  // 行尾注释合法形态：version: 1.0.0+1 # released —— 取 # 前的值
  const m = /^version:\s*(\S+)(?:\s*#.*)?$/m.exec(text);
  if (!m) return {};
  const [name, code] = m[1]!.split("+"); // \S 贪婪会吞 +n，先整取再拆
  return { versionName: name, versionCode: code };
}

function readJsonVersionKey(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  // 多处 "version" 键（嵌套依赖声明）时取缩进最浅的（JSON 顶层）；无行锚点的全局首匹配会读错
  let best: { indent: number; value: string } | undefined;
  for (const m of text.matchAll(/^(\s*)"version"\s*:\s*"([^"]+)"\s*,?\s*$/gm)) {
    const indent = m[1]!.length;
    if (!best || indent < best.indent) best = { indent, value: m[2]! };
  }
  if (best) return { versionName: best.value };
  // 单行/压缩 JSON：JSON.parse 取顶层值（嵌套先出现且值不同时不误中）
  try {
    const obj = JSON.parse(text) as { version?: unknown };
    if (typeof obj.version === "string") return { versionName: obj.version };
  } catch {
    // 非 JSON 走首匹配
  }
  const flat = /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return flat ? { versionName: flat } : {};
}

function readExpoAppJson(file: string): Partial<PlatformVersionInfo> {
  const text = readText(file);
  if (!text) return {};
  const name = /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const code =
    /"versionCode"\s*:\s*(\d+)/.exec(text)?.[1] ?? /"buildNumber"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return { versionName: name, versionCode: code };
}

/** 各端版本实况（按框架布局；未识别框架时尝试全部标准位置） */
export function readProjectVersions(
  cwd: string,
  framework: FrameworkAdapter | null,
): PlatformVersionInfo[] {
  const loc = locateVersionFiles(cwd, framework);
  const out: PlatformVersionInfo[] = [];
  if (loc.android)
    out.push({
      platform: "android",
      file: loc.android,
      kind: "gradle",
      ...readGradle(loc.android),
    });
  if (loc.ios) {
    out.push({ platform: "ios", file: loc.ios, kind: "pbxproj", ...readPbxproj(loc.ios) });
  } else if (loc.plist) {
    const plist = readPlist(loc.plist);
    if (plist.versionName) {
      // $(VAR) 引用不作为事实源：读不到字面量就不产出（pbxproj 才是源头）
      out.push({
        platform: "ios",
        file: loc.plist,
        kind: "pbxproj",
        ...plist,
        problem: "未找到 pbxproj，读 Info.plist 字面量",
      });
    }
  }
  if (loc.harmony)
    out.push({
      platform: "harmony",
      file: loc.harmony,
      kind: "app-json5",
      ...readAppJson5(loc.harmony),
    });
  if (loc.pubspec)
    out.push({
      platform: "flutter",
      file: loc.pubspec,
      kind: "pubspec",
      ...readPubspec(loc.pubspec),
    });
  if (loc.packageJson)
    out.push({
      platform: "js",
      file: loc.packageJson,
      kind: "package-json",
      ...readJsonVersionKey(loc.packageJson),
    });
  if (loc.tauri)
    out.push({
      platform: "tauri",
      file: loc.tauri,
      kind: "tauri",
      ...readJsonVersionKey(loc.tauri),
    });
  if (loc.expoAppJson)
    out.push({
      platform: "expo",
      file: loc.expoAppJson,
      kind: "expo-app-json",
      ...readExpoAppJson(loc.expoAppJson),
    });
  return out;
}

// ---------- 写（幂等行级改写；catalog 引用形态拒绝写入） ----------

/** 指定捕获组替换为 value（其余组原样保留；约定各正则组外无字面量） */
function replaceGroup(
  re: RegExp,
  text: string,
  group: number,
  value: string,
): { text: string; count: number } {
  let count = 0;
  const out = text.replace(re, (_m: string, ...groups: unknown[]) => {
    count++;
    const g = groups.slice(0, -2) as string[]; // 末尾两位是 offset 与原字符串
    g[group - 1] = value;
    return g.join("");
  });
  return { text: out, count };
}

function writeIfChanged(file: string, next: string): boolean {
  const cur = readText(file);
  if (cur === next) return false;
  fs.writeFileSync(file, next, "utf8");
  return true;
}

function writeGradle(file: string, w: VersionWrite): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  if (/version(Code|Name)\s*=?\s*libs\.versions\./.test(text)) {
    throw new Error(
      `${file} 的版本字段是 version catalog 引用形态：请先改造为字面量（applift 只写标准形态）`,
    );
  }
  let next = text;
  const code = replaceGroup(
    /(versionCode(?!Suffix)\s*=?\s*)(\d+)/g,
    next,
    2,
    String(w.versionCode),
  );
  next = code.text;
  const name = replaceGroup(
    /(versionName(?!Suffix)\s*=?\s*)("[^"]*"|'[^']*'|[\w.+-]+)/g,
    next,
    2,
    `"${w.versionName}"`,
  );
  next = name.text;
  if (code.count === 0 && name.count === 0)
    throw new Error(`${file} 未找到 versionCode/versionName 字面量`);
  return writeIfChanged(file, next);
}

function writePbxproj(file: string, w: VersionWrite): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  let next = text;
  const name = replaceGroup(/(MARKETING_VERSION\s*=\s*)([^;]+)(;)/g, next, 2, w.versionName);
  next = name.text;
  const code = replaceGroup(
    /(CURRENT_PROJECT_VERSION\s*=\s*)([^;]+)(;)/g,
    next,
    2,
    String(w.versionCode),
  );
  next = code.text;
  if (name.count === 0 && code.count === 0)
    throw new Error(`${file} 未找到 MARKETING_VERSION/CURRENT_PROJECT_VERSION`);
  return writeIfChanged(file, next);
}

function writeAppJson5(file: string, w: VersionWrite): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  let next = text;
  const name = replaceGroup(/("versionName"\s*:\s*")([^"]+)(")/g, next, 2, w.versionName);
  next = name.text;
  const code = replaceGroup(/("versionCode"\s*:\s*)(\d+)/g, next, 2, String(w.versionCode));
  next = code.text;
  if (name.count === 0 && code.count === 0)
    throw new Error(`${file} 未找到 versionName/versionCode`);
  return writeIfChanged(file, next);
}

function writePubspec(file: string, w: VersionWrite): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  if (!/^version:\s*\S+/m.test(text)) throw new Error(`${file} 未找到 version: 行`);
  // 保留行尾注释：只替换到 # 前
  const next = text.replace(
    /^version:[^\n#]*?(\s*)(#.*)?$/m,
    (_m, gap: string | undefined, comment: string | undefined) =>
      `version: ${w.versionName}+${w.versionCode}${comment ? (gap ?? " ") : ""}${comment ?? ""}`,
  );
  return writeIfChanged(file, next); // 已是目标值 → false（幂等，不与"行不存在"混淆）
}

/** JSON 顶层 version 键改写（两遍：先定位最小缩进行，再只改该行——单遍回调在嵌套键
 *  先出现时会把它一并改写，篡改依赖声明）。单行 JSON 回退首个匹配。 */
function writeJsonVersionKey(file: string, versionName: string): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  const lines = text.split("\n");
  const re = /^(\s*)"version"\s*:\s*"([^"]+)"(\s*,?\s*)$/;
  let target = -1;
  let bestIndent = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const ind = m[1]!.length;
    if (ind < bestIndent) {
      bestIndent = ind;
      target = i;
    }
  }
  let next: string;
  if (target >= 0) {
    const m = re.exec(lines[target]!)!;
    lines[target] = `${m[1]}"version": "${versionName}"${m[3]}`;
    next = lines.join("\n");
  } else {
    // 单行/压缩 JSON：JSON.parse 取顶层值，按值定位改写（嵌套先出现且值不同时不误改）
    let topVersion: string | undefined;
    try {
      const obj = JSON.parse(text) as { version?: unknown };
      if (typeof obj.version === "string") topVersion = obj.version;
    } catch {
      // 非 JSON 走首匹配
    }
    const esc = (topVersion ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = topVersion ? new RegExp(`"version"\\s*:\\s*"${esc}"`) : /"version"\s*:\s*"([^"]+)"/;
    if (!re1.test(text)) throw new Error(`${file} 未找到 "version" 键`);
    next = text.replace(re1, `"version": "${versionName}"`);
  }
  return writeIfChanged(file, next);
}

function writeExpoAppJson(file: string, w: VersionWrite): boolean {
  const text = readText(file);
  if (!text) throw new Error(`无法读取 ${file}`);
  const v = replaceGroup(/("version"\s*:\s*")([^"]+)(")/g, text, 2, w.versionName);
  if (v.count === 0) throw new Error(`${file} 未找到 expo "version" 键`);
  let next = v.text;
  // android.versionCode（数字）与 ios.buildNumber（字符串）
  next = replaceGroup(/("versionCode"\s*:\s*)(\d+)/g, next, 2, String(w.versionCode)).text;
  next = replaceGroup(/("buildNumber"\s*:\s*")([^"]+)(")/g, next, 2, String(w.versionCode)).text;
  return writeIfChanged(file, next);
}

/**
 * 写回各端版本（多端 versionName 同步、versionCode 各端独立）。
 * 返回实际改动的文件列表（commit 范围）。problem 端跳过并在返回中列出（不阻断其他端）。
 */
export function writeProjectVersions(
  cwd: string,
  framework: FrameworkAdapter | null,
  writes: VersionWrite[],
): { changed: string[]; skipped: Array<{ platform: string; reason: string }> } {
  const loc = locateVersionFiles(cwd, framework);
  const changed: string[] = [];
  const skipped: Array<{ platform: string; reason: string }> = [];
  const plat = new Map(writes.map((w) => [w.platform, w]));

  const apply = (file: string | undefined, fn: (f: string) => boolean, key: string) => {
    if (!file) {
      const w = plat.get(key as string);
      if (w) skipped.push({ platform: w.platform, reason: `未找到版本文件（${key}）` });
      return;
    }
    try {
      if (fn(file)) changed.push(file); // 值未变不列入（写放大防护）
    } catch (e) {
      // 环境类错误（权限/只读）与形态问题不同：修复后重跑即愈，直接抛出阻断，不降级 skipped
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw e;
      skipped.push({ platform: key, reason: (e as Error).message });
    }
  };

  if (plat.has("android"))
    apply(loc.android, (f) => writeGradle(f, plat.get("android")!), "android");
  if (plat.has("ios")) apply(loc.ios, (f) => writePbxproj(f, plat.get("ios")!), "ios");
  if (plat.has("harmony"))
    apply(loc.harmony, (f) => writeAppJson5(f, plat.get("harmony")!), "harmony");
  if (plat.has("flutter"))
    apply(loc.pubspec, (f) => writePubspec(f, plat.get("flutter")!), "flutter");
  // js/tauri/expo 不短路：文件缺失（apply 报"未找到版本文件"）或无 version 键（writer 抛）
  // 都必须进 skipped —— 静默双空会让版本同步丢端而无感知
  if (plat.has("js"))
    apply(loc.packageJson, (f) => writeJsonVersionKey(f, plat.get("js")!.versionName), "js");
  if (plat.has("tauri"))
    apply(loc.tauri, (f) => writeJsonVersionKey(f, plat.get("tauri")!.versionName), "tauri");
  if (plat.has("expo"))
    apply(loc.expoAppJson, (f) => writeExpoAppJson(f, plat.get("expo")!), "expo");

  return { changed: [...new Set(changed)], skipped };
}

import { AppliftRunner, findGlobalApplift, findProjectApplift } from "./runner.js";

/** 已检出来源的形态（spec §2：工程内 / 全局各列一行，版本单独探测） */
export interface AppliftSource {
  kind: "project" | "global";
  path: string;
  version: string | null;
}

/** GET /api/applift/availability 响应体 */
export interface Availability {
  nodeVersion: string;
  nodeOk: boolean;
  sources: AppliftSource[];
  latest: string | null;
}

/** `--version` 探测超时：本地 bin，10s 足够（挂载卷/杀毒扫描慢盘留余量） */
const VERSION_TIMEOUT_MS = 10_000;
/** `npm view` 超时：网络调用，失败置 null（离线/registry 不通不该阻塞 availability） */
const NPM_VIEW_TIMEOUT_MS = 10_000;
/** 版本探测缓存：同一 bin 60s 内不重复 spawn */
const VERSION_CACHE_MS = 60_000;
/** Node 最低版本（spec §2：≥20） */
const NODE_MIN_MAJOR = 20;

function nodeMajor(version: string): number {
  const m = /v(\d+)\./.exec(version);
  return m !== null ? Number(m[1]) : 0;
}

async function probeVersionDefault(bin: string[]): Promise<string | null> {
  const { code, stdout } = await new AppliftRunner({ bin }).run(["--version"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (code !== 0) return null;
  const v = stdout.trim();
  return v === "" ? null : v;
}

async function fetchLatestDefault(npmBin: string | string[] = "npm"): Promise<string | null> {
  const runner = new AppliftRunner({ bin: npmBin });
  const { code, stdout } = await runner.run(["view", "@applift/cli", "version"], {
    timeoutMs: NPM_VIEW_TIMEOUT_MS,
  });
  if (code !== 0) return null;
  const v = stdout.trim();
  return v === "" ? null : v;
}

export interface AvailabilityProberOptions {
  /** 测试注入：版本探测桩（缓存仍生效） */
  probeVersion?: (bin: string[]) => Promise<string | null>;
  /** 测试注入：npm view 桩（默认真跑 npm，10s 超时置 null） */
  fetchLatest?: () => Promise<string | null>;
  /** npm 命令形态（e2e 注入桩脚本；默认 PATH 上的 npm） */
  npmBin?: string | string[];
  /** 版本缓存时长（默认 60s；测试可缩短） */
  versionCacheMs?: number;
  /** 测试注入：PATH 覆盖（不污染全局 process.env）；缺省用真实 PATH */
  pathEnv?: string;
}
export function createAvailabilityProber(opts: AvailabilityProberOptions = {}): {
  get(cwd?: string): Promise<Availability>;
  invalidate(): void;
} {
  const probeVersion = opts.probeVersion ?? probeVersionDefault;
  const fetchLatest = opts.fetchLatest ?? (() => fetchLatestDefault(opts.npmBin));
  const cacheMs = opts.versionCacheMs ?? VERSION_CACHE_MS;
  const cache = new Map<string, { at: number; version: string | null }>();

  const cachedVersion = async (bin: string[]): Promise<string | null> => {
    const key = bin.join(" ");
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < cacheMs) return hit.version;
    const version = await probeVersion(bin);
    cache.set(key, { at: Date.now(), version });
    return version;
  };

  return {
    async get(cwd?: string): Promise<Availability> {
      const found: Array<{ kind: "project" | "global"; path: string; bin: string[] }> = [];
      if (cwd !== undefined) {
        const project = findProjectApplift(cwd);
        if (project !== null) found.push({ kind: "project", path: project, bin: [project] });
      }
      const global = findGlobalApplift(opts.pathEnv);
      if (global !== null) found.push({ kind: "global", path: global, bin: [global] });
      // 各源版本探测与 npm view 全并行（互不阻塞；任一失败不拖垮整体，latest null = 离线降级）
      const [latest, ...versions] = await Promise.all([
        fetchLatest().catch(() => null),
        ...found.map((f) => cachedVersion(f.bin).catch(() => null)),
      ]);
      return {
        nodeVersion: process.version,
        nodeOk: nodeMajor(process.version) >= NODE_MIN_MAJOR,
        sources: found.map((f, i) => ({
          kind: f.kind,
          path: f.path,
          version: versions[i] ?? null,
        })),
        latest,
      };
    },
    /** 失效版本缓存（安装/更新任务结束后调用，立即重探测拿新版本） */
    invalidate(): void {
      cache.clear();
    },
  };
}

/**
 * 惰性文件 Blob：FormData multipart 上传的文件部件。
 * 优先 fs.openAsBlob（Node ≥19.8，按需分片读，零整读内存）；
 * 能力检测不存在时回退整读（旧运行时兜底）。
 */
import fs from "node:fs";

export async function fileBlob(p: string): Promise<Blob> {
  if (typeof fs.openAsBlob === "function") {
    try {
      return await fs.openAsBlob(p);
    } catch (e) {
      // openAsBlob 的原生报错（ERR_INVALID_ARG_VALUE）不含路径，重抛补上——缺文件时可定位
      const cause = e instanceof Error ? e.message : String(e);
      throw new Error(`打开上传文件失败 ${p}: ${cause}`);
    }
  }
  return new Blob([await fs.promises.readFile(p)]);
}

/**
 * 惰性文件 Blob：FormData multipart 上传的文件部件。
 * 优先 fs.openAsBlob（Node ≥19.8，按需分片读，零整读内存）；
 * 能力检测不存在时回退整读（旧运行时兜底）。
 */
import fs from "node:fs";

export async function fileBlob(p: string): Promise<Blob> {
  if (typeof fs.openAsBlob === "function") return fs.openAsBlob(p);
  return new Blob([await fs.promises.readFile(p)]);
}

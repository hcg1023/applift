/** core 内部共用小工具（不进公共 API） */
import { createHash } from "node:crypto";
import fs from "node:fs";

export const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** 分块计算文件 SHA256（产物可达上百 MB，8MB 分块避免整读内存，同 sign.ts md5File 先例） */
export function sha256File(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  const hash = createHash("sha256");
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

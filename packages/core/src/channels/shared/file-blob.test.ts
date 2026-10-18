/**
 * fileBlob 契约：默认走 openAsBlob 惰性 Blob；旧运行时（无 openAsBlob）回退整读。
 * 两条路径都必须产出与文件字节一致的 Blob（multipart 文件部件的正确性底线）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileBlob } from "./file-blob.js";

function tmpFile(name: string, bytes: Buffer): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "applift-fb-")), name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe("fileBlob", () => {
  it("默认路径（Node ≥20.1 openAsBlob）：Blob.size=文件字节数，内容逐字节一致", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const blob = await fileBlob(tmpFile("a.bin", bytes));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(bytes.length);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  });

  it("openAsBlob 不可用（旧运行时）→ 回退整读，内容一致", async () => {
    const bytes = Buffer.from("hello-fileblob");
    const p = tmpFile("b.bin", bytes);
    const original = fs.openAsBlob;
    try {
      // 运行时摘除 openAsBlob（typeof 检测走回退臂）；Reflect.set 免去内联转型
      Reflect.set(fs, "openAsBlob", undefined);
      const blob = await fileBlob(p);
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
    } finally {
      Reflect.set(fs, "openAsBlob", original);
    }
  });
});

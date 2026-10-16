import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSize, sha256File, sleep } from "./util.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("到点才 resolve（fake timers 驱动）", async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    await p;
  });
});

describe("sha256File", () => {
  it("文本内容与已知向量及 node 实现一致", () => {
    const p = path.join(os.tmpdir(), "applift-test-sha256.txt");
    fs.writeFileSync(p, "hello");
    try {
      expect(sha256File(p)).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
      expect(sha256File(p)).toBe(createHash("sha256").update("hello").digest("hex"));
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("二进制内容与 node 实现一致", () => {
    const p = path.join(os.tmpdir(), "applift-test-sha256.bin");
    const content = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
    fs.writeFileSync(p, content);
    try {
      expect(sha256File(p)).toBe(createHash("sha256").update(content).digest("hex"));
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("9MB+7B（跨 8MB 分块边界）与整读一致", () => {
    const p = path.join(os.tmpdir(), "applift-test-sha256-big.bin");
    fs.writeFileSync(p, Buffer.alloc(9 * 1024 * 1024 + 7, 1));
    try {
      const whole = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      expect(sha256File(p)).toBe(whole);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("formatSize 各档位", () => {
  it("字节档（含 0 与恰好 1KB 边界，不进位）", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1024)).toBe("1024 B"); // 恰好 1KB 不进位（> 为严格比较）
  });

  it("KB 档（toFixed(0)，恰好 1MB 边界留在 KB）", () => {
    expect(formatSize(1025)).toBe("1 KB");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1024 * 1024)).toBe("1024 KB");
  });

  it("MB 档（toFixed(1)，恰好 1GB 边界留在 MB）", () => {
    expect(formatSize(1024 * 1024 + 1)).toBe("1.0 MB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(1024 ** 3)).toBe("1024.0 MB");
  });

  it("GB 档（toFixed(2)）", () => {
    expect(formatSize(1024 ** 3 + 1)).toBe("1.00 GB");
    expect(formatSize(2.5 * 1024 ** 3)).toBe("2.50 GB");
  });
});

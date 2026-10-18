/**
 * init 凭据组一致性（静态对拍）：
 * - CREDENTIAL_GROUPS 每组每个键都在 CREDENTIAL_FIELDS 有条目（向导能给出 label/where 指引，find 不会落空）
 * - huawei 组 ⊇ 渠道元数据 REQUIRED_KEYS_BY_CHANNEL 的 huawei+agc 键（安卓 HW_* 与鸿蒙 AGC_* 一组配齐）
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_FIELDS, CREDENTIAL_GROUPS } from "./lifecycle.js";
import { REQUIRED_KEYS_BY_CHANNEL } from "./channel-meta.js";

describe("init 凭据组一致性", () => {
  it("每组每个键都存在于 CREDENTIAL_FIELDS", () => {
    for (const [group, keys] of Object.entries(CREDENTIAL_GROUPS)) {
      for (const key of keys) {
        expect(
          CREDENTIAL_FIELDS.some((f) => f.key === key),
          `${group} 组的 ${key} 缺少 CREDENTIAL_FIELDS 条目`,
        ).toBe(true);
      }
    }
  });

  it("huawei 组 ⊇ REQUIRED_KEYS_BY_CHANNEL 的 huawei+agc 键", () => {
    const need = [
      ...(REQUIRED_KEYS_BY_CHANNEL.huawei ?? []),
      ...(REQUIRED_KEYS_BY_CHANNEL.agc ?? []),
    ];
    for (const key of need) {
      expect(CREDENTIAL_GROUPS.huawei, `huawei 组缺 ${key}`).toContain(key);
    }
  });
});

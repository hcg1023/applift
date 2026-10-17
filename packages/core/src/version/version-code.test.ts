/**
 * versionCode 契约测试：公式白名单求值（无 eval）与 max(公式, 现值+1) 单调策略。
 * 关键行为：吞任意历史值（3052/4000000）首次 bump 归一；公式追平时 +1 兜底。
 */
import { describe, expect, it } from "vitest";
import { evalVersionCodeFormula, nextVersionCode } from "./version-code.js";

describe("evalVersionCodeFormula", () => {
  it("四则与优先级：major*10000+minor*100+patch", () => {
    expect(
      evalVersionCodeFormula("major*10000+minor*100+patch", { major: 4, minor: 1, patch: 2 }),
    ).toBe(40102);
    expect(
      evalVersionCodeFormula("major*1000000+minor*1000+patch", { major: 4, minor: 0, patch: 0 }),
    ).toBe(4000000);
  });

  it("括号与乘法结合", () => {
    expect(evalVersionCodeFormula("(major+minor)*10", { major: 4, minor: 1, patch: 0 })).toBe(50);
    expect(evalVersionCodeFormula("major * 1000 + patch", { major: 4, minor: 0, patch: 9 })).toBe(
      4009,
    );
  });

  it("非法输入整式拒绝（不 eval、无副作用）", () => {
    expect(
      evalVersionCodeFormula("process.exit(1)", { major: 1, minor: 0, patch: 0 }),
    ).toBeUndefined();
    expect(evalVersionCodeFormula("major/patch", { major: 1, minor: 0, patch: 2 })).toBeUndefined();
    expect(evalVersionCodeFormula("", { major: 1, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("major**2", { major: 2, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("major;42", { major: 1, minor: 0, patch: 0 })).toBeUndefined();
  });

  it("非正整数结果拒绝", () => {
    expect(evalVersionCodeFormula("major-minor-patch", { major: 1, minor: 0, patch: 0 })).toBe(1);
    expect(
      evalVersionCodeFormula("major-minor-patch", { major: 0, minor: 1, patch: 0 }),
    ).toBeUndefined();
  });

  it("残缺表达式（未闭合括号/悬空运算符）拒绝", () => {
    expect(evalVersionCodeFormula("(major+1", { major: 4, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("major+", { major: 4, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("()", { major: 4, minor: 0, patch: 0 })).toBeUndefined();
  });
});

describe("nextVersionCode", () => {
  it("公式大于现值+1：走公式（4.0.0→4.1.0 公式重新接管）", () => {
    expect(nextVersionCode(4000004, 4010000)).toBe(4010000);
  });

  it("公式追平或更小：+1 兜底（同 versionName 重发不撞墙）", () => {
    expect(nextVersionCode(4000003, 4000000)).toBe(4000004);
    expect(nextVersionCode(4000003, undefined)).toBe(4000004);
  });

  it("吞任意历史脏值（旧安卓去点编码 3052）", () => {
    expect(nextVersionCode(3052, undefined)).toBe(3053);
  });
});

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FrameworkAdapter } from "../framework.js";
import {
  electronFramework,
  flutterFramework,
  nativeAndroidFramework,
  nativeHarmonyFramework,
  nativeIosFramework,
  rnAdapter,
  rnFramework,
  suggestFramework,
  tauriFramework,
} from "./frameworks.js";

function collect(factory: () => { "framework:register"?: unknown }): FrameworkAdapter[] {
  const registered: FrameworkAdapter[] = [];
  const plugin = factory() as unknown as {
    "framework:register"?: (a: FrameworkAdapter[], c: { cwd: string }) => void;
  };
  plugin["framework:register"]!(registered, { cwd: "/tmp" });
  return registered;
}

function tmpProject(setup: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-fwp-"));
  setup(dir);
  return dir;
}

describe("framework 插件工厂", () => {
  it("七个工厂各注册一个对应 id 的 adapter", () => {
    expect(collect(() => rnFramework()).map((a) => a.id)).toEqual(["rn"]);
    expect(collect(() => flutterFramework()).map((a) => a.id)).toEqual(["flutter"]);
    expect(collect(() => nativeAndroidFramework()).map((a) => a.id)).toEqual(["native-android"]);
    expect(collect(() => nativeIosFramework()).map((a) => a.id)).toEqual(["native-ios"]);
    expect(collect(() => nativeHarmonyFramework()).map((a) => a.id)).toEqual(["native-harmony"]);
    expect(collect(() => electronFramework()).map((a) => a.id)).toEqual(["electron"]);
    expect(collect(() => tauriFramework()).map((a) => a.id)).toEqual(["tauri"]);
  });

  it("rnFramework 的 adapter 能识别 RN 工程（detect 校验）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
      );
    });
    const [adapter] = collect(() => rnFramework());
    expect(adapter!.detect(dir)).toBe(true);
  });
});

describe("suggestFramework（init/doctor 的探测建议，非发布依据）", () => {
  it("RN 工程建议 rn", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
      );
    });
    expect(suggestFramework(dir)?.id).toBe("rn");
  });

  it("未知目录返回 null", () => {
    expect(suggestFramework(os.tmpdir())).toBeNull();
  });

  it("expoAwareLabel：依赖 expo → Expo (React Native)，无 expo → React Native", () => {
    const expoDir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0", expo: "~54.0.0" } }),
      );
    });
    const plainDir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
      );
    });
    expect(rnAdapter.expoAwareLabel?.(expoDir)).toBe("Expo (React Native)");
    expect(rnAdapter.expoAwareLabel?.(plainDir)).toBe("React Native");
  });
});

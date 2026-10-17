/**
 * version 域统一出口：工程文件版本读写（project）+ bump 编排（bump）+
 * git 推断（infer）+ versionCode 策略（version-code）+ CHANGELOG（changelog）+
 * 产物版本读取（artifact）。
 */
export * from "./project.js";
export * from "./bump.js";
export * from "./infer.js";
export * from "./version-code.js";
export * from "./changelog.js";
export * from "./git.js";
export * from "./artifact.js";

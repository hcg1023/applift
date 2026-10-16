/** 华为 AGC token（安卓/鸿蒙同源）——自 v1 lib/agc.mjs 迁移 */
export async function getAgcToken({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const res = await fetch("https://connect-api.cloud.huawei.com/api/oauth2/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    ret?: { code?: number; msg?: string };
  };
  // 华为成功响应只带 access_token（无 ret 字段），错误时才是 error…/ret…——成功判定唯一标准是有 token
  if (!json.access_token) {
    const desc =
      json.error_description ?? json.ret?.msg ?? json.error ?? JSON.stringify(json).slice(0, 200);
    throw new Error(`AGC 获取 token 失败: ${desc}（检查 client_id/client_secret）`);
  }
  return json.access_token;
}

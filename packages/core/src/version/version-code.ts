/**
 * versionCode 计算：默认递增 +1；可配公式（如 major*1000000+minor*1000+patch）。
 * 实际写入 = max(公式值, 现值+1)——公式在同 versionName 重发时算出同值，
 * +1 兜底保证单调（AGC 同版本不能重复提交 / Google Play 单调 / App Store 单调）。
 */

/** 公式白名单求值（仅支持 + - * ( ) 数字 与 major/minor/patch 变量；不 eval） */
export function evalVersionCodeFormula(
  formula: string,
  v: { major: number; minor: number; patch: number },
): number | undefined {
  // 词法：变量与数字归一为数值 token，运算符/括号原样
  const tokens: Array<{ n: number } | { op: string }> = [];
  let i = 0;
  const src = formula.replace(/\s+/g, "");
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "+" || c === "-" || c === "*" || c === "(" || c === ")") {
      tokens.push({ op: c });
      i++;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < src.length && /\d/.test(src.charAt(j))) j++;
      tokens.push({ n: Number(src.slice(i, j)) });
      i = j;
    } else {
      const word = /^(major|minor|patch)/.exec(src.slice(i));
      if (!word) return undefined; // 非法字符：整式拒绝
      const name = word[1] as "major" | "minor" | "patch";
      tokens.push({ n: v[name] });
      i += name.length;
    }
  }
  if (tokens.length === 0) return undefined;

  // 递归下降：expr = term (('+'|'-') term)* ; term = factor ('*' factor)* ; factor = 数 | '(' expr ')'
  let pos = 0;
  const peek = () => tokens[pos];
  function factor(): number | undefined {
    const t = peek();
    if (!t) return undefined;
    if ("n" in t) {
      pos++;
      return t.n;
    }
    if (t.op === "(") {
      pos++;
      const inner = expr();
      const close = peek();
      if (inner === undefined || !close || !("op" in close) || close.op !== ")") return undefined;
      pos++;
      return inner;
    }
    if (t.op === "-") {
      pos++;
      const f = factor();
      return f === undefined ? undefined : -f;
    }
    return undefined;
  }
  function term(): number | undefined {
    let left = factor();
    for (;;) {
      const t = peek();
      if (left === undefined || !t || !("op" in t) || t.op !== "*") return left;
      pos++;
      const right = factor();
      if (right === undefined) return undefined;
      left = left * right;
    }
  }
  function expr(): number | undefined {
    let left = term();
    for (;;) {
      const t = peek();
      if (left === undefined || !t || !("op" in t) || (t.op !== "+" && t.op !== "-")) return left;
      pos++;
      const right = term();
      if (right === undefined) return undefined;
      left = t.op === "+" ? left + right : left - right;
    }
  }
  const result = expr();
  if (result === undefined || pos !== tokens.length) return undefined;
  return Number.isFinite(result) && Number.isInteger(result) && result > 0 ? result : undefined;
}

/**
 * 下一 versionCode：max(公式值, 现值+1)。
 * - 无现值（首接工程无该字段）：公式值，否则 1
 * - 有现值：至少现值+1（吞 3052/4000000 等任意历史值，首次 bump 即归一）
 */
export function nextVersionCode(
  current: number | undefined,
  formulaValue: number | undefined,
): number {
  if (current === undefined) return formulaValue ?? 1;
  return Math.max(formulaValue ?? Number.NEGATIVE_INFINITY, current + 1);
}

import { countTokens } from "../snap/cli/src/tokens.ts";
const cases: Array<[string, string]> = [
  ["english prose (200 words)", "The quick brown fox jumps over the lazy dog. ".repeat(22)],
  ["CJK 7-char runs x 50", "这是一个测试句。".repeat(50)],
  ["CJK one 400-char run", "测".repeat(400)],
  ["digits 1000", "1234567890".repeat(100)],
  ["minified JSON", JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: i, k: "v" + i, ok: true })))],
  ["base64 4KB", Buffer.alloc(3072, 7).toString("base64")],
  ["whitespace-indented code", "    if (x) {\n        return y;\n    }\n".repeat(50)],
  ["emoji 100", "😀".repeat(100)],
];
for (const [n, s] of cases) console.log(n.padEnd(28), "chars", String(s.length).padStart(5), "est", String(countTokens(s)).padStart(5), "chars/est", (s.length / countTokens(s)).toFixed(2));

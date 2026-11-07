import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { redactDiagnosticForOutput } from "../src/core/persistence_protection.js";

/**
 * Secret shapes whose body contains "/" and "+" (base64, not base64url). The body is what must never survive:
 * a redactor that stops at the first "/" or "+" leaves a recognisable tail behind.
 */
const SHAPES: Array<{ name: string; prefix: string; body: string }> = [
  { name: "anthropic key", prefix: "sk-ant-api03-", body: "Qx7Km2+Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt/Bq" },
  { name: "openai key", prefix: "sk-", body: "proj7Ka+Mb3Qx/Zt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo+Sa/Tk" },
  { name: "openai key, slash first", prefix: "sk-", body: "/Zt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo+Sa/Tk7Ka+Mb3Qx" },
  { name: "aws secret access key", prefix: "", body: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEYq9" },
  { name: "base64 token with padding", prefix: "", body: "Tq8Zc3+Lm5Xv/Rb2Nk7Hd1Yw4Js6Pg9Fe0Ua+Oi8Sx2Q==" },
  { name: "bearer-style token", prefix: "", body: "Hn4Vb7+Cx2Zl/Km9Qw3Rt6Yu1Ip8Oa5Sd0Fg+Jk2Lz/Mq" },
];

/** Where a secret can appear in diagnostic text. */
const TEMPLATES: Array<{ name: string; render: (secret: string) => string }> = [
  { name: "free text", render: (s) => `request failed with key ${s} while connecting` },
  { name: "end of sentence", render: (s) => `the credential was ${s}.` },
  { name: "key=value", render: (s) => `token=${s} retry=1` },
  { name: "api_key assignment", render: (s) => `API_KEY=${s}` },
  { name: "json field", render: (s) => `{"api_key":"${s}","ok":false}` },
  { name: "quoted", render: (s) => `header 'x-key: ${s}' rejected` },
  { name: "bearer header", render: (s) => `Authorization: Bearer ${s}` },
  { name: "url query", render: (s) => `GET https://llm.example/v1/models?key=${s}&x=1 failed` },
  { name: "parenthesised", render: (s) => `rejected (${s}) by gateway` },
  { name: "backticks", render: (s) => `set \`${s}\` in the env` },
  { name: "colon and comma", render: (s) => `key: ${s}, region: us-east-1` },
  { name: "angle brackets", render: (s) => `<${s}> was sent` },
  { name: "trailing semicolon", render: (s) => `export KEY="${s}"; run` },
  { name: "exclamation", render: (s) => `leaked ${s}!` },
  { name: "multiline",render: (s) => `error:\n  key ${s}\n  retry later` },
];

/** A distinctive 6-character window of the body that survives into the output means a tail was left. */
function leftoverWindow(output: string, body: string): string | undefined {
  for (let i = 0; i + 6 <= body.length; i++) {
    const window = body.slice(i, i + 6);
    if (output.includes(window)) return window;
  }
  return undefined;
}

test("secrets containing / and + are redacted whole in every shape and template", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  const failures: string[] = [];
  try {
    for (const shape of SHAPES) {
      const secret = `${shape.prefix}${shape.body}`;
      for (const template of TEMPLATES) {
        const output = redactDiagnosticForOutput(template.render(secret));
        const tail = leftoverWindow(output, shape.body);
        if (tail) failures.push(`${shape.name} in ${template.name}: left "${tail}" in ${JSON.stringify(output)}`);
      }
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${SHAPES.length * TEMPLATES.length} combinations left part of the secret:\n${failures.join("\n")}`);
});

test("ordinary text around a redacted secret is untouched", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    const output = redactDiagnosticForOutput("GET /v1/models/gpt-4o failed in src/a+b/file.ts: see https://llm.example/v1/models");
    assert.equal(output, "GET /v1/models/gpt-4o failed in src/a+b/file.ts: see https://llm.example/v1/models");
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

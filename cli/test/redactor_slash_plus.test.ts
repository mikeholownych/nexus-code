import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { assertNoSensitivePersistenceContent, redactDiagnosticForOutput } from "../src/core/persistence_protection.js";

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
    for (const text of [
      "GET /v1/models/gpt-4o failed in src/a+b/file.ts: see https://llm.example/v1/models",
      // A path after the word "Bearer" is not a token.
      "Bearer /api/v1/organizations/x returned 404; retry Bearer api/v1/organizations/default/members later",
    ]) {
      assert.equal(redactDiagnosticForOutput(text), text);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** Crafted tool output must not freeze the (synchronous) redactor: every pattern is linear in the input. */
test("pathological 800 KB inputs are redacted in linear time", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  const size = 800_000;
  const inputs: Array<[string, string]> = [
    ["sk- repeated", "sk-".repeat(Math.ceil(size / 3))],
    ["sk-ant- repeated", "sk-ant-".repeat(Math.ceil(size / 7))],
    ["sk- with slashes", "sk-a/".repeat(Math.ceil(size / 5))],
    ["sk- with slashes and capitals", "sk-A1/".repeat(Math.ceil(size / 6))],
    ["Bearer repeated", "Bearer ".repeat(Math.ceil(size / 7))],
    ["Bearer then spaces", `Bearer ${" ".repeat(size)}`],
    ["token soup", "A1/+".repeat(Math.ceil(size / 4))],
    ["delimiter soup", "a<`|&?".repeat(Math.ceil(size / 6))],
    ["one huge sk- run", `sk-${"aB3".repeat(Math.ceil(size / 3))}`],
    // A checkpointed file is scanned whole; `/[.!]+$/` on this was quadratic.
    ["trailing punctuation run", `${".".repeat(size)}x`],
    ["exclamation run", `${"!".repeat(size)}x`],
    // Many short `sk-` runs with no "/": a backward search for a path separator must not reach into earlier text.
    ["short sk- runs", "sk-a ".repeat(Math.ceil(size / 5))],
    ["sk- with escaped slashes", "sk-A1\\/".repeat(Math.ceil(size / 6))],
    ["Bearer then escaped slashes", `Bearer A1a${"\\/".repeat(Math.ceil(size / 2))}`],
  ];
  try {
    for (const [name, input] of inputs) {
      const started = performance.now();
      redactDiagnosticForOutput(input);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 2000, `${name}: ${Math.round(elapsed)} ms for ${input.length} chars`);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("identifier-, type- and path-shaped text is not mistaken for a high-entropy secret", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const text of [
      "returns Promise<UpgradeExecutionResult> when done",
      "see `docs/reviews/evidence/v1/PLAN-04_SESSION_POWER_RECOVERY` for details",
      "merge into downstream/branch-specific. Then continue",
      "call `executeOperationFromCheckpoint` before `restoreWorkspaceState`",
      "Map<SessionIdentifier, WorkspaceTrustDecision> is cached",
      "wrote `/tmp/nexus-collab3r-C72e2R` and `/home/mike/nexus-wt/gov-8cf3e82` for the run",
    ]) {
      assert.equal(redactDiagnosticForOutput(text), text);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

test("a key directly followed by / or - is redacted whole, with no tail", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    const key = "sk-ant-api03-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
    for (const suffix of ["/models", "/v1/x", "-suffix", "-", "/", "=", "+extra", ".", ",", ")"]) {
      const output = redactDiagnosticForOutput(`calling ${key}${suffix} now`);
      assert.ok(!output.includes("Qx7Km2"), `${JSON.stringify(suffix)}: ${output}`);
      assert.ok(!output.includes("RtBq"), `${JSON.stringify(suffix)}: ${output}`);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/**
 * Two classifiers can match the same credential at the same place, one taking more of it than the other. The longest
 * match wins and the shorter one is dropped: replacing the shorter one first would leave the rest of the credential in
 * the text, and a second entry for the same credential is a second vault mapping.
 */
test("a credential matched at the same place by two classifiers is classified once, as the longest match", () => {
  const boundary = new InformationFlowBoundary();
  // The Bearer pattern stops at "~"; the Authorization pattern takes the whole token68 value.
  const token = "AbCd/EfGhIjKlMnOp~QrStUvWxYz0123456789";
  const header = boundary.classifyText(`Authorization: Bearer ${token} rejected`, []);
  assert.deepEqual(header.map((s) => s.secret), [token]);
  // The Bearer capture keeps the sentence's full stop; the entropy tokenizer trims it.
  const sentence = boundary.classifyText("Connecting to provider with Bearer bAGOhOwLeY7Mabcdef123456789.\n", []);
  assert.equal(sentence.length, 1, JSON.stringify(sentence));
  assert.ok(sentence[0].secret.startsWith("bAGOhOwLeY7Mabcdef123456789"));
  // The same two matches, in redaction: nothing of the token survives.
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    const output = redactDiagnosticForOutput(`Authorization: Bearer ${token} rejected`);
    assert.ok(!output.includes("QrStUvWxYz") && !output.includes("AbCd/EfGh"), output);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** A plain key is matched by its bounded pattern; the base64 scanner only adds keys whose body has "/" or "+". */
test("a plain key followed by a URL path is redacted once and the path is kept", () => {
  const boundary = new InformationFlowBoundary();
  const key = "sk-ant-api03-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
  for (const suffix of ["/models", "/v1/models", "/v1/messages?beta=true", "/"]) {
    const text = `calling ${key}${suffix} now`;
    const found = boundary.classifyText(text, []);
    assert.equal(found.length, 1, `${suffix}: ${JSON.stringify(found)}`);
    assert.equal(found[0].secret, key, suffix);
    const original = InformationFlowBoundary.getGlobalInstance();
    InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
    try {
      assert.equal(redactDiagnosticForOutput(text), `calling [REDACTED:ANTHROPIC_API_KEY]${suffix} now`);
    } finally {
      InformationFlowBoundary.setGlobalInstance(original);
    }
  }
});

/** A base64 key's final segment is key material whatever its letter case: nothing of the run is taken for a URL path. */
test("a base64 key ending in a lower-case segment is redacted whole", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const key of [
      "sk-AbCd/EfGhIjKlMnOpQrStUvWxYz0123456789/abcdef",
      "sk-ant-api03-Qx7Km2+Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0Ua/models",
      "sk-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1/Jf5Ge0UaXo2RtBq",
    ]) {
      const output = redactDiagnosticForOutput(`calling ${key} now`);
      assert.match(output, /^calling \[REDACTED:[A-Z_]+\] now$/, `${key}: ${output}`);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** A key start inside a longer credential does not split it: the enclosing credential is redacted whole. */
test("a credential with an embedded sk- is redacted whole, prefix included", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    const credential = "AbCdEfGhIjKlMn+sk-A/4fA8zK1x9qLmP3wV7tY0bE5rC2uI8oNs";
    const output = redactDiagnosticForOutput(`token ${credential} rejected`);
    assert.ok(!output.includes("AbCdEfGh") && !output.includes("4fA8zK1x"), output);
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** An operator-declared secret that is part of a key does not shorten the key's redaction, wherever it sits in it. */
test("an operator secret inside a key does not shorten the key's redaction", () => {
  const key = "sk-ant-api03-Qx7Km2+Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt/Bq";
  for (const explicit of ["sk-ant-api03-", "Hc6Yp1Jf5Ge0Ua"]) {
    const boundary = new InformationFlowBoundary({ explicitSecrets: [explicit] });
    for (const text of [`key ${key} end`, `key ${key} end; also ${explicit} alone`]) {
      assert.ok(boundary.classifyText(text, []).some((f) => f.secret === key), `${explicit}: the key is classified whole`);
      const output = boundary.redactForTelemetry(text);
      assert.ok(!output.includes("Qx7Km2") && !output.includes("Xo2Rt") && !output.includes(explicit), `${explicit}: ${output}`);
    }
  }
});

/**
 * A key inside a longer high-entropy token keeps its deterministic classification: persistence refuses deterministic
 * findings and only redacts uncertain ones, so losing the classification would let the key be written to disk.
 */
test("a key inside a high-entropy token keeps its deterministic classification and the token is redacted whole", () => {
  const boundary = new InformationFlowBoundary();
  for (const [text, fragment] of [
    ["abc/ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo", "Qx7Km2"],
    ["x+sk-proj7KaMb3QxZt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo", "7KaMb3"],
    ["prefix-sk-4fA8zK1x9qLmP3wV7tY0bE5rC2uI8oNs", "4fA8zK"],
  ]) {
    const found = boundary.classifyText(text, []);
    assert.ok(found.some((f) => f.classificationType === "PATTERN_DETERMINISTIC"), `${text}: ${JSON.stringify(found)}`);
    const output = boundary.redactForTelemetry(text);
    assert.ok(!output.includes(fragment) && !output.includes(text.slice(0, 4)), `${text}: ${output}`);
    const original = InformationFlowBoundary.getGlobalInstance();
    InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
    try {
      assert.throws(() => assertNoSensitivePersistenceContent(text, "checkpoint"), /./, `${text}: the checkpoint guard refuses it`);
    } finally {
      InformationFlowBoundary.setGlobalInstance(original);
    }
  }
});

/** JSON may escape "/" as "\/": the escaped slash is part of the secret, not its end. */
test("secrets with JSON-escaped slashes are redacted whole", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const [secret, render] of [
      [String.raw`sk-ant-api03-Qx7Km2+Vb9Lr\/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt\/Bq`, (s: string) => `{"a":"${s}"}`],
      [String.raw`sk-proj7Ka+Mb3Qx\/Zt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo+Sa\/Tk`, (s: string) => `{"k":"${s}"}`],
      [String.raw`Tq8Zc3+Lm5Xv\/Rb2Nk7Hd1Yw4Js6Pg9Fe0Ua+Oi8Sx2Q==`, (s: string) => `{"t":"${s}"}`],
      [String.raw`Hn4Vb7+Cx2Zl\/Km9Qw3Rt6Yu1Ip8Oa5Sd0Fg+Jk2Lz\/Mq`, (s: string) => `{"h":"Authorization: Bearer ${s}"}`],
      [String.raw`Hn4Vb7Cx2Zl\/Km9Qw3Rt6Yu1Ip8Oa5Sd0FgJk2Lz\/Mq`, (s: string) => `{"h":"Bearer ${s}"}`],
    ] as Array<[string, (s: string) => string]>) {
      const output = redactDiagnosticForOutput(render(secret));
      for (const segment of secret.replace(/=+$/, "").split("\\/")) {
        assert.ok(!output.includes(segment) && !leftoverWindow(output, segment), `${secret}: left "${segment}" in ${output}`);
      }
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary, replaceValues } from "../src/core/egress.js";
import { assertNoSensitivePersistenceContent, redactDiagnosticForOutput } from "../src/core/persistence_protection.js";
import { SecretsVault } from "../src/security.js";

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
      // Linear runs take well under 1 s; the quadratic scans this guards against took minutes. Loose for slow CI hosts.
      assert.ok(elapsed < 10_000, `${name}: ${Math.round(elapsed)} ms for ${input.length} chars`);
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
 * value comes first and is replaced first: replacing the shorter one first would leave the rest of the credential in
 * the text. The shorter value stays classified (it may occur elsewhere), but only the value replaced is vaulted.
 */
test("a credential matched at the same place by two classifiers is replaced as the longest match", () => {
  const boundary = new InformationFlowBoundary();
  // The Bearer pattern stops at "~"; the Authorization pattern takes the whole token68 value.
  const token = "AbCd/EfGhIjKlMnOp~QrStUvWxYz0123456789";
  const header = boundary.classifyText(`Authorization: Bearer ${token} rejected`, []);
  assert.equal(header[0].secret, token, JSON.stringify(header));
  // The Bearer capture keeps the sentence's full stop; the entropy tokenizer trims it.
  const sentenceText = "Connecting to provider with Bearer bAGOhOwLeY7Mabcdef123456789.\n";
  const sentence = boundary.classifyText(sentenceText, []);
  assert.equal(sentence[0].secret, "bAGOhOwLeY7Mabcdef123456789.", JSON.stringify(sentence));
  const vault = new SecretsVault(new InformationFlowBoundary());
  assert.equal(vault.quarantine(sentenceText).quarantinedCount, 1);
  assert.equal(vault.getMappingCount(), 1);
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

/** scikit-learn style paths start with `sk-` but are paths: identifier segments, no "+", no long random segment. */
test("sk-learn style paths are not keys", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const text of [
      "see sk-learn/Linear_model/Ridge.py",
      "see sk-learn/linear_model/Ridge2.py",
      "error at sk-learn/sklearn/linear_model/ridge/Ridge_Regression.py",
      "import sk-learn/Ensemble/RandomForestClassifier",
    ]) {
      assert.equal(redactDiagnosticForOutput(text), text);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** A Bearer token with "/" needs a digit or a capital and must not be a path; then it is redacted whole. */
test("a Bearer token with a slash is redacted whole unless it is a path", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const text of [
      "Bearer aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb1",
      "Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb1",
      "Bearer Abcdefghijklmnopqrstuv/wxyzabcdefghijklmnop",
    ]) {
      const output = redactDiagnosticForOutput(text);
      assert.ok(!/aaaaaa|bbbbbb|bcdefg|wxyzab/.test(output), `${text}: ${output}`);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** A base64 run longer than the entropy tokenizer's 128-character cap is still a secret when it carries "+" or "/". */
test("a base64 run longer than 128 characters is redacted", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    for (const unit of ["Qx7Km2+Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt/Bq", "Qx7Km2Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2Rt/Bq"]) {
      const blob = unit.repeat(4);
      const output = redactDiagnosticForOutput(`blob ${blob} end`);
      assert.ok(!output.includes("Qx7Km2") && !output.includes("Rt/Bq"), `${blob.length} chars: ${output}`);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** Base64 data (a data-URI payload, an embedded file of more than credential size) is data, not a secret. */
test("base64 data blobs are not taken for secrets", () => {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    const unit = "Qx7Km2+Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt/Bq";
    for (const text of [
      `<img src="data:image/png;base64,iVBORw0KGgo${unit.repeat(4)}AAAAElFTkSuQmCC">`,
      `font: url(data:font/woff2;base64,d09GMgABAAAA${unit.repeat(3)}) format("woff2")`,
      // Over the 512-character cap for base64 runs: an embedded file, not a credential.
      `fixture ${unit.repeat(20)} end`,
    ]) {
      assert.equal(redactDiagnosticForOutput(text), text);
    }
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
});

/** The data-URI exemption is for long payloads only: a credential-sized value after `base64,` is still a secret. */
test("a short secret after base64, is still redacted", () => {
  const boundary = new InformationFlowBoundary();
  const key = "Qx7Km2+Vb9Lr/Tz4Wd8Ns3Hc6Yp1Jf5Ge0Ua+Xo2Rt/Bq";
  for (const [text, secret] of [
    [`config base64,${key} end`, key],
    [`{"token":"base64,${key}"}`, key],
    ["x=base64,wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYq9Zr3", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYq9Zr3"],
    [`data:text/plain;base64,${key}`, key],
  ]) {
    const output = boundary.redactForTelemetry(text);
    assert.ok(!output.includes(secret.slice(0, 12)) && !output.includes(secret.slice(-12)), `${text}: ${output}`);
  }
});

/**
 * The scheme name is case-insensitive (RFC 7235). After "Bearer" any 16-character token is redacted; after another case
 * of the word, which is also ordinary prose ("the bearer of"), the value must look like a token (a digit, a capital,
 * "+", "/" or "=") unless an Authorization header carries it.
 */
test("a Bearer token is redacted whatever the case of the scheme name; prose after bearer is not", () => {
  const boundary = new InformationFlowBoundary();
  for (const text of [
    "Authorization: bearer aaaaaaaabbbbbbbbcccccccc",
    "token was bearer abcdefghijklmnopqrstu1234",
    "token was BEARER Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1",
    "token was Bearer aaaabbbbccccddddeeee",
  ]) {
    const output = boundary.redactForTelemetry(text);
    assert.ok(!/aaaabbbb|aaaaaaaabbbb|abcdefghijkl|Qx7Km2/.test(output), `${text}: ${output}`);
  }
  for (const text of [
    "the bearer tokenizationsuffixes are lost",
    "a bearer of_information_system",
    "the bearer of this note is welcome",
  ]) {
    assert.equal(boundary.redactForTelemetry(text), text);
  }
});

/** A secret value found inside a longer match is still replaced wherever else it appears in the text. */
test("a secret inside a longer match is redacted at its other occurrences too", () => {
  const boundary = new InformationFlowBoundary();
  const text = "Bearer abc-sk-0123456789abcdefghij; saved prefix_sk-0123456789abcdefghij.log";
  const output = boundary.redactForTelemetry(text);
  assert.ok(!output.includes("0123456789abcdefghij"), output);
});

/**
 * Replacement is one pass over the text, not one pass per distinct secret: 20k distinct keys in about 1 MB. Timed
 * against 2.5k keys in the same process, so a slow host does not matter: 8 times the keys is about 12 times the time
 * when linear, and about 120 times with one replaceAll per key (the quadratic version took about 20 s).
 */
test("many distinct secrets are redacted in linear time", () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed >>> 26;
  };
  const keys = Array.from({ length: 20_000 }, () => `sk-${Array.from({ length: 44 }, () => alphabet[next()]).join("")}`);
  const boundary = new InformationFlowBoundary();
  let output = "";
  const fastest = (count: number, runs: number): number => {
    const text = keys.slice(0, count).join(" ");
    let best = Infinity;
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      output = boundary.redactForTelemetry(text);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const few = fastest(2_500, 3);
  const many = fastest(20_000, 2);
  assert.ok(many / few < 32, `${Math.round(few)} ms for 2.5k keys, ${Math.round(many)} ms for 20k keys`);
  assert.ok(!keys.some((key) => output.includes(key.slice(3, 15))), "every key is redacted");
});

/** Whether two occurrences of the values overlap without one lying inside the other. */
function hasPartialOverlap(text: string, values: string[]): boolean {
  const spans: Array<[number, number]> = [];
  for (const value of values) for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  return spans.some(([a, b]) => spans.some(([c, d]) => a < c && c < b && b < d));
}

/**
 * The one-pass replacement gives the same text as replaceAll for each value in turn, longest value first, unless a value
 * overlaps another only partly: replaceAll would then leave the rest of one in clear, so every part of both is replaced.
 */
test("one-pass replacement matches sequential replaceAll unless values overlap partly, with few values and with many", () => {
  let seed = 7;
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  for (let round = 0; round < 400; round++) {
    const text = Array.from({ length: 40 + random(80) }, () => "ab+/"[random(4)]).join("");
    const count = round % 2 === 0 ? 1 + random(6) : 17 + random(20);
    const values = [...new Set(Array.from({ length: count }, () => {
      const start = random(text.length - 2);
      return text.slice(start, start + 2 + random(6));
    }))].sort((a, b) => b.length - a.length);
    let expected = text;
    values.forEach((value, index) => { expected = expected.replaceAll(value, `<${index}>`); });
    const actual = replaceValues(text, values, (index) => `<${index}>`);
    // The results differ only where two values overlap partly (replaceAll leaves text of one in clear): no value is left in clear now.
    if (hasPartialOverlap(text, values)) {
      for (const value of values) assert.ok(!actual.includes(value), JSON.stringify({ text, values, actual }));
    } else {
      assert.equal(actual, expected, JSON.stringify({ text, values }));
    }
  }
  // Disjoint and nested occurrences (no partial overlap) give exactly the sequential result.
  assert.equal(replaceValues("xabcdefyycdez", ["abcdef", "cde"], (index) => `<${index}>`), "x<0>yy<1>z");
  // A partial overlap: "ab" and "bc" in "abc" are both replaced whole.
  assert.equal(replaceValues("abc", ["ab", "bc"], (index) => `<${index}>`), "<0>");
  // More occurrences than characters: the fallback replaces the union of all occurrences, by the longest value.
  assert.equal(replaceValues(`x${"a".repeat(5000)}y`, ["aaa", "aa", "a"], (index) => `<${index}>`), "x<0>y");
  assert.equal(replaceValues(`${"ab".repeat(3000)}-c`, Array.from({ length: 20 }, (_, i) => "ab".repeat(i + 1)), (index) => `<${index}>`), "<19>-c");
});

/** Secrets that are suffixes of one another over a repetitive text: occurrence collection is bounded. */
test("nested secrets over a repetitive text are redacted in bounded time", () => {
  for (const count of [10, 30]) {
    const explicitSecrets = Array.from({ length: count }, (_, i) => "a".repeat(i + 1));
    const boundary = new InformationFlowBoundary({ explicitSecrets });
    const text = `start ${"a".repeat(1_000_000)} end`;
    const started = performance.now();
    const output = boundary.redactForTelemetry(text);
    const elapsed = performance.now() - started;
    // About 1 s when bounded; without the occurrence budget, 30 secrets took about 26 s. Loose for slow CI hosts.
    assert.ok(elapsed < 10_000, `${count} secrets: ${Math.round(elapsed)} ms`);
    assert.ok(!output.includes("aa"), `${count} secrets: the run is redacted`);
    assert.ok(output.startsWith("st") && output.endsWith("end"), `${count} secrets: ${output.slice(0, 40)}`);
  }
});

/** Reversible quarantine is lossless even when the redactor's occurrence budget is exceeded: restore gives the input. */
test("quarantine of self-overlapping secrets restores the exact text", () => {
  const vault = new SecretsVault(new InformationFlowBoundary({ explicitSecrets: ["a".repeat(20), "a".repeat(21)] }));
  const text = `x ${"a".repeat(2000)} y`;
  const { sanitized } = vault.quarantine(text);
  assert.ok(!sanitized.includes("a".repeat(20)), sanitized.slice(0, 80));
  assert.equal(vault.restore(sanitized, { isAuthorizedSink: true }), text);
});

test("egress tokens for self-overlapping secrets rehydrate to the exact text, in linear time", () => {
  const boundary = new InformationFlowBoundary({ explicitSecrets: ["a".repeat(20), "a".repeat(21)] });
  const text = `x ${"a".repeat(2000)} y ${"a".repeat(25)} z ${"a".repeat(800_000)} w`;
  const started = performance.now();
  const result = boundary.evaluateEgress(text, "EXTERNAL_PUBLIC", { taskId: "t1" });
  assert.ok(performance.now() - started < 10_000, "over budget fallback stays linear"); // about 0.5 s; loose for CI
  assert.ok(!result.sanitizedText!.includes("a".repeat(20)), result.sanitizedText!.slice(0, 80));
  assert.equal(result.quarantinedCount, 3);
  assert.deepEqual(result.quarantinedSecrets!.map((item) => item.secret.length), [2000, 25, 800_000]);
  const rehydrated = boundary.rehydrate(result.sanitizedText, { taskId: "t1", isAuthorizedSink: true });
  assert.equal(rehydrated.rehydrated, text);
  assert.equal(rehydrated.rehydratedCount, 3);
});

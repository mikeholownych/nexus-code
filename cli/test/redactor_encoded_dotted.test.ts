import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary, replaceValues, scanWorkForTest } from "../src/core/egress.js";
import { redactDiagnosticForOutput } from "../src/core/persistence_protection.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { corpus, redactedRanges } from "./fixtures/redaction_monotone_corpus.js";

/** Synthetic keys only: no real credential appears here. */
const ANTHROPIC_BODY = "api03-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1";
const TAIL = "Jf5Ge0UaXo2RtBq";

const TEMPLATES: Array<[string, (s: string) => string]> = [
  ["free text", (s) => `request failed with key ${s} while connecting`],
  ["end of sentence", (s) => `the credential was ${s}.`],
  ["key=value", (s) => `token=${s} retry=1`],
  ["json field", (s) => `{"note":"${s}","ok":false}`],
  ["url query", (s) => `GET https://llm.example/v1/models?key=${s}&x=1 failed`],
  ["parenthesised", (s) => `rejected (${s}) by gateway`],
  ["multiline", (s) => `error:\n  key ${s}\n  retry later`],
];

function withFreshBoundary<T>(run: () => T): T {
  const original = InformationFlowBoundary.getGlobalInstance();
  InformationFlowBoundary.setGlobalInstance(new InformationFlowBoundary());
  try {
    return run();
  } finally {
    InformationFlowBoundary.setGlobalInstance(original);
  }
}

/** Any 6-character window of the secret's body that survives means part of the key was left in clear. */
function leftover(output: string, body: string): string | undefined {
  for (let i = 0; i + 6 <= body.length; i++) if (output.includes(body.slice(i, i + 6))) return body.slice(i, i + 6);
  return undefined;
}

function assertRedactedEverywhere(secret: string, body: string, label: string): void {
  withFreshBoundary(() => {
    for (const [name, render] of TEMPLATES) {
      const output = redactDiagnosticForOutput(render(secret));
      const tail = leftover(output, body);
      assert.equal(tail, undefined, `${label} in ${name}: left "${tail}" in ${JSON.stringify(output)}`);
    }
  });
}

test("a key whose / or + is percent-encoded or a look-alike is redacted whole", () => {
  for (const slash of ["%2F", "%2f", "%252F", "∕", "⁄", "／"]) {
    for (const plus of ["%2B", "%2b", "＋"]) {
      const body = `${ANTHROPIC_BODY}${slash}${TAIL}${plus}Zq4Lm8Wn`;
      assertRedactedEverywhere(`sk-ant-${body}`, body, `anthropic ${JSON.stringify(slash + plus)}`);
      const openai = `proj7Ka${plus}Mb3Qx${slash}Zt9Lw2Vn5Hd8Rc1Yf4Jg6Pu0Eo`;
      assertRedactedEverywhere(`sk-${openai}`, openai, `openai ${JSON.stringify(slash + plus)}`);
    }
  }
});

test("a short head before an encoded slash does not hide the rest of the key", () => {
  const body = "Qx7Km2Vb9%2FLrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
  assertRedactedEverywhere(`sk-${body}`, body, "short head");
});

test("a non-prefixed base64 secret with encoded / and + is redacted whole", () => {
  const body = "wJalrXUtnFEMI%2FK7MDENG%2BbPxRfiCYEXAMPLEKEYq9";
  assertRedactedEverywhere(body, body, "aws-style secret");
  const lookalike = "wJalrXUtnFEMI∕K7MDENG＋bPxRfiCYEXAMPLEKEYq9";
  assertRedactedEverywhere(lookalike, lookalike, "look-alike aws-style secret");
});

test("key material after a dot that follows an sk- key is redacted whole", () => {
  const cases = [
    `sk-ant-${ANTHROPIC_BODY}${TAIL}.Xo2RtBq`,
    `sk-ant-${ANTHROPIC_BODY}${TAIL}.Xo2RtBq.Mn5Kp9Vc`,
    `sk-${ANTHROPIC_BODY}${TAIL}.Xo2RtBq`,
    `sk-${ANTHROPIC_BODY}/${TAIL}.Xo2RtBq`,
    `sk-${ANTHROPIC_BODY}%2F${TAIL}.Xo2RtBq`,
    `sk-${ANTHROPIC_BODY}${TAIL}.Xo2%2FRtBqMn5Kp9Vc`,
  ];
  for (const secret of cases) assertRedactedEverywhere(secret, secret.replace(/^sk-(ant-)?/, ""), secret);
});

test("the same dotted continuation is redacted after other token kinds", () => {
  const jwe = "eyJhbGciOiJSU0EtT0FFUCJ9abc.Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1.Jf5Ge0UaXo2RtBq9Zk.Mn5Kp9Vc3Xb7Lq2Wd4.Hs8Ty1Rg6Ne0Cu";
  assertRedactedEverywhere(jwe, jwe.replace("eyJhbGciOiJSU0EtT0FFUCJ9abc.", ""), "five-segment JWE");
  const github = "ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo.Xo2RtBq9Mn5Kp";
  assertRedactedEverywhere(github, "Xo2RtBq9Mn5Kp", "github token with dotted tail");
});

test("length gates and the entropy threshold use the decoded length of an encoded token", () => {
  // 23 characters encoded, 19 decoded (`Qx7/Km2Zp9+Vb4Lr8Tw`, all distinct, entropy 4.25 > 4.0): under the 20-character gate once decoded.
  const short = "Qx7%2FKm2Zp9%2BVb4Lr8Tw";
  withFreshBoundary(() => assert.equal(redactDiagnosticForOutput(`id ${short} x`), `id ${short} x`));
  // One more decoded character and the same shape is redacted.
  const long = "Qx7%2FKm2Zp9%2BVb4Lr8Tw5";
  assertRedactedEverywhere(long, long, "long encoded token");
});

test("extending a key past a dot keeps keys inside the extension and elsewhere redacted", () => {
  withFreshBoundary(() => {
    // The extension moves a "/" into the path exemption; the key after the dot must still be found.
    const nested = redactDiagnosticForOutput("sk-cache.sk-Qx7Km2Vb9LrTz4/Models");
    assert.ok(!nested.includes("Qx7Km2"), nested);
    // The plain key is still replaced where it occurs on its own, whatever follows it elsewhere.
    const text = "sk-0123456789abcdefghij.Xo2RtBq; saved prefix_sk-0123456789abcdefghij.log";
    const output = redactDiagnosticForOutput(text);
    assert.ok(!output.includes("0123456789abcdefghij") && !output.includes("Xo2RtBq"), output);
  });
});

test("redaction is monotone: every character redacted before this change is still redacted", () => {
  const inputs = corpus();
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/redaction_base_spans.json", import.meta.url), "utf8")) as
    { count: number; digest: string; spans: Record<string, number[][]> };
  assert.equal(inputs.length, recorded.count, "the corpus changed: regenerate fixtures/redaction_base_spans.json");
  assert.equal(createHash("sha256").update(inputs.join("\u0000")).digest("hex"), recorded.digest, "the corpus changed: regenerate the fixture");
  assert.ok(Object.keys(recorded.spans).length > 1000, "the fixture records the base spans");
  const boundary = new InformationFlowBoundary();
  const failures: string[] = [];
  for (const [index, ranges] of Object.entries(recorded.spans)) {
    const input = inputs[Number(index)];
    const now = new Set<number>();
    for (const [start, end] of redactedRanges(replaceValues, boundary.classifyText(input, []).map((c) => c.secret), input)) {
      for (let i = start; i < end; i++) now.add(i);
    }
    for (const [start, end] of ranges) {
      for (let i = start; i < end; i++) {
        if (!now.has(i)) {
          failures.push(`${JSON.stringify(input.slice(start, end))} at ${i} no longer redacted in ${JSON.stringify(input)}`);
          break;
        }
      }
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} ranges redacted at the base are now (partly) left in clear`);
});

test("operator secrets that overlap one another or a key only partly leave no tail in clear", () => {
  const boundary = new InformationFlowBoundary({ explicitSecrets: ["AAAA1234", "1234BBBB", "BBBByyyyy"] });
  const output = boundary.redactForTelemetry("BBBByyyyy AAAA1234BBBB AAAA1234BBBByyyyy");
  assert.ok(!/AAAA|1234|BBBB|yyyy/.test(output), output);
});

test("a value that straddles the end of an extended key is still redacted whole", () => {
  const key = "ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo";
  // The extension stops before ".ab" (too short to be key material): the operator secret crosses the end of the extension.
  const boundary = new InformationFlowBoundary({ explicitSecrets: ["A1b2C3d4.ab"] });
  const output = boundary.redactForTelemetry(`${key}.A1b2C3d4.ab and more`);
  assert.ok(!output.includes("A1b2") && !output.includes(".ab") && !output.includes("Qx7Km2"), output);
});

const FAMILIES = 1 + InformationFlowBoundary.DETERMINISTIC_PATTERNS.length;
const valueChars = (input: string): number =>
  new InformationFlowBoundary().classifyText(input, []).reduce((sum, item) => sum + item.secret.length, 0);
const unitKey = (i: number): string => `sk-%2F${i.toString(36).padStart(8, "A")}-`;

/**
 * The bounds of the disjoint-window design, asserted on every adversarial input: the values to replace total at most
 * about 3x the text (each extended value repeats its run once, windows of one family are disjoint) and the scan work
 * is linear in the text for each family.
 */
function assertBounded(input: string): void {
  const work = scanWorkForTest();
  const total = valueChars(input);
  assert.ok(total <= 3 * input.length + 4096, `${total} characters of values for ${input.length} characters of text`);
  const spent = scanWorkForTest() - work;
  assert.ok(spent <= 16 * input.length * FAMILIES, `${spent} characters scanned for ${input.length} characters of text`);
}

/** Redacts `input` and checks that the text after the last " then " (the real key) holds none of its secret material. */
function assertRealKeyGone(input: string, material: string[], label: string): void {
  withFreshBoundary(() => {
    const output = redactDiagnosticForOutput(input);
    const after = output.slice(output.lastIndexOf(" then ") + 6);
    assert.ok(after.endsWith(" end") && after.length < 60, `${label}: ${after}`);
    for (const piece of material) assert.ok(!after.includes(piece), `${label}: "${piece}" left in ${after}`);
  });
}

const REAL_BODY = "Qx7Km2Vb9%2FLrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
const REAL_KEY = `sk-${REAL_BODY}.${TAIL}`;
const REAL_PIECES = ["Qx7Km2", "Wd8Ns3", "RtBq", TAIL];

test("a blob of cheap look-alikes of any size does not starve a real key later in the text", () => {
  for (const unit of ["sk-%2F-", "sk-. "]) {
    for (const n of [200, 2000, 20000]) {
      const input = `${unit.repeat(n)} then ${REAL_KEY} end`;
      assertRealKeyGone(input, REAL_PIECES, `${JSON.stringify(unit)} x ${n}`);
      assertBounded(input);
    }
  }
});

test("a blob of 200 accepted encoded runs does not starve a real encoded and dotted key", () => {
  const units = Array.from({ length: 200 }, (_, i) => unitKey(i)).join("");
  const input = `${units}${"abcdefgh-".repeat(10000)} then sk-${REAL_BODY}${".Zk4Pq8Rt".repeat(20)} end`;
  assertRealKeyGone(input, ["Qx7Km2", "RtBq", "Zk4Pq8Rt"], "accepted blob");
  assertBounded(input);
});

test("a real key whose tail contains sk- is redacted whole", () => {
  const key = `sk-${REAL_BODY}.${TAIL}-sk-Hq3Lm8Vb2Nz5Kd9Xc4Rt7Yp%2FMn5Qr7Vw2.Zk4Pq8Rt9Wm2Lx`;
  for (const [, render] of TEMPLATES) {
    withFreshBoundary(() => {
      const output = redactDiagnosticForOutput(render(key));
      assert.ok(!output.includes("Qx7Km2") && !output.includes("Hq3Lm8") && !output.includes("Zk4Pq8") && !output.includes(TAIL), output);
    });
  }
  assertBounded(key);
});

test("the original match is always redacted even where its window is empty", () => {
  const input = `${"sk-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo.".repeat(50)} end`;
  withFreshBoundary(() => assert.ok(!redactDiagnosticForOutput(input).includes("Qx7Km2")));
  assertBounded(input);
});

test("a long dotted high-entropy token is redacted whole", () => {
  const secret = "Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq.Xo2RtBq";
  assertRedactedEverywhere(secret, secret, "dotted token");
});

test("a key at the end of a sentence keeps the full stop and an extension-like tail stays readable", () => {
  withFreshBoundary(() => {
    const key = `sk-ant-${ANTHROPIC_BODY}${TAIL}`;
    assert.equal(redactDiagnosticForOutput(`the key was ${key}.`), "the key was [REDACTED:ANTHROPIC_API_KEY].");
    assert.equal(redactDiagnosticForOutput(`wrote ${key}.json now`), "wrote [REDACTED:ANTHROPIC_API_KEY].json now");
    for (const word of ["Models", "toString", "README", "getBytes", "ApiClient"]) {
      assert.equal(redactDiagnosticForOutput(`a ${key}.${word} b`), `a [REDACTED:ANTHROPIC_API_KEY].${word} b`);
    }
  });
});

test("ordinary dotted, encoded and base64 text is not redacted", () => {
  const unchanged = [
    "released version 1.2.3 and 10.0.19045.4291 today",
    "see package-lock.json and cli/src/core/egress.test.ts",
    "Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf is loaded",
    "https://example.com/docs/getting-started/installation.html?ref=main",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "host api.us-east-1.amazonaws.com responded",
    "Maven.Central.Repository1.Mirror is slow",
    "open https://example.com/a%2Fb%2Fc/readme%2Etxt and also a%2Bb",
    "use sk-learn/linear_model/Ridge2.fit and sk-learn.Linear.Models",
    "com.example.analytics.TrackingConfigurationService.initialize",
    "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ];
  withFreshBoundary(() => {
    for (const text of unchanged) assert.equal(redactDiagnosticForOutput(text), text);
  });
});

test("adversarial inputs finish within a time bound: long runs of sk-, escapes, dots and chained keys", () => {
  const long = "Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
  const inputs = [
    "sk-" + "%2F".repeat(30000),
    "sk-" + "%252F".repeat(15000) + ".",
    "sk-a.".repeat(20000),
    "sk-" + "Ab1.".repeat(20000),
    "sk-sk-".repeat(30000) + "∕".repeat(1000),
    long + ".".repeat(80000) + long,
    (long + ".").repeat(4000),
    "sk-Aaaaaa1.".repeat(20000),
    "sk-%2FAAAAAAA0-".repeat(10000),
    ("ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo.").repeat(5000),
    ("A".repeat(30) + "%2F").repeat(5000),
    "." .repeat(100000),
  ];
  withFreshBoundary(() => {
    for (const input of inputs) {
      const started = performance.now();
      redactDiagnosticForOutput(input);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 20000, `${input.slice(0, 24)}...(${input.length}) took ${Math.round(elapsed)}ms`);
    }
  });
});

const GHP_BASE = "Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
/** A placeholder ghp_ key (36 characters after the prefix) made distinct by `tag`. */
const ghp = (tag: string): string => `ghp_${GHP_BASE.slice(0, 36 - tag.length)}${tag}`;
const dotted = (count: number, c: string): string => Array.from({ length: count }, (_, i) => `.Zk4Pq8${c}${String(i).padStart(3, "0")}`).join("");

test("sparse dotted keys with 1 KB spacing do not starve the last key's tail", () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(38); // ~1 KB
  const sparse = Array.from({ length: 12 }, (_, i) => `${ghp(String(i).padStart(4, "0"))}${dotted(3, "S")} ${filler}`).join("");
  const target = `${ghp("zzzz")}${dotted(10, "T")}`; // ~100-character dotted tail
  const input = `${sparse}then ${target} end ${"padding text ".repeat(8000)}`;
  withFreshBoundary(() => {
    const output = redactDiagnosticForOutput(input);
    const after = output.slice(output.lastIndexOf("then ") + 5, output.indexOf(" end "));
    assert.equal(after, "[REDACTED:GITHUB_TOKEN]", after);
  });
});

test("nine space-separated dotted ghp_ tokens with 1000-character tails do not starve a target or a trailing sk-ant key", () => {
  const long = (i: number): string => `${ghp(String(i).padStart(4, "0"))}${dotted(100, "L").slice(0, 1000)}`;
  const target = `${ghp("tttt")}${dotted(30, "T")}`;
  const anthropic = `sk-ant-${ANTHROPIC_BODY}${TAIL}`;
  const input = `${Array.from({ length: 9 }, (_, i) => long(i)).join(" ")} then ${target} end ${anthropic}`;
  withFreshBoundary(() => {
    const output = redactDiagnosticForOutput(input);
    const after = output.slice(output.lastIndexOf("then ") + 5);
    assert.equal(after, "[REDACTED:GITHUB_TOKEN] end [REDACTED:ANTHROPIC_API_KEY]", after);
  });
});

test("a long dot-joined chain of keys does not lose the tail of its last key", () => {
  const sk = "Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaX".slice(0, 33);
  for (const prefix of ["ghp_", "sk-ant-", "sk-"]) {
    for (const count of [40, 100]) {
      const chain = Array.from({ length: count }, (_, i) => `${prefix}${sk}${String(100 + i)}`).join(".");
      withFreshBoundary(() => {
        const output = redactDiagnosticForOutput(`${chain}.Mn5Qr7Vw2.Mn5Qr7Vw3 end`);
        assert.ok(!output.includes("Mn5Qr7Vw2") && !output.includes("Mn5Qr7Vw3"), `${prefix} x${count}: ${output.slice(-80)}`);
      });
    }
  }
});

test("a dense chain of 100 dot-joined keys of three prefixes does not lose its last tail", () => {
  const prefixes = ["ghp_", "sk-ant-", "sk-"];
  const chain = Array.from({ length: 100 }, (_, i) => `${prefixes[i % 3]}${GHP_BASE.slice(0, 33)}${String(100 + i)}`).join(".");
  withFreshBoundary(() => {
    const output = redactDiagnosticForOutput(`${chain}.Mn5Qr7Vw2.Mn5Qr7Vw3 end`);
    assert.ok(!output.includes("Mn5Qr7Vw2") && !output.includes("Mn5Qr7Vw3"), output.slice(-80));
  });
});

test("after 1500 ghp_ candidates the later key is redacted whole and work stays linear", () => {
  const candidates = Array.from({ length: 1500 }, (_, i) => `${ghp(String(i).padStart(4, "0"))}${dotted(2, "C")} `).join("");
  const target = `${ghp("zzzz")}${dotted(5, "T")}`;
  const input = `${candidates}then ${target} end`;
  withFreshBoundary(() => {
    const output = redactDiagnosticForOutput(input);
    assert.equal(output.slice(output.lastIndexOf("then ") + 5), "[REDACTED:GITHUB_TOKEN] end");
  });
  assertBounded(input);
});

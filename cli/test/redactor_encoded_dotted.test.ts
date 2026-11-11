import { test } from "node:test";
import assert from "node:assert/strict";
import { InformationFlowBoundary } from "../src/core/egress.js";
import { redactDiagnosticForOutput } from "../src/core/persistence_protection.js";

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
  // 18 decoded characters, 30 encoded: below the 20-character gate once decoded, so it is not classified.
  const short = "Qx7%2FKm2%2BVb9%2FLrTz4";
  withFreshBoundary(() => assert.equal(redactDiagnosticForOutput(`id ${short} x`), `id ${short} x`));
  // The same shape, long enough decoded, is redacted.
  const long = "Qx7%2FKm2%2BVb9%2FLrTz4Wd8Ns3Hc6Yp1Jf5";
  assertRedactedEverywhere(long, long, "long encoded token");
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

test("adversarial inputs are linear: long runs of sk-, escapes and dots finish within a time bound", () => {
  const long = "Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo2RtBq";
  const inputs = [
    "sk-" + "%2F".repeat(60000),
    "sk-" + "%252F".repeat(30000) + ".",
    "sk-a.".repeat(40000),
    "sk-" + "Ab1.".repeat(40000),
    "sk-sk-".repeat(30000) + "∕".repeat(1000),
    long + ".".repeat(80000) + long,
    (long + ".").repeat(4000),
    ("A".repeat(30) + "%2F").repeat(5000),
    "." .repeat(100000),
  ];
  // A chain of keys joined by dots (each key extends to the end of the chain) must cost the same per key at N and 4N.
  const chain = (unit: string, count: number): string => (unit + ".").repeat(count) + "end";
  const ghp = "ghp_Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0UaXo";
  const skKey = "sk-Qx7Km2Vb9LrTz4Wd8Ns3Hc6Yp1Jf5Ge0Ua";
  withFreshBoundary(() => {
    for (const unit of [ghp, skKey]) {
      const time = (count: number): number => {
        const started = performance.now();
        redactDiagnosticForOutput(chain(unit, count));
        return performance.now() - started;
      };
      time(500); // warm up
      const small = Math.max(time(2000), 5);
      const large = time(8000);
      assert.ok(large < small * 12, `${unit.slice(0, 6)} chain: ${Math.round(small)}ms for 2000, ${Math.round(large)}ms for 8000`);
    }
    for (const input of inputs) {
      const started = performance.now();
      redactDiagnosticForOutput(input);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 3000, `${input.slice(0, 24)}...(${input.length}) took ${Math.round(elapsed)}ms`);
    }
  });
});

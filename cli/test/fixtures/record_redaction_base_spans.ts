/**
 * Regenerates redaction_base_spans.json (the ranges of each corpus input that the redactor replaces) from a copy of the redactor as it was before the encoded/dotted work:
 *   git show 29e7ebff:cli/src/core/egress.ts > /tmp/egress_base.ts
 *   npx tsx test/fixtures/record_redaction_base_spans.ts /tmp/egress_base.ts
 * Run it again only when the corpus changes, with the same base copy.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { corpus, redactedRanges } from "./redaction_monotone_corpus.js";

const base = await import(resolve(process.argv[2] ?? "egress_base.ts"));
const boundary = new base.InformationFlowBoundary();
const inputs = corpus();
const spans: Record<string, number[][]> = {};
inputs.forEach((input, index) => {
  const found = redactedRanges(base.replaceValues, boundary.classifyText(input, []).map((c: { secret: string }) => c.secret), input);
  if (found.length) spans[String(index)] = found;
});
const digest = createHash("sha256").update(inputs.join("\u0000")).digest("hex");
writeFileSync(new URL("./redaction_base_spans.json", import.meta.url), JSON.stringify({ count: inputs.length, digest, spans }));
console.log(`${inputs.length} inputs, ${Object.keys(spans).length} with spans`);

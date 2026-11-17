/** The labelled prompt-injection corpus with its invisible-character placeholders expanded (see the corpus file's comment). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CorpusEntry {
  id: string;
  set?: "dev" | "heldout";
  group: "attack" | "evasion" | "benign";
  kind: string;
  text: string;
  intent: "detect" | "miss" | "clean" | "false_positive";
  expect: "detect" | "miss" | "clean" | "false_positive";
  note?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_FILE = path.resolve(here, "../fixtures/injection_corpus.json");

const tagged = (text: string, base: number): string => [...text].map((c) => String.fromCodePoint(base + c.charCodeAt(0))).join("");

/** `⟦TAG:text⟧` and friends become the characters they stand for. */
export function expand(text: string): string {
  return text
    .replace(/⟦TAG:([^⟧]*)⟧/g, (_m, t: string) => tagged(t, 0xe0000))
    .replace(/⟦VS:([^⟧]*)⟧/g, (_m, t: string) => [...t].map((c) => String.fromCodePoint(0xe0100 + (c.charCodeAt(0) % 240))).join(""))
    .replace(/⟦B64:([^⟧]*)⟧/g, (_m, t: string) => Buffer.from(t).toString("base64"))
    .replace(/⟦PCT:([^⟧]*)⟧/g, (_m, t: string) => [...Buffer.from(t)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""))
    .replaceAll("⟦BIDI⟧", "‮")
    .replaceAll("⟦ZW⟧", "​")
    .replaceAll("⟦ZWNJ⟧", "‌")
    .replaceAll("⟦ZWJ⟧", "‍")
    .replaceAll("⟦RLM⟧", "‏")
    .replaceAll("⟦BOM⟧", "﻿")
    .replaceAll("⟦CYR_o⟧", "о")
    .replaceAll("⟦CYR_e⟧", "е");
}

export function loadCorpus(): CorpusEntry[] {
  const raw = JSON.parse(fs.readFileSync(CORPUS_FILE, "utf8")) as { entries: Array<Omit<CorpusEntry, "expect"> & { expect?: CorpusEntry["expect"] }> };
  return raw.entries.map((e) => ({ ...e, text: expand(e.text), expect: e.expect ?? e.intent }));
}

/** What the scanner measurably does with an entry, in the corpus's vocabulary. */
export function outcomeOf(entry: Pick<CorpusEntry, "group">, suspected: boolean): CorpusEntry["expect"] {
  if (entry.group === "benign") return suspected ? "false_positive" : "clean";
  return suspected ? "detect" : "miss";
}

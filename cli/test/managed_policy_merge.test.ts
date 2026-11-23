/**
 * GV-1 and GV-5: the merge of the policy tiers (src/core/managed_policy.ts) and the helpers that read the result.
 *
 * The precedence table is generated: for every key, every combination of a small domain across the three tiers. The
 * expected value and the deciding tier come from the oracles in this file, written per key type from the table in the
 * implementation plan; they never call `mergePolicies` or `meetDocuments`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampAlwaysApproval,
  clampApprovalRequest,
  clampEgressInspector,
  clampEnvTrust,
  clampRuntimeApprovalMode,
  clampSandbox,
  clampSandboxNetwork,
  decideManagedCommand,
  describeSource,
  effectiveVerificationMode,
  meetDocuments,
  mergePolicies,
  permitsEgressHost,
  permitsMcpServer,
  permitsPlugin,
  permitsSecretDestination,
  POLICY_KEYS,
  projectPolicyFromSecurityJson,
  requiresHuman,
  type EffectivePolicy,
  type PolicyDocument,
  type PolicyTier,
  type ProjectPolicyTier,
} from "../src/core/managed_policy.js";
import { splitSubcommands } from "../src/security.js";
import { documentWith, domainOf, PLAN_KEYS, randomDocument, seeded, type KeyRow, type Loose } from "./helpers/policy_fixture.js";

const TIER_NAMES = ["system", "user", "project"] as const;
type Tier = (typeof TIER_NAMES)[number] | "default";
const FILES = { system: "/fake/etc/nexus/policy.toml", user: "/fake/home/.config/nexus/policy.toml", project: "/fake/ws/.nexus-security.json" };

const tier = (name: (typeof TIER_NAMES)[number], document: PolicyDocument | undefined): PolicyTier | undefined => (document === undefined ? undefined : { document, file: FILES[name] });
const merge3 = (system?: PolicyDocument, user?: PolicyDocument, project?: PolicyDocument): EffectivePolicy => mergePolicies(tier("system", system), tier("user", user), tier("project", project));
const at = (policy: EffectivePolicy, row: KeyRow): any => (policy as any)[row.table][row.key];
const sorted = (values: readonly string[]): string[] => [...values].sort();

// ---------------------------------------------------------------------------------------------------------------------
// The oracles. `values` are the three tiers' own values for one key, system first; undefined = not set.

/** OR: true when any tier says true. Deciding tier: the highest tier whose own value is the result. */
function oracleOr(values: unknown[]): { value: boolean; tier: Tier } {
  const value = values[0] === true || values[1] === true || values[2] === true;
  const index = values.findIndex((v) => v === value);
  return { value, tier: index === -1 ? "default" : TIER_NAMES[index] };
}

/** Maximum over the listed order. Deciding tier: the highest tier that names the maximum. */
function oracleMax(values: unknown[], order: readonly string[]): { value: string | undefined; tier: Tier } {
  let best = -1;
  for (const v of values) if (typeof v === "string") best = Math.max(best, order.indexOf(v));
  if (best === -1) return { value: undefined, tier: "default" };
  return { value: order[best], tier: TIER_NAMES[values.findIndex((v) => v === order[best])] };
}

/** Union. Each item belongs to the highest tier that lists it. */
function oracleUnion(values: unknown[]): Map<string, Tier> {
  const out = new Map<string, Tier>();
  values.forEach((list, i) => {
    for (const item of (list as string[] | undefined) ?? []) if (!out.has(item)) out.set(item, TIER_NAMES[i]);
  });
  return out;
}

/** Intersection over the tiers that set the list; no tier sets it = unrestricted. The list belongs to the highest tier that sets it. */
function oracleIntersection(values: unknown[], universe: readonly string[]): { restricted: boolean; values: string[]; tier: Tier } {
  const setting = values.map((list, i) => ({ list: list as string[] | undefined, i })).filter((entry) => entry.list !== undefined);
  if (setting.length === 0) return { restricted: false, values: [], tier: "default" };
  return { restricted: true, values: universe.filter((item) => setting.every((entry) => entry.list!.includes(item))), tier: TIER_NAMES[setting[0].i] };
}

// ---------------------------------------------------------------------------------------------------------------------

test("the oracle's key list names exactly the keys of the implementation, with the same merge rule", () => {
  const implemented = Object.entries(POLICY_KEYS).flatMap(([table, keys]) => Object.entries(keys).map(([key, spec]) => `${table}.${key}:${spec.merge}`));
  assert.deepEqual(sorted(implemented), sorted(PLAN_KEYS.map((row) => `${row.table}.${row.key}:${row.rule}`)));
  for (const row of PLAN_KEYS.filter((r) => r.rule === "max")) assert.deepEqual((POLICY_KEYS as any)[row.table][row.key].values, row.values, "the order of restriction");
});

let tableRows = 0;
for (const row of PLAN_KEYS) {
  const domain = domainOf(row);
  test(`precedence table: ${row.table}.${row.key} (${row.rule}), ${domain.length ** 3} combinations`, () => {
    for (const s of domain) {
      for (const u of domain) {
        for (const p of domain) {
          tableRows++;
          const values = [s, u, p];
          const label = `${row.table}.${row.key} system=${JSON.stringify(s)} user=${JSON.stringify(u)} project=${JSON.stringify(p)}`;
          const policy = merge3(...(values.map((v) => (v === undefined ? undefined : documentWith(row, v))) as [PolicyDocument?, PolicyDocument?, PolicyDocument?]));
          const got = at(policy, row);
          if (row.rule === "or") {
            const want = oracleOr(values);
            assert.deepEqual([got.value, got.source.tier], [want.value, want.tier], label);
            if (want.tier !== "default") assert.deepEqual([got.source.file, got.source.key], [FILES[want.tier], `${row.table}.${row.key}`], label);
          } else if (row.rule === "max") {
            const want = oracleMax(values, row.values);
            assert.deepEqual([got.value, got.source.tier], [want.value, want.tier], label);
          } else if (row.rule === "union") {
            const want = oracleUnion(values);
            assert.deepEqual(sorted(got.values), sorted([...want.keys()]), label);
            assert.deepEqual(new Map(got.items.map((item: any) => [item.value, item.source.tier])), want, label);
          } else {
            const want = oracleIntersection(values, row.values);
            assert.deepEqual([got.restricted, sorted(got.values), got.source.tier], [want.restricted, sorted(want.values), want.tier], label);
            for (const item of got.items) assert.equal(item.source.tier, want.tier, label);
          }
        }
      }
    }
  });
}

test("precedence table size", () => {
  // 10 booleans and 2 enumerations of 3 values (27 each), 9 lists of 5 values (125 each).
  assert.equal(tableRows, 10 * 27 + 2 * 27 + 9 * 125);
});

const STRICT_STATES: { name: string; approval?: Record<string, boolean>; own?: boolean; key?: string }[] = [
  { name: "absent" },
  { name: "strict", approval: { strict: true }, own: true, key: "approval.strict" },
  { name: "specific", approval: { disable_auto: true }, own: true, key: "approval.disable_auto" },
  { name: "both", approval: { strict: true, disable_auto: true }, own: true, key: "approval.disable_auto" },
  { name: "strict=false", approval: { strict: false } },
  { name: "specific=false", approval: { disable_auto: false }, own: false, key: "approval.disable_auto" },
  { name: "strict over specific=false", approval: { strict: true, disable_auto: false }, own: true, key: "approval.strict" },
];

test(`approval.strict is shorthand for the three disable keys: ${STRICT_STATES.length ** 3} combinations, value and deciding tier`, () => {
  for (const specific of ["disable_auto", "disable_yes", "disable_full_access"]) {
    const rename = (state: (typeof STRICT_STATES)[number]) => ({
      ...state,
      approval: state.approval && Object.fromEntries(Object.entries(state.approval).map(([k, v]) => [k === "disable_auto" ? specific : k, v])),
      key: state.key?.replace("disable_auto", specific),
    });
    for (const s of STRICT_STATES.map(rename)) {
      for (const u of STRICT_STATES.map(rename)) {
        for (const p of STRICT_STATES.map(rename)) {
          const states = [s, u, p];
          const value = states.some((state) => state.own === true);
          const index = states.findIndex((state) => state.own === value);
          const policy = merge3(...(states.map((state) => (state.approval ? { approval: state.approval } : undefined)) as [PolicyDocument?, PolicyDocument?, PolicyDocument?]));
          const got = (policy.approval as any)[specific];
          const label = `${specific}: ${states.map((state) => state.name).join(" / ")}`;
          assert.equal(got.value, value, label);
          assert.equal(got.source.tier, index === -1 ? "default" : TIER_NAMES[index], label);
          if (index !== -1) assert.equal(got.source.key, states[index].key, label);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// "At least as restrictive", per key type; independent of the merge.

const VERIFICATION_ORDER = ["off", "record", "approve", "block"];

/** Every way `policy` is less restrictive than `floor`. Empty when it is at least as restrictive on every key. */
function looserThan(policy: EffectivePolicy, floor: EffectivePolicy): string[] {
  const problems: string[] = [];
  for (const row of PLAN_KEYS) {
    const got = at(policy, row);
    const base = at(floor, row);
    const name = `${row.table}.${row.key}`;
    if (row.rule === "or" && base.value === true && got.value !== true) problems.push(`${name}: was true, is ${got.value}`);
    if (row.rule === "max" && base.value !== undefined && row.values.indexOf(got.value) < row.values.indexOf(base.value)) problems.push(`${name}: was ${base.value}, is ${got.value}`);
    if (row.rule === "union") for (const item of base.values) if (!got.values.includes(item)) problems.push(`${name}: lost ${item}`);
    if (row.rule === "intersection" && base.restricted) {
      if (!got.restricted) problems.push(`${name}: was restricted, is unrestricted`);
      for (const item of got.values) if (!base.values.includes(item)) problems.push(`${name}: gained ${item}`);
    }
  }
  // Where `floor` says something about verification, the mode in force may not drop and no exemption may appear. (Where
  // it says nothing, an approved project file may still relax the built-in default, as it can today.)
  if (floor.verification.mode.value !== undefined || floor.verification.protected.values.length > 0) {
    const mode = effectiveVerificationMode(policy).value;
    const baseMode = effectiveVerificationMode(floor).value;
    if (VERIFICATION_ORDER.indexOf(mode) < VERIFICATION_ORDER.indexOf(baseMode)) problems.push(`verification mode in force: was ${baseMode}, is ${mode}`);
    for (const glob of policy.verification.relaxation?.allow ?? []) problems.push(`verification allow: gained ${glob}`);
  }
  return problems;
}

/** A document's values in a canonical form (lists as sorted sets), to compare documents as values. */
function canonical(document: PolicyDocument): Loose {
  const out: Loose = {};
  for (const row of PLAN_KEYS) {
    const value = (document as Loose)[row.table]?.[row.key];
    if (value === undefined) continue;
    (out[row.table] ??= {})[row.key] = Array.isArray(value) ? [...new Set(value as string[])].sort() : value;
  }
  return out;
}

/** The values of an effective policy, attribution dropped. */
function valuesOf(policy: EffectivePolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of PLAN_KEYS) {
    const got = at(policy, row);
    out[`${row.table}.${row.key}`] = row.rule === "or" || row.rule === "max" ? got.value : row.rule === "union" ? sorted(got.values) : got.restricted ? sorted(got.values) : "unrestricted";
  }
  return out;
}

const TRIPLES = 400;

test(`the meet is idempotent, commutative and associative, and the empty document is its identity (${TRIPLES} generated triples)`, () => {
  const random = seeded(0xa16e);
  for (let i = 0; i < TRIPLES; i++) {
    const [a, b, c] = [randomDocument(random), randomDocument(random), randomDocument(random)];
    assert.deepEqual(canonical(meetDocuments(a, a)), canonical(a), "idempotent");
    assert.deepEqual(canonical(meetDocuments(a, {})), canonical(a), "identity, right");
    assert.deepEqual(canonical(meetDocuments({}, a)), canonical(a), "identity, left");
    assert.deepEqual(canonical(meetDocuments(a, b)), canonical(meetDocuments(b, a)), "commutative");
    assert.deepEqual(canonical(meetDocuments(meetDocuments(a, b), c)), canonical(meetDocuments(a, meetDocuments(b, c))), "associative");
  }
});

test(`mergePolicies: the same values in every tier order, equal to the meet of the documents, and monotone (${TRIPLES} generated triples)`, () => {
  const random = seeded(0x3e7a);
  for (let i = 0; i < TRIPLES; i++) {
    const [a, b, c] = [randomDocument(random), randomDocument(random), randomDocument(random)];
    const all = merge3(a, b, c);
    const values = valuesOf(all);
    for (const [x, y, z] of [[a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) assert.deepEqual(valuesOf(merge3(x, y, z)), values, "tier order does not change a value");
    assert.deepEqual(values, valuesOf(merge3(meetDocuments(meetDocuments(a, b), c))), "the merge is the meet of the documents");
    assert.deepEqual(valuesOf(merge3(a, a, a)), valuesOf(merge3(a)), "idempotent");
    // Monotone: adding a tier, in any position, never makes any key less restrictive.
    assert.deepEqual(looserThan(merge3(a), merge3()), []);
    assert.deepEqual(looserThan(merge3(a, b), merge3(a)), []);
    assert.deepEqual(looserThan(merge3(a, b), merge3(undefined, b)), []);
    assert.deepEqual(looserThan(all, merge3(a, b)), []);
    assert.deepEqual(looserThan(all, merge3(a, undefined, c)), []);
    assert.deepEqual(looserThan(all, merge3(undefined, b, c)), []);
  }
});

test("the comparison used by the properties does notice a looser policy", () => {
  for (const row of PLAN_KEYS) {
    const strict = row.rule === "or" ? true : row.rule === "max" ? row.values[1] : row.rule === "union" ? [...row.values] : [row.values[0]];
    const loose = row.rule === "or" ? false : row.rule === "max" ? row.values[0] : row.rule === "union" ? [row.values[0]] : [...row.values];
    assert.equal(looserThan(merge3(documentWith(row, loose)), merge3(documentWith(row, strict))).length > 0, true, `${row.table}.${row.key}`);
    assert.equal(looserThan(merge3(), merge3(documentWith(row, strict))).length > 0, true, `${row.table}.${row.key} absent`);
    assert.deepEqual(looserThan(merge3(documentWith(row, strict)), merge3(documentWith(row, loose))), []);
  }
});

test("an absent tier is the identity: removing the user or project tier never goes below the system tier", () => {
  const random = seeded(0x1d);
  for (let i = 0; i < 200; i++) {
    const system = randomDocument(random);
    const alone = merge3(system);
    assert.deepEqual(valuesOf(merge3(system, {}, {})), valuesOf(alone));
    assert.deepEqual(looserThan(merge3(system, randomDocument(random), undefined), alone), []);
    assert.deepEqual(looserThan(merge3(system, undefined, randomDocument(random)), alone), []);
  }
  assert.deepEqual(merge3().tiers, []);
  assert.deepEqual(merge3({}, undefined, {}).tiers, ["system", "project"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// A project policy cannot loosen a system policy.

/** What a repository can put in `.nexus-security.json`, tightening and weakening, well-formed and not. */
const PROJECT_FILES: { name: string; raw: unknown }[] = [
  { name: "an empty object", raw: {} },
  { name: "mode off", raw: { verificationPaths: { mode: "off" } } },
  { name: "mode record", raw: { verificationPaths: { mode: "record" } } },
  { name: "mode approve", raw: { verificationPaths: { mode: "approve" } } },
  { name: "mode block", raw: { verificationPaths: { mode: "block" } } },
  { name: "allow everything", raw: { verificationPaths: { allow: ["**", "ci/**", "scripts/verify.sh"] } } },
  { name: "mode off and allow", raw: { verificationPaths: { mode: "off", allow: ["ci/**"] } } },
  { name: "extra and allow of the same glob", raw: { verificationPaths: { extra: ["ci/**"], allow: ["ci/**"] } } },
  { name: "every legacy key", raw: { blockedCommands: ["curl evil"], protectedPaths: ["dist/**"], allowedDomains: ["example.com", "attacker.example"], verificationPaths: { mode: "record", extra: ["x"], allow: ["y"] } } },
  { name: "an empty domain allowlist", raw: { allowedDomains: [] } },
  { name: "a wide domain allowlist", raw: { allowedDomains: ["example.com", "*.example.org", "attacker.example"] } },
  { name: "keys of the managed format", raw: { approval: { strict: false, disable_auto: false }, sandbox: { required: false }, mcp: { allow: ["evil"] }, plugins: { allow: [] }, workspace: { disable_env_trust: false }, egress: { inspector: "off" }, egressInspector: { mode: "off" } } },
  { name: "an unknown mode", raw: { verificationPaths: { mode: "none" } } },
  { name: "wrong types everywhere", raw: { blockedCommands: "rm", protectedPaths: 7, allowedDomains: { a: 1 }, verificationPaths: [] } },
  { name: "wrong item types", raw: { protectedPaths: [1, null, "", "ok"], allowedDomains: ["UPPER.example", 5, "example.com"], verificationPaths: { extra: [{}], allow: [3] } } },
  { name: "prototype keys", raw: JSON.parse('{"__proto__": {"verificationPaths": {"mode": "off"}}, "constructor": {"prototype": {}}}') },
  { name: "malformed: an array", raw: [] },
  { name: "malformed: null", raw: null },
  { name: "malformed: a string", raw: "verificationPaths" },
  { name: "malformed: a number", raw: 0 },
];

/** The project tier the loader would build from `raw` (none when the file is unusable), for one approval state. */
function projectTier(raw: unknown, relaxationsApply: boolean): ProjectPolicyTier | undefined {
  try {
    const parts = projectPolicyFromSecurityJson(raw);
    return { document: parts.restrictive, file: FILES.project, relaxations: parts.relaxations, relaxationsApply };
  } catch {
    return undefined;
  }
}

test("a project policy cannot loosen a system policy: every key, every system value, every project file and approval state", () => {
  const random = seeded(0xbeef);
  // Besides the files a repository can write, project tiers that carry an arbitrary document of the managed shape.
  const synthetic: { name: string; tier: (apply: boolean) => ProjectPolicyTier | undefined }[] = Array.from({ length: 40 }, (_, i) => {
    const document = randomDocument(random);
    const relaxations = [{}, { verification_mode: "off" as const }, { verification_mode: "record" as const, verification_allow: ["**"] }, { verification_allow: ["ci/**"] }][i % 4];
    return { name: `generated document ${i}`, tier: (apply) => ({ document, file: FILES.project, relaxations, relaxationsApply: apply }) };
  });
  const projects = [{ name: "no project file", tier: () => undefined }, ...PROJECT_FILES.map((file) => ({ name: file.name, tier: (apply: boolean) => projectTier(file.raw, apply) })), ...synthetic];
  // Trusted with an approved file and environment-trusted both mean "relaxations apply"; untrusted means they do not.
  const states = [
    { name: "trusted, approved", apply: true },
    { name: "environment-trusted", apply: true },
    { name: "untrusted", apply: false },
  ];
  let cases = 0;
  for (const row of PLAN_KEYS) {
    for (const systemValue of domainOf(row).slice(1)) {
      const system = tier("system", documentWith(row, systemValue))!;
      const alone = mergePolicies(system);
      for (const project of projects) {
        for (const state of states) {
          cases++;
          const label = `system ${row.table}.${row.key}=${JSON.stringify(systemValue)}; project: ${project.name}; ${state.name}`;
          const effective = mergePolicies(system, undefined, project.tier(state.apply));
          assert.deepEqual(looserThan(effective, alone), [], label);
          // The system's own value survives exactly, for the types where "at least as restrictive" pins it.
          if (row.rule === "or" && systemValue === true) assert.deepEqual([at(effective, row).value, at(effective, row).source.tier], [true, "system"], label);
          if (row.table === "verification") {
            assert.equal(effective.verification.relaxation, undefined, `${label}: a relaxation applies although the system tier sets [verification]`);
            assert.ok(VERIFICATION_ORDER.indexOf(effectiveVerificationMode(effective).value) >= VERIFICATION_ORDER.indexOf("approve"), label);
          }
        }
      }
    }
  }
  assert.equal(cases, (10 * 2 + 2 * 2 + 9 * 4) * projects.length * states.length);
  assert.equal(projects.length, 61);
});

test("the same holds for the user tier, and for both managed tiers together", () => {
  const relaxing = projectTier({ verificationPaths: { mode: "off", allow: ["**"] } }, true)!;
  for (const key of ["mode", "protected"] as const) {
    const managed: PolicyTier = { document: { verification: key === "mode" ? { mode: "approve" } : { protected: ["ci/**"] } }, file: FILES.user };
    for (const [system, user] of [[managed, undefined], [undefined, managed], [managed, managed]] as const) {
      const effective = mergePolicies(system, user, relaxing);
      assert.equal(effective.verification.relaxation, undefined);
      assert.equal(effective.verification.relaxationStatus, "void_managed");
      assert.deepEqual(effective.verification.relaxationVoidedBy, { tier: system ? "system" : "user", file: FILES.user, key: `verification.${key}` });
      assert.equal(effectiveVerificationMode(effective).value, "approve");
    }
  }
});

const VERIFICATION_PROJECTS: { name: string; raw?: unknown; floor?: string; relaxMode?: string; allow?: string[] }[] = [
  { name: "absent" },
  { name: "empty", raw: {} },
  { name: "off", raw: { verificationPaths: { mode: "off" } }, relaxMode: "off" },
  { name: "record", raw: { verificationPaths: { mode: "record" } }, relaxMode: "record" },
  { name: "approve", raw: { verificationPaths: { mode: "approve" } }, floor: "approve" },
  { name: "block", raw: { verificationPaths: { mode: "block" } }, floor: "block" },
  { name: "allow only", raw: { verificationPaths: { allow: ["ci/**"] } }, allow: ["ci/**"] },
  { name: "off and allow", raw: { verificationPaths: { mode: "off", allow: ["ci/**"] } }, relaxMode: "off", allow: ["ci/**"] },
];

test("verification mode table: managed floors x managed protected paths x the project's legacy modes x approval (288 combinations)", () => {
  let rows = 0;
  const floors = [undefined, "approve", "block"] as const;
  for (const s of floors) {
    for (const u of floors) {
      for (const managedProtected of [false, true]) {
        for (const project of VERIFICATION_PROJECTS) {
          for (const apply of [true, false]) {
            rows++;
            const label = `system=${s} user=${u} protected=${managedProtected} project=${project.name} apply=${apply}`;
            const system = s || managedProtected ? { verification: { ...(s ? { mode: s } : {}), ...(managedProtected ? { protected: ["ci/**"] } : {}) } } : undefined;
            const effective = mergePolicies(tier("system", system), tier("user", u ? { verification: { mode: u } } : undefined), project.raw === undefined ? undefined : projectTier(project.raw, apply));
            // The oracle. A floor is the maximum of the floors set; relaxations count only when approved and no managed tier speaks.
            const managedSpeaks = s !== undefined || u !== undefined || managedProtected;
            const floor = [s, u, project.floor].filter((m): m is string => m !== undefined).sort((a, b) => VERIFICATION_ORDER.indexOf(b) - VERIFICATION_ORDER.indexOf(a))[0];
            const asksToRelax = project.relaxMode !== undefined || project.allow !== undefined;
            const relaxed = asksToRelax && apply && !managedSpeaks;
            const wantMode = floor ?? (relaxed && project.relaxMode ? project.relaxMode : "approve");
            const wantStatus = !asksToRelax ? "none" : managedSpeaks ? "void_managed" : apply ? "applied" : "not_approved";
            const inForce = effectiveVerificationMode(effective);
            assert.equal(inForce.value, wantMode, label);
            assert.equal(effective.verification.relaxationStatus, wantStatus, label);
            assert.deepEqual(effective.verification.relaxation?.allow ?? [], relaxed ? (project.allow ?? []) : [], label);
            assert.equal(effective.verification.relaxation?.mode, relaxed ? project.relaxMode : undefined, label);
            const wantTier = floor !== undefined ? (s === floor ? "system" : u === floor ? "user" : "project") : relaxed && project.relaxMode ? "project" : "default";
            assert.equal(inForce.source.tier, wantTier, label);
          }
        }
      }
    }
  }
  assert.equal(rows, 288);
});

// ---------------------------------------------------------------------------------------------------------------------

test("the project adapter: tightenings become a document, weakenings are kept apart, nothing is dropped silently", () => {
  const parts = projectPolicyFromSecurityJson({
    version: "1",
    blockedCommands: ["curl | sh", "dd if="],
    protectedPaths: ["dist/**", "dist/**"],
    allowedDomains: ["example.com", "Not A Host"],
    verificationPaths: { mode: "record", extra: ["tools/check.sh"], allow: ["ci/**"] },
    egressInspector: { mode: "off" },
  });
  assert.deepEqual(parts.restrictive, { paths: { protected: ["dist/**"] }, egress: { allowed_domains: ["example.com"] }, verification: { protected: ["tools/check.sh"] } });
  assert.deepEqual(parts.relaxations, { verification_mode: "record", verification_allow: ["ci/**"] });
  // Substring patterns of the destructive-command tripwire are not prefix rules: they stay what they are.
  assert.deepEqual(parts.blockedCommandPatterns, ["curl | sh", "dd if="]);
  assert.equal(parts.restrictive.commands, undefined);
  assert.deepEqual(parts.notices, ["allowedDomains: an entry that is not valid was ignored", "egressInspector is ignored: a repository cannot change the egress inspector"]);

  assert.deepEqual(projectPolicyFromSecurityJson({ verificationPaths: { mode: "block" } }).restrictive, { verification: { mode: "block" } });
  assert.deepEqual(projectPolicyFromSecurityJson({ verificationPaths: { mode: "block" } }).relaxations, {});
  // A dropped allowlist entry narrows the list; an empty list stays a list.
  assert.deepEqual(projectPolicyFromSecurityJson({ allowedDomains: ["BAD"] }).restrictive, { egress: { allowed_domains: [] } });
  assert.deepEqual(projectPolicyFromSecurityJson({ allowedDomains: "example.com" }).restrictive, {});
  assert.throws(() => projectPolicyFromSecurityJson([]), /the file must contain a JSON object/);
  // The adapter has no path from a project file to a managed-only table.
  for (const file of PROJECT_FILES) {
    const tierOf = projectTier(file.raw, true);
    for (const table of Object.keys(tierOf?.document ?? {})) assert.ok(["paths", "egress", "verification"].includes(table), `${file.name}: ${table}`);
    assert.deepEqual(Object.keys(tierOf?.document.egress ?? {}).filter((key) => key !== "allowed_domains"), [], file.name);
  }
});

test("the effective policy is frozen at every depth", () => {
  const policy = merge3({ approval: { strict: true, require_human: ["exec"] }, mcp: { allow: ["github"] } }, { commands: { forbid: ["git push"] } }, {});
  const walk = (value: unknown, where: string): void => {
    if (!value || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value), where);
    for (const [key, member] of Object.entries(value)) walk(member, `${where}.${key}`);
  };
  walk(policy, "policy");
  assert.throws(() => ((policy.approval.disable_auto as any).value = false), TypeError);
  assert.throws(() => (policy.mcp.allow.values as string[]).push("evil"), TypeError);
  assert.throws(() => (policy.commands.forbid.items as unknown[]).pop(), TypeError);
  assert.throws(() => ((policy as any).sandbox = {}), TypeError);
});

test("the merge does not change or keep hold of its inputs", () => {
  const document: PolicyDocument = { mcp: { allow: ["github"] }, commands: { forbid: ["git push"] } };
  const before = JSON.stringify(document);
  const policy = merge3(document, document);
  document.mcp!.allow!.push("evil");
  document.commands!.forbid!.push("ls");
  assert.deepEqual([policy.mcp.allow.values, policy.commands.forbid.values, policy.mcp.allow.tiers[0].values], [["github"], ["git push"], ["github"]]);
  assert.deepEqual(meetDocuments(JSON.parse(before), {}), JSON.parse(before));
});

test("describeSource: the tier, the file and the key; the default has no file", () => {
  assert.equal(describeSource({ tier: "system", file: "/fake/etc/nexus/policy.toml", key: "approval.strict", line: 3 }), "[policy: system /fake/etc/nexus/policy.toml approval.strict]");
  assert.equal(describeSource({ tier: "user", file: "/home/a/.config/nexus/policy.toml", key: "mcp.allow" }), "[policy: user /home/a/.config/nexus/policy.toml mcp.allow]");
  assert.equal(describeSource({ tier: "project", key: "verificationPaths.mode" }), "[policy: project verificationPaths.mode]");
  assert.equal(describeSource({ tier: "operator-rules", file: "/home/a/.config/nexus/command_rules.json", key: "rules[2]" }), "[policy: operator-rules /home/a/.config/nexus/command_rules.json rules[2]]");
  assert.equal(describeSource({ tier: "default", key: "approval.strict" }), "[policy: default]");
  const lines = new Map([["approval.strict", 4]]);
  const policy = mergePolicies({ document: { approval: { strict: true } }, file: "/fake/etc/nexus/policy.toml", lines });
  assert.deepEqual(policy.approval.disable_yes.source, { tier: "system", file: "/fake/etc/nexus/policy.toml", key: "approval.strict", line: 4 });
});

// ---------------------------------------------------------------------------------------------------------------------
// The clamp helpers: GV-5 refusals, each message exact and carrying its source.

const SYS = "/fake/etc/nexus/policy.toml";
const sys = (document: PolicyDocument): EffectivePolicy => mergePolicies({ document, file: SYS });
const NONE = mergePolicies();

test("strict mode refuses --yes and approval mode auto, naming the policy source", () => {
  const strict = sys({ approval: { strict: true } });
  const yes = clampApprovalRequest(strict, { mode: "review", modeOrigin: "default", yes: true });
  assert.deepEqual(yes, { allowed: false, message: "--yes is refused: managed policy disables it. [policy: system /fake/etc/nexus/policy.toml approval.strict]", source: { tier: "system", file: SYS, key: "approval.strict" } });
  for (const origin of ["--mode auto", "NEXUS_APPROVAL_MODE=auto"]) {
    assert.deepEqual(clampApprovalRequest(strict, { mode: "auto", modeOrigin: origin }), {
      allowed: false,
      message: `${origin} is refused: managed policy disables approval mode 'auto'. [policy: system /fake/etc/nexus/policy.toml approval.strict]`,
      source: { tier: "system", file: SYS, key: "approval.strict" },
    });
  }
  assert.deepEqual(clampApprovalRequest(strict, { mode: "review", modeOrigin: "--mode review", fullAccessOrigin: "--full-access" }), {
    allowed: false,
    message: "--full-access is refused: managed policy disables full access. [policy: system /fake/etc/nexus/policy.toml approval.strict]",
    source: { tier: "system", file: SYS, key: "approval.strict" },
  });
  // What strict leaves available.
  assert.deepEqual(clampApprovalRequest(strict, { mode: "review", modeOrigin: "default" }), { allowed: true, value: { mode: "review", fullAccess: false }, source: { tier: "system", file: SYS, key: "approval.strict" } });
  const readOnly = clampApprovalRequest(strict, { mode: "read-only", modeOrigin: "--read-only" });
  assert.ok(readOnly.allowed && readOnly.value.mode === "read-only");
});

test("the specific keys refuse the same requests with their own key as the source", () => {
  const user = (document: PolicyDocument): EffectivePolicy => mergePolicies(undefined, { document, file: "/fake/home/.config/nexus/policy.toml" });
  assert.deepEqual(clampApprovalRequest(user({ approval: { disable_yes: true } }), { mode: "review", modeOrigin: "default", yes: true }), {
    allowed: false,
    message: "--yes is refused: managed policy disables it. [policy: user /fake/home/.config/nexus/policy.toml approval.disable_yes]",
    source: { tier: "user", file: "/fake/home/.config/nexus/policy.toml", key: "approval.disable_yes" },
  });
  const noAuto = clampApprovalRequest(user({ approval: { disable_auto: true } }), { mode: "review", modeOrigin: "default", yes: true });
  assert.equal(!noAuto.allowed && noAuto.message, "--yes is refused: it selects approval mode 'auto', which managed policy disables. [policy: user /fake/home/.config/nexus/policy.toml approval.disable_auto]");
  const noFull = clampApprovalRequest(user({ approval: { disable_full_access: true } }), { mode: "review", modeOrigin: "default", yes: true });
  assert.equal(!noFull.allowed && noFull.message, "--yes is refused: it grants full access, which managed policy disables. [policy: user /fake/home/.config/nexus/policy.toml approval.disable_full_access]");
  // disable_yes alone leaves --mode auto.
  assert.ok(clampApprovalRequest(user({ approval: { disable_yes: true } }), { mode: "auto", modeOrigin: "--mode auto" }).allowed);
  // No policy: everything asked is what is returned, attributed to the default.
  assert.deepEqual(clampApprovalRequest(NONE, { mode: "review", modeOrigin: "default", yes: true }), { allowed: true, value: { mode: "auto", fullAccess: true }, source: { tier: "default", key: "approval.disable_yes" } });
  assert.equal(describeSource(clampApprovalRequest(NONE, { mode: "auto", modeOrigin: "--mode auto" }).source), "[policy: default]");
});

test("a mode change or an 'always' answer during a session is clamped with a notice, not refused", () => {
  const strict = sys({ approval: { strict: true } });
  assert.deepEqual(clampRuntimeApprovalMode(strict, "review", "auto", "/mode auto"), {
    mode: "review",
    changed: false,
    notice: "/mode auto is ignored: managed policy disables approval mode 'auto'; the mode stays 'review'. [policy: system /fake/etc/nexus/policy.toml approval.strict]",
    source: { tier: "system", file: SYS, key: "approval.strict" },
  });
  assert.deepEqual(clampRuntimeApprovalMode(strict, "review", "read-only", "/mode read-only"), { mode: "read-only", changed: true, source: { tier: "system", file: SYS, key: "approval.strict" } });
  assert.deepEqual(clampRuntimeApprovalMode(NONE, "review", "auto", "/mode auto"), { mode: "auto", changed: true, source: { tier: "default", key: "approval.disable_auto" } });
  assert.deepEqual(clampAlwaysApproval(strict), {
    remember: false,
    approveThisCall: true,
    notice: "'always' is not remembered: managed policy disables approval mode 'auto'; this one call is approved. [policy: system /fake/etc/nexus/policy.toml approval.strict]",
    source: { tier: "system", file: SYS, key: "approval.strict" },
  });
  assert.deepEqual(clampAlwaysApproval(NONE), { remember: true, approveThisCall: true, source: { tier: "default", key: "approval.disable_auto" } });
});

test("require_human names the effect and its source", () => {
  const policy = sys({ approval: { require_human: ["exec", "egress"] } });
  assert.deepEqual(requiresHuman(policy, "exec"), {
    required: true,
    message: "approval required: managed policy requires a human decision for exec, also under full access. [policy: system /fake/etc/nexus/policy.toml approval.require_human]",
    source: { tier: "system", file: SYS, key: "approval.require_human" },
  });
  assert.deepEqual(requiresHuman(policy, "write_workspace"), { required: false, source: { tier: "default", key: "approval.require_human" } });
});

test("sandbox.required refuses an explicit 'none' and turns no request into auto; forbid_network refuses the network", () => {
  const required = sys({ sandbox: { required: true, forbid_network: true } });
  assert.deepEqual(clampSandbox(required, { mode: "none", origin: "--sandbox none" }), {
    allowed: false,
    message: "--sandbox none is refused: managed policy requires the sandbox. [policy: system /fake/etc/nexus/policy.toml sandbox.required]",
    source: { tier: "system", file: SYS, key: "sandbox.required" },
  });
  assert.deepEqual(clampSandbox(required, { mode: undefined }), {
    allowed: true,
    value: { mode: "auto", requireSandbox: true },
    source: { tier: "system", file: SYS, key: "sandbox.required" },
    notice: "the sandbox is on (auto): managed policy requires it. [policy: system /fake/etc/nexus/policy.toml sandbox.required]",
  });
  assert.deepEqual(clampSandbox(required, { mode: "docker", origin: "--sandbox docker" }), { allowed: true, value: { mode: "docker", requireSandbox: true }, source: { tier: "system", file: SYS, key: "sandbox.required" } });
  assert.deepEqual(clampSandbox(NONE, { mode: "none", origin: "--sandbox none" }), { allowed: true, value: { mode: "none", requireSandbox: false }, source: { tier: "default", key: "sandbox.required" } });
  for (const origin of ["--sandbox-network", "NEXUS_SANDBOX_NETWORK=1"]) {
    assert.deepEqual(clampSandboxNetwork(required, true, origin), {
      allowed: false,
      message: `${origin} is refused: managed policy forbids network access in the sandbox. [policy: system /fake/etc/nexus/policy.toml sandbox.forbid_network]`,
      source: { tier: "system", file: SYS, key: "sandbox.forbid_network" },
    });
  }
  assert.deepEqual(clampSandboxNetwork(required, false, "default"), { allowed: true, value: false, source: { tier: "system", file: SYS, key: "sandbox.forbid_network" } });
  assert.deepEqual(clampSandboxNetwork(NONE, true, "--sandbox-network"), { allowed: true, value: true, source: { tier: "default", key: "sandbox.forbid_network" } });
});

test("an MCP server outside mcp.allow is refused; a workspace server is refused under disable_workspace", () => {
  const policy = sys({ mcp: { allow: ["github", "command:/usr/local/bin/mcp-files", "url:https://mcp.example.com"], disable_workspace: true } });
  const source = { tier: "system", file: SYS, key: "mcp.allow" };
  assert.deepEqual(permitsMcpServer(policy, { name: "shell", command: "/usr/bin/evil", fromWorkspace: false }), {
    allowed: false,
    message: "MCP server 'shell' is not started: it is not in the managed allowlist (mcp.allow). [policy: system /fake/etc/nexus/policy.toml mcp.allow]",
    source,
  });
  assert.ok(permitsMcpServer(policy, { name: "github", fromWorkspace: false }).allowed);
  assert.ok(permitsMcpServer(policy, { name: "anything", command: "/usr/local/bin/mcp-files", fromWorkspace: false }).allowed);
  assert.ok(permitsMcpServer(policy, { name: "remote", url: "https://mcp.example.com/sse?x=1", fromWorkspace: false }).allowed);
  assert.ok(!permitsMcpServer(policy, { name: "remote", url: "https://mcp.example.com.evil.test/sse", fromWorkspace: false }).allowed);
  assert.ok(!permitsMcpServer(policy, { name: "remote", url: "http://mcp.example.com/sse", fromWorkspace: false }).allowed, "another scheme is another origin");
  assert.ok(!permitsMcpServer(policy, { name: "remote", url: "not a url", fromWorkspace: false }).allowed);
  assert.ok(!permitsMcpServer(policy, { name: "x", command: "/usr/local/bin/mcp-files-2", fromWorkspace: false }).allowed);
  assert.deepEqual(permitsMcpServer(policy, { name: "github", fromWorkspace: true }), {
    allowed: false,
    message: "MCP server 'github' is not started: managed policy disables MCP servers configured by the workspace. [policy: system /fake/etc/nexus/policy.toml mcp.disable_workspace]",
    source: { tier: "system", file: SYS, key: "mcp.disable_workspace" },
  });
  // An empty list admits nothing; no list admits everything.
  assert.ok(!permitsMcpServer(sys({ mcp: { allow: [] } }), { name: "github", fromWorkspace: false }).allowed);
  assert.deepEqual(permitsMcpServer(NONE, { name: "github", fromWorkspace: true }).source, { tier: "default", key: "mcp.allow" });
  // The refusal names the tier whose list excludes the server.
  const both = mergePolicies({ document: { mcp: { allow: ["github", "files"] } }, file: SYS }, { document: { mcp: { allow: ["github"] } }, file: "/fake/user.toml" });
  const refused = permitsMcpServer(both, { name: "files", fromWorkspace: false });
  assert.deepEqual(!refused.allowed && refused.source, { tier: "user", file: "/fake/user.toml", key: "mcp.allow" });
});

test("a plugin file outside plugins.allow is refused, by hash or by path", () => {
  const hash = "ab".repeat(32);
  const policy = sys({ plugins: { allow: [`sha256:${hash}`, "file:/opt/nexus/plugins/audit.mjs"] } });
  assert.deepEqual(permitsPlugin(policy, { path: "/ws/plugins/x.mjs", sha256: "cd".repeat(32), fromWorkspace: true }), {
    allowed: false,
    message: "plugin '/ws/plugins/x.mjs' is not imported: it is not in the managed allowlist (plugins.allow). [policy: system /fake/etc/nexus/policy.toml plugins.allow]",
    source: { tier: "system", file: SYS, key: "plugins.allow" },
  });
  assert.ok(permitsPlugin(policy, { path: "/anywhere/y.mjs", sha256: hash, fromWorkspace: true }).allowed);
  assert.ok(permitsPlugin(policy, { path: "/opt/nexus/plugins/audit.mjs", sha256: "00".repeat(32), fromWorkspace: false }).allowed);
  assert.deepEqual(permitsPlugin(sys({ plugins: { disable_workspace: true } }), { path: "/ws/plugins/x.mjs", sha256: hash, fromWorkspace: true }), {
    allowed: false,
    message: "plugin '/ws/plugins/x.mjs' is not imported: managed policy disables plugins from the workspace. [policy: system /fake/etc/nexus/policy.toml plugins.disable_workspace]",
    source: { tier: "system", file: SYS, key: "plugins.disable_workspace" },
  });
  assert.ok(permitsPlugin(NONE, { path: "/ws/plugins/x.mjs", sha256: hash, fromWorkspace: true }).allowed);
});

test("managed command prefixes: forbid refuses, prompt asks and is reported as holding under full access; there is no allow", () => {
  const policy = sys({ commands: { forbid: ["git push", "rm -rf"], prompt: ["npm publish", "git"] } });
  const decide = (command: string) => decideManagedCommand(policy, splitSubcommands(command));
  assert.deepEqual(decide("git push origin main"), {
    decision: "forbidden",
    rule: "git push",
    message: "command refused: managed policy forbids 'git push'. [policy: system /fake/etc/nexus/policy.toml commands.forbid]",
    source: { tier: "system", file: SYS, key: "commands.forbid" },
  });
  assert.deepEqual(decide("npm publish --tag next"), {
    decision: "prompt",
    rule: "npm publish",
    message: "approval required: managed policy asks before 'npm publish', also under full access. [policy: system /fake/etc/nexus/policy.toml commands.prompt]",
    source: { tier: "system", file: SYS, key: "commands.prompt" },
    holdsUnderFullAccess: true,
  });
  // Any segment of a chain counts, and forbid outranks prompt.
  assert.equal(decide("ls && git push").decision, "forbidden");
  assert.equal(decide("git status; echo ok").decision, "prompt");
  assert.equal(decide("echo ok | rm -rf build").decision, "forbidden");
  // A prefix is whole words: `git pushx` and `gitk` are other commands.
  assert.equal(decide("git pushx").decision, "prompt");
  assert.deepEqual(decide("gitk"), { decision: "none" });
  assert.deepEqual(decide("ls -la"), { decision: "none" });
  assert.deepEqual(decideManagedCommand(NONE, splitSubcommands("git push")), { decision: "none" });
  assert.ok(!("allow" in POLICY_KEYS.commands));
});

test("the egress helpers: an inspector floor, a host allowlist and a secret-destination filter", () => {
  const policy = sys({ egress: { inspector: "block", allowed_domains: ["example.com", "*.example.org"], secret_destinations: ["https://api.example.com"] } });
  assert.deepEqual(clampEgressInspector(policy, "off"), {
    mode: "block",
    raised: true,
    notice: "the egress inspector runs in 'block' mode, not 'off': managed policy sets the floor. [policy: system /fake/etc/nexus/policy.toml egress.inspector]",
    source: { tier: "system", file: SYS, key: "egress.inspector" },
  });
  assert.equal(clampEgressInspector(policy, "block").raised, false);
  assert.deepEqual(clampEgressInspector(sys({ egress: { inspector: "record" } }), "block"), { mode: "block", raised: false, source: { tier: "system", file: SYS, key: "egress.inspector" } });
  assert.deepEqual(clampEgressInspector(NONE, "off"), { mode: "off", raised: false, source: { tier: "default", key: "egress.inspector" } });

  assert.ok(permitsEgressHost(policy, "example.com").allowed);
  assert.ok(permitsEgressHost(policy, "API.Example.org").allowed);
  assert.ok(!permitsEgressHost(policy, "example.org").allowed, "*.example.org is its subdomains, not the name itself");
  assert.ok(!permitsEgressHost(policy, "evilexample.org").allowed);
  assert.ok(!permitsEgressHost(policy, "sub.example.com").allowed);
  const host = permitsEgressHost(policy, "attacker.test");
  assert.equal(!host.allowed && host.message, "'attacker.test' is not reachable: it is not in the managed allowlist (egress.allowed_domains). [policy: system /fake/etc/nexus/policy.toml egress.allowed_domains]");
  assert.ok(permitsEgressHost(NONE, "attacker.test").allowed);

  assert.ok(permitsSecretDestination(policy, "https://api.example.com").allowed);
  const secret = permitsSecretDestination(policy, "https://api.example.com:8443");
  assert.equal(!secret.allowed && secret.message, "no credential is sent to 'https://api.example.com:8443': it is not in the managed allowlist (egress.secret_destinations). [policy: system /fake/etc/nexus/policy.toml egress.secret_destinations]");
});

test("workspace.disable_env_trust makes NEXUS_TRUST_WORKSPACE count for nothing", () => {
  assert.deepEqual(clampEnvTrust(sys({ workspace: { disable_env_trust: true } }), true), {
    trusted: false,
    notice: "NEXUS_TRUST_WORKSPACE is ignored: managed policy disables it. [policy: system /fake/etc/nexus/policy.toml workspace.disable_env_trust]",
    source: { tier: "system", file: SYS, key: "workspace.disable_env_trust" },
  });
  assert.deepEqual(clampEnvTrust(NONE, true), { trusted: true, source: { tier: "default", key: "workspace.disable_env_trust" } });
  assert.equal(clampEnvTrust(sys({ workspace: { disable_env_trust: true } }), false).trusted, false);
});

test("no helper turns an absent policy into a restriction, and none has an outcome that grants", () => {
  // With no tier, every answer is "as asked", attributed to the default.
  assert.equal(effectiveVerificationMode(NONE).value, "approve");
  assert.equal(describeSource(effectiveVerificationMode(NONE).source), "[policy: default]");
  for (const row of PLAN_KEYS) {
    const got = at(NONE, row);
    assert.equal((got.source ?? { tier: "default" }).tier, "default", `${row.table}.${row.key}`);
  }
});

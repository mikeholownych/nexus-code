/**
 * BG-1 / G-4: the unattended policy as a pure module. The whole decision table of `UnattendedApprovalPolicy` (both job
 * policies x every effect class x managed `require_human` x the context a caller can pass), the configuration clamp
 * and its postcondition, and the environment scrub. No auto mode, no full access and no remembered grant is reachable.
 */
import "./helpers/leak_guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalPolicy, type PolicyContext } from "../src/core/approval_policy.js";
import { EFFECT_CLASSES, type EffectClass } from "../src/core/capabilities.js";
import { buildConfigWithPolicy } from "../src/config.js";
import { mergePolicies, type EffectivePolicy, type PolicyDocument } from "../src/core/managed_policy.js";
import { DEFAULT_JOB_BUDGETS, JOB_POLICIES, type JobPolicy } from "../src/core/runner_store.js";
import {
  assertUnattended, scrubUnattendedEnv, UNATTENDED_ENV_SCRUB, UNATTENDED_SURFACE, unattendedApprovalMode, UnattendedApprovalPolicy, UnattendedClampError,
  unattendedConfig, unattendedOptions, type UnattendedJob,
} from "../src/core/unattended.js";
import type { HarnessConfig } from "../src/types.js";

const managed = (document?: PolicyDocument): EffectivePolicy => mergePolicies(document ? { document, file: "/fake/etc/nexus/policy.toml" } : undefined);
const HUMAN_EFFECTS = ["exec", "write_workspace", "egress"] as const;
/** Every subset of what `approval.require_human` can name. */
const HUMAN_SETS: Array<Array<(typeof HUMAN_EFFECTS)[number]>> = Array.from({ length: 8 }, (_, bits) => HUMAN_EFFECTS.filter((_, i) => bits & (1 << i)));
/** Every context a caller can pass: the mode and the grants an attended front end could have built up are among them. */
const CONTEXTS: PolicyContext[] = [];
for (const mode of ["review", "auto", "read-only"] as const) {
  for (const fullAccess of [false, true]) {
    for (const policyRequiresHuman of [false, true]) {
      for (const isUntrustedSource of [false, true]) {
        for (const approved of [false, true]) {
          CONTEXTS.push({ mode, trusted: true, fullAccess, policyRequiresHuman, isUntrustedSource, egressOrigin: "https://example.test", approvedEgressOrigins: new Set(approved ? ["https://example.test"] : []) });
        }
      }
    }
  }
}

/** The table, written out independently of the implementation. */
function expected(jobPolicy: JobPolicy, effect: EffectClass, human: readonly string[], context: PolicyContext): boolean {
  if (context.policyRequiresHuman || human.includes(effect)) return true;
  switch (effect) {
    case "read_workspace": case "delegate": case "internal": return false;
    case "write_workspace": return jobPolicy !== "worktree-write";
    case "exec": case "egress": return true;
    case "context_inject": return Boolean(context.isUntrustedSource);
  }
}

type PolicyFactory = (jobPolicy: JobPolicy, policy: () => EffectivePolicy) => ApprovalPolicy;

/** Every cell where `make`'s policy differs from the table. */
function mismatches(make: PolicyFactory): string[] {
  const wrong: string[] = [];
  for (const jobPolicy of JOB_POLICIES) {
    for (const human of HUMAN_SETS) {
      const effective = managed(human.length ? { approval: { require_human: human } } : undefined);
      const policy = make(jobPolicy, () => effective);
      for (const effect of EFFECT_CLASSES) {
        for (const context of CONTEXTS) {
          const got = policy.requiresDecision(effect, context);
          if (got !== expected(jobPolicy, effect, human, context)) wrong.push(`${jobPolicy} ${effect} human=[${human}] ${JSON.stringify({ ...context, approvedEgressOrigins: [...context.approvedEgressOrigins!] })} -> ${got}`);
        }
      }
    }
  }
  return wrong;
}

test("the decision table: both job policies x every effect x managed require_human x every caller context", () => {
  assert.deepEqual(EFFECT_CLASSES, ["read_workspace", "write_workspace", "exec", "egress", "delegate", "context_inject", "internal"], "a new effect class must be added to the table");
  assert.equal(JOB_POLICIES.length * HUMAN_SETS.length * EFFECT_CLASSES.length * CONTEXTS.length, 2 * 8 * 7 * 48);
  assert.deepEqual(mismatches((jobPolicy, policy) => new UnattendedApprovalPolicy(jobPolicy, policy)), []);
});

test("an unattended run is never looser than review mode except for worktree writes, and never auto", () => {
  const none = managed();
  const review = new ApprovalPolicy(() => none);
  for (const jobPolicy of JOB_POLICIES) {
    const unattended = new UnattendedApprovalPolicy(jobPolicy, () => none);
    for (const effect of EFFECT_CLASSES) {
      for (const context of CONTEXTS) {
        const asReview = review.requiresDecision(effect, { ...context, mode: "review", fullAccess: false, approvedEgressOrigins: new Set() });
        const got = unattended.requiresDecision(effect, context);
        const relaxed = asReview && !got;
        assert.equal(relaxed, jobPolicy === "worktree-write" && effect === "write_workspace" && !context.policyRequiresHuman, `${jobPolicy} ${effect}`);
      }
    }
    // Auto mode and full access let commands run; here they always need a decision, whatever mode the caller names.
    for (const mode of ["auto", "review", "read-only"] as const) {
      for (const fullAccess of [false, true]) {
        assert.equal(unattended.requiresDecision("exec", { mode, trusted: true, fullAccess }), true);
        assert.equal(unattended.requiresDecision("egress", { mode, trusted: true, fullAccess, egressOrigin: "https://a.test", approvedEgressOrigins: new Set(["https://a.test"]) }), true, "an origin approved earlier is not remembered");
      }
    }
  }
});

test("mutation guard: a policy that lets a command, an egress call or a read-only write through fails the table", () => {
  const mutant = (loosen: (jobPolicy: JobPolicy, effect: EffectClass, context: PolicyContext) => boolean): PolicyFactory => (jobPolicy, policy) =>
    new (class extends UnattendedApprovalPolicy {
      override requiresDecision(effect: EffectClass, context: PolicyContext): boolean {
        return loosen(jobPolicy, effect, context) ? false : super.requiresDecision(effect, context);
      }
    })(jobPolicy, policy);
  assert.ok(mismatches(mutant((_p, effect) => effect === "exec")).length > 0, "exec allowed");
  assert.ok(mismatches(mutant((_p, effect) => effect === "egress")).length > 0, "egress allowed");
  assert.ok(mismatches(mutant((p, effect) => p === "read-only" && effect === "write_workspace")).length > 0, "a read-only job writing");
  assert.ok(mismatches(mutant((_p, effect, context) => effect === "egress" && Boolean(context.approvedEgressOrigins?.size))).length > 0, "a remembered egress grant");
  assert.ok(mismatches(mutant((_p, effect, context) => effect === "exec" && context.mode === "auto")).length > 0, "auto mode honoured");
  assert.ok(mismatches(mutant((_p, effect, context) => effect === "write_workspace" && Boolean(context.policyRequiresHuman))).length > 0, "managed require_human ignored");
  // The plain review policy is itself a mutant: it honours remembered egress grants.
  assert.ok(mismatches((_jobPolicy, policy) => new ApprovalPolicy(policy)).length > 0);
});

const job = (policy: JobPolicy, overrides: Partial<UnattendedJob> = {}): UnattendedJob => ({ workspace: "/work/repo", policy, verifier: null, deliverables: [], provider: {}, budgets: { ...DEFAULT_JOB_BUDGETS }, ...overrides });
const base = (policy: JobPolicy, overrides: Partial<HarnessConfig> = {}): HarnessConfig => ({
  endpoint: "http://127.0.0.1:1/v1", model: "m", maxSteps: 30, temperature: 0, workspace: "/work/repo", shell: "bash",
  approvalMode: unattendedApprovalMode(policy), fullAccess: false, yes: false, dryRun: false, sandbox: "auto", surface: UNATTENDED_SURFACE, ...overrides,
} as HarnessConfig);

test("assertUnattended rejects each forbidden configuration and accepts exactly the two clamped ones", () => {
  assert.equal(unattendedApprovalMode("worktree-write"), "review");
  assert.equal(unattendedApprovalMode("read-only"), "read-only");
  for (const policy of JOB_POLICIES) {
    assert.doesNotThrow(() => assertUnattended(base(policy), policy, false));
    const rejects = (overrides: Partial<HarnessConfig>, pattern: RegExp, network = false) =>
      assert.throws(() => assertUnattended(base(policy, overrides), policy, network), (e) => e instanceof UnattendedClampError && e.reason === "UNATTENDED_CLAMP" && pattern.test(e.message), `${policy} ${JSON.stringify(overrides)}`);
    rejects({ approvalMode: "auto" }, /approval mode is auto/);
    rejects({ fullAccess: true }, /full access is on/);
    rejects({ yes: true }, /--yes is set/);
    rejects({ dryRun: true }, /dry-run is on/);
    rejects({ surface: "headless" }, /not marked unattended/);
    rejects({ surface: undefined }, /not marked unattended/);
    rejects({ sandbox: "none" }, /sandbox is off/);
    rejects({ sandbox: undefined }, /sandbox is off/);
    rejects({ sandbox: false }, /sandbox is off/);
    rejects({}, /network access inside the sandbox is on/, true);
  }
  // The mode must be the job policy's own: a read-only job in review mode, or the reverse, is refused.
  assert.throws(() => assertUnattended(base("read-only", { approvalMode: "review" }), "read-only", false), /approval mode is review, not read-only/);
  assert.throws(() => assertUnattended(base("worktree-write", { approvalMode: "read-only" }), "worktree-write", false), /approval mode is read-only, not review/);
});

test("unattendedConfig clamps what it owns and refuses what it does not, whatever buildConfig returned", () => {
  const seen: Array<Record<string, unknown>> = [];
  const built = (overrides: Partial<HarnessConfig>) => (policy: JobPolicy) => unattendedConfig(job(policy), (options) => { seen.push(options); return base(policy, overrides); }, false);
  for (const policy of JOB_POLICIES) {
    // Each of these is set by the clamp itself, so a hostile value is corrected, not carried.
    for (const hostile of [{ fullAccess: true }, { yes: true }, { surface: "repl" }, { sandbox: "none" }, { sandbox: undefined }] as Array<Partial<HarnessConfig>>) {
      const config = built(hostile)(policy);
      assert.deepEqual({ fullAccess: config.fullAccess, yes: config.yes, surface: config.surface, sandbox: config.sandbox, approvalMode: config.approvalMode },
        { fullAccess: false, yes: false, surface: "unattended", sandbox: "auto", approvalMode: unattendedApprovalMode(policy) }, JSON.stringify(hostile));
    }
    // The mode and dry-run come from buildConfig; a wrong one is never repaired into a run.
    assert.throws(() => built({ approvalMode: "auto" })(policy), UnattendedClampError);
    assert.throws(() => built({ dryRun: true })(policy), UnattendedClampError);
    assert.throws(() => unattendedConfig(job(policy), () => base(policy), true), /network access inside the sandbox/);
  }
  for (const options of seen) {
    for (const forbidden of ["yes", "mode", "fullAccess", "sandboxNetwork", "dryRun", "worktree"]) assert.equal(forbidden in options, false, forbidden);
    assert.equal(options.sandbox, "auto");
    assert.equal(Boolean(options.approve) !== Boolean(options.readOnly), true, "exactly one of the two explicit modes");
  }
  assert.deepEqual(unattendedOptions(job("worktree-write", { verifier: "npm test", deliverables: ["src/add.js"], provider: { endpoint: "http://gw/v1", model: "m" } })), {
    workspace: "/work/repo", approve: true, sandbox: "auto", maxTotalSteps: 200, maxToolInvocations: 300, maxInferenceSubmissions: 300, maxTurnMinutes: 60,
    authoritativeVerifier: "npm test", deliverableFile: ["src/add.js"], endpoint: "http://gw/v1", model: "m",
  });
  assert.deepEqual(unattendedOptions(job("read-only")), { workspace: "/work/repo", readOnly: true, sandbox: "auto", maxTotalSteps: 200, maxToolInvocations: 300, maxInferenceSubmissions: 300, maxTurnMinutes: 60 });
});

test("through the real buildConfig, NEXUS_APPROVAL_MODE=auto in the environment does not reach an unattended run", () => {
  const saved = process.env.NEXUS_APPROVAL_MODE;
  process.env.NEXUS_APPROVAL_MODE = "auto";
  try {
    const none = managed();
    const real = (options: Record<string, unknown>) => buildConfigWithPolicy(options, none);
    assert.equal(real({ workspace: process.cwd() }).approvalMode, "auto", "the variable does select auto for an attended run");
    for (const policy of JOB_POLICIES) {
      const config = unattendedConfig(job(policy, { workspace: process.cwd() }), real, false);
      assert.equal(config.approvalMode, unattendedApprovalMode(policy));
      assert.equal(config.fullAccess, false);
      assert.equal(config.surface, "unattended");
      assert.equal(config.continuation?.maxTotalSteps, 200);
      assert.equal(config.continuation?.maxTurnMinutes, 60);
      assert.equal(config.maxToolInvocations, 300);
      assert.equal(config.maxInferenceSubmissions, 300);
    }
    // Managed policy still applies on top: where it disables auto, nothing changes; it can only tighten.
    const strict = managed({ approval: { strict: true, require_human: ["write_workspace"] } });
    assert.equal(unattendedConfig(job("worktree-write", { workspace: process.cwd() }), (options) => buildConfigWithPolicy(options, strict), false).approvalMode, "review");
  } finally {
    if (saved === undefined) delete process.env.NEXUS_APPROVAL_MODE;
    else process.env.NEXUS_APPROVAL_MODE = saved;
  }
});

test("the environment scrub removes every variable that could widen a job, and only those", () => {
  assert.deepEqual([...UNATTENDED_ENV_SCRUB], ["NEXUS_TRUST_WORKSPACE", "NEXUS_APPROVAL_MODE", "NEXUS_SANDBOX_NETWORK", "NEXUS_EGRESS_POLICY"]);
  const env: NodeJS.ProcessEnv = { NEXUS_TRUST_WORKSPACE: "1", NEXUS_APPROVAL_MODE: "auto", NEXUS_SANDBOX_NETWORK: "1", NEXUS_EGRESS_POLICY: "{}", NEXUS_STATE_DIR: "/state", PATH: "/usr/bin" };
  assert.deepEqual(scrubUnattendedEnv(env), [...UNATTENDED_ENV_SCRUB]);
  assert.deepEqual(env, { NEXUS_STATE_DIR: "/state", PATH: "/usr/bin" });
  assert.deepEqual(scrubUnattendedEnv(env), []);
});

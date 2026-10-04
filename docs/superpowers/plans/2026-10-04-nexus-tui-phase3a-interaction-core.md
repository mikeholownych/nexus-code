# Nexus TUI Phase 3A: Interaction Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live TUI (`nexus-tui --live`, `harness --live`) gets a real multi-line editor with prompt history, a review-mode approval modal that shows a unified diff (approve, approve for the session, deny), a `?` help overlay, transcript focus and scrollback, Shift+Enter on terminals that report it, a visible shutdown, and clean exits on SIGTERM/SIGHUP.

**Architecture:** The sidecar keeps deciding nothing: for a gated tool call it now sends a structured `review` payload (before/after text, patch, or command) built from the call's arguments and redacted. Rust turns that payload into diff lines with the `similar` crate already in `core/Cargo.toml`. Two new pure modules join the binary: `composer` (text buffer, grapheme cursor, readline keys, history, character-wrapped layout with an exact cursor position) and `review` (payload → diff lines). `live_state` gains focus, overlays, scrollback and decision entries; `live_view` renders the real terminal cursor, the scrolled transcript and the modals, and reports what it measured (`LiveLayout`) so key handling can page and clamp; `live` feeds that back, enables the kitty keyboard protocol when supported, draws a closing frame and handles stop signals.

**Tech Stack:** Rust 2024 (rustc 1.95), ratatui 0.30.2, crossterm 0.29 (bracketed paste, keyboard enhancement flags), `similar` 2.7, `unicode-segmentation` 1.13 and `unicode-width` 0.2 (already in `Cargo.lock`), libc (signals). TypeScript (Node 24, `node:test`) for the sidecar payload.

**Spec:** `docs/superpowers/specs/2026-10-04-nexus-ratatui-live-default-design.md` (sections 4, 5, 6 phase 3). **Previous plans:** `docs/superpowers/plans/2026-10-04-nexus-tui-sidecar-protocol.md`, `docs/superpowers/plans/2026-10-04-nexus-tui-live-spectator.md`.

## Phase 3 roadmap (this plan is 3A)

The operator chose full REPL slash-command parity and all four overlays, so phase 3 is split into three plans that each ship working software, executed in order:

- **3A Interaction core (this plan):** editor, history, approval modal, help overlay, focus and scrollback, keyboard protocol, shutdown and signals.
- **3B Slash commands and default entry:** a sidecar slash router covering every REPL command (about 40, including the turn-starting ones), the per-turn checkpoint and session save the REPL performs, slash completion in the composer, `slash.result` rendering, then `harness` opens the TUI and `harness --repl` keeps the readline REPL.
- **3C Detail overlays:** tool and evidence detail (the sidecar retains full redacted output per `(turn_id, call_id)` and serves it on request), and the validation receipt overlay (turn verification evidence plus the active receipt).

---

## Before you start

- Work in an isolated worktree (superpowers:using-git-worktrees). The main checkout has unrelated uncommitted Cloudflare/Issue 12 files; never stage them.
- Build once: `make build` (Rust release build plus `cli/dist`). The real-sidecar Rust test needs `cli/dist/sidecar.js`.
- Rust tests: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t.txt 2>&1`, then read `/tmp/t.txt` (baseline: 67 tests pass). Filter by module, e.g. `... --bin nexus-tui composer::`. An `rtk` shell wrapper alters piped cargo output; always redirect to a file and read real counts.
- CLI tests: `cd cli && node --import tsx --test test/*.test.ts > /tmp/cli.txt 2>&1` (never `npx tsx --test`, which reports false passes). Baseline: 301 tests, 300 pass; the only failure is `SCAN-001 & SCAN-004: Security gates script passes on clean codebase` (and its parent `WP-11` suite).
- Run edits and test commands strictly one after another. Never issue an edit and a test run in the same batch; earlier implementers tested stale code that way.
- New code is unreferenced until later tasks, so `dead_code` warnings are expected in Tasks 2–5. Do not add `allow` attributes; Task 10 requires zero warnings in `nexus_tui` files.
- Format only the files you touch: `rustfmt --edition 2024 core/src/bin/nexus_tui/<file>.rs`. If rustfmt reorders the `#[path] mod` declarations in `core/src/bin/nexus_tui.rs`, restore the original order.
- After TS changes rebuild with `cd cli && npm run build` and commit the changed `cli/dist` files. If npm touches `package-lock.json`, revert it.
- Never read or print `cli/.env`.

## Decisions refined from the spec (binding for this plan)

- **Composer keys:** Enter submits. Shift+Enter (kitty keyboard protocol) or Alt+Enter inserts a newline. Left/Right move by grapheme; Ctrl or Alt + Left/Right and Alt+B/F move by word; Home/End and Ctrl-A/E go to line start/end; Backspace/Delete remove a grapheme; Ctrl-W, Ctrl+Backspace and Alt+Backspace delete the previous word; Ctrl-U/Ctrl-K delete to line start/end; Ctrl-L clears the draft. Up/Down move between lines; Up on the first line recalls the previous prompt, Down past the newest brings the draft back. History is in memory, at most 200 prompts, blank and repeated prompts skipped. Typing while a turn runs is kept as a draft.
- **Composer layout** wraps by character (paths and code have no good word breaks), counts a tab as four columns, drops control characters other than newline and tab on insert, shows at most 6 rows with the cursor row always visible, and places the real terminal cursor.
- **Approval modal:** opens on `approval.request`, covering the transcript area (status strip and composer hint stay visible), titled "Approval needed", headed by the tool verb and subject. Body: unified diff (3 context lines) for `edit_file` (old snippet vs new snippet) and `write_file` (current file vs new content, "new file" when absent, a note when the current content cannot be shown), the patch as sent for `patch_file`, the command line for `run_command`, pretty JSON for anything else. Keys: `y`/Enter approve, `a` approve this and every later action (the sidecar switches to auto mode), `n`/Esc deny, Up/Down/`j`/`k`/PgUp/PgDn/Home/End scroll. Esc denies because closing the panel without an answer would leave the turn blocked. Ctrl-C closes the modal and cancels the turn (the sidecar settles the pending approval on abort). The decision is recorded in the transcript. Per-hunk review of patches is not in this plan. Decision keys are ignored for 400 ms after the modal opens so keystrokes typed for the draft cannot answer it; Ctrl-C works immediately.
- **Help overlay:** `?` with an empty composer opens it; Esc, Enter, `?` or `q` close it; it scrolls like the approval modal.
- **Focus and scrollback:** Tab switches focus between composer and transcript at any time (the spec says idle; allowing it during a turn is what makes reading back useful). PgUp/PgDn scroll the transcript from either focus. In transcript focus: Up/Down/`k`/`j` one row, Home/`g` top, End/`G` newest, Enter or Esc back to the composer, any other printable key returns to the composer and types. Submitting a prompt returns to the newest line. A badge on the last transcript row shows how many rows are below while scrolled back. The viewport keeps its distance from the bottom while text streams (anchoring is phase 4 polish).
- **Model notes** render under the labelled model summary.
- **Quit** draws "shutting down the agent…" before the graceful sidecar shutdown starts. SIGTERM and SIGHUP stop the session the same way as `q` (sidecar shutdown, terminal restored).
- **Keyboard protocol:** when `supports_keyboard_enhancement()` reports true, push `DISAMBIGUATE_ESCAPE_CODES` and pop it on every exit path.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `cli/src/approval_review.ts` | Create | `approvalReview(tool, args, workspace)` → structured, redacted, capped review payload |
| `cli/src/protocol.ts` | Modify | `approval.request` gains `review: ApprovalReview` |
| `cli/src/sidecar.ts` | Modify | Attach the review payload to approval requests |
| `cli/test/approval_review.test.ts` | Create | Payload tests |
| `cli/test/sidecar.test.ts` | Modify | Approval request carries the review |
| `core/Cargo.toml` | Modify | Direct deps `unicode-segmentation`, `unicode-width` |
| `core/src/bin/nexus_tui.rs` | Modify | `#[path]` declarations for `review` and `composer` |
| `core/src/bin/nexus_tui/protocol.rs` | Modify | `Review`, full `ApprovalRequest`, `ModelSummary.notes`, `Approve`/`Deny` commands |
| `core/src/bin/nexus_tui/review.rs` | Create | `review_lines(&Review)` → `Vec<ReviewLine>` |
| `core/src/bin/nexus_tui/composer.rs` | Create | `Composer` editor and `ComposerLayout` |
| `core/src/bin/nexus_tui/live_state.rs` | Modify | Composer integration, focus, overlays, scrollback, decisions, notes, `LiveLayout` |
| `core/src/bin/nexus_tui/live_view.rs` | Modify | Cursor, scrolled transcript, decision and notes rendering, hints, modals; returns `LiveLayout` |
| `core/src/bin/nexus_tui/live.rs` | Modify | Layout feedback, keyboard protocol, closing frame, stop signals |

---

### Task 1: Sidecar review payload for approvals

**Files:**
- Create: `cli/src/approval_review.ts`
- Create: `cli/test/approval_review.test.ts`
- Modify: `cli/src/protocol.ts` (the `approval.request` member of `SidecarEvent`, line 33)
- Modify: `cli/src/sidecar.ts` (`requestApproval`, lines 148-170)
- Modify: `cli/test/sidecar.test.ts` (test "deny keeps the file unwritten and reports the tool as failed")

- [ ] **Step 1: Write the failing payload tests**

Create `cli/test/approval_review.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvalReview, MAX_REVIEW_TEXT } from "../src/approval_review.js";

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-review-"));
  fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
  return dir;
}

describe("approvalReview", () => {
  test("edit_file reviews the replaced snippet against the replacement", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("edit_file", { path: "a.ts", old_content: "let a = 1;", new_content: "let a = 2;" }, ws), {
      kind: "change",
      path: "a.ts",
      before: "let a = 1;",
      after: "let a = 2;",
      created: false,
      truncated: false,
    });
  });

  test("write_file to a new path is a created file with no current content", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("write_file", { path: "new.txt", content: "hi\n" }, ws), {
      kind: "change",
      path: "new.txt",
      before: null,
      after: "hi\n",
      created: true,
      truncated: false,
    });
  });

  test("write_file over an existing file reviews against its current content", () => {
    const ws = workspace();
    const review = approvalReview("write_file", { path: "base.txt", content: "changed\n" }, ws);
    assert.deepEqual(review, { kind: "change", path: "base.txt", before: "base\n", after: "changed\n", created: false, truncated: false });
  });

  test("current content outside the workspace is never read", () => {
    const ws = workspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "do not show\n");
    const rel = path.relative(ws, path.join(outside, "secret.txt"));
    const review = approvalReview("write_file", { path: rel, content: "x" }, ws);
    assert.equal(review.kind, "change");
    assert.equal((review as any).before, null);
    assert.equal((review as any).created, false);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"));
    const viaLink = approvalReview("write_file", { path: "link.txt", content: "x" }, ws);
    assert.equal((viaLink as any).before, null);
    assert.equal(JSON.stringify(viaLink).includes("do not show"), false);
  });

  test("secrets are redacted and oversized text is capped", () => {
    const ws = workspace();
    const review = approvalReview("write_file", { path: "n.txt", content: `token=supersecretvalue1\n${"x".repeat(MAX_REVIEW_TEXT)}` }, ws) as any;
    assert.equal(JSON.stringify(review).includes("supersecretvalue1"), false);
    assert.equal(review.truncated, true);
    assert.equal(review.after.length, MAX_REVIEW_TEXT);
  });

  test("patch_file, run_command and other tools", () => {
    const ws = workspace();
    assert.deepEqual(approvalReview("patch_file", { path: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b" }, ws), {
      kind: "patch",
      path: "a.ts",
      patch: "@@ -1 +1 @@\n-a\n+b",
      truncated: false,
    });
    assert.deepEqual(approvalReview("run_command", { command: "npm test -- --token=abcdefghijklmnop" }, ws), {
      kind: "command",
      command: "npm test -- --token=[REDACTED]",
    });
    assert.deepEqual(approvalReview("fetch_web", { url: "https://example.com" }, ws), {
      kind: "args",
      text: '{\n  "url": "https://example.com"\n}',
      truncated: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd cli && node --import tsx --test test/approval_review.test.ts > /tmp/t1.txt 2>&1`
Expected: FAIL; the module `../src/approval_review.js` cannot be found.

- [ ] **Step 3: Implement the payload builder**

Create `cli/src/approval_review.ts`:

```ts
/**
 * What an operator needs to judge a gated tool call, built from the call's arguments. The client renders it
 * (unified diff, command line); the sidecar never decides whether the change is acceptable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./ui.js";

export const MAX_REVIEW_TEXT = 100_000;

export type ApprovalReview =
  | { kind: "change"; path: string; before: string | null; after: string; created: boolean; truncated: boolean }
  | { kind: "patch"; path: string; patch: string; truncated: boolean }
  | { kind: "command"; command: string }
  | { kind: "args"; text: string; truncated: boolean };

function capped(text: string): { text: string; truncated: boolean } {
  const clean = redactSecrets(text);
  return clean.length > MAX_REVIEW_TEXT ? { text: clean.slice(0, MAX_REVIEW_TEXT), truncated: true } : { text: clean, truncated: false };
}

/**
 * Whether `file` exists, and its text when it is a regular file whose real path stays inside `workspace` and is
 * small enough to show. Symlinks are resolved first, so a link cannot pull outside content into the review.
 */
function currentText(workspace: string, file: string): { exists: boolean; text: string | null } {
  let root: string;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    return { exists: false, text: null };
  }
  const lexical = path.resolve(root, file);
  if (!fs.existsSync(lexical)) return { exists: false, text: null };
  try {
    const target = fs.realpathSync(lexical);
    if (target !== root && !target.startsWith(root + path.sep)) return { exists: true, text: null };
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_REVIEW_TEXT * 4) return { exists: true, text: null };
    return { exists: true, text: fs.readFileSync(target, "utf-8") };
  } catch {
    return { exists: true, text: null };
  }
}

export function approvalReview(tool: string, args: Record<string, any>, workspace: string): ApprovalReview {
  const file = typeof args.path === "string" ? args.path : "";
  switch (tool) {
    case "edit_file": {
      const before = capped(String(args.old_content ?? ""));
      const after = capped(String(args.new_content ?? ""));
      return { kind: "change", path: file, before: before.text, after: after.text, created: false, truncated: before.truncated || after.truncated };
    }
    case "write_file": {
      const current = currentText(workspace, file);
      const before = current.text === null ? null : capped(current.text);
      const after = capped(String(args.content ?? ""));
      return {
        kind: "change",
        path: file,
        before: before ? before.text : null,
        after: after.text,
        created: !current.exists,
        truncated: after.truncated || Boolean(before?.truncated),
      };
    }
    case "patch_file": {
      const patch = capped(String(args.patch ?? ""));
      return { kind: "patch", path: file, patch: patch.text, truncated: patch.truncated };
    }
    case "run_command":
      return { kind: "command", command: redactSecrets(String(args.command ?? "")) };
    default: {
      const text = capped(JSON.stringify(args, null, 2));
      return { kind: "args", text: text.text, truncated: text.truncated };
    }
  }
}
```

- [ ] **Step 4: Run the payload tests**

Run: `cd cli && node --import tsx --test test/approval_review.test.ts > /tmp/t1.txt 2>&1`
Expected: PASS, 6 tests.

- [ ] **Step 5: Extend the sidecar approval test**

In `cli/test/sidecar.test.ts`, test "deny keeps the file unwritten and reports the tool as failed", directly after `assert.ok(req.preview.includes("x.txt"));` add:

```ts
      assert.deepEqual(req.review, { kind: "change", path: "x.txt", before: null, after: "hi", created: true, truncated: false });
```

Run: `cd cli && node --import tsx --test test/sidecar.test.ts > /tmp/t1s.txt 2>&1`
Expected: FAIL on that assertion (`req.review` is undefined).

- [ ] **Step 6: Send the payload with every approval request**

In `cli/src/protocol.ts` add after the existing `import { redactSecrets } from "./ui.js";`:

```ts
import type { ApprovalReview } from "./approval_review.js";
```

and change the `approval.request` member of `SidecarEvent` to:

```ts
  | { type: "approval.request"; id: string; turn_id: string; tool: string; subject: string; preview: string; review: ApprovalReview }
```

In `cli/src/sidecar.ts` add `import { approvalReview } from "./approval_review.js";` after the `./ui.js` import, and in `requestApproval` change the emitted event to:

```ts
      this.emit({
        type: "approval.request",
        id,
        turn_id: turnId,
        tool,
        subject: toolSubject(args),
        preview: capText(redactSecrets(JSON.stringify(args, null, 2))),
        review: approvalReview(tool, args, this.app.getConfig().workspace),
      });
```

(`this.app.getConfig().workspace` is the same root the tool bridge uses, `agent.ts:1767`.)

- [ ] **Step 7: Run the CLI suite and rebuild dist**

Run: `cd cli && node --import tsx --test test/*.test.ts > /tmp/cli.txt 2>&1`
Expected: 307 tests, 306 pass; the only failure is the known `SCAN-001 & SCAN-004` test.

Run: `cd cli && npm run build > /tmp/build.txt 2>&1`, then `git status --short cli`.
Expected: `cli/dist/approval_review.js` is new and `cli/dist/sidecar.js` changed (`cli/dist/protocol.js` may be unchanged; type-only edits emit nothing). `package-lock.json` unchanged.

- [ ] **Step 8: Commit**

```bash
git add cli/src/approval_review.ts cli/src/protocol.ts cli/src/sidecar.ts cli/test/approval_review.test.ts cli/test/sidecar.test.ts cli/dist/approval_review.js cli/dist/sidecar.js
git status --short cli/dist   # add cli/dist/protocol.js too if it changed
git commit -m "feat(sidecar): structured review payload for approval requests"
```

---

### Task 2: Protocol types for approvals, decisions and notes

**Files:**
- Modify: `core/src/bin/nexus_tui/protocol.rs`
- Modify: `core/src/bin/nexus_tui/live_state.rs` (one match arm, line 165)

- [ ] **Step 1: Write the failing tests**

In `core/src/bin/nexus_tui/protocol.rs` tests:

1. In `parses_every_rendered_event_type`, replace the `approval.request` assertion with:

```rust
        assert_eq!(
            parse_event(
                r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#
            ),
            Ok(Event::ApprovalRequest {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                review: None,
            })
        );
```

2. In `turn_result_keeps_the_reported_turn_verbatim`, replace the final `assert!(matches!(with_summary, ...))` with:

```rust
        assert!(matches!(
            with_summary,
            Event::TurnResult { model_summary: Some(ModelSummary { ref summary, ref notes }), .. }
                if summary == "Fixed it." && notes.as_deref() == Some("n")
        ));
```

3. In `commands_encode_as_single_versioned_lines`, add these two cases to the array:

```rust
            (
                Command::Approve {
                    id: "approval-1".into(),
                    always: true,
                },
                serde_json::json!({"v":1,"type":"approve","id":"approval-1","always":true}),
            ),
            (
                Command::Deny {
                    id: "approval-1".into(),
                },
                serde_json::json!({"v":1,"type":"deny","id":"approval-1"}),
            ),
```

4. Add a new test:

```rust
    #[test]
    fn approval_requests_carry_each_review_kind() {
        let review = |json: &str| match parse_event(&format!(
            r#"{{"v":1,"type":"approval.request","id":"a1","turn_id":"t1","tool":"t","subject":"s","preview":"{{}}","review":{json}}}"#
        )) {
            Ok(Event::ApprovalRequest { review, .. }) => review,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            review(r#"{"kind":"change","path":"x.txt","before":null,"after":"hi\n","created":true,"truncated":false}"#),
            Some(Review::Change {
                path: "x.txt".into(),
                before: None,
                after: "hi\n".into(),
                created: true,
                truncated: false
            })
        );
        assert_eq!(
            review(r#"{"kind":"patch","path":"a.ts","patch":"@@ -1 +1 @@","truncated":true}"#),
            Some(Review::Patch {
                path: "a.ts".into(),
                patch: "@@ -1 +1 @@".into(),
                truncated: true
            })
        );
        assert_eq!(
            review(r#"{"kind":"command","command":"npm test"}"#),
            Some(Review::Shell {
                command: "npm test".into()
            })
        );
        assert_eq!(
            review(r#"{"kind":"args","text":"{}","truncated":false}"#),
            Some(Review::Args {
                text: "{}".into(),
                truncated: false
            })
        );
        assert_eq!(review(r#"{"kind":"hologram"}"#), Some(Review::Unknown));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui protocol:: > /tmp/t2.txt 2>&1`
Expected: compile errors: no field `id`/`review` on `ApprovalRequest`, no `notes` on `ModelSummary`, no `Approve`/`Deny`, no `Review`.

- [ ] **Step 3: Implement the types**

In `core/src/bin/nexus_tui/protocol.rs` replace `ModelSummary` with:

```rust
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelSummary {
    pub summary: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// What the operator is asked to approve (`approvalReview` in `cli/src/approval_review.ts`). Text is already
/// redacted and capped by the sidecar.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind")]
pub enum Review {
    #[serde(rename = "change")]
    Change {
        path: String,
        before: Option<String>,
        after: String,
        created: bool,
        truncated: bool,
    },
    #[serde(rename = "patch")]
    Patch {
        path: String,
        patch: String,
        truncated: bool,
    },
    #[serde(rename = "command")]
    Shell { command: String },
    #[serde(rename = "args")]
    Args { text: String, truncated: bool },
    /// A review kind this client does not know; the modal still asks, without a preview.
    #[serde(other)]
    Unknown,
}
```

Replace the `ApprovalRequest` variant of `Event` with:

```rust
    #[serde(rename = "approval.request")]
    ApprovalRequest {
        id: String,
        tool: String,
        subject: String,
        #[serde(default)]
        review: Option<Review>,
    },
```

Add to `Command` after `Cancel`:

```rust
    #[serde(rename = "approve")]
    Approve { id: String, always: bool },
    #[serde(rename = "deny")]
    Deny { id: String },
```

In `core/src/bin/nexus_tui/live_state.rs` change the arm `Event::ApprovalRequest { tool, subject } => ...` to start with `Event::ApprovalRequest { tool, subject, .. } =>` (the body stays; Task 6 replaces it).

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t2.txt 2>&1`
Expected: PASS, 68 tests (67 + 1). Warnings that `id`, `review`, `notes`, `Approve` and `Deny` are unused are expected until Task 6.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/live_state.rs
git add core/src/bin/nexus_tui/protocol.rs core/src/bin/nexus_tui/live_state.rs
git commit -m "feat(tui): protocol types for approval reviews, decisions and model notes"
```

---

### Task 3: Review lines (unified diff)

**Files:**
- Create: `core/src/bin/nexus_tui/review.rs`
- Modify: `core/src/bin/nexus_tui.rs` (module declaration after `mod protocol;`)

- [ ] **Step 1: Declare the module**

In `core/src/bin/nexus_tui.rs`, directly after the two lines declaring `mod protocol;`, add:

```rust
#[path = "nexus_tui/review.rs"]
mod review;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/review.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn texts(lines: &[ReviewLine], kind: LineKind) -> Vec<&str> {
        lines
            .iter()
            .filter(|line| line.kind == kind)
            .map(|line| line.text.as_str())
            .collect()
    }

    #[test]
    fn a_change_renders_as_a_unified_diff_with_context() {
        let lines = review_lines(&Review::Change {
            path: "src/a.txt".into(),
            before: Some("one\ntwo\nthree\n".into()),
            after: "one\nTWO\nthree\n".into(),
            created: false,
            truncated: false,
        });
        assert_eq!(texts(&lines, LineKind::Meta), vec!["--- src/a.txt", "+++ src/a.txt"]);
        assert_eq!(texts(&lines, LineKind::Hunk), vec!["@@ -1,3 +1,3 @@"]);
        assert_eq!(texts(&lines, LineKind::Removed), vec!["-two"]);
        assert_eq!(texts(&lines, LineKind::Added), vec!["+TWO"]);
        assert_eq!(texts(&lines, LineKind::Context), vec![" one", " three"]);
    }

    #[test]
    fn distant_changes_get_separate_hunks() {
        let before: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let after = before
            .replace("line 2\n", "line two\n")
            .replace("line 18\n", "line eighteen\n");
        let lines = review_lines(&Review::Change {
            path: "f".into(),
            before: Some(before),
            after,
            created: false,
            truncated: false,
        });
        assert_eq!(
            texts(&lines, LineKind::Hunk),
            vec!["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]
        );
    }

    #[test]
    fn new_files_unknown_content_and_truncation_are_labelled() {
        let created = review_lines(&Review::Change {
            path: "x.txt".into(),
            before: None,
            after: "a\nb\n".into(),
            created: true,
            truncated: true,
        });
        assert_eq!(created[0], ReviewLine { kind: LineKind::Meta, text: "new file x.txt".into() });
        assert_eq!(texts(&created, LineKind::Hunk), vec!["@@ -0,0 +1,2 @@"]);
        assert_eq!(texts(&created, LineKind::Added), vec!["+a", "+b"]);
        assert!(created.last().unwrap().text.contains("truncated"));
        let hidden = review_lines(&Review::Change {
            path: "big.bin".into(),
            before: None,
            after: "x".into(),
            created: false,
            truncated: false,
        });
        assert!(hidden[0].text.contains("current content not shown"), "{hidden:?}");
        let same = review_lines(&Review::Change {
            path: "s".into(),
            before: Some("a\n".into()),
            after: "a\n".into(),
            created: false,
            truncated: false,
        });
        assert_eq!(same.last().unwrap().text, "no changes");
    }

    #[test]
    fn patches_commands_and_args_are_shown_as_sent() {
        let patch = review_lines(&Review::Patch {
            path: "a.ts".into(),
            patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n same".into(),
            truncated: false,
        });
        assert_eq!(
            patch.iter().map(|line| line.kind).collect::<Vec<_>>(),
            vec![
                LineKind::Meta,
                LineKind::Meta,
                LineKind::Meta,
                LineKind::Hunk,
                LineKind::Removed,
                LineKind::Added,
                LineKind::Context
            ]
        );
        assert_eq!(patch[0].text, "patch a.ts");
        assert_eq!(
            review_lines(&Review::Shell { command: "npm test\n--watch".into() }),
            vec![
                ReviewLine { kind: LineKind::Command, text: "$ npm test".into() },
                ReviewLine { kind: LineKind::Command, text: "  --watch".into() },
            ]
        );
        assert_eq!(
            texts(
                &review_lines(&Review::Args { text: "{\n  \"url\": \"u\"\n}".into(), truncated: false }),
                LineKind::Context
            ),
            vec!["{", "  \"url\": \"u\"", "}"]
        );
        assert_eq!(review_lines(&Review::Unknown)[0].kind, LineKind::Meta);
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui review:: > /tmp/t3.txt 2>&1`
Expected: compile errors: cannot find `ReviewLine`, `LineKind`, `review_lines`, `Review`.

- [ ] **Step 4: Implement**

Add above the test module in `core/src/bin/nexus_tui/review.rs`:

```rust
//! Turns an approval request's review payload into display lines: a unified diff for file changes, the patch as
//! sent, or the command line. Pure; the sidecar already redacted and capped the text.
use std::ops::Range;
use std::time::Duration;

use similar::{ChangeTag, TextDiff};

use crate::protocol::Review;

const CONTEXT_LINES: usize = 3;
/// Bounds the diff on huge inputs; `similar` falls back to a coarser diff when it runs out of time.
const DIFF_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LineKind {
    Meta,
    Hunk,
    Added,
    Removed,
    Context,
    Command,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReviewLine {
    pub kind: LineKind,
    pub text: String,
}

fn line(kind: LineKind, text: impl Into<String>) -> ReviewLine {
    ReviewLine {
        kind,
        text: text.into(),
    }
}

fn truncation_note() -> ReviewLine {
    line(
        LineKind::Meta,
        "… preview truncated; the action uses the full content",
    )
}

pub fn review_lines(review: &Review) -> Vec<ReviewLine> {
    let mut lines = Vec::new();
    let truncated = match review {
        Review::Change {
            path,
            before,
            after,
            created,
            truncated,
        } => {
            if *created {
                lines.push(line(LineKind::Meta, format!("new file {path}")));
            } else if before.is_none() {
                lines.push(line(
                    LineKind::Meta,
                    format!(
                        "{path}: current content not shown (outside the workspace, unreadable, or too large)"
                    ),
                ));
            }
            lines.extend(unified(path, before.as_deref().unwrap_or(""), after));
            *truncated
        }
        Review::Patch {
            path,
            patch,
            truncated,
        } => {
            lines.push(line(LineKind::Meta, format!("patch {path}")));
            lines.extend(patch.lines().map(classify));
            *truncated
        }
        Review::Shell { command } => {
            lines.extend(command.lines().enumerate().map(|(index, row)| {
                line(
                    LineKind::Command,
                    format!("{} {row}", if index == 0 { "$" } else { " " }),
                )
            }));
            false
        }
        Review::Args { text, truncated } => {
            lines.extend(text.lines().map(|row| line(LineKind::Context, row)));
            *truncated
        }
        Review::Unknown => {
            lines.push(line(
                LineKind::Meta,
                "This request has no preview this view can show.",
            ));
            false
        }
    };
    if truncated {
        lines.push(truncation_note());
    }
    lines
}

/// `start,len` of a hunk range in unified-diff form; an empty range is written `start,0` like git does.
fn hunk_range(range: Range<usize>) -> String {
    if range.is_empty() {
        format!("{},0", range.start)
    } else {
        format!("{},{}", range.start + 1, range.len())
    }
}

fn unified(path: &str, before: &str, after: &str) -> Vec<ReviewLine> {
    let diff = TextDiff::configure()
        .timeout(DIFF_TIMEOUT)
        .diff_lines(before, after);
    let mut lines = vec![
        line(LineKind::Meta, format!("--- {path}")),
        line(LineKind::Meta, format!("+++ {path}")),
    ];
    let groups = diff.grouped_ops(CONTEXT_LINES);
    if groups.is_empty() {
        lines.push(line(LineKind::Meta, "no changes"));
    }
    for group in groups {
        let (Some(first), Some(last)) = (group.first(), group.last()) else {
            continue;
        };
        let old = first.old_range().start..last.old_range().end;
        let new = first.new_range().start..last.new_range().end;
        lines.push(line(
            LineKind::Hunk,
            format!("@@ -{} +{} @@", hunk_range(old), hunk_range(new)),
        ));
        for op in &group {
            for change in diff.iter_changes(op) {
                let (kind, sign) = match change.tag() {
                    ChangeTag::Delete => (LineKind::Removed, '-'),
                    ChangeTag::Insert => (LineKind::Added, '+'),
                    ChangeTag::Equal => (LineKind::Context, ' '),
                };
                let text = change.value().trim_end_matches(['\n', '\r']);
                lines.push(line(kind, format!("{sign}{text}")));
            }
        }
    }
    lines
}

fn classify(row: &str) -> ReviewLine {
    let kind = if row.starts_with("+++")
        || row.starts_with("---")
        || row.starts_with("diff ")
        || row.starts_with("index ")
    {
        LineKind::Meta
    } else if row.starts_with("@@") {
        LineKind::Hunk
    } else if row.starts_with('+') {
        LineKind::Added
    } else if row.starts_with('-') {
        LineKind::Removed
    } else {
        LineKind::Context
    };
    line(kind, row)
}
```

- [ ] **Step 5: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui review:: > /tmp/t3.txt 2>&1`
Expected: PASS, 4 tests. If `distant_changes_get_separate_hunks` reports different ranges, print the hunks and check them against `git diff --no-index` on the same two texts before changing the expectation; the hunk header format must match git's.

- [ ] **Step 6: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/review.rs
git add core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/review.rs
git commit -m "feat(tui): unified diff lines for approval reviews"
```

---

### Task 4: Composer editor

**Files:**
- Create: `core/src/bin/nexus_tui/composer.rs`
- Modify: `core/Cargo.toml` (`[dependencies]`)
- Modify: `core/src/bin/nexus_tui.rs` (module declaration after `mod review;`)

- [ ] **Step 1: Add the dependencies and declare the module**

In `core/Cargo.toml` `[dependencies]`, after the `crossterm` line, add:

```toml
unicode-segmentation = "1.13"
unicode-width = "0.2"
```

(Both are already in `Cargo.lock` through ratatui; the lock file only records the new direct edges.)

In `core/src/bin/nexus_tui.rs`, directly after the `mod review;` declaration, add:

```rust
#[path = "nexus_tui/composer.rs"]
mod composer;
```

- [ ] **Step 2: Write the failing tests**

Create `core/src/bin/nexus_tui/composer.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn typed(text: &str) -> Composer {
        let mut composer = Composer::default();
        composer.insert(text);
        composer
    }

    #[test]
    fn inserts_at_the_cursor_and_moves_by_grapheme() {
        let mut composer = typed("helo");
        composer.left();
        composer.insert("l");
        assert_eq!(composer.text(), "hello");
        assert_eq!(composer.cursor(), 4);
        let mut emoji = typed("a👩‍💻b");
        emoji.left();
        emoji.backspace();
        assert_eq!(emoji.text(), "ab");
        emoji.line_start();
        emoji.delete();
        assert_eq!(emoji.text(), "b");
    }

    #[test]
    fn word_motions_and_word_delete() {
        let mut composer = typed("fix the parser");
        composer.word_left();
        assert_eq!(composer.cursor(), 8);
        composer.word_left();
        assert_eq!(composer.cursor(), 4);
        composer.word_right();
        assert_eq!(composer.cursor(), 7);
        composer.line_end();
        composer.delete_word_back();
        assert_eq!(composer.text(), "fix the ");
    }

    #[test]
    fn line_keys_work_on_the_current_line() {
        let mut composer = typed("one\ntwo");
        composer.line_start();
        assert_eq!(composer.cursor(), 4);
        composer.kill_to_line_end();
        assert_eq!(composer.text(), "one\n");
        composer.insert("2");
        composer.up();
        assert_eq!(composer.cursor(), 1);
        composer.line_end();
        composer.kill_to_line_start();
        assert_eq!(composer.text(), "\n2");
    }

    #[test]
    fn up_and_down_keep_the_column_where_they_can() {
        let mut composer = typed("long line\nab");
        composer.up();
        assert_eq!(composer.cursor(), 2);
        composer.down();
        assert_eq!(composer.cursor(), 12);
    }

    #[test]
    fn history_recalls_prompts_and_restores_the_draft() {
        let mut composer = Composer::default();
        for prompt in ["first", "second", "second", "   "] {
            composer.insert(prompt);
            composer.take();
        }
        composer.insert("draft");
        composer.up();
        assert_eq!(composer.text(), "second");
        composer.up();
        assert_eq!(composer.text(), "first");
        composer.up();
        assert_eq!(composer.text(), "first");
        composer.down();
        assert_eq!(composer.text(), "second");
        composer.down();
        assert_eq!(composer.text(), "draft");
        composer.up();
        composer.insert("!");
        composer.down();
        assert_eq!(composer.text(), "second!", "editing a recalled prompt makes it the draft");
    }

    #[test]
    fn layout_wraps_by_character_and_places_the_cursor() {
        assert_eq!(
            typed("abcdefghij").layout(10),
            ComposerLayout {
                rows: vec!["abcdefgh".into(), "ij".into()],
                cursor: (1, 2)
            }
        );
        let mut two_lines = typed("ab\ncd");
        two_lines.up();
        two_lines.line_start();
        two_lines.right();
        assert_eq!(
            two_lines.layout(20),
            ComposerLayout {
                rows: vec!["ab".into(), "cd".into()],
                cursor: (0, 1)
            }
        );
        assert_eq!(
            typed("日本語の").layout(10),
            ComposerLayout {
                rows: vec!["日本語の".into(), String::new()],
                cursor: (1, 0)
            }
        );
        assert_eq!(
            typed("日本語の").layout(9),
            ComposerLayout {
                rows: vec!["日本語".into(), "の".into()],
                cursor: (1, 2)
            }
        );
        assert_eq!(
            typed("\tx").layout(20),
            ComposerLayout {
                rows: vec!["    x".into()],
                cursor: (0, 5)
            }
        );
        assert_eq!(
            Composer::default().layout(20),
            ComposerLayout {
                rows: vec![String::new()],
                cursor: (0, 0)
            }
        );
    }

    #[test]
    fn inserted_text_normalises_line_endings_and_drops_control_characters() {
        let composer = Composer::from("a\r\nb\rc\u{1b}[31md\u{7}\te");
        assert_eq!(composer, "a\nb\nc[31md\te");
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui composer:: > /tmp/t4.txt 2>&1`
Expected: compile errors: cannot find `Composer`, `ComposerLayout`.

- [ ] **Step 4: Implement**

Add above the test module in `core/src/bin/nexus_tui/composer.rs`:

```rust
//! Multi-line prompt editor for the live composer: a text buffer with a grapheme-aware cursor, readline-style
//! editing, and in-memory prompt history. Pure; the view asks it for a wrapped layout.
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const HISTORY_LIMIT: usize = 200;
/// Columns taken by the `› ` / `  ` prefix in front of every composer row.
pub const PREFIX_WIDTH: u16 = 2;
const TAB: &str = "    ";

#[derive(Clone, Debug, Default)]
pub struct Composer {
    text: String,
    /// Byte offset into `text`, always on a grapheme boundary.
    cursor: usize,
    history: Vec<String>,
    /// Index into `history` while recalling; `None` while editing a draft.
    recall: Option<usize>,
    /// The draft being edited when recall started; Down past the newest prompt brings it back.
    stash: String,
}

/// Composer rows after wrapping (tabs expanded), and the cursor's row and column (column after the prefix).
#[derive(Clone, Debug, PartialEq)]
pub struct ComposerLayout {
    pub rows: Vec<String>,
    pub cursor: (usize, u16),
}

impl From<&str> for Composer {
    fn from(text: &str) -> Self {
        let mut composer = Composer::default();
        composer.insert(text);
        composer
    }
}

impl PartialEq<&str> for Composer {
    fn eq(&self, other: &&str) -> bool {
        self.text == *other
    }
}

impl Composer {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn clear(&mut self) {
        self.edited();
        self.text.clear();
        self.cursor = 0;
    }

    /// Inserts at the cursor. Carriage returns become newlines; control characters other than newline and tab
    /// are dropped (the terminal would not show them and they would throw off the cursor column).
    pub fn insert(&mut self, text: &str) {
        let clean: String = text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            .collect();
        if clean.is_empty() {
            return;
        }
        self.edited();
        self.text.insert_str(self.cursor, &clean);
        self.cursor += clean.len();
    }

    pub fn backspace(&mut self) {
        if let Some(start) = self.previous_boundary() {
            self.remove(start, self.cursor);
        }
    }

    pub fn delete(&mut self) {
        if let Some(end) = self.next_boundary() {
            self.remove(self.cursor, end);
        }
    }

    pub fn left(&mut self) {
        if let Some(at) = self.previous_boundary() {
            self.cursor = at;
        }
    }

    pub fn right(&mut self) {
        if let Some(at) = self.next_boundary() {
            self.cursor = at;
        }
    }

    pub fn word_left(&mut self) {
        self.cursor = self.word_start();
    }

    pub fn word_right(&mut self) {
        let rest = &self.text[self.cursor..];
        let spaces = rest.len() - rest.trim_start().len();
        let word = rest[spaces..]
            .find(char::is_whitespace)
            .unwrap_or(rest.len() - spaces);
        self.cursor += spaces + word;
    }

    pub fn delete_word_back(&mut self) {
        let start = self.word_start();
        self.remove(start, self.cursor);
    }

    pub fn line_start(&mut self) {
        self.cursor = self.current_line_start();
    }

    pub fn line_end(&mut self) {
        self.cursor = self.current_line_end();
    }

    pub fn kill_to_line_start(&mut self) {
        let start = self.current_line_start();
        self.remove(start, self.cursor);
    }

    pub fn kill_to_line_end(&mut self) {
        let end = self.current_line_end();
        self.remove(self.cursor, end);
    }

    /// Moves to the previous line; on the first line, recalls the previous prompt.
    pub fn up(&mut self) {
        let start = self.current_line_start();
        if start == 0 {
            self.recall_older();
            return;
        }
        let column = self.text[start..self.cursor].graphemes(true).count();
        let previous = self.text[..start - 1].rfind('\n').map_or(0, |at| at + 1);
        self.cursor = self.offset_in_line(previous, start - 1, column);
    }

    /// Moves to the next line; on the last line, steps forward through recalled prompts.
    pub fn down(&mut self) {
        let end = self.current_line_end();
        if end == self.text.len() {
            self.recall_newer();
            return;
        }
        let column = self.text[self.current_line_start()..self.cursor]
            .graphemes(true)
            .count();
        let next = end + 1;
        let next_end = self.text[next..]
            .find('\n')
            .map_or(self.text.len(), |at| next + at);
        self.cursor = self.offset_in_line(next, next_end, column);
    }

    /// Hands the draft over for submission, records it in history, and starts an empty draft.
    pub fn take(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.recall = None;
        self.stash.clear();
        if !text.trim().is_empty() && self.history.last() != Some(&text) {
            self.history.push(text.clone());
            if self.history.len() > HISTORY_LIMIT {
                self.history.remove(0);
            }
        }
        text
    }

    /// Wraps the draft into rows of at most `width - PREFIX_WIDTH` columns, breaking between graphemes, and
    /// finds the cursor. A cursor at the end of a full row moves to the start of a new row.
    pub fn layout(&self, width: u16) -> ComposerLayout {
        let room = usize::from(width.saturating_sub(PREFIX_WIDTH).max(1));
        let column = |used: usize| u16::try_from(used).unwrap_or(u16::MAX);
        let mut rows = vec![String::new()];
        let mut cursor = (0, 0);
        let mut offset = 0;
        for (index, line) in self.text.split('\n').enumerate() {
            if index > 0 {
                rows.push(String::new());
                offset += 1;
            }
            let mut used = 0;
            for grapheme in line.graphemes(true) {
                let shown = if grapheme == "\t" { TAB } else { grapheme };
                let cols = shown.width();
                if used > 0 && used + cols > room {
                    rows.push(String::new());
                    used = 0;
                }
                if offset == self.cursor {
                    cursor = (rows.len() - 1, column(used));
                }
                if let Some(row) = rows.last_mut() {
                    row.push_str(shown);
                }
                used += cols;
                offset += grapheme.len();
            }
            if offset == self.cursor {
                if used >= room {
                    rows.push(String::new());
                    used = 0;
                }
                cursor = (rows.len() - 1, column(used));
            }
        }
        ComposerLayout { rows, cursor }
    }

    /// Any edit ends history recall; the recalled text becomes the draft.
    fn edited(&mut self) {
        self.recall = None;
        self.stash.clear();
    }

    fn remove(&mut self, start: usize, end: usize) {
        if start < end {
            self.edited();
            self.text.replace_range(start..end, "");
            self.cursor = start;
        }
    }

    fn previous_boundary(&self) -> Option<usize> {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map(|(index, _)| index)
    }

    fn next_boundary(&self) -> Option<usize> {
        self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map(|grapheme| self.cursor + grapheme.len())
    }

    fn word_start(&self) -> usize {
        let before = self.text[..self.cursor].trim_end();
        before
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
            .map_or(0, |(index, c)| index + c.len_utf8())
    }

    fn current_line_start(&self) -> usize {
        self.text[..self.cursor].rfind('\n').map_or(0, |at| at + 1)
    }

    fn current_line_end(&self) -> usize {
        self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |at| self.cursor + at)
    }

    /// Byte offset of the `column`-th grapheme of the line `start..end`, or `end` when the line is shorter.
    fn offset_in_line(&self, start: usize, end: usize, column: usize) -> usize {
        self.text[start..end]
            .grapheme_indices(true)
            .nth(column)
            .map_or(end, |(index, _)| start + index)
    }

    fn recall_older(&mut self) {
        let index = match self.recall {
            None if self.history.is_empty() => return,
            None => {
                self.stash = self.text.clone();
                self.history.len() - 1
            }
            Some(0) => return,
            Some(index) => index - 1,
        };
        self.recall = Some(index);
        self.text = self.history[index].clone();
        self.cursor = self.text.len();
    }

    fn recall_newer(&mut self) {
        let Some(index) = self.recall else {
            return;
        };
        if index + 1 < self.history.len() {
            self.recall = Some(index + 1);
            self.text = self.history[index + 1].clone();
        } else {
            self.recall = None;
            self.text = std::mem::take(&mut self.stash);
        }
        self.cursor = self.text.len();
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui composer:: > /tmp/t4.txt 2>&1`
Expected: PASS, 7 tests. Then the full binary: 79 tests pass (68 + 4 + 7).

- [ ] **Step 6: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/composer.rs
git add core/Cargo.toml core/Cargo.lock core/src/bin/nexus_tui.rs core/src/bin/nexus_tui/composer.rs
git commit -m "feat(tui): multi-line composer with grapheme cursor, readline keys and history"
```

---

### Task 5: Composer in the live state

**Files:**
- Modify: `core/src/bin/nexus_tui/live_state.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module of `core/src/bin/nexus_tui/live_state.rs`:

```rust
    fn with(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn editing_keys_edit_at_the_cursor() {
        let mut state = ready();
        type_text(&mut state, "fix bug");
        for _ in 0..3 {
            assert_eq!(state.on_key(key(KeyCode::Left)), None);
        }
        type_text(&mut state, "the ");
        assert_eq!(state.composer, "fix the bug");
        assert_eq!(state.on_key(ctrl('e')), None);
        assert_eq!(state.on_key(ctrl('w')), None);
        assert_eq!(state.composer, "fix the ");
        assert_eq!(state.on_key(with(KeyCode::Left, KeyModifiers::CONTROL)), None);
        assert_eq!(state.on_key(ctrl('k')), None);
        assert_eq!(state.composer, "fix ");
        assert_eq!(state.on_key(with(KeyCode::Backspace, KeyModifiers::ALT)), None);
        assert_eq!(state.composer, "");
    }

    #[test]
    fn up_recalls_the_previous_prompt_after_a_turn() {
        let mut state = ready();
        type_text(&mut state, "first");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#));
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.composer, "first");
        assert_eq!(
            state.on_key(key(KeyCode::Enter)),
            Some(Action::Send(Command::PromptSubmit {
                id: "t2".into(),
                text: "first".into()
            }))
        );
    }

    #[test]
    fn paste_inserts_at_the_cursor_and_typing_while_busy_keeps_a_draft() {
        let mut state = ready();
        type_text(&mut state, "ab");
        assert_eq!(state.on_key(key(KeyCode::Left)), None);
        state.on_paste("X\r\nY");
        assert_eq!(state.composer, "aX\nYb");
        state.session.busy = true;
        type_text(&mut state, "!");
        assert_eq!(state.on_key(key(KeyCode::Enter)), None);
        assert_eq!(state.composer, "aX\nY!b");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state:: > /tmp/t5.txt 2>&1`
Expected: the three new tests FAIL (Left/Up/Ctrl-E/Ctrl-W/Ctrl-K are ignored, so the text differs), the rest pass.

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_state.rs`:

1. Add `use crate::composer::Composer;` after the `crossterm` import.
2. Change the field `pub composer: String,` to `pub composer: Composer,` and its initializer in `new()` to `composer: Composer::default(),`.
3. Replace `on_paste` with:

```rust
    pub fn on_paste(&mut self, text: &str) {
        if !matches!(self.link, Link::Crashed { .. }) {
            self.composer.insert(text);
        }
    }
```

4. Replace `on_key` with the following three methods (the crash-screen branch is unchanged):

```rust
    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if matches!(self.link, Link::Crashed { .. }) {
            return match key.code {
                KeyCode::Char('r') if !ctrl => Some(Action::Restart),
                KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
                KeyCode::Char('c') if ctrl => Some(Action::Quit),
                _ => None,
            };
        }
        match key.code {
            KeyCode::Char('c') if ctrl => self.on_ctrl_c(),
            KeyCode::Esc if self.session.busy => Some(Action::Send(Command::Cancel)),
            KeyCode::Esc => None,
            _ => self.on_composer_key(key),
        }
    }

    fn on_ctrl_c(&mut self) -> Option<Action> {
        if self.session.busy && self.cancel_requested {
            Some(Action::Quit)
        } else if self.session.busy {
            self.cancel_requested = true;
            Some(Action::Send(Command::Cancel))
        } else if !self.composer.is_empty() {
            self.composer.clear();
            None
        } else {
            Some(Action::Quit)
        }
    }

    /// Readline-style editing: ctrl+a/e/u/k/w/l, alt+b/f, arrows, home/end, word jumps and word delete.
    fn on_composer_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        if key.code == KeyCode::Enter && !alt && !shift {
            return self.submit();
        }
        let composer = &mut self.composer;
        match key.code {
            KeyCode::Enter => composer.insert("\n"),
            KeyCode::Backspace if ctrl || alt => composer.delete_word_back(),
            KeyCode::Backspace => composer.backspace(),
            KeyCode::Delete => composer.delete(),
            KeyCode::Left if ctrl || alt => composer.word_left(),
            KeyCode::Right if ctrl || alt => composer.word_right(),
            KeyCode::Left => composer.left(),
            KeyCode::Right => composer.right(),
            KeyCode::Home => composer.line_start(),
            KeyCode::End => composer.line_end(),
            KeyCode::Up => composer.up(),
            KeyCode::Down => composer.down(),
            KeyCode::Char('a') if ctrl => composer.line_start(),
            KeyCode::Char('e') if ctrl => composer.line_end(),
            KeyCode::Char('u') if ctrl => composer.kill_to_line_start(),
            KeyCode::Char('k') if ctrl => composer.kill_to_line_end(),
            KeyCode::Char('w') if ctrl => composer.delete_word_back(),
            KeyCode::Char('l') if ctrl => composer.clear(),
            KeyCode::Char('b') if alt => composer.word_left(),
            KeyCode::Char('f') if alt => composer.word_right(),
            KeyCode::Char(c) if !ctrl && !alt => composer.insert(c.encode_utf8(&mut [0; 4])),
            _ => {}
        }
        None
    }
```

5. In `submit`, replace `self.composer.trim().is_empty()` with `self.composer.text().trim().is_empty()` and `let text = std::mem::take(&mut self.composer);` with `let text = self.composer.take();`.

Existing tests that assign `state.composer = "...".into()` or compare `assert_eq!(state.composer, "...")` keep compiling through `From<&str>` and `PartialEq<&str>`; do not edit them. `live_view.rs` still calls `state.composer.split('\n')`; change that one expression to `state.composer.text().split('\n')` so the binary compiles (Task 7 replaces the function).

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t5.txt 2>&1`
Expected: PASS, 82 tests (79 + 3).

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): live composer edits at the cursor and recalls earlier prompts"
```

---

### Task 6: Focus, scrollback, overlays and decisions in the live state

**Files:**
- Modify: `core/src/bin/nexus_tui/live_state.rs`

- [ ] **Step 1: Write the failing tests**

In the test module of `core/src/bin/nexus_tui/live_state.rs`:

1. Add `use crate::protocol::Review;` and `use crate::review::{LineKind, review_lines};` next to the existing `use` lines in the test module.
2. In `turn_result_projects_the_reported_outcome_and_closes_open_tools` and `turn_result_carries_the_inference_failure_message`, add `notes: None,` to every `Entry::Banner { ... }` literal.
3. Replace the test `errors_and_approval_requests_become_notices` with:

```rust
    #[test]
    fn errors_become_notices_and_approval_requests_open_the_review() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"error","id":"t9","code":"BUSY","message":"A turn is already running"}"#));
        state.apply(ev(r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}"}"#));
        assert_eq!(
            state.transcript,
            vec![Entry::Notice("BUSY: A turn is already running".into())]
        );
        assert_eq!(
            state.overlay,
            Some(Overlay::Approval(Approval {
                id: "approval-1".into(),
                tool: "write_file".into(),
                subject: "x.txt".into(),
                lines: review_lines(&Review::Unknown),
                scroll: 0,
            }))
        );
    }
```

4. Add these tests:

```rust
    const APPROVAL: &str = r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}","review":{"kind":"change","path":"x.txt","before":null,"after":"hi\n","created":true,"truncated":false}}"#;

    fn busy_with_approval() -> LiveState {
        let mut state = ready();
        type_text(&mut state, "make x");
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        state.apply(ev(APPROVAL));
        state
    }

    #[test]
    fn the_approval_modal_takes_keys_and_records_the_decision() {
        let mut state = busy_with_approval();
        let Some(Overlay::Approval(approval)) = &state.overlay else {
            panic!("expected the approval modal");
        };
        assert!(approval.lines.iter().any(|line| line.kind == LineKind::Added && line.text == "+hi"));
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        assert_eq!(state.composer, "", "keys go to the modal, not the composer");
        assert_eq!(
            state.on_key(key(KeyCode::Char('y'))),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: false
            }))
        );
        assert_eq!(state.overlay, None);
        assert_eq!(
            state.transcript.last(),
            Some(&Entry::Decision {
                tool: "write_file".into(),
                subject: "x.txt".into(),
                verdict: Verdict::Approved
            })
        );
        state.apply(ev(APPROVAL));
        assert_eq!(
            state.on_key(key(KeyCode::Char('a'))),
            Some(Action::Send(Command::Approve {
                id: "approval-1".into(),
                always: true
            }))
        );
        state.apply(ev(APPROVAL));
        assert_eq!(
            state.on_key(key(KeyCode::Esc)),
            Some(Action::Send(Command::Deny {
                id: "approval-1".into()
            }))
        );
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Decision { verdict: Verdict::Denied, .. })
        ));
    }

    #[test]
    fn ctrl_c_and_the_turn_result_close_a_pending_approval() {
        let mut state = busy_with_approval();
        assert_eq!(state.on_key(ctrl('c')), Some(Action::Send(Command::Cancel)));
        assert_eq!(state.overlay, None);
        state.apply(ev(APPROVAL));
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN INTERRUPTED","line":"Stopped","turn":{"execution":"INTERRUPTED","outcome":"NOT_ESTABLISHED"},"model_summary":null}"#));
        assert_eq!(state.overlay, None);
        state.apply(ev(APPROVAL));
        state.fail("gone".into(), None, Vec::new());
        assert_eq!(state.overlay, None);
    }

    #[test]
    fn approval_scrolling_is_clamped_by_the_last_frame() {
        let mut state = busy_with_approval();
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 0,
            overlay_rows: 4,
            overlay_limit: 6,
        });
        for code in [KeyCode::Down, KeyCode::Char('j'), KeyCode::PageDown] {
            assert_eq!(state.on_key(key(code)), None);
        }
        assert!(matches!(&state.overlay, Some(Overlay::Approval(Approval { scroll: 5, .. }))));
        assert_eq!(state.on_key(key(KeyCode::End)), None);
        state.note_layout(LiveLayout {
            transcript_rows: 10,
            scroll_limit: 0,
            overlay_rows: 4,
            overlay_limit: 6,
        });
        assert!(matches!(&state.overlay, Some(Overlay::Approval(Approval { scroll: 6, .. }))));
    }

    #[test]
    fn question_mark_opens_help_only_on_an_empty_composer() {
        let mut state = ready();
        assert_eq!(state.on_key(key(KeyCode::Char('?'))), None);
        assert_eq!(state.overlay, Some(Overlay::Help { scroll: 0 }));
        assert_eq!(state.on_key(key(KeyCode::Char('x'))), None);
        assert_eq!(state.composer, "");
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        assert_eq!(state.overlay, None);
        type_text(&mut state, "why?");
        assert_eq!(state.composer, "why?");
        assert_eq!(state.overlay, None);
        state.overlay = Some(Overlay::Help { scroll: 0 });
        state.apply(ev(APPROVAL));
        assert!(matches!(state.overlay, Some(Overlay::Approval(_))), "an approval replaces help");
    }

    #[test]
    fn tab_switches_focus_and_the_transcript_scrolls() {
        let mut state = ready();
        let layout = LiveLayout {
            transcript_rows: 10,
            scroll_limit: 50,
            overlay_rows: 0,
            overlay_limit: 0,
        };
        state.note_layout(layout);
        assert_eq!(state.on_key(key(KeyCode::PageUp)), None);
        assert_eq!(state.scroll_back, 9, "pgup scrolls from the composer too");
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        assert_eq!(state.focus, Focus::Transcript);
        assert_eq!(state.on_key(key(KeyCode::Up)), None);
        assert_eq!(state.on_key(key(KeyCode::Char('k'))), None);
        assert_eq!(state.scroll_back, 11);
        assert_eq!(state.on_key(key(KeyCode::Down)), None);
        assert_eq!(state.scroll_back, 10);
        assert_eq!(state.on_key(key(KeyCode::Home)), None);
        state.note_layout(layout);
        assert_eq!(state.scroll_back, 50);
        assert_eq!(state.on_key(key(KeyCode::Char('G'))), None);
        assert_eq!(state.scroll_back, 0);
        assert_eq!(state.on_key(key(KeyCode::Esc)), None);
        assert_eq!(state.focus, Focus::Composer);
        assert_eq!(state.on_key(key(KeyCode::Tab)), None);
        type_text(&mut state, "x");
        assert_eq!(state.focus, Focus::Composer, "typing returns to the composer");
        assert_eq!(state.composer, "x");
    }

    #[test]
    fn submitting_returns_to_the_newest_line() {
        let mut state = ready();
        state.scroll_back = 7;
        state.focus = Focus::Transcript;
        assert_eq!(state.on_key(key(KeyCode::Char('h'))), None);
        assert!(state.on_key(key(KeyCode::Enter)).is_some());
        assert_eq!(state.scroll_back, 0);
    }

    #[test]
    fn model_notes_ride_along_with_the_summary() {
        let mut state = ready();
        state.apply(ev(r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"H","line":"L","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Done.","notes":"Watch the cache."}}"#));
        assert!(matches!(
            state.transcript.last(),
            Some(Entry::Banner { summary: Some(summary), notes: Some(notes), .. })
                if summary == "Done." && notes == "Watch the cache."
        ));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_state:: > /tmp/t6.txt 2>&1`
Expected: compile errors: no `Overlay`, `Approval`, `Verdict`, `Focus`, `LiveLayout`, `note_layout`, `scroll_back`, `overlay`, `focus`, `Entry::Decision`, Banner `notes`.

- [ ] **Step 3: Implement the types and fields**

In `core/src/bin/nexus_tui/live_state.rs`:

1. Change `use crate::protocol::{Command, Event, PROTOCOL_VERSION};` to `use crate::protocol::{Command, Event, PROTOCOL_VERSION, Review};` and add `use crate::review::{ReviewLine, review_lines};`.
2. In `Entry::Banner` add `notes: Option<String>,` after `summary`, and add a variant after `Notice(String),`:

```rust
    /// The operator's answer to an approval request.
    Decision {
        tool: String,
        subject: String,
        verdict: Verdict,
    },
```

3. Add after the `Action` enum:

```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Verdict {
    Approved,
    /// Approved, and every later action in the session runs without asking (the sidecar switches to auto).
    ApprovedForSession,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Focus {
    Composer,
    Transcript,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Approval {
    pub id: String,
    pub tool: String,
    pub subject: String,
    pub lines: Vec<ReviewLine>,
    pub scroll: usize,
}

/// Modal panels. While one is open it receives every key except Ctrl-C.
#[derive(Clone, Debug, PartialEq)]
pub enum Overlay {
    Approval(Approval),
    Help { scroll: usize },
}

/// What the last frame measured. Key handling uses it for page sizes, and it clamps scrolling at the top.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LiveLayout {
    pub transcript_rows: usize,
    /// Largest useful `scroll_back`; `usize::MAX` when the frame did not reach the top of the transcript.
    pub scroll_limit: usize,
    pub overlay_rows: usize,
    pub overlay_limit: usize,
}
```

4. Add fields to `LiveState` (after `cancel_requested`):

```rust
    pub focus: Focus,
    pub overlay: Option<Overlay>,
    /// Transcript rows hidden below the viewport; 0 follows the newest line.
    pub scroll_back: usize,
    /// Quit was requested; the frame says so while the sidecar shuts down.
    pub closing: bool,
    layout: LiveLayout,
```

and initialize them in `new()`:

```rust
            focus: Focus::Composer,
            overlay: None,
            scroll_back: 0,
            closing: false,
            layout: LiveLayout::default(),
```

- [ ] **Step 4: Implement the behaviour**

1. In `apply`, replace the `Event::ApprovalRequest` arm with:

```rust
            Event::ApprovalRequest {
                id,
                tool,
                subject,
                review,
            } => {
                let lines = review_lines(review.as_ref().unwrap_or(&Review::Unknown));
                self.overlay = Some(Overlay::Approval(Approval {
                    id,
                    tool,
                    subject,
                    lines,
                    scroll: 0,
                }));
            }
```

2. In the `Event::TurnResult` arm, call `self.close_approval();` after `self.interrupt_running_tools();`, and build the banner with notes:

```rust
                let (summary, notes) = model_summary
                    .map_or((None, None), |model| (Some(model.summary), model.notes));
                self.transcript.push(Entry::Banner {
                    heading,
                    line,
                    tone: tone_for(&turn),
                    failure: turn["inferenceFailure"]["message"].as_str().map(str::to_string),
                    summary,
                    notes,
                });
```

3. In `fail` and in `restarted`, add `self.close_approval();` as the first statement.

4. Add these methods to `impl LiveState`:

```rust
    /// Records what the frame measured and clamps scrolling to it.
    pub fn note_layout(&mut self, layout: LiveLayout) {
        self.scroll_back = self.scroll_back.min(layout.scroll_limit);
        if let Some(Overlay::Approval(Approval { scroll, .. }) | Overlay::Help { scroll }) = &mut self.overlay {
            *scroll = (*scroll).min(layout.overlay_limit);
        }
        self.layout = layout;
    }

    fn close_approval(&mut self) {
        if matches!(self.overlay, Some(Overlay::Approval(_))) {
            self.overlay = None;
        }
    }

    fn page(rows: usize) -> usize {
        rows.saturating_sub(1).max(1)
    }

    fn on_approval_key(&mut self, key: KeyEvent) -> Option<Action> {
        let verdict = match key.code {
            KeyCode::Char('y' | 'Y') | KeyCode::Enter => Verdict::Approved,
            KeyCode::Char('a' | 'A') => Verdict::ApprovedForSession,
            KeyCode::Char('n' | 'N') | KeyCode::Esc => Verdict::Denied,
            code => {
                self.scroll_overlay(code);
                return None;
            }
        };
        let Some(Overlay::Approval(approval)) = self.overlay.take() else {
            return None;
        };
        self.transcript.push(Entry::Decision {
            tool: approval.tool,
            subject: approval.subject,
            verdict,
        });
        Some(Action::Send(match verdict {
            Verdict::Denied => Command::Deny { id: approval.id },
            verdict => Command::Approve {
                id: approval.id,
                always: verdict == Verdict::ApprovedForSession,
            },
        }))
    }

    fn on_help_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('?' | 'q') => self.overlay = None,
            code => self.scroll_overlay(code),
        }
    }

    /// Scrolls the open overlay. The next frame clamps past-the-end values through `note_layout`.
    fn scroll_overlay(&mut self, code: KeyCode) {
        let page = Self::page(self.layout.overlay_rows);
        if let Some(Overlay::Approval(Approval { scroll, .. }) | Overlay::Help { scroll }) = &mut self.overlay {
            *scroll = match code {
                KeyCode::Up | KeyCode::Char('k') => scroll.saturating_sub(1),
                KeyCode::Down | KeyCode::Char('j') => scroll.saturating_add(1),
                KeyCode::PageUp => scroll.saturating_sub(page),
                KeyCode::PageDown => scroll.saturating_add(page),
                KeyCode::Home => 0,
                KeyCode::End => usize::MAX,
                _ => *scroll,
            };
        }
    }

    fn on_transcript_key(&mut self, key: KeyEvent) -> Option<Action> {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => self.scroll_back = self.scroll_back.saturating_add(1),
            KeyCode::Down | KeyCode::Char('j') => self.scroll_back = self.scroll_back.saturating_sub(1),
            KeyCode::Home | KeyCode::Char('g') => self.scroll_back = usize::MAX,
            KeyCode::End | KeyCode::Char('G') => self.scroll_back = 0,
            KeyCode::Enter => self.focus = Focus::Composer,
            KeyCode::Char(_)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.focus = Focus::Composer;
                return self.on_composer_key(key);
            }
            _ => {}
        }
        None
    }
```

(With the default `layout.overlay_rows` of 0, `page` is 1 before the first frame; after a frame with `overlay_rows: 4` a page is 3. The test above uses 1 + 1 + 3 = 5.)

5. Replace `on_key` and `on_ctrl_c` with:

```rust
    pub fn on_key(&mut self, key: KeyEvent) -> Option<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if matches!(self.link, Link::Crashed { .. }) {
            return match key.code {
                KeyCode::Char('r') if !ctrl => Some(Action::Restart),
                KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
                KeyCode::Char('c') if ctrl => Some(Action::Quit),
                _ => None,
            };
        }
        if key.code == KeyCode::Char('c') && ctrl {
            return self.on_ctrl_c();
        }
        match self.overlay {
            Some(Overlay::Approval(_)) => return self.on_approval_key(key),
            Some(Overlay::Help { .. }) => {
                self.on_help_key(key);
                return None;
            }
            None => {}
        }
        let page = Self::page(self.layout.transcript_rows);
        match key.code {
            KeyCode::Tab => {
                self.focus = match self.focus {
                    Focus::Composer => Focus::Transcript,
                    Focus::Transcript => Focus::Composer,
                };
                None
            }
            KeyCode::PageUp => {
                self.scroll_back = self.scroll_back.saturating_add(page);
                None
            }
            KeyCode::PageDown => {
                self.scroll_back = self.scroll_back.saturating_sub(page);
                None
            }
            KeyCode::Esc if self.focus == Focus::Transcript => {
                self.focus = Focus::Composer;
                None
            }
            KeyCode::Esc if self.session.busy => Some(Action::Send(Command::Cancel)),
            KeyCode::Esc => None,
            _ if self.focus == Focus::Transcript => self.on_transcript_key(key),
            KeyCode::Char('?') if !ctrl && self.composer.is_empty() => {
                self.overlay = Some(Overlay::Help { scroll: 0 });
                None
            }
            _ => self.on_composer_key(key),
        }
    }

    fn on_ctrl_c(&mut self) -> Option<Action> {
        match self.overlay {
            Some(Overlay::Help { .. }) => {
                self.overlay = None;
                return None;
            }
            // Cancelling the turn settles the pending approval on the sidecar; the turn result reports it.
            Some(Overlay::Approval(_)) => self.overlay = None,
            None => {}
        }
        if self.session.busy && self.cancel_requested {
            Some(Action::Quit)
        } else if self.session.busy {
            self.cancel_requested = true;
            Some(Action::Send(Command::Cancel))
        } else if !self.composer.is_empty() {
            self.composer.clear();
            None
        } else {
            Some(Action::Quit)
        }
    }
```

6. In `submit`, after `let text = self.composer.take();` add:

```rust
        self.scroll_back = 0;
        self.focus = Focus::Composer;
```

7. `live_view.rs` must still compile: in its `Entry::Banner { .. }` match arm add `notes: _,` to the destructuring, and add an arm for `Entry::Decision { .. } => {}` in `entry_lines` (Task 7 renders both).

- [ ] **Step 5: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t6.txt 2>&1`
Expected: PASS, 89 tests (82 + 7; one test replaced).

- [ ] **Step 6: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_state.rs core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): approval modal, help overlay, transcript focus and scrollback in live state"
```

---

### Task 7: Cursor, scrollback and decision rendering

**Files:**
- Modify: `core/src/bin/nexus_tui/live_view.rs`

- [ ] **Step 1: Write the failing tests**

In the test module of `core/src/bin/nexus_tui/live_view.rs`:

1. Change the imports to:

```rust
    use super::*;
    use crate::live_state::{Focus, LiveLayout, Verdict};
    use crate::protocol::{Event, parse_event};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend, layout::Position};
```

2. Change the `draw` helper and add `draw_measured`:

```rust
    fn draw(state: &LiveState, width: u16, height: u16) -> String {
        draw_measured(state, width, height).0
    }

    fn draw_measured(state: &LiveState, width: u16, height: u16) -> (String, LiveLayout) {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        let mut layout = LiveLayout::default();
        terminal
            .draw(|frame| layout = render_live(frame, state))
            .unwrap();
        (terminal.backend().to_string(), layout)
    }
```

3. Add tests:

```rust
    fn press(state: &mut LiveState, text: &str) {
        for c in text.chars() {
            state.on_key(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
    }

    #[test]
    fn the_terminal_cursor_sits_at_the_composer_cursor() {
        let mut state = ready();
        press(&mut state, "fix");
        state.on_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal.draw(|frame| {
            render_live(frame, &state);
        })
        .unwrap();
        assert_eq!(terminal.get_cursor_position().unwrap(), Position::new(4, 19));
    }

    #[test]
    fn long_drafts_wrap_by_character_and_keep_the_cursor_row_visible() {
        let mut state = ready();
        state.composer = format!("{}END", "x".repeat(400)).as_str().into();
        let screen = rows(&draw(&state, 40, 20));
        assert_eq!(screen[19], format!("  {}END", "x".repeat(400 % 38)));
        assert!(screen[13].contains('─'), "composer is capped at 6 rows: {screen:#?}");
    }

    #[test]
    fn scrolled_back_transcripts_show_older_rows_and_a_badge() {
        let mut state = ready();
        let text = (1..=80)
            .map(|n| format!("row {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        state.apply(Event::AssistantDelta {
            turn_id: "t1".into(),
            text,
        });
        state.scroll_back = 30;
        let (screen, layout) = draw_measured(&state, 60, 16);
        assert_eq!(layout.transcript_rows, 13);
        assert_eq!(
            layout.scroll_limit,
            usize::MAX,
            "the walk stopped before the first entry, so the top is not known yet"
        );
        assert_shows(&screen, &["row 38", "row 50", "↓ 30 more rows · pgdn"]);
        assert!(!screen.contains("row 37") && !screen.contains("row 51"), "{screen}");
        state.scroll_back = usize::MAX;
        let (top, layout) = draw_measured(&state, 60, 16);
        assert_eq!(layout.scroll_limit, 67);
        assert_shows(&top, &["row 1", "row 13", "↓ 67 more rows"]);
        assert!(!top.contains("row 14"), "{top}");
    }

    #[test]
    fn decisions_notes_and_focus_render() {
        let mut state = ready();
        state.transcript.push(Entry::Decision {
            tool: "write_file".into(),
            subject: "x.txt".into(),
            verdict: Verdict::Approved,
        });
        state.transcript.push(Entry::Decision {
            tool: "run_command".into(),
            subject: "rm -rf build".into(),
            verdict: Verdict::Denied,
        });
        state.transcript.push(Entry::Decision {
            tool: "edit_file".into(),
            subject: "a.ts".into(),
            verdict: Verdict::ApprovedForSession,
        });
        feed(
            &mut state,
            &[r#"{"v":1,"type":"turn.result","turn_id":"t1","heading":"H","line":"L","turn":{"execution":"COMPLETED","outcome":"VERIFIED"},"model_summary":{"summary":"Done.","notes":"Watch the cache."}}"#],
        );
        state.focus = Focus::Transcript;
        let screen = draw(&state, 100, 24);
        assert_shows(
            &screen,
            &[
                "✓ approved Write x.txt",
                "× denied Run rm -rf build",
                "✓ approved Edit a.ts · later actions run without asking",
                "Notes:",
                "Watch the cache.",
                "transcript · ↑↓ scroll · tab back",
            ],
        );
    }

    #[test]
    fn closing_says_so() {
        let mut state = ready();
        state.closing = true;
        assert_shows(&draw(&state, 80, 20), &["shutting down the agent"]);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view:: > /tmp/t7.txt 2>&1`
Expected: compile error: `render_live` returns `()`, so `layout = render_live(...)` does not type-check.

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_view.rs`:

1. Change the imports to:

```rust
use crate::composer::{ComposerLayout, PREFIX_WIDTH};
use crate::live_state::{Entry, Focus, Link, LiveLayout, LiveState, Tone, ToolStatus, Verdict};
use crate::{ACCENT, MUTED, SURFACE};
```

2. Replace `render_live` with:

```rust
pub fn render_live(frame: &mut Frame, state: &LiveState) -> LiveLayout {
    let area = frame.area();
    if area.width < MIN_WIDTH || area.height < MIN_HEIGHT {
        frame.render_widget(
            Paragraph::new(format!(
                "Nexus needs a larger terminal ({MIN_WIDTH}×{MIN_HEIGHT} minimum)."
            ))
            .style(Style::default().fg(ACCENT))
            .wrap(Wrap { trim: true }),
            area,
        );
        return LiveLayout::default();
    }
    let composer = state.composer.layout(area.width);
    let composer_rows = if matches!(state.link, Link::Crashed { .. }) {
        1
    } else {
        u16::try_from(composer.rows.len())
            .unwrap_or(MAX_COMPOSER_ROWS)
            .clamp(1, MAX_COMPOSER_ROWS)
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(composer_rows + 1),
        ])
        .split(area);
    render_status(frame, rows[0], state);
    let mut layout = LiveLayout {
        transcript_rows: usize::from(rows[1].height),
        ..LiveLayout::default()
    };
    match &state.link {
        Link::Crashed {
            code,
            reason,
            stderr,
        } => render_crash(frame, rows[1], *code, reason, stderr),
        _ if state.transcript.is_empty() => render_empty(frame, rows[1]),
        _ => {
            layout.scroll_limit =
                render_transcript(frame, rows[1], &state.transcript, state.scroll_back);
        }
    }
    let block = Block::default()
        .borders(Borders::TOP)
        .border_style(Style::default().fg(Color::DarkGray))
        .title(Span::styled(
            composer_hint(state),
            Style::default().fg(MUTED),
        ));
    let inner = block.inner(rows[2]);
    frame.render_widget(block, rows[2]);
    render_composer(frame, inner, state, &composer);
    layout
}
```

3. Delete `render_pinned` and `composer_paragraph`, and add:

```rust
/// Draws the composer rows that hold the cursor and places the terminal cursor while the operator is typing.
fn render_composer(frame: &mut Frame, area: Rect, state: &LiveState, layout: &ComposerLayout) {
    let prompt = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let height = usize::from(area.height);
    let top = (layout.cursor.0 + 1).saturating_sub(height);
    let lines: Vec<Line> = layout
        .rows
        .iter()
        .enumerate()
        .skip(top)
        .take(height)
        .map(|(index, row)| {
            Line::from(vec![
                Span::styled(if index == 0 { "› " } else { "  " }, prompt),
                Span::raw(row.as_str()),
            ])
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), area);
    let typing = !matches!(state.link, Link::Crashed { .. })
        && state.overlay.is_none()
        && state.focus == Focus::Composer
        && !state.closing;
    if typing && let Ok(row) = u16::try_from(layout.cursor.0 - top) {
        frame.set_cursor_position((area.x + PREFIX_WIDTH + layout.cursor.1, area.y + row));
    }
}
```

4. Replace `render_transcript` with:

```rust
/// Renders the transcript window `scroll_back` rows above the newest line. Only the entries needed to fill the
/// window are laid out, so the cost follows the window, not the transcript. Returns the largest useful
/// `scroll_back` (`usize::MAX` when the walk stopped before the first entry).
fn render_transcript(frame: &mut Frame, area: Rect, transcript: &[Entry], scroll_back: usize) -> usize {
    let height = usize::from(area.height);
    let want = height.saturating_add(scroll_back);
    let mut tail = Vec::new();
    let mut total = 0;
    let mut reached_top = true;
    'entries: for (index, entry) in transcript.iter().enumerate().rev() {
        for line in entry_lines(entry, index == 0).into_iter().rev() {
            let rows = wrapped_rows(&line, area.width);
            total += rows;
            tail.push((line, rows));
            if total >= want {
                reached_top = false;
                break 'entries;
            }
        }
    }
    let limit = if reached_top {
        total.saturating_sub(height)
    } else {
        usize::MAX
    };
    let back = scroll_back.min(limit);
    let first_row = total.saturating_sub(height + back);
    tail.reverse();
    let mut skipped = 0;
    let mut covered = 0;
    let mut lines = Vec::new();
    for (line, rows) in tail {
        if skipped + rows <= first_row {
            skipped += rows;
            continue;
        }
        if covered >= height + (first_row - skipped) {
            break;
        }
        covered += rows;
        lines.push(line);
    }
    let offset = u16::try_from(first_row - skipped).unwrap_or(u16::MAX);
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((offset, 0)),
        area,
    );
    if back > 0 {
        render_scroll_badge(frame, area, back);
    }
    limit
}

fn render_scroll_badge(frame: &mut Frame, area: Rect, rows_below: usize) {
    let text = format!(" ↓ {rows_below} more rows · pgdn ");
    let width = u16::try_from(text.chars().count())
        .unwrap_or(area.width)
        .min(area.width);
    let at = Rect::new(area.right() - width, area.bottom() - 1, width, 1);
    frame.render_widget(
        Paragraph::new(Span::styled(
            text,
            Style::default().fg(Color::Black).bg(ACCENT),
        )),
        at,
    );
}
```

5. In `entry_lines`, in the `Entry::Banner` arm destructure `notes` (replace `notes: _`), and after the summary rows (inside `if let Some(summary) = summary { ... }`, after `lines.extend(...)`) add:

```rust
                if let Some(notes) = notes {
                    lines.push(Line::from(Span::styled("Notes:", muted)));
                    lines.extend(
                        notes
                            .split('\n')
                            .map(|row| Line::from(Span::styled(expand_tabs(row), muted))),
                    );
                }
```

Replace the placeholder `Entry::Decision { .. } => {}` arm with:

```rust
        Entry::Decision {
            tool,
            subject,
            verdict,
        } => {
            let (glyph, color, label) = match verdict {
                Verdict::Approved | Verdict::ApprovedForSession => ("✓", Color::Green, "approved"),
                Verdict::Denied => ("×", Color::Red, "denied"),
            };
            let mut spans = vec![
                Span::styled(format!("  {glyph} {label} "), Style::default().fg(color)),
                Span::styled(tool_verb(tool), white),
            ];
            if !subject.is_empty() {
                spans.push(Span::styled(format!(" {subject}"), muted));
            }
            if *verdict == Verdict::ApprovedForSession {
                spans.push(Span::styled(" · later actions run without asking", muted));
            }
            lines.push(Line::from(spans));
        }
```

6. Replace `composer_hint` with:

```rust
fn composer_hint(state: &LiveState) -> &'static str {
    match (&state.link, state.session.busy) {
        _ if state.closing => " shutting down the agent… ",
        (Link::Crashed { .. }, _) => " r restart · q quit ",
        _ if state.connecting() => " starting the agent… ",
        _ if matches!(state.overlay, Some(crate::live_state::Overlay::Approval(_))) => {
            " approval needed · y approve · n deny "
        }
        _ if state.overlay.is_some() => " esc close help ",
        _ if state.focus == Focus::Transcript => " transcript · ↑↓ scroll · tab back ",
        (_, true) if state.cancel_requested() => " cancelling… ctrl-c again to quit ",
        (_, true) => " waiting for the agent ",
        (_, false) => " enter send · shift+enter newline · ? help ",
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t7.txt 2>&1`
Expected: PASS, 94 tests (89 + 5). The existing tail-matching and 100,000-entry tests must still pass unchanged; if `the_tail_matches_the_bottom_of_a_full_render_at_narrow_widths` fails, the window arithmetic is wrong (with `scroll_back` 0 the result must equal the previous tail-only render).

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): real composer cursor, transcript scrollback, decisions and model notes"
```

---

### Task 8: Approval and help overlays

**Files:**
- Modify: `core/src/bin/nexus_tui/live_view.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module of `core/src/bin/nexus_tui/live_view.rs`:

```rust
    fn approval(review: &str) -> String {
        format!(
            r#"{{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"edit_file","subject":"src/x.txt","preview":"{{}}","review":{review}}}"#
        )
    }

    #[test]
    fn the_approval_modal_shows_the_action_a_coloured_diff_and_the_keys() {
        let mut state = ready();
        let request = approval(
            r#"{"kind":"change","path":"src/x.txt","before":"a\nb\nc\n","after":"a\nB\nc\n","created":false,"truncated":false}"#,
        );
        feed(&mut state, &[BUSY, request.as_str()]);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal
            .draw(|frame| {
                render_live(frame, &state);
            })
            .unwrap();
        let screen = terminal.backend().to_string();
        assert_shows(
            &screen,
            &[
                "Approval needed",
                "Edit src/x.txt",
                "@@ -1,3 +1,3 @@",
                "-b",
                "+B",
                "y approve",
                "a always",
                "n deny",
                "approval needed · y approve · n deny",
            ],
        );
        let lines = rows(&screen);
        let added = lines.iter().position(|row| row.contains("+B")).unwrap();
        let column = lines[added].find("+B").unwrap();
        let x = u16::try_from(lines[added][..column].chars().count()).unwrap();
        let cell = &terminal.backend().buffer()[(x, u16::try_from(added).unwrap())];
        assert_eq!(cell.fg, Color::Green);
    }

    #[test]
    fn long_reviews_report_rows_and_limit_and_scroll() {
        let mut state = ready();
        let after: String = (1..=100).map(|n| format!("line {n}\n")).collect();
        let request = approval(&format!(
            r#"{{"kind":"change","path":"n.txt","before":null,"after":{after:?},"created":true,"truncated":false}}"#
        ));
        feed(&mut state, &[request.as_str()]);
        let (screen, layout) = draw_measured(&state, 80, 24);
        assert_eq!(layout.overlay_rows, 17);
        assert_eq!(layout.overlay_limit, 104 - 17);
        assert_shows(&screen, &["new file n.txt", "+line 1"]);
        state.note_layout(layout);
        state.on_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
        assert_shows(&draw(&state, 80, 24), &["+line 100"]);
    }

    #[test]
    fn help_lists_the_keys() {
        let mut state = ready();
        state.on_key(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE));
        assert_shows(
            &draw(&state, 100, 30),
            &["Keys", "shift+enter", "ctrl+c", "approve this action", "esc close help"],
        );
    }

    #[test]
    fn overlays_fit_the_minimum_terminal() {
        let mut state = ready();
        let request = approval(r#"{"kind":"command","command":"npm test"}"#);
        feed(&mut state, &[request.as_str()]);
        assert_shows(&draw(&state, 40, 10), &["$ npm test"]);
        state.overlay = Some(crate::live_state::Overlay::Help { scroll: 0 });
        assert_shows(&draw(&state, 40, 10), &["Keys"]);
    }
```

(`104` = "new file n.txt" + `---` + `+++` + one hunk header + 100 added lines. Modals cover the transcript area only, so the status strip and the composer hint stay visible. At 80×24 that area is 21 rows (24 − status − composer border − one composer row); inside the modal border 19; the header takes 2, leaving 17.)

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live_view:: > /tmp/t8.txt 2>&1`
Expected: the four new tests FAIL (no modal is drawn; `overlay_rows` is 0).

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live_view.rs`:

1. Extend the imports: add `BorderType, Clear` to the `widgets` list, and change the live_state import to also bring `Approval, Overlay`, and add `use crate::review::{LineKind, ReviewLine};`.
2. In `composer_hint`, change `crate::live_state::Overlay::Approval(_)` to `Overlay::Approval(_)`.
3. At the end of `render_live`, before `layout`, add (overlays cover the transcript area `rows[1]`, leaving the status strip and composer hint visible):

```rust
    match &state.overlay {
        Some(Overlay::Approval(approval)) => {
            (layout.overlay_rows, layout.overlay_limit) =
                render_approval(frame, rows[1], approval);
        }
        Some(Overlay::Help { scroll }) => {
            (layout.overlay_rows, layout.overlay_limit) = render_help(frame, rows[1], *scroll);
        }
        None => {}
    }
```

4. Add:

```rust
const HELP: &[(&str, &str)] = &[
    ("", "Keys"),
    ("enter", "send the prompt"),
    ("shift+enter", "new line (alt+enter where shift is not reported)"),
    ("↑ / ↓", "move between lines; recall earlier prompts from the first line"),
    ("ctrl+a / ctrl+e", "start / end of the line"),
    ("ctrl+u / ctrl+k", "delete to the start / end of the line"),
    ("ctrl+w", "delete the previous word"),
    ("ctrl+l", "clear the draft"),
    ("tab", "switch between the composer and the transcript"),
    ("pgup / pgdn", "scroll the transcript"),
    ("esc", "close this panel; cancel a running turn"),
    ("ctrl+c", "cancel a running turn, twice to quit; quit when idle and empty"),
    ("", ""),
    ("", "Approvals (review mode)"),
    ("y / enter", "approve this action"),
    ("a", "approve this and every later action (switches to auto)"),
    ("n / esc", "deny"),
];

/// A modal rectangle at the top of `area`: one column of margin each side, at most `max_width` wide and
/// `wanted_height` tall, centred horizontally.
fn modal(area: Rect, max_width: u16, wanted_height: u16) -> Rect {
    let width = area.width.saturating_sub(2).min(max_width);
    let height = area.height.min(wanted_height);
    Rect::new(area.x + (area.width - width) / 2, area.y, width, height)
}

fn modal_block(title: &'static str) -> Block<'static> {
    Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(
            title,
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ))
}

/// Draws the approval modal; returns the rows available to the review and the largest useful scroll.
fn render_approval(frame: &mut Frame, area: Rect, approval: &Approval) -> (usize, usize) {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let rect = modal(area, area.width, area.height);
    let block = modal_block(" Approval needed ").title_bottom(Line::from(vec![
        Span::styled(" y", key),
        Span::raw(" approve  "),
        Span::styled("a", key),
        Span::raw(" always  "),
        Span::styled("n", key),
        Span::raw(" deny  "),
        Span::styled("↑↓", key),
        Span::raw(" scroll "),
    ]));
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    let [head, body] =
        Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).areas(inner);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                tool_verb(&approval.tool),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!(" {}", approval.subject), Style::default().fg(MUTED)),
        ])),
        head,
    );
    let rows = usize::from(body.height);
    let limit = approval.lines.len().saturating_sub(rows);
    let lines: Vec<Line> = approval
        .lines
        .iter()
        .skip(approval.scroll.min(limit))
        .take(rows)
        .map(review_line)
        .collect();
    frame.render_widget(Paragraph::new(lines), body);
    (rows, limit)
}

fn review_line(line: &ReviewLine) -> Line<'_> {
    let style = match line.kind {
        LineKind::Added => Style::default().fg(Color::Green),
        LineKind::Removed => Style::default().fg(Color::Red),
        LineKind::Hunk => Style::default().fg(Color::Cyan),
        LineKind::Meta => Style::default().fg(MUTED),
        LineKind::Command => Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
        LineKind::Context => Style::default().fg(Color::White),
    };
    Line::from(Span::styled(expand_tabs(&line.text), style))
}

/// Draws the help panel; returns its visible rows and the largest useful scroll.
fn render_help(frame: &mut Frame, area: Rect, scroll: usize) -> (usize, usize) {
    let key = Style::default().fg(ACCENT).add_modifier(Modifier::BOLD);
    let lines: Vec<Line> = HELP
        .iter()
        .map(|(keys, text)| {
            if keys.is_empty() {
                Line::from(Span::styled(
                    *text,
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ))
            } else {
                Line::from(vec![
                    Span::styled(format!("  {keys:<17}"), key),
                    Span::styled(*text, Style::default().fg(Color::White)),
                ])
            }
        })
        .collect();
    let wanted = u16::try_from(lines.len() + 2).unwrap_or(u16::MAX);
    let rect = modal(area, 84, wanted);
    let block = modal_block(" Help ");
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    let rows = usize::from(inner.height);
    let limit = lines.len().saturating_sub(rows);
    frame.render_widget(
        Paragraph::new(lines).scroll((u16::try_from(scroll.min(limit)).unwrap_or(0), 0)),
        inner,
    );
    (rows, limit)
}
```

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t8.txt 2>&1`
Expected: PASS, 98 tests (94 + 4).

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live_view.rs
git add core/src/bin/nexus_tui/live_view.rs
git commit -m "feat(tui): approval modal with unified diff and a key help panel"
```

---

### Task 9: Event loop: layout feedback, keyboard protocol, closing frame, stop signals

**Files:**
- Modify: `core/src/bin/nexus_tui/live.rs`

- [ ] **Step 1: Write the failing tests**

Add to the test module of `core/src/bin/nexus_tui/live.rs` (and add `Verdict` to its `use crate::live_state::...` import: `use crate::live_state::{Entry, Overlay, Verdict};`):

```rust
    #[test]
    fn an_approval_round_trips_through_the_sidecar() {
        let script = format!(
            r#"{HELLO}
read prompt
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":true}}'
echo '{{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{{}}","review":{{"kind":"change","path":"x.txt","before":null,"after":"hi","created":true,"truncated":false}}}}'
read answer
case "$answer" in *'"type":"approve"'*) ;; *) exit 7;; esac
case "$answer" in *'"id":"approval-1"'*) ;; *) exit 7;; esac
case "$answer" in *'"always":false'*) ;; *) exit 7;; esac
echo '{{"v":1,"type":"turn.result","turn_id":"t1","heading":"TURN ENDED - UNVERIFIED","line":"x.txt written","turn":{{"execution":"COMPLETED","outcome":"UNVERIFIED"}},"model_summary":null}}'
echo '{{"v":1,"type":"session.state","workspace":"/w","workspace_name":"w","model":"m","mode":"review","git":null,"busy":false}}'
read shutdown
exit 0"#
        );
        let mut app = LiveApp::start(fake_sidecar(&script));
        pump_until(&mut app, |s| s.link == Link::Ready && s.session.model == "m");
        for code in [KeyCode::Char('g'), KeyCode::Char('o'), KeyCode::Enter] {
            if let Some(action) = app.state.on_key(KeyEvent::new(code, KeyModifiers::NONE)) {
                assert!(app.handle(action));
            }
        }
        pump_until(&mut app, |s| matches!(s.overlay, Some(Overlay::Approval(_))));
        let approve = app
            .state
            .on_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE))
            .unwrap();
        assert!(app.handle(approve));
        pump_until(&mut app, |s| {
            !s.session.busy && s.transcript.iter().any(|e| matches!(e, Entry::Banner { .. }))
        });
        assert_eq!(app.state.link, Link::Ready, "the fake exits 7 on a wrong answer");
        assert!(app.state.transcript.iter().any(|e| matches!(
            e,
            Entry::Decision { verdict: Verdict::Approved, .. }
        )));
        assert!(!app.handle(Action::Quit));
    }

    #[cfg(unix)]
    #[test]
    fn sigterm_requests_a_clean_stop_once() {
        install_stop_signals();
        assert!(!stop_requested());
        // SAFETY: the handler installed above only stores to an atomic.
        unsafe {
            libc::raise(libc::SIGTERM);
        }
        assert!(stop_requested());
        assert!(!stop_requested(), "the request is consumed");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui live:: > /tmp/t9.txt 2>&1`
Expected: compile errors: cannot find `install_stop_signals`, `stop_requested`. (Do not run the SIGTERM test before the handler exists; it would kill the test process. It is gated on the compile error here.)

- [ ] **Step 3: Implement**

In `core/src/bin/nexus_tui/live.rs`:

1. Change the imports to:

```rust
use std::{
    env,
    error::Error,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event as TermEvent, KeyEventKind,
        KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute, terminal,
};

use crate::live_state::{Action, Link, LiveLayout, LiveState};
use crate::live_view::render_live;
use crate::sidecar::{Sidecar, SidecarMsg, SidecarSpec};
```

2. Add after the constants:

```rust
static STOP: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn request_stop(_signal: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

/// SIGTERM and SIGHUP (terminal closed) end the session like `q`: the sidecar is shut down and the terminal
/// restored by the normal exit path.
#[cfg(unix)]
fn install_stop_signals() {
    for signal in [libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe {
            libc::signal(signal, request_stop as *const () as libc::sighandler_t);
        }
    }
}

#[cfg(not(unix))]
fn install_stop_signals() {}

fn stop_requested() -> bool {
    STOP.swap(false, Ordering::SeqCst)
}
```

3. Replace `TerminalGuard` and `run_live` with:

```rust
/// Restores the terminal on every exit path. ratatui's panic hook restores raw mode and the alternate screen
/// but not bracketed paste or the keyboard protocol, so those are undone here, during unwinding as well.
struct TerminalGuard {
    keyboard_protocol: bool,
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.keyboard_protocol {
            let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(io::stdout(), DisableBracketedPaste);
        ratatui::restore();
    }
}

pub fn run_live(spec: SidecarSpec) -> Result<(), Box<dyn std::error::Error>> {
    install_stop_signals();
    let mut guard = TerminalGuard {
        keyboard_protocol: false,
    };
    let mut terminal = ratatui::try_init()?;
    execute!(io::stdout(), EnableBracketedPaste)?;
    // Lets Shift+Enter arrive as its own key on terminals that speak the kitty keyboard protocol.
    if terminal::supports_keyboard_enhancement().unwrap_or(false) {
        execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
        guard.keyboard_protocol = true;
    }
    let mut app = LiveApp::start(spec);
    let result = event_loop(&mut terminal, &mut app);
    app.handle(Action::Quit);
    result
}
```

4. Replace `event_loop` with:

```rust
fn draw(terminal: &mut ratatui::DefaultTerminal, app: &mut LiveApp) -> io::Result<()> {
    let mut layout = LiveLayout::default();
    terminal.draw(|frame| layout = render_live(frame, &app.state))?;
    app.state.note_layout(layout);
    Ok(())
}

fn event_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut LiveApp,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut redraw = true;
    loop {
        if stop_requested() {
            app.state.closing = true;
            draw(terminal, app)?;
            return Ok(());
        }
        redraw |= app.pump();
        if redraw {
            draw(terminal, app)?;
            redraw = false;
        }
        if !event::poll(INPUT_POLL)? {
            continue;
        }
        let action = match event::read()? {
            TermEvent::Key(key) if key.kind == KeyEventKind::Press => app.state.on_key(key),
            TermEvent::Paste(text) => {
                app.state.on_paste(&text);
                None
            }
            TermEvent::Resize(_, _) => None,
            _ => continue,
        };
        redraw = true;
        let Some(action) = action else {
            continue;
        };
        if action == Action::Quit {
            app.state.closing = true;
            draw(terminal, app)?;
        }
        if !app.handle(action) {
            return Ok(());
        }
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `command cargo test --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/t9.txt 2>&1`
Expected: PASS, 100 tests (98 + 2). Then `pgrep -af 'sidecar.js|sleep 30'` shows nothing left by the tests.

Run: `command cargo build --manifest-path core/Cargo.toml --bin nexus-tui > /tmp/b9.txt 2>&1`
Expected: zero warnings in `nexus_tui` files (every new type is now used). Fix any that remain properly; do not add `allow` attributes.

- [ ] **Step 5: Commit**

```bash
rustfmt --edition 2024 core/src/bin/nexus_tui/live.rs
git add core/src/bin/nexus_tui/live.rs
git commit -m "feat(tui): layout feedback, kitty keyboard protocol, closing frame and stop signals"
```

---

### Task 9A: Multiline objective integrity across the live boundary (acceptance addendum)

Added after the defect reconciliation review (`docs/reviews/NEXUS_DEFECT_RECONCILIATION_PHASE3_2026-10-04.md`, main commit `0024449`). The legacy readline REPL drops every pasted line after the first (defect D1). The TUI composer is a separate input path, and this task proves that path across the real boundary: PTY keystrokes → `nexus-tui` → NDJSON `prompt.submit` → real sidecar → agent → gateway. It changes no product code. It does not touch `repl.ts`, `harness run -j`, verifier timeouts or context budgeting (D2–D4 are out of scope).

**Files:**
- Create: `cli/test/helpers/sidecar_recorder.mjs`
- Create: `cli/test/tui_multiline_e2e.test.ts`
- Create: `docs/reviews/NEXUS_TUI_MULTILINE_QUALIFICATION_2026-10-04.md`

**Composer contract under test** (`composer.rs` `insert`, used by `on_paste`): `\r\n` becomes `\n`, then a lone `\r` becomes `\n`; tab and newline are kept; other control characters are dropped. `take()` submits the draft verbatim (no trimming). The agent's only established transformation (`cli/src/agent.ts`, `effectiveUserContent`) is that in a git workspace the first user message is `prompt + "\n" + runtimeContext`, where `runtimeContext` starts with `"\n[Git Status: <branch> (<n> uncommitted dirty files)]"`. No active plan exists in a fresh session, so nothing else is appended. Confirm both against the code before writing assertions; if either differs, assert the real contract and report the difference.

- [ ] **Step 1: Recorder shim**

`nexus-tui --live --sidecar PATH --node BIN -- ARGS` runs `BIN PATH ARGS`. Create `cli/test/helpers/sidecar_recorder.mjs`, a transparent shim launched as that `PATH`. It spawns `process.execPath` with `[process.env.NEXUS_RECORD_SIDECAR, ...process.argv.slice(2)]` and `stdio: ["pipe", "pipe", "inherit"]`. Every stdin chunk is appended to `process.env.NEXUS_RECORD_COMMANDS` and forwarded to the child; stdin end ends the child's stdin. Every child stdout chunk is appended to `process.env.NEXUS_RECORD_EVENTS` and forwarded to `process.stdout`. It forwards SIGTERM, SIGINT and SIGHUP to the child and exits with the child's exit code (1 if it was killed by a signal). Use synchronous appends so the logs are complete when the process exits. The shim never parses, filters or rewrites bytes.

- [ ] **Step 2: The end-to-end test**

Create `cli/test/tui_multiline_e2e.test.ts` with one test: "a pasted multiline objective reaches the agent intact as exactly one prompt".

Prerequisites: `core/target/release/nexus-tui`, `cli/dist/sidecar.js` and `script` (util-linux) must exist. If any is missing, fail with a message naming `make build`. Do not skip: a skipped acceptance test is not evidence.

Rig:
- `startGateway((n) => ({ kind: "text", content: "Noted." }))`, `makeRepo()` and `makeHome()` from `./helpers/fixtures.js`. Use temp files for the two recorder logs.
- Spawn `script -qfec "<cmd>" /dev/null` with `stdio: ["pipe", "pipe", "pipe"]`. `<cmd>` is `stty rows 40 cols 120; exec <tui> --live --sidecar <recorder> --node <process.execPath> -- -w <repo> -e <gw.url> -m m`, with every path shell-quoted. The env is `{ ...process.env, HOME: home, NEXUS_DEBUG: "0", NEXUS_RECORD_SIDECAR: <abs cli/dist/sidecar.js>, NEXUS_RECORD_COMMANDS, NEXUS_RECORD_EVENTS }`.
- Answer the terminal like a real terminal without the kitty keyboard protocol: whenever new PTY output contains `\x1b[c`, write `\x1b[?62c` (send no `\x1b[?u` answer). Otherwise crossterm waits out its query timeout.
- Readiness: wait until the events log contains a `session.state` line and the PTY output contains a hint that live_view only draws once the link is ready (find the exact text in `live_view.rs`). Then wait 300 ms more.

Objective (22 lines; LF form shown; `⇥` is a literal tab):

```
Fix the flaky retry logic in the payment webhook handler.

Context:
The handler in src/webhooks/payment.ts retries failed deliveries, but
retries sometimes fire twice when the upstream returns 502 & then times out.

Requirements:
  1. Keep the public API unchanged; callers rely on `handle(event, opts)`.
  2. Cap retries at 3, with exponential backoff (250ms, 500ms, 1s).
     - Jitter must stay within +/-10%.
     - Do not retry 4xx responses, except 429.
  3. Log each attempt as: "attempt=<n> status=<code> delay=<ms>".

⇥Tab-indented note: the queue lives in src/queue/index.ts.

Notes from the incident channel, pasted verbatim:
/exit
> that line above was someone trying to leave the chat, ignore it.
    // keep this code-looking comment exactly as written

Acceptance: all tests in test/webhooks pass; no new dependencies.
Deadline: Friday?! Questions -> ask in #payments. Owner: TBD
```

Input sequence, each write separate, about 150 ms apart:
1. Bracketed paste: `\x1b[200~` + the objective joined with `\r\n`, except that the break between the `> that line above…` line and the `    // keep this…` line is a lone `\r` + `\x1b[201~`. There is no trailing line break.
2. In-composer edits: Backspace (`\x7f`) three times and then `mike`, which edits the last line. Then Up (`\x1b[A`) to the `Acceptance:` line, End (`\x1b[F`), then ` Run the suite twice.`
3. Enter (`\r`), exactly once.

Write `EXPECTED` as a literal in the test, not computed from the input: the LF objective with the last line `Deadline: Friday?! Questions -> ask in #payments. Owner: mike` and the `Acceptance:` line ending `no new dependencies. Run the suite twice.`.

Assertions, in this order:
1. Wait (≤ 30 s) for a `turn.result` in the events log. The commands log then holds exactly one line, and it parses to `{ v: 1, type: "prompt.submit", id, text }` with `text === EXPECTED` (byte-exact; LF only: no `\r` anywhere).
2. `EXPECTED` itself (sanity, catches a wrong literal): 22 lines, 5 blank lines, contains `"\n/exit\n"`, `"\n\tTab-indented"`, `"\n    // keep"` and `"\n     - Jitter"`.
3. The events log has exactly one `turn.result`, no `error` event, and its `turn.execution` is `COMPLETED`.
4. The gateway's first request's first `role: "user"` message equals `EXPECTED + "\n\n[Git Status: " + …`: assert `content.startsWith(EXPECTED + "\n")` and that the remainder matches `/^\n\[Git Status: [^\]\n]+ \(\d+ uncommitted dirty files\)\]$/`.
5. `/exit` did not end the session: wait 1 s; the `script` child is still running and the commands log still has exactly one line.
6. Quit with Ctrl-C (`\x03`, idle with an empty composer, so the TUI quits). The `script` child exits 0 within 20 s. The commands log is then exactly two lines: the `prompt.submit` above and a `shutdown`. No other command was sent at any point.

Cleanup in `finally`: SIGKILL the child if still running, close the gateway, remove the repo, home and logs.

- [ ] **Step 3: Run it**

Run: `cd cli && node --import tsx --test test/tui_multiline_e2e.test.ts > /tmp/t9a.txt 2>&1`
Expected: PASS, 1 test. Then run it twice more; it must pass all three times (no flakiness). Then `pgrep -af 'sidecar.js|nexus-core rpc|nexus-tui'` must show nothing the test started.

If it fails because the product drops, splits, reorders or executes text, do not edit the assertions to match. Stop and report the failure with the logs: that is a Phase 3A defect.

- [ ] **Step 4: Probe terminals without bracketed paste (evidence only, not a suite test)**

With the same rig in a throwaway script under `/tmp`, have the gateway reply after `delayMs: 3000`. Send the same 22 lines as plain keystrokes, with `\r` between lines and no `\x1b[200~`/`\x1b[201~` markers, which is how such a terminal delivers a paste. After the turn ends, wait 1 s and copy the commands log. Capture the composer from the screen (use `pyte` as in Task 10, or the raw PTY output). Then quit with Ctrl-C twice: the first clears the draft. Record exactly which `prompt.submit` commands were sent, their text, and what remained in the composer. Do not change product code because of this probe.

- [ ] **Step 5: Qualification record**

Write `docs/reviews/NEXUS_TUI_MULTILINE_QUALIFICATION_2026-10-04.md` (keep it short):
- What the test proves and where it lives, plus the boundary crossed: PTY bytes → crossterm paste and key events → composer → `Command::PromptSubmit` → recorder (raw bytes) → real `cli/dist/sidecar.js` → agent → fake gateway request body.
- The observed results of three consecutive runs.
- The non-bracketed-paste probe: the observed behaviour, stated plainly. In particular, say whether the first line ran as its own prompt and whether line breaks or text were lost. Disposition `BOUNDED`: Phase 3 enables bracketed paste and relies on it for multiline paste. On terminals that do not provide it, multiline paste is unsupported, and the TUI does not claim otherwise. Making it reliable would need paste-burst heuristics, which are out of Phase 3 scope.
- `LEGACY_REPL_MULTILINE_DEFECT: REMAINS_OPEN` (the TUI bypasses `repl.ts`; it is not fixed). D2, D3 and D4 are untouched.
- The status block: `MULTILINE_OBJECTIVE_E2E`, `MULTILINE_SINGLE_SUBMISSION`, `MULTILINE_CONTENT_INTEGRITY`, `COMMAND_LIKE_TEXT_PRESERVED_AS_DATA`, `NON_BRACKETED_PASTE`, `LEGACY_REPL_MULTILINE_DEFECT`.

- [ ] **Step 6: Commit**

```bash
git add cli/test/helpers/sidecar_recorder.mjs cli/test/tui_multiline_e2e.test.ts docs/reviews/NEXUS_TUI_MULTILINE_QUALIFICATION_2026-10-04.md
git commit -m "test(tui): end-to-end multiline objective integrity through the live sidecar boundary"
```

Count effect: the CLI suite becomes 308 tests (307 + 1) and the only allowed failure is still `SCAN-001 & SCAN-004`. Rust counts are unchanged by this task.

---

### Task 10: Full verification and PTY smoke

**Files:**
- No source changes expected. Clippy fix-ups only, committed as `fix(tui): clippy findings in phase 3a`.

- [ ] **Step 1: Build, lint, test**

```bash
make build > /tmp/v-build.txt 2>&1
command cargo clippy --manifest-path core/Cargo.toml --bin nexus-tui --all-targets > /tmp/v-clippy.txt 2>&1
command cargo test --manifest-path core/Cargo.toml > /tmp/v-test.txt 2>&1
cd cli && node --import tsx --test test/*.test.ts > /tmp/v-cli.txt 2>&1
```

Expected: build succeeds; no clippy findings pointing into `core/src/bin/nexus_tui.rs` or `core/src/bin/nexus_tui/` (pre-existing `harness-core` warnings are out of scope); all cargo tests pass (108 in `nexus-tui`: the 100 planned plus eight added during review, including the single-line hunk header test and five for the approval grace period and overlay pastes); CLI suite 308 tests (Task 9A added one), with only the known `SCAN-001 & SCAN-004` failure; `tui_multiline_e2e.test.ts` passes.

- [ ] **Step 2: PTY driver**

Write `/tmp/nexus_live_pty.py` (outside the repo) that spawns a command in a pseudo-terminal of 100×30 (`pty.fork`, `TIOCSWINSZ`), reads with a `select` timeout, feeds output to `pyte` for screen text (install `pyte` into a throwaway venv under `/tmp` if needed), and offers `send(bytes)`, `wait_for(text, timeout)` and `screen()`. It must answer terminal queries the way a kitty-protocol terminal does: when the output contains `\x1b[?u`, write `\x1b[?0u`; when it contains `\x1b[c`, write `\x1b[?62c`. Without the second answer crossterm waits for its query timeout before the first frame.

- [ ] **Step 3: Smokes**

Run each against the release binary from the worktree. Record the screen text at the key moments, the exit code, and that `\x1b[?1049l`, `\x1b[?2004l` and `\x1b[<u` (keyboard protocol pop) appear at exit.

1. **Editor:** `core/target/release/nexus-tui --live --node sh --sidecar /tmp/fake_idle.sh`, where `fake_idle.sh` prints `hello` and an idle `session.state`, then `read` lines until `shutdown`. Type `hello world`, Ctrl-W, `there`, Shift+Enter as `\x1b[13;2u`, `line two`. Expect composer rows `› hello there` and `  line two`. Then `?`: expect the help panel; Esc closes it. Ctrl-C clears the draft, Ctrl-C again quits; expect "shutting down the agent" on the last frame before exit.
2. **Approval with a fake sidecar:** a `sh` fake that emits an `approval.request` with a `change` review for `src/app.ts` (before `a\nb\n`, after `a\nB\n`) after the first prompt, then expects `approve` with `"always":false`. Expect "Approval needed", `-b` and `+B`; press `y`; expect "✓ approved Edit src/app.ts" and the banner.
3. **Real gateway, review mode:** in a temporary git repo under `/tmp` (never the worktree), run `harness --live --approve` (`harness.sh` already inserts the `--` before sidecar arguments; a second `--` would make the sidecar ignore `--approve`) (the gateway at `127.0.0.1:18010` must be up; `/v1/models` answers 401 without a key, which still means up). Prompt: "Create a file named hello.txt containing the single word hi, then stop." Expect the approval modal with `new file hello.txt` and `+hi`; press `y`; expect the banner, and `hello.txt` contains `hi`. Repeat with a second prompt to overwrite it with `bye` and press `n`; expect "× denied" and the file still says `hi`. Do not read `cli/.env`.
4. **Scrollback:** after the real turn, PgUp; expect the `↓ … more rows · pgdn` badge; End in transcript focus (Tab first) returns to the newest line.
5. **SIGTERM:** start the editor smoke, then `kill -TERM <nexus-tui pid>`; expect exit 0, the restore sequences, and no sidecar process left.

After all smokes, `pgrep -af 'sidecar.js|nexus-core rpc|nexus-tui'` must show nothing you started.

- [ ] **Step 4: Commit any fix-ups**

```bash
git status --short
```

Expected: clean, or only the clippy fix-up commit from Step 1.

---

## Self-review notes

- Spec coverage for phase 3 interaction: multi-line composer (Tasks 4, 5, 7), approval modal with unified diff and approve/deny/always (Tasks 1, 2, 3, 6, 8), Ctrl-C cancel semantics kept (Task 6 keeps phase-2 behaviour and adds the modal case), `?` help (Tasks 6, 8), Tab focus (Task 6), quiet Esc semantics (Task 6). Slash commands, default entry, detail and receipt overlays are plans 3B and 3C.
- Deferred, not forgotten: per-hunk patch approval (a REPL approval feature, scheduled for phase 4), anchoring the scrolled viewport while text streams, mouse wheel scrolling, persistent prompt history, visual-row (rather than logical-line) Up/Down in wrapped drafts.

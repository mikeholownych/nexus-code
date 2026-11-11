//! Sweep of the approval panel's whole state space. Every combination of review kind, terminal size, draft and queue
//! is drawn, and the invariants that make the panel safe to answer are asserted on what reached the screen:
//!
//! - (a) nothing panics, no row is wider than the terminal, the change's rows stay inside it;
//! - (b) the panel counts as answerable only when its buttons and hint were drawn, and `y` approves only after every row
//!   of the change was drawn in some frame; asking to approve all later actions is confirmed only after the question
//!   was drawn;
//! - (c) a terminal too small to draw it refuses with "enlarge the terminal" and Esc still denies; one that is big
//!   enough for a one-line command is never refused (and what is answerable at one height is at every greater height);
//! - (d) no cell of the screen holds a control, bidi, tag, zero-width or blank-looking character;
//! - (e) a burst of keys never answers.
use super::*;
use crate::live_state::{Action, LiveLayout, LiveState, Overlay};
use crate::protocol::{Command, parse_event};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{Terminal, backend::TestBackend};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

const HELLO: &str = r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#;
const BUSY: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":true}"#;

/// What a cell must never hold, listed independently of the predicate the panel uses: controls, bidi and format
/// characters, tag characters, zero-width and blank-looking characters.
fn forbidden(c: char) -> bool {
    let code = c as u32;
    c.is_control()
        || matches!(code,
            0xa0 | 0xad | 0x34f | 0x61c | 0x115f | 0x1160 | 0x1680 | 0x17b4..=0x17b5 | 0x180b..=0x180f | 0x2000..=0x200f | 0x2028..=0x202f
            | 0x205f..=0x206f | 0x2800 | 0x3000 | 0x3164 | 0xfe00..=0xfe0f | 0xfeff | 0xffa0 | 0xfff9..=0xfffb | 0x1d173..=0x1d17a
            | 0xe0000..=0xe0fff)
}

/// One of every kind of character `forbidden` lists.
fn bad() -> String {
    let mut out = String::new();
    for code in (0x1bu32..=0x1b).chain([0x0d, 0x7f, 0x85, 0x9f, 0xa0, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x1680, 0x17b4, 0x180b, 0x180e, 0x2800, 0x3000, 0x3164, 0xfeff, 0xffa0, 0xe0001])
        .chain(0x2000..=0x200f)
        .chain(0x2028..=0x202f)
        .chain(0x205f..=0x206f)
        .chain(0xfe00..=0xfe0f)
        .chain(0xfff9..=0xfffb)
        .chain(0x1d173..=0x1d17a)
        .chain(0xe0020..=0xe007f)
        .chain(0xe0100..=0xe0102)
    {
        out.push(char::from_u32(code).unwrap());
    }
    out
}

#[derive(Clone)]
struct Kind {
    name: &'static str,
    tool: String,
    subject: String,
    review: serde_json::Value,
    /// Short strings that must reach the screen (in some frame) before the change counts as read.
    tokens: Vec<String>,
}

fn kinds(bad: &str) -> Vec<Kind> {
    let kind = |name, tool: &str, subject: &str, review: serde_json::Value, tokens: &[&str]| Kind {
        name,
        tool: tool.to_string(),
        subject: format!("{subject}{bad}"),
        review,
        tokens: tokens.iter().map(|token| token.to_string()).collect(),
    };
    let numbered = |prefix: &str, count: usize| (0..count).map(|n| format!("{prefix}{n:02}\n")).collect::<String>();
    let long_command = format!("echo {}ZZTAIL{bad}", (0..30).map(|n| format!("word{n} ")).collect::<String>());
    vec![
        kind("command", "run_command", "echo ok", serde_json::json!({"kind": "command", "command": format!("echo ok{bad}")}), &["echook"]),
        kind("command multi", "run_command", "deploy", serde_json::json!({"kind": "command", "command": format!("{}echo end{bad}", numbered("echo qa", 8))}), &["echoqa00", "echoqa07", "echoend"]),
        kind("command long", "run_command", "x", serde_json::json!({"kind": "command", "command": long_command}), &["ZZTAIL"]),
        kind("verifier", "run_tests", "npm test", serde_json::json!({"kind": "verifier", "command": format!("npm test{bad}"), "script": format!("echo qv1\nqv2{bad}"), "detail": format!("qv3{bad}")}), &["npmtest", "qv1", "qv2", "qv3"]),
        kind("args", "fetch_web", "x", serde_json::json!({"kind": "args", "text": format!("qw1\nqw2{bad}\nqw3"), "truncated": true}), &["qw1", "qw2", "qw3", "previewtruncated"]),
        kind("create", "write_file", "a.txt", serde_json::json!({"kind": "change", "path": format!("a{bad}.txt"), "before": null, "after": format!("{}z{bad}", numbered("qc", 12)), "created": true, "truncated": false}), &["qc00", "qc05", "qc11"]),
        kind("create empty", "write_file", "a.txt", serde_json::json!({"kind": "change", "path": format!("a{bad}.txt"), "before": null, "after": "", "created": true, "truncated": false}), &["nochanges"]),
        kind("identical", "write_file", "a.txt", serde_json::json!({"kind": "change", "path": format!("a{bad}.txt"), "before": "same\n", "after": "same\n", "created": false, "truncated": false}), &["nochanges"]),
        kind("edit", "write_file", "a.txt", serde_json::json!({"kind": "change", "path": "a.txt", "before": format!("a\nb{bad}\nc\n"), "after": format!("a\nqe1{bad}\nc\n"), "created": false, "truncated": false}), &["qe1"]),
        kind("patch", "patch_file", "x", serde_json::json!({"kind": "patch", "path": "x", "patch": format!("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ sec{bad}\n-qp1{bad}\n+qp2{bad}\n qp3"), "truncated": false}), &["qp1", "qp2", "qp3"]),
        kind("patch no hunks", "patch_file", "x", serde_json::json!({"kind": "patch", "path": "x", "patch": format!("--- a/x\n+++ b/x\nBinary files differ{bad}"), "truncated": false}), &["Binaryfiles"]),
        kind("unknown tool", "zap_things", "x", serde_json::json!({"kind": "args", "text": format!("qz1{bad}"), "truncated": false}), &["qz1"]),
        kind("future kind", "zap_things", "x", serde_json::json!({"kind": "future-kind"}), &["Thisrequesthasnopreview"]),
    ]
}

fn request(kind: &Kind, id: &str) -> String {
    serde_json::json!({"v": 1, "type": "approval.request", "id": id, "turn_id": "t1", "tool": kind.tool, "subject": kind.subject, "preview": "", "review": kind.review}).to_string()
}

fn build(kind: &Kind, draft: &str, queued: bool) -> LiveState {
    let mut state = LiveState::new();
    for line in [HELLO, BUSY, request(kind, "a1").as_str()] {
        state.apply(parse_event(line).unwrap());
    }
    if queued {
        state.apply(parse_event(&request(kind, "a2")).unwrap());
    }
    state.composer.insert(draft);
    state
}

struct Frame {
    /// The notice and the question as the frame drew them (the frame's own `note_layout` may clear them after).
    notice: Option<&'static str>,
    confirming: bool,
    rows: Vec<String>,
    layout: LiveLayout,
    terminal: Terminal<TestBackend>,
}

/// How a frame is drawn: the whole screen (composer, status and all), or the panel alone in a rectangle of that size
/// (cheap, so every panel height can be swept).
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Screen,
    Panel,
}

fn draw(state: &mut LiveState, width: u16, height: u16, mode: Mode) -> Frame {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    let mut layout = LiveLayout::default();
    let (notice, confirming) = match &state.overlay {
        Some(Overlay::Approval(approval)) => (approval.notice, approval.confirming),
        _ => (None, false),
    };
    terminal
        .draw(|frame| match (mode, &state.overlay) {
            (Mode::Panel, Some(Overlay::Approval(approval))) => render_approval(frame, frame.area(), approval, state.depth, state.approvals_waiting(), &mut layout),
            _ => layout = render_live(frame, state),
        })
        .unwrap();
    state.note_layout(layout);
    let buffer = terminal.backend().buffer();
    let rows = (0..height).map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect::<String>()).collect();
    Frame { notice, confirming, rows, layout, terminal }
}

/// A row's text without spaces and panel borders, so wrapped text compares by its characters.
fn flat(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace() && *c != '│').collect()
}

fn answerable(state: &LiveState) -> bool {
    matches!(&state.overlay, Some(Overlay::Approval(approval)) if approval.shown)
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn is_approve(action: &Option<Action>, always: bool) -> bool {
    matches!(action, Some(Action::Send(Command::Approve { always: a, .. })) if *a == always)
}

/// What a frame of an answerable panel must show: the three buttons and the hint (the question when confirming).
fn check_answerable_frame(state: &LiveState, frame: &Frame, tag: &str, out: &mut Vec<String>) {
    let all = flat(&frame.rows.join(""));
    let _ = state;
    if !frame.layout.approval_drawn {
        out.push(format!("{tag}: answerable but the frame did not draw it"));
    }
    for needed in ["Approve", "Deny"] {
        if !all.contains(needed) {
            out.push(format!("{tag}: answerable without {needed} drawn"));
        }
    }
    if !all.contains("Alllater") && !all.contains("Approvealllateractions") {
        out.push(format!("{tag}: answerable without the approve-all button drawn"));
    }
    match frame.notice {
        Some(notice) => {
            let head: String = flat(notice.split(" — ").next().unwrap_or(notice)).chars().take(10).collect();
            if !all.contains(&head) {
                out.push(format!("{tag}: the notice {notice:?} was not drawn"));
            }
        }
        None if frame.confirming => {
            if !all.contains("confirms") || !all.contains("all") {
                out.push(format!("{tag}: confirming without the question drawn"));
            }
        }
        None => {}
    }
    if frame.notice.is_none() && !all.contains("denies") {
        out.push(format!("{tag}: answerable without the Esc hint drawn"));
    }
}

/// Reads the rows of the change the frame drew into `doc`, by their index in the change.
fn record(doc: &mut BTreeMap<usize, String>, frame: &Frame) {
    let layout = frame.layout;
    let buffer = frame.terminal.backend().buffer();
    for row in 0..layout.overlay_rows {
        let y = layout.approval_body.y + u16::try_from(row).unwrap();
        let text: String = (layout.approval_body.x..layout.approval_body.right()).map(|x| buffer[(x, y)].symbol()).collect();
        doc.insert(layout.approval_top + row, text);
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Finish {
    Approve,
    ApproveAll,
}

/// Reads the change a page at a time, pressing the decision key between pages, until it answers. Returns the
/// violations found.
fn read_through(kind: &Kind, draft: &str, queued: bool, width: u16, height: u16, mode: Mode, finish: Finish, tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let t0 = Instant::now();
    let mut state = build(kind, draft, queued);
    let mut frame = draw(&mut state, width, height, mode);
    if !answerable(&state) {
        return out;
    }
    let mut doc = BTreeMap::new();
    let mut clock = 0u64;
    let at = |ms: u64| t0 + Duration::from_millis(ms);
    for step in 0..80 {
        let tag = format!("{tag} step {step}");
        check_answerable_frame(&state, &frame, &tag, &mut out);
        record(&mut doc, &frame);
        let read = {
            let all: String = doc.values().map(|row| flat(row)).collect();
            kind.tokens.iter().all(|token| all.contains(token.as_str()))
        };
        let complete = matches!(&state.overlay, Some(Overlay::Approval(approval)) if approval.read_all);
        if complete {
            if !read {
                out.push(format!("{tag}: counted as read before every row was drawn: {doc:?}"));
            }
            if finish == Finish::ApproveAll {
                clock += 3000;
                let action = state.on_key_at(key(KeyCode::Char('a')), at(clock));
                let confirming = matches!(&state.overlay, Some(Overlay::Approval(approval)) if approval.confirming);
                if action.is_some() || !confirming {
                    out.push(format!("{tag}: `a` did not ask the question ({action:?})"));
                    return out;
                }
                // The question must be on screen before Enter can confirm it.
                frame = draw(&mut state, width, height, mode);
                check_answerable_frame(&state, &frame, &format!("{tag} (question)"), &mut out);
                clock += 3000;
                let action = state.on_key_at(key(KeyCode::Enter), at(clock));
                if !is_approve(&action, true) {
                    out.push(format!("{tag}: Enter after the drawn question did not confirm ({action:?})"));
                }
                return out;
            }
            for burst in [vec!['x', 'y'], vec!['y', 'x'], vec!['a', 'a'], vec!['n', 'n']] {
                clock += 3000;
                let keys = burst.into_iter().map(|c| key(KeyCode::Char(c))).collect();
                let action = state.on_key_burst_at(keys, at(clock));
                if action.is_some() || !matches!(state.overlay, Some(Overlay::Approval(_))) {
                    out.push(format!("{tag}: a burst answered ({action:?})"));
                    return out;
                }
            }
            clock += 3000;
            let action = state.on_key_burst_at(vec![key(KeyCode::Enter), key(KeyCode::Enter)], at(clock));
            if action.is_some() {
                out.push(format!("{tag}: Enter, Enter in one burst answered ({action:?})"));
                return out;
            }
            clock += 3000;
            let action = state.on_key_at(key(KeyCode::Char('y')), at(clock));
            if !is_approve(&action, false) {
                out.push(format!("{tag}: y after reading everything did not approve ({action:?})"));
            }
            return out;
        }
        // Not everything was drawn yet: no decision key answers.
        clock += 3000;
        let action = state.on_key_at(key(KeyCode::Char('y')), at(clock));
        if action.is_some() {
            out.push(format!("{tag}: y answered before the change was drawn ({action:?})"));
            return out;
        }
        clock += 3000;
        state.on_key_at(key(KeyCode::PageDown), at(clock));
        frame = draw(&mut state, width, height, mode);
        if !answerable(&state) {
            out.push(format!("{tag}: stopped being answerable while reading"));
            return out;
        }
    }
    out.push(format!("{tag}: could not be read through to an answer"));
    out
}

const WIDTHS: [u16; 5] = [20, 40, 41, 60, 61];
/// Every page of a change whose text is full of unsafe characters: none of them reaches a cell, wherever it is scrolled.
fn scan_every_page(kind: &Kind, width: u16, height: u16, mode: Mode) -> Vec<String> {
    let mut out = Vec::new();
    // The heading wraps the subject over many rows (and is drawn at the top whatever the page): a short one leaves room
    // for the pages.
    let kind = &Kind { subject: "x".to_string(), ..kind.clone() };
    let mut state = build(kind, "", false);
    let mut frame = draw(&mut state, width, height, mode);
    let tag = format!("{} / {width}x{height}", kind.name);
    for page in 0..120 {
        for row in &frame.rows {
            if let Some(c) = row.chars().find(|c| forbidden(*c)) {
                out.push(format!("{tag} page {page}: U+{:04X} is on screen", c as u32));
            }
        }
        let layout = frame.layout;
        if layout.approval_top + layout.overlay_rows >= layout.approval_total {
            return out;
        }
        state.on_key_at(key(KeyCode::PageDown), Instant::now());
        frame = draw(&mut state, width, height, mode);
    }
    out.push(format!("{tag}: the pages never ended"));
    out
}

const READ_WIDTHS: [u16; 3] = [20, 40, 60];
const SCREEN_WIDTHS: [u16; 4] = [20, 40, 60, 100];

fn sweep_kind(kind: &Kind, with_bad: bool, mode: Mode) -> Vec<String> {
    let mut out = Vec::new();
    // Drafts and the queue matter on the whole screen (the draft takes rows); the panel alone only shows the queue.
    let queue = matches!(kind.name, "command" | "patch");
    let drafts: &[(&str, &str, bool)] = match (mode, with_bad, queue) {
        (Mode::Panel, true, _) | (Mode::Screen, true, _) => &[("empty", "", false)],
        (Mode::Panel, false, true) => &[("empty", "", false), ("queued", "", true)],
        (Mode::Panel, false, false) => &[("empty", "", false)],
        (Mode::Screen, false, true) => &[("empty", "", false), ("multiline", "one\ntwo\nthree", false), ("queued", "", true)],
        (Mode::Screen, false, false) => &[("empty", "", false), ("multiline", "one\ntwo\nthree", false)],
    };
    // Text with unsafe characters is drawn at a few sizes only: how a character is shown does not depend on the size.
    let (widths, max_height): (&[u16], u16) = match (mode, with_bad) {
        (Mode::Panel, false) => (&WIDTHS, 20),
        (_, true) => (&[20, 60], 12),
        (Mode::Screen, false) => (&SCREEN_WIDTHS, 20),
    };
    for &(label, draft, queued) in drafts {
        for &width in widths {
            let mut was_answerable = false;
            for height in 1..=max_height {
                let tag = format!("{} / {mode_name} / {label} / {width}x{height}", kind.name, mode_name = if mode == Mode::Panel { "panel" } else { "screen" });
                let mut state = build(kind, draft, queued);
                let frame = draw(&mut state, width, height, mode);
                // (a) and (d): what is on the screen.
                for row in &frame.rows {
                    if unicode_width::UnicodeWidthStr::width(row.as_str()) > usize::from(width) {
                        out.push(format!("{tag}: a row is wider than the terminal"));
                    }
                    if let Some(c) = row.chars().find(|c| forbidden(*c)) {
                        out.push(format!("{tag}: U+{:04X} is on screen", c as u32));
                    }
                }
                // Ratatui leaves zero-width characters out of its cells, so a cell check alone cannot see them: the text the
                // panel draws from must be free of them as well.
                if let Some(Overlay::Approval(approval)) = &state.overlay
                    && let Some(row) = approval.lines.iter().find(|row| row.text.chars().any(forbidden))
                {
                    out.push(format!("{tag}: a row of the panel's text still holds an unsafe character: {:?}", row.text));
                }
                let body = frame.layout.approval_body;
                if body.right() > width || body.bottom() > height {
                    out.push(format!("{tag}: the change's rows are outside the terminal"));
                }
                let shown = answerable(&state);
                // (c): monotonic in height, and a one-line command fits where it plainly can.
                if was_answerable && !shown {
                    out.push(format!("{tag}: answerable at a smaller height, refused here"));
                }
                was_answerable |= shown;
                // Panel: border, heading and its subtitle, buttons, hint, one row. Screen: the same above a one-row
                // status line and the three-row composer.
                let room = if mode == Mode::Panel { 7 } else { 11 };
                if !with_bad && kind.name == "command" && label == "empty" && width >= 60 && height >= room && !shown {
                    out.push(format!("{tag}: a one-line command is refused on a terminal with room for it"));
                }
                if shown {
                    check_answerable_frame(&state, &frame, &tag, &mut out);
                } else {
                    let all = flat(&frame.rows.join(""));
                    let top = frame.rows.iter().position(|row| row.contains('╭'));
                    let bottom = frame.rows.iter().position(|row| row.contains('╰'));
                    if let (Some(top), Some(bottom)) = (top, bottom)
                        && bottom >= top + 2
                        && !all.contains("enlarge")
                    {
                        out.push(format!("{tag}: refused without saying to enlarge the terminal:\n{}", frame.rows.join("\n")));
                    }
                    for code in ['y', 'a'] {
                        if let Some(action) = state.on_key_at(key(KeyCode::Char(code)), Instant::now() + Duration::from_secs(60)) {
                            out.push(format!("{tag}: {code} answered a panel that was not drawn ({action:?})"));
                        }
                    }
                    let action = state.on_key_at(key(KeyCode::Enter), Instant::now() + Duration::from_secs(120));
                    if action.is_some() {
                        out.push(format!("{tag}: Enter answered a panel that was not drawn ({action:?})"));
                    }
                }
                // Esc denies wherever the panel stands.
                let mut fresh = build(kind, draft, queued);
                if !matches!(fresh.on_key_at(key(KeyCode::Esc), Instant::now()), Some(Action::Send(Command::Deny { .. }))) {
                    out.push(format!("{tag}: Esc did not deny"));
                }
                // (b), (e): reading through to an answer. The panel alone: every kind at the widths that wrap differently; the
                // whole screen: the commands, with and without a draft.
                let reads = match mode {
                    Mode::Panel => label == "empty",
                    Mode::Screen => matches!(kind.name, "command" | "command multi") && matches!(label, "empty" | "multiline"),
                };
                if !with_bad && reads && height <= 18 && READ_WIDTHS.contains(&width) {
                    out.extend(read_through(kind, draft, queued, width, height, mode, Finish::Approve, &tag));
                    if matches!(kind.name, "command multi" | "patch") && label == "empty" {
                        out.extend(read_through(kind, draft, queued, width, height, mode, Finish::ApproveAll, &format!("{tag} (all later)")));
                    }
                }
            }
        }
    }
    out
}

#[test]
fn the_approval_panel_holds_its_invariants_across_its_whole_state_space() {
    let started = Instant::now();
    let clean = kinds("");
    let dirty = kinds(&bad());
    let violations: Vec<String> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for kind in &dirty {
            for (width, height) in [(100u16, 30u16), (60, 45)] {
                handles.push(scope.spawn(move || scan_every_page(kind, width, height, Mode::Panel)));
            }
        }
        for (kinds, with_bad) in [(&clean, false), (&dirty, true)] {
            for kind in kinds {
                for mode in [Mode::Panel, Mode::Screen] {
                    handles.push(scope.spawn(move || sweep_kind(kind, with_bad, mode)));
                }
            }
        }
        handles.into_iter().flat_map(|handle| handle.join().expect("the sweep must not panic")).collect()
    });
    // Grouped by what went wrong, with the first example of each.
    let mut groups: BTreeMap<String, (usize, &String)> = BTreeMap::new();
    for violation in &violations {
        let class = violation.split_once(": ").map_or(violation.as_str(), |(_, what)| what).chars().take(60).collect::<String>();
        groups.entry(class).or_insert((0, violation)).0 += 1;
    }
    let report: Vec<String> = groups.iter().map(|(class, (count, first))| format!("{count} x {class}\n    e.g. {first}")).collect();
    assert!(violations.is_empty(), "{} violations in {:?}:\n{}", violations.len(), started.elapsed(), report.join("\n"));
}






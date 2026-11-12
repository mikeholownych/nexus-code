//! Input capabilities (audit D-09, D-10): which key makes a newline, what the hints advertise per terminal, and what
//! the mouse may do. A mouse event never answers an approval, whatever it is and wherever it lands.
use super::*;
use crate::live_state::{Action, Entry, Focus, LiveLayout, LiveState, Overlay};
use crate::protocol::parse_event;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{Terminal, backend::TestBackend};
use std::time::{Duration, Instant};

const HELLO: &str = r#"{"v":1,"type":"hello","protocol":1,"pid":1}"#;
const IDLE: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":false}"#;
const BUSY: &str = r#"{"v":1,"type":"session.state","workspace":"/w/app","workspace_name":"app","model":"m","mode":"auto","git":null,"busy":true}"#;
const APPROVAL: &str = r#"{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{}","review":{"kind":"change","path":"x.txt","before":null,"after":"hi\n","created":true,"truncated":false}}"#;

fn feed(state: &mut LiveState, lines: &[&str]) {
    for line in lines {
        state.apply(parse_event(line).unwrap());
    }
}

fn ready(busy: bool) -> LiveState {
    let mut state = LiveState::new();
    feed(&mut state, &[HELLO, if busy { BUSY } else { IDLE }]);
    state
}

fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, modifiers)
}

fn type_text(state: &mut LiveState, text: &str) {
    for c in text.chars() {
        assert_eq!(state.on_key(key(KeyCode::Char(c), KeyModifiers::NONE)), None);
    }
}

fn tool_call(state: &mut LiveState, name: &str) {
    feed(
        state,
        &[
            &format!(r#"{{"v":1,"type":"tool.start","turn_id":"t1","call_id":"{name}","tool":"read_file","subject":"{name}.ts","evidence":"ev-{name}"}}"#),
            &format!(r#"{{"v":1,"type":"tool.end","turn_id":"t1","call_id":"{name}","tool":"read_file","success":true,"summary":"ok","lines":1,"evidence":"ev-{name}"}}"#),
        ],
    );
}

/// Draws the frame and tells the state what it measured, as the live loop does. Returns the screen rows.
fn draw(state: &mut LiveState, width: u16, height: u16) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
    let mut layout = LiveLayout::default();
    terminal.draw(|frame| layout = render_live(frame, state)).unwrap();
    state.note_layout(layout);
    let buffer = terminal.backend().buffer().clone();
    (0..buffer.area.height)
        .map(|y| (0..buffer.area.width).map(|x| buffer[(x, y)].symbol().to_string()).collect::<String>().trim_end().to_string())
        .collect()
}

fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE }
}

fn click(column: u16, row: u16) -> MouseEvent {
    mouse(MouseEventKind::Down(MouseButton::Left), column, row)
}

fn every_mouse_kind() -> Vec<MouseEventKind> {
    let mut kinds = vec![MouseEventKind::Moved, MouseEventKind::ScrollUp, MouseEventKind::ScrollDown, MouseEventKind::ScrollLeft, MouseEventKind::ScrollRight];
    for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
        kinds.extend([MouseEventKind::Down(button), MouseEventKind::Up(button), MouseEventKind::Drag(button)]);
    }
    kinds
}

fn with_tools(count: usize) -> LiveState {
    let mut state = ready(false);
    for i in 0..count {
        tool_call(&mut state, &format!("k{i}"));
        state.transcript.push(Entry::Info(format!("note {i}")));
    }
    state
}

// ---- D-09: Shift+Enter is advertised only where it works; a documented newline key always works ----

#[test]
fn ctrl_j_and_alt_enter_insert_a_newline_and_never_send() {
    for newline in [key(KeyCode::Char('j'), KeyModifiers::CONTROL), key(KeyCode::Enter, KeyModifiers::ALT), key(KeyCode::Enter, KeyModifiers::SHIFT)] {
        let mut state = ready(false);
        type_text(&mut state, "first");
        assert_eq!(state.on_key(newline), None, "{newline:?} must not send the half-written prompt");
        type_text(&mut state, "second");
        assert_eq!(state.composer.text(), "first\nsecond", "{newline:?}");
        let sent = state.on_key(key(KeyCode::Enter, KeyModifiers::NONE));
        assert!(matches!(sent, Some(Action::Send(_))), "plain enter sends the whole draft: {sent:?}");
    }
}

#[test]
fn a_terminal_that_does_not_report_shift_enter_is_not_told_to_use_it() {
    for width in [120, 80, 60, 44, 40] {
        let mut state = ready(false);
        state.shift_enter = false;
        let screen = draw(&mut state, width, 14).join("\n");
        assert!(!screen.contains("shift+enter") && !screen.contains('⇧'), "width {width}: {screen}");
        assert!(screen.contains("ctrl+j newline"), "width {width}: the key every terminal can send is advertised: {screen}");
    }
}

#[test]
fn a_terminal_that_reports_shift_enter_advertises_it() {
    let mut wide = ready(false);
    wide.shift_enter = true;
    let screen = draw(&mut wide, 100, 14).join("\n");
    assert!(screen.contains("shift+enter newline"), "{screen}");
    assert!(!screen.contains("alt+enter newline"), "{screen}");
    let mut narrow = ready(false);
    narrow.shift_enter = true;
    let screen = draw(&mut narrow, 40, 14).join("\n");
    assert!(screen.contains("⇧↵ newline"), "{screen}");
}

#[test]
fn help_names_the_key_that_works_on_this_terminal_and_says_what_shift_enter_does_here() {
    for supported in [false, true] {
        let mut state = ready(false);
        state.shift_enter = supported;
        state.overlay = Some(Overlay::Help { scroll: 0 });
        let screen = draw(&mut state, 110, 60).join("\n");
        assert!(screen.contains("alt+enter/ctrl+j"), "the documented keys are always listed: {screen}");
        assert!(screen.contains("ctrl+j in every terminal"), "{screen}");
        if supported {
            assert!(screen.contains("this terminal reports it"), "{screen}");
            assert!(!screen.contains("would send"), "{screen}");
        } else {
            assert!(screen.contains("not reported by this terminal"), "{screen}");
            assert!(screen.contains("which would send"), "{screen}");
        }
    }
}

// ---- D-10: wheel scrolls, a click selects a tool card, the mouse never answers an approval ----

#[test]
fn the_wheel_scrolls_the_transcript_and_stops_at_the_newest_line() {
    let mut state = with_tools(30);
    draw(&mut state, 80, 24);
    assert_eq!(state.scroll_back, 0);
    assert_eq!(state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 5)), None);
    assert_eq!(state.scroll_back, 3, "one notch is three rows");
    state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 5));
    assert_eq!(state.scroll_back, 6);
    state.on_mouse(mouse(MouseEventKind::ScrollDown, 10, 5));
    assert_eq!(state.scroll_back, 3);
    for _ in 0..5 {
        state.on_mouse(mouse(MouseEventKind::ScrollDown, 10, 5));
    }
    assert_eq!(state.scroll_back, 0, "saturates at the newest line");
    let rows = draw(&mut state, 80, 24).join("\n");
    assert!(rows.contains("note 29"), "{rows}");
}

#[test]
fn the_wheel_does_not_recall_history_or_touch_the_draft() {
    let mut state = with_tools(30);
    type_text(&mut state, "draft");
    draw(&mut state, 80, 24);
    state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 5));
    assert_eq!(state.composer.text(), "draft");
    assert_eq!(state.scroll_back, 3);
}

#[test]
fn clicking_a_tool_card_selects_it_and_a_second_click_opens_its_details() {
    let mut state = with_tools(6);
    let rows = draw(&mut state, 80, 24);
    let row = rows.iter().position(|r| r.contains("k2.ts")).expect("the k2 card is on screen") as u16;
    assert_eq!(state.focus, Focus::Composer);
    assert_eq!(state.on_mouse(click(8, row)), None);
    assert_eq!(state.focus, Focus::Transcript, "a click focuses the transcript");
    let selected = state.selected.expect("the card is selected");
    assert!(matches!(&state.transcript[selected], Entry::Tool { subject, .. } if subject == "k2.ts"), "{:?}", state.transcript[selected]);
    assert!(state.overlay.is_none(), "the first click only selects");
    let rows = draw(&mut state, 80, 24);
    let row = rows.iter().position(|r| r.contains("k2.ts")).unwrap() as u16;
    let opened = state.on_mouse(click(8, row));
    assert!(opened.is_some() || state.overlay.is_some(), "the second click does what enter does on a selected card");
    assert_eq!(state.selected, Some(selected));
}

#[test]
fn clicks_that_miss_a_tool_card_change_nothing() {
    let mut state = with_tools(6);
    let rows = draw(&mut state, 80, 24);
    let info = rows.iter().position(|r| r.contains("note 3")).unwrap() as u16;
    let before_focus = state.focus;
    assert_eq!(state.on_mouse(click(3, info)), None);
    assert_eq!((state.selected, state.focus), (None, before_focus), "an info row is not a card");
    for (column, row) in [(0, 0), (79, 0), (5, 23), (200, 200), (79, 23)] {
        state.on_mouse(click(column, row));
        assert_eq!((state.selected, state.focus), (None, before_focus), "({column},{row})");
    }
    // Only the left button down selects.
    let card = rows.iter().position(|r| r.contains("k2.ts")).unwrap() as u16;
    for kind in every_mouse_kind() {
        if matches!(kind, MouseEventKind::Down(MouseButton::Left)) || matches!(kind, MouseEventKind::ScrollUp | MouseEventKind::ScrollDown) {
            continue;
        }
        state.on_mouse(mouse(kind, 8, card));
        assert_eq!((state.selected, state.focus, state.scroll_back), (None, before_focus, 0), "{kind:?}");
    }
}

#[test]
fn a_stale_layout_never_panics_or_selects_a_row_that_is_no_longer_a_tool_card() {
    let mut state = with_tools(6);
    draw(&mut state, 80, 24);
    // Entries replaced since the frame was drawn: nothing at a stale index is a card, so no click selects.
    state.transcript = (0..4).map(|i| Entry::Info(format!("n{i}"))).collect();
    for row in 0..24 {
        state.on_mouse(click(5, row));
    }
    assert_eq!(state.selected, None);
    state.transcript.clear();
    for row in 0..24 {
        state.on_mouse(click(5, row));
    }
    assert_eq!(state.selected, None);
}

#[test]
fn a_click_on_the_scroll_badge_or_under_the_completion_list_selects_nothing() {
    let mut state = with_tools(30);
    draw(&mut state, 80, 24);
    state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 5));
    let rows = draw(&mut state, 80, 24);
    // The badge ("more rows") sits on the last transcript row, over whatever entry is there.
    let badge = rows.iter().position(|r| r.contains("more rows")).expect("scrolled back, so the badge is drawn") as u16;
    state.on_mouse(click(70, badge));
    assert_eq!((state.selected, state.focus), (None, Focus::Composer));
    state.commands = vec![crate::protocol::SlashSpec { name: "diff".into(), usage: "/diff".into(), summary: "diff summary".into() }];
    type_text(&mut state, "/");
    assert!(state.completion().is_some());
    draw(&mut state, 80, 24);
    for row in 0..23 {
        state.on_mouse(click(5, row));
    }
    assert_eq!(state.selected, None, "no card is selected through the completion list");
}

fn approval_state() -> (LiveState, Instant) {
    let mut state = with_tools(8);
    state.apply(parse_event(BUSY).unwrap());
    state.apply(parse_event(APPROVAL).unwrap());
    let shown = Instant::now() + Duration::from_secs(5);
    draw(&mut state, 80, 24);
    state.note_approval_shown_and_read(shown);
    (state, shown)
}

fn decided(state: &LiveState) -> bool {
    !matches!(state.overlay, Some(Overlay::Approval(_))) || state.transcript.iter().any(|e| matches!(e, Entry::Decision { .. }))
}

#[test]
fn no_mouse_event_anywhere_answers_an_approval() {
    let (mut state, _) = approval_state();
    assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
    let transcript_len = state.transcript.len();
    for kind in every_mouse_kind() {
        for modifiers in [KeyModifiers::NONE, KeyModifiers::SHIFT, KeyModifiers::CONTROL] {
            for row in 0..24 {
                for column in (0..80).step_by(3) {
                    let action = state.on_mouse(MouseEvent { kind, column, row, modifiers });
                    assert_eq!(action, None, "{kind:?} at ({column},{row}) produced {action:?}");
                }
            }
        }
        draw(&mut state, 80, 24);
    }
    assert!(!decided(&state), "the approval is still waiting");
    assert_eq!(state.transcript.len(), transcript_len, "nothing was added to the transcript");
    assert_eq!(state.selected, None);
    assert_eq!(state.composer.text(), "");
    assert!(state.take_outbox().is_empty(), "no command queued");
}

#[test]
fn a_click_on_the_buttons_of_an_approval_panel_does_not_decide() {
    let (mut state, _) = approval_state();
    let rows = draw(&mut state, 80, 24);
    let buttons = rows.iter().position(|r| r.contains("Approve") || r.contains("approve")).expect("the panel is drawn") as u16;
    for column in 0..80 {
        assert_eq!(state.on_mouse(click(column, buttons)), None);
    }
    assert!(!decided(&state));
}

#[test]
fn the_wheel_over_an_approval_scrolls_the_review_only() {
    let mut state = ready(true);
    let after = (0..60).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\\n");
    feed(&mut state, &[&format!(r#"{{"v":1,"type":"approval.request","id":"approval-1","turn_id":"t1","tool":"write_file","subject":"x.txt","preview":"{{}}","review":{{"kind":"change","path":"x.txt","before":null,"after":"{after}","created":true,"truncated":false}}}}"#)]);
    draw(&mut state, 80, 24);
    let scroll = |s: &LiveState| match &s.overlay {
        Some(Overlay::Approval(a)) => a.scroll,
        other => panic!("{other:?}"),
    };
    assert_eq!(scroll(&state), 0);
    assert_eq!(state.on_mouse(mouse(MouseEventKind::ScrollDown, 10, 10)), None);
    assert_eq!(scroll(&state), 3);
    assert_eq!(state.scroll_back, 0, "the transcript behind the panel stays put");
    state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 10));
    assert_eq!(scroll(&state), 0);
    state.on_mouse(mouse(MouseEventKind::ScrollUp, 10, 10));
    assert_eq!(scroll(&state), 0);
    assert!(matches!(state.overlay, Some(Overlay::Approval(_))));
}

#[test]
fn mouse_events_leave_the_approval_guard_exactly_as_it_was() {
    // Two identical panels, one typed into just before it opened (so its guard is on); the second also sees the mouse.
    let run = |with_mouse: bool| {
        let t0 = Instant::now();
        let mut state = ready(false);
        type_text(&mut state, "go");
        state.on_key_at(key(KeyCode::Enter, KeyModifiers::NONE), t0);
        state.apply(parse_event(APPROVAL).unwrap());
        state.note_approval_shown_and_read(t0 + Duration::from_millis(50));
        if with_mouse {
            for kind in every_mouse_kind() {
                state.on_mouse(mouse(kind, 10, 10));
            }
        }
        let early = state.on_key_at(key(KeyCode::Char('y'), KeyModifiers::NONE), t0 + Duration::from_millis(400));
        let late = state.on_key_at(key(KeyCode::Char('y'), KeyModifiers::NONE), t0 + Duration::from_secs(9));
        (early, late)
    };
    let (early_plain, late_plain) = run(false);
    let (early_mouse, late_mouse) = run(true);
    assert_eq!(early_plain, None, "the guard held an early key");
    assert_eq!((early_plain, late_plain), (early_mouse.clone(), late_mouse.clone()), "mouse events changed no decision");
    assert!(matches!(late_mouse, Some(Action::Send(_))), "a deliberate key after the guard still approves: {late_mouse:?}");
}

#[test]
fn the_wheel_scrolls_an_open_help_panel_and_other_overlays_ignore_clicks() {
    let mut state = ready(false);
    state.overlay = Some(Overlay::Help { scroll: 0 });
    draw(&mut state, 100, 20);
    state.on_mouse(mouse(MouseEventKind::ScrollDown, 10, 5));
    assert_eq!(state.overlay, Some(Overlay::Help { scroll: 3 }));
    assert_eq!(state.on_mouse(click(10, 5)), None);
    assert_eq!(state.overlay, Some(Overlay::Help { scroll: 3 }), "a click does not close or change help");
}

#[test]
fn every_size_survives_every_mouse_event() {
    for (width, height) in [(1, 1), (2, 2), (10, 3), (20, 4), (30, 6), (40, 8), (80, 24), (200, 5)] {
        let mut state = with_tools(5);
        draw(&mut state, width, height);
        for kind in every_mouse_kind() {
            for row in 0..=height.saturating_add(1) {
                for column in 0..=width.saturating_add(1) {
                    state.on_mouse(mouse(kind, column, row));
                }
            }
        }
        let (mut approving, _) = approval_state();
        draw(&mut approving, width, height);
        for kind in every_mouse_kind() {
            approving.on_mouse(mouse(kind, width / 2, height / 2));
        }
        assert!(!decided(&approving), "{width}x{height}");
    }
}

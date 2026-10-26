//! Model picker (`/model`) and provider connection (ctrl+p in the picker). Pure: keys in, intents out; the live
//! state turns intents into protocol commands and the sidecar decides every outcome.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::protocol::{Catalog, CatalogProvider, ConnectMethod, Secret};

/// A panel's content: requested from the sidecar, then filled by its answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Fetch<T> {
    Waiting,
    Ready(T),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// Section title: "Recent" or a provider label with its connection source.
    Header { title: String, detail: String },
    Model {
        provider: String,
        model: String,
        /// Provider label, shown beside the model when the list is filtered or in Recent.
        provider_label: String,
        current: bool,
    },
    /// A provider that is not connected yet; choosing it starts connecting it.
    Connect { provider: String, label: String },
    /// Not selectable: why a provider has no models listed.
    Note(String),
}

impl Row {
    pub fn selectable(&self) -> bool {
        matches!(self, Row::Model { .. } | Row::Connect { .. })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Picker {
    pub request: String,
    pub catalog: Fetch<Catalog>,
    pub query: String,
    /// Index into `rows()` of the highlighted row.
    pub pick: usize,
    /// Show only this provider's models (after connecting it).
    pub only: Option<String>,
    /// Provider-connect request whose provisional local setup this picker can explicitly clear.
    pub local_endpoint_setup_id: Option<String>,
    /// Open the connect panel as soon as the catalog arrives (`/connect`).
    pub connect_on_load: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PickerIntent {
    Close,
    Select { provider: String, model: String },
    /// Open the connect panel, optionally straight at one provider.
    Connect(Option<String>),
}

fn provider_detail(p: &CatalogProvider) -> String {
    let mut parts = Vec::new();
    if p.disclosure == "cloud" {
        parts.push("cloud".to_string());
    } else {
        parts.push("local".to_string());
    }
    if let Some(source) = &p.source {
        parts.push(format!("via {source}"));
    }
    match p.status.as_str() {
        "cached" => parts.push("offline · cached list".into()),
        "error" => parts.push("could not list models".into()),
        _ => {}
    }
    parts.join(" · ")
}

/// Every whitespace-separated term occurs in "provider-label model-id", ignoring case.
fn matches(query: &str, provider_label: &str, model: &str) -> bool {
    let hay = format!("{provider_label} {model}").to_lowercase();
    query
        .split_whitespace()
        .all(|term| hay.contains(&term.to_lowercase()))
}

impl Picker {
    pub fn new(request: String) -> Self {
        Picker {
            request,
            catalog: Fetch::Waiting,
            query: String::new(),
            pick: 0,
            only: None,
            local_endpoint_setup_id: None,
            connect_on_load: false,
        }
    }

    pub fn rows(&self) -> Vec<Row> {
        let Fetch::Ready(catalog) = &self.catalog else {
            return Vec::new();
        };
        let label = |id: &str| {
            catalog
                .providers
                .iter()
                .find(|p| p.id == id)
                .map_or_else(|| id.to_string(), |p| p.label.clone())
        };
        let is_current =
            |provider: &str, model: &str| catalog.current.provider == provider && catalog.current.model == model;
        let model_row = |provider: &str, model: &str| Row::Model {
            provider: provider.to_string(),
            model: model.to_string(),
            provider_label: label(provider),
            current: is_current(provider, model),
        };
        let shown = |provider: &str| self.only.as_deref().is_none_or(|only| only == provider);
        let mut rows = Vec::new();
        if !self.query.trim().is_empty() {
            for m in &catalog.models {
                if shown(&m.provider) && matches(&self.query, &label(&m.provider), &m.id) {
                    rows.push(model_row(&m.provider, &m.id));
                }
            }
            return rows;
        }
        let connected = |id: &str| catalog.providers.iter().any(|p| p.id == id && p.connected);
        let recent: Vec<_> = catalog
            .recent
            .iter()
            .filter(|r| shown(&r.provider) && connected(&r.provider))
            .collect();
        if self.only.is_none() && !recent.is_empty() {
            rows.push(Row::Header {
                title: "Recent".into(),
                detail: String::new(),
            });
            rows.extend(recent.iter().map(|r| model_row(&r.provider, &r.model)));
        }
        let mut providers: Vec<&CatalogProvider> = catalog.providers.iter().filter(|p| shown(&p.id)).collect();
        // Connected providers first, otherwise in the sidecar's order (appliance first).
        providers.sort_by_key(|p| !p.connected);
        for p in providers {
            rows.push(Row::Header {
                title: p.label.clone(),
                detail: provider_detail(p),
            });
            if !p.connected {
                rows.push(Row::Connect {
                    provider: p.id.clone(),
                    label: p.label.clone(),
                });
                continue;
            }
            let before = rows.len();
            rows.extend(
                catalog
                    .models
                    .iter()
                    .filter(|m| m.provider == p.id)
                    .map(|m| model_row(&m.provider, &m.id)),
            );
            if rows.len() == before {
                rows.push(Row::Note(match &p.error {
                    Some(error) => format!("no models listed: {error}"),
                    None => "no models listed".into(),
                }));
            }
        }
        rows
    }

    /// The highlighted row, moved onto the nearest selectable row.
    pub fn selected(&self) -> Option<(usize, Row)> {
        let rows = self.rows();
        let start = self.pick.min(rows.len().saturating_sub(1));
        rows.iter()
            .enumerate()
            .skip(start)
            .chain(rows.iter().enumerate().take(start).rev())
            .find(|(_, row)| row.selectable())
            .map(|(index, row)| (index, row.clone()))
    }

    /// Highlights the current model (or the first selectable row) once the catalog arrives.
    pub fn focus_current(&mut self) {
        let rows = self.rows();
        self.pick = rows
            .iter()
            .position(|row| matches!(row, Row::Model { current: true, .. }))
            .or_else(|| rows.iter().position(Row::selectable))
            .unwrap_or(0);
    }

    fn step(&mut self, down: bool, count: usize) {
        let rows = self.rows();
        let selectable: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.selectable())
            .map(|(index, _)| index)
            .collect();
        if selectable.is_empty() {
            return;
        }
        let current = self.selected().map_or(0, |(index, _)| index);
        let at = selectable.iter().position(|&i| i == current).unwrap_or(0);
        let next = if down {
            (at + count).min(selectable.len() - 1)
        } else {
            at.saturating_sub(count)
        };
        self.pick = selectable[next];
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<PickerIntent> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => return Some(PickerIntent::Close),
            KeyCode::Char('p') if ctrl => {
                if matches!(self.catalog, Fetch::Ready(_)) {
                    return Some(PickerIntent::Connect(None));
                }
            }
            KeyCode::Up => self.step(false, 1),
            KeyCode::Down => self.step(true, 1),
            KeyCode::Char('n') if ctrl => self.step(true, 1),
            KeyCode::PageUp => self.step(false, 10),
            KeyCode::PageDown => self.step(true, 10),
            KeyCode::Enter => match self.selected() {
                Some((_, Row::Model { provider, model, .. })) => {
                    return Some(PickerIntent::Select { provider, model });
                }
                Some((_, Row::Connect { provider, .. })) => return Some(PickerIntent::Connect(Some(provider))),
                _ => {}
            },
            KeyCode::Backspace => {
                if self.query.pop().is_none() {
                    self.only = None;
                }
                self.pick = 0;
            }
            KeyCode::Char('u') if ctrl => {
                self.query.clear();
                self.pick = 0;
            }
            KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) => {
                self.query.push(c);
                self.pick = 0;
            }
            _ => {}
        }
        None
    }
}

// ---------------------------------------------------------------- connect flow

#[derive(Clone, Debug, PartialEq)]
pub struct AuthInfo {
    pub url: String,
    pub user_code: Option<String>,
    pub instructions: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Providers { pick: usize },
    Methods { provider: String, pick: usize },
    Key { provider: String, input: String, error: Option<String> },
    LocalEndpoint { input: String, error: Option<String> },
    LocalKey { endpoint: String, input: Secret, error: Option<String> },
    /// The sidecar is verifying a key or waiting for a sign-in; `auth` arrives for sign-ins.
    Waiting { request: String, provider: String, method: String, auth: Option<AuthInfo> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Connect {
    pub providers: Vec<CatalogProvider>,
    pub step: Step,
    /// Outcome of the last attempt or disconnect, shown at the top of the panel.
    pub notice: Option<(bool, String)>,
    /// Request id of a catalog refresh whose answer replaces `providers` (after a disconnect).
    pub refresh: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ConnectIntent {
    /// Back to the model picker.
    Back,
    /// Send provider.connect (`key` only for API keys).
    Connect { provider: String, method: String, key: Option<String> },
    LocalEndpoint { endpoint: String, key: Option<Secret> },
    Cancel { request: String },
    Disconnect { provider: String },
}

/// Connectable cloud providers and the local appliance endpoint setup entry.
fn connectable(providers: &[CatalogProvider]) -> Vec<&CatalogProvider> {
    providers.iter().filter(|p| p.id == "appliance" || !p.methods.is_empty()).collect()
}

impl Connect {
    /// Opens on the provider list, or straight at provider `at`; a sole sign-in method starts at once (the intent).
    pub fn new(providers: Vec<CatalogProvider>, at: Option<&str>) -> (Self, Option<ConnectIntent>) {
        let mut flow = Connect {
            providers,
            step: Step::Providers { pick: 0 },
            notice: None,
            refresh: None,
        };
        let mut intent = None;
        if let Some(id) = at
            && let Some(index) = connectable(&flow.providers).iter().position(|p| p.id == id)
        {
            flow.step = Step::Providers { pick: index };
            intent = flow.choose_provider(id.to_string());
        }
        (flow, intent)
    }

    pub fn list(&self) -> Vec<&CatalogProvider> {
        connectable(&self.providers)
    }

    pub fn provider(&self, id: &str) -> Option<&CatalogProvider> {
        self.providers.iter().find(|p| p.id == id)
    }

    pub fn methods(&self, id: &str) -> Vec<ConnectMethod> {
        self.provider(id).map(|p| p.methods.clone()).unwrap_or_default()
    }

    /// One method goes straight to it; several ask which.
    fn choose_provider(&mut self, id: String) -> Option<ConnectIntent> {
        if id == "appliance" {
            self.step = Step::LocalEndpoint { input: String::new(), error: None };
            return None;
        }
        let methods = self.methods(&id);
        if methods.len() == 1 {
            return self.choose_method(id, methods[0].clone());
        }
        self.step = Step::Methods { provider: id, pick: 0 };
        None
    }

    fn choose_method(&mut self, provider: String, method: ConnectMethod) -> Option<ConnectIntent> {
        if method.kind == "key" {
            self.step = Step::Key {
                provider,
                input: String::new(),
                error: None,
            };
            return None;
        }
        Some(ConnectIntent::Connect {
            provider,
            method: method.id,
            key: None,
        })
    }

    /// Pasted text goes into the key field (whitespace and newlines dropped).
    pub fn on_paste(&mut self, text: &str) {
        if let Step::Key { input, error, .. } = &mut self.step {
            input.extend(text.chars().filter(|c| !c.is_whitespace()));
            *error = None;
        } else if let Step::LocalEndpoint { input, error } = &mut self.step {
            input.extend(text.chars().filter(|c| !c.is_control()).take(2048usize.saturating_sub(input.chars().count())));
            *error = None;
        } else if let Step::LocalKey { input, error, .. } = &mut self.step {
            input.0.extend(text.chars().filter(|c| !c.is_whitespace() && !c.is_control()));
            *error = None;
        }
    }

    pub fn on_key(&mut self, key: KeyEvent) -> Option<ConnectIntent> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match self.step.clone() {
            Step::Providers { pick } => {
                let ids: Vec<String> = self.list().iter().map(|p| p.id.clone()).collect();
                match key.code {
                    KeyCode::Esc => return Some(ConnectIntent::Back),
                    KeyCode::Up => self.step = Step::Providers { pick: pick.saturating_sub(1) },
                    KeyCode::Down => self.step = Step::Providers { pick: (pick + 1).min(ids.len().saturating_sub(1)) },
                    KeyCode::Char('d') if ctrl => {
                        return ids.get(pick).filter(|id| id.as_str() != "appliance").map(|id| ConnectIntent::Disconnect { provider: id.clone() });
                    }
                    KeyCode::Enter => {
                        let id = ids.get(pick)?.clone();
                        self.notice = None;
                        return self.choose_provider(id);
                    }
                    _ => {}
                }
            }
            Step::Methods { provider, pick } => {
                let methods = self.methods(&provider);
                match key.code {
                    KeyCode::Esc => self.back_to_providers(&provider),
                    KeyCode::Up => self.step = Step::Methods { provider, pick: pick.saturating_sub(1) },
                    KeyCode::Down => {
                        self.step = Step::Methods { provider, pick: (pick + 1).min(methods.len().saturating_sub(1)) }
                    }
                    KeyCode::Enter => {
                        let method = methods.get(pick)?.clone();
                        self.notice = None;
                        return self.choose_method(provider, method);
                    }
                    _ => {}
                }
            }
            Step::Key { provider, mut input, mut error } => {
                match key.code {
                    KeyCode::Esc => {
                        if self.methods(&provider).len() > 1 {
                            self.step = Step::Methods { provider, pick: 0 };
                        } else {
                            self.back_to_providers(&provider);
                        }
                        return None;
                    }
                    KeyCode::Enter if !input.trim().is_empty() => {
                        return Some(ConnectIntent::Connect {
                            provider,
                            method: "api-key".into(),
                            key: Some(input.trim().to_string()),
                        });
                    }
                    KeyCode::Backspace => {
                        input.pop();
                        error = None;
                    }
                    KeyCode::Char('u') if ctrl => input.clear(),
                    KeyCode::Char(c) if !ctrl && !c.is_whitespace() => {
                        input.push(c);
                        error = None;
                    }
                    _ => {}
                }
                self.step = Step::Key { provider, input, error };
            }
            Step::LocalEndpoint { mut input, mut error } => {
                let mut transitioned = false;
                match key.code {
                    KeyCode::Esc => self.back_to_providers("appliance"),
                    KeyCode::Enter if !input.trim().is_empty() => {
                        self.step = Step::LocalKey { endpoint: input.trim().to_string(), input: Secret(String::new()), error: None };
                        transitioned = true;
                    }
                    KeyCode::Enter => error = Some("Enter an endpoint URL.".into()),
                    KeyCode::Backspace => { input.pop(); error = None; }
                    KeyCode::Char('u') if ctrl => { input.clear(); error = None; }
                    KeyCode::Char(c) if !ctrl && !key.modifiers.contains(KeyModifiers::ALT) && !c.is_control() => {
                        if input.chars().count() < 2048 { input.push(c); }
                        error = None;
                    }
                    _ => {}
                }
                if matches!(key.code, KeyCode::Esc) { return None; }
                if !transitioned { self.step = Step::LocalEndpoint { input, error }; }
            }
            Step::LocalKey { endpoint, mut input, mut error } => {
                match key.code {
                    KeyCode::Esc => { self.step = Step::LocalEndpoint { input: endpoint, error: None }; return None; }
                    KeyCode::Enter => {
                        return Some(ConnectIntent::LocalEndpoint {
                            endpoint,
                            key: if input.0.is_empty() { None } else { Some(input) },
                        });
                    }
                    KeyCode::Backspace => { input.0.pop(); error = None; }
                    KeyCode::Char('u') if ctrl => { input.0.clear(); error = None; }
                    KeyCode::Char(c) if !ctrl && !c.is_whitespace() && !c.is_control() => { input.0.push(c); error = None; }
                    _ => {}
                }
                self.step = Step::LocalKey { endpoint, input, error };
            }
            Step::Waiting { request, provider, auth, .. } => {
                if key.code == KeyCode::Esc {
                    self.back_to_providers(&provider);
                    // A key being verified finishes on its own; a sign-in is stopped.
                    return auth.is_some().then_some(ConnectIntent::Cancel { request });
                }
            }
        }
        None
    }

    fn back_to_providers(&mut self, provider: &str) {
        let pick = self.list().iter().position(|p| p.id == provider).unwrap_or(0);
        self.step = Step::Providers { pick };
    }

    /// The sidecar's answer to the attempt `request`. Success returns true (the caller reopens the picker).
    pub fn on_result(&mut self, request: &str, success: bool, message: String) -> bool {
        let Step::Waiting { request: waiting, provider, method, .. } = &self.step else {
            return false;
        };
        if waiting != request {
            return false;
        }
        let provider = provider.clone();
        if success {
            self.notice = Some((true, message));
            return true;
        }
        if method == "api-key" {
            self.step = Step::Key {
                provider,
                input: String::new(),
                error: Some(message),
            };
        } else {
            self.back_to_providers(&provider);
            self.notice = Some((false, message));
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CatalogModel, ModelRef};

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn ctrl(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::CONTROL)
    }
    fn method(id: &str, kind: &str) -> ConnectMethod {
        ConnectMethod {
            id: id.into(),
            label: id.into(),
            kind: kind.into(),
            unofficial: id.contains("chatgpt"),
        }
    }
    fn provider(id: &str, connected: bool, methods: Vec<ConnectMethod>) -> CatalogProvider {
        CatalogProvider {
            id: id.into(),
            label: id.to_uppercase(),
            disclosure: if id == "appliance" { "local".into() } else { "cloud".into() },
            connected,
            source: connected.then(|| "$KEY".to_string()),
            external: false,
            methods,
            status: if connected { "ok".into() } else { "disconnected".into() },
            error: None,
        }
    }
    fn catalog() -> Catalog {
        Catalog {
            providers: vec![
                provider("appliance", true, vec![]),
                provider("openrouter", true, vec![method("api-key", "key"), method("openrouter-oauth", "browser")]),
                provider("anthropic", false, vec![method("api-key", "key")]),
                provider("chatgpt", false, vec![method("chatgpt-oauth", "browser")]),
            ],
            models: vec![
                CatalogModel { provider: "appliance".into(), id: "engineering/b0".into() },
                CatalogModel { provider: "openrouter".into(), id: "anthropic/claude-x".into() },
                CatalogModel { provider: "openrouter".into(), id: "meta/llama:free".into() },
            ],
            current: ModelRef { provider: "appliance".into(), model: "engineering/b0".into() },
            recent: vec![ModelRef { provider: "openrouter".into(), model: "anthropic/claude-x".into() }],
        }
    }
    fn ready() -> Picker {
        let mut p = Picker::new("m1".into());
        p.catalog = Fetch::Ready(catalog());
        p.focus_current();
        p
    }

    #[test]
    fn rows_group_recent_then_connected_providers_then_connect_rows() {
        let rows = ready().rows();
        let titles: Vec<String> = rows
            .iter()
            .map(|r| match r {
                Row::Header { title, .. } => format!("# {title}"),
                Row::Model { model, current, .. } => format!("{}{model}", if *current { "*" } else { "" }),
                Row::Connect { provider, .. } => format!("+ {provider}"),
                Row::Note(n) => format!("! {n}"),
            })
            .collect();
        assert_eq!(
            titles,
            vec![
                "# Recent", "anthropic/claude-x",
                "# APPLIANCE", "*engineering/b0",
                "# OPENROUTER", "anthropic/claude-x", "meta/llama:free",
                "# ANTHROPIC", "+ anthropic",
                "# CHATGPT", "+ chatgpt",
            ]
        );
    }

    #[test]
    fn opens_on_the_current_model_and_enter_selects() {
        let mut p = ready();
        assert!(matches!(p.selected(), Some((_, Row::Model { current: true, .. }))));
        p.on_key(key(KeyCode::Down));
        assert_eq!(
            p.on_key(key(KeyCode::Enter)),
            Some(PickerIntent::Select { provider: "openrouter".into(), model: "anthropic/claude-x".into() })
        );
    }

    #[test]
    fn typing_filters_by_provider_and_model_terms() {
        let mut p = ready();
        for c in "open free".chars() {
            p.on_key(key(KeyCode::Char(c)));
        }
        let rows = p.rows();
        assert_eq!(rows.len(), 1);
        assert!(matches!(&rows[0], Row::Model { model, .. } if model == "meta/llama:free"));
        assert!(p.on_key(key(KeyCode::Enter)).is_some());
    }

    #[test]
    fn ctrl_p_connects_and_connect_rows_jump_to_their_provider() {
        let mut p = ready();
        assert_eq!(p.on_key(ctrl('p')), Some(PickerIntent::Connect(None)));
        let mut waiting = Picker::new("m2".into());
        assert_eq!(waiting.on_key(ctrl('p')), None, "no provider list before the catalog arrives");
        for _ in 0..10 {
            p.on_key(key(KeyCode::Down));
        }
        assert_eq!(p.on_key(key(KeyCode::Enter)), Some(PickerIntent::Connect(Some("chatgpt".into()))));
    }

    #[test]
    fn api_key_flow_sends_the_trimmed_pasted_key() {
        let (mut c, _) = Connect::new(catalog().providers, Some("anthropic"));
        assert!(matches!(c.step, Step::Key { .. }), "single key method opens the key field");
        c.on_paste("  sk-ant-123\n");
        assert_eq!(
            c.on_key(key(KeyCode::Enter)),
            Some(ConnectIntent::Connect { provider: "anthropic".into(), method: "api-key".into(), key: Some("sk-ant-123".into()) })
        );
    }

    #[test]
    fn several_methods_ask_which_and_a_sign_in_can_be_cancelled() {
        let (mut c, _) = Connect::new(catalog().providers, None);
        assert_eq!(c.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), vec!["appliance", "openrouter", "anthropic", "chatgpt"]);
        c.on_key(key(KeyCode::Down));
        assert_eq!(c.on_key(key(KeyCode::Enter)), None);
        assert!(matches!(c.step, Step::Methods { .. }));
        c.on_key(key(KeyCode::Down));
        let intent = c.on_key(key(KeyCode::Enter));
        assert_eq!(intent, Some(ConnectIntent::Connect { provider: "openrouter".into(), method: "openrouter-oauth".into(), key: None }));
        c.step = Step::Waiting { request: "p3".into(), provider: "openrouter".into(), method: "openrouter-oauth".into(), auth: Some(AuthInfo { url: "u".into(), user_code: None, instructions: "i".into() }) };
        assert_eq!(c.on_key(key(KeyCode::Esc)), Some(ConnectIntent::Cancel { request: "p3".into() }));
        assert_eq!(c.step, Step::Providers { pick: 1 }, "cancel returns to the selected cloud provider after the new appliance option");
    }

    #[test]
    fn a_rejected_key_returns_to_the_key_field_with_the_reason() {
        let (mut c, _) = Connect::new(catalog().providers, Some("anthropic"));
        c.step = Step::Waiting { request: "p1".into(), provider: "anthropic".into(), method: "api-key".into(), auth: None };
        assert!(!c.on_result("other", false, "x".into()), "answers for other requests are ignored");
        assert!(!c.on_result("p1", false, "key rejected".into()));
        assert_eq!(c.step, Step::Key { provider: "anthropic".into(), input: String::new(), error: Some("key rejected".into()) });
        c.step = Step::Waiting { request: "p2".into(), provider: "anthropic".into(), method: "api-key".into(), auth: None };
        assert!(c.on_result("p2", true, "connected".into()));
    }

    #[test]
    fn a_sole_sign_in_method_starts_immediately() {
        let (c, intent) = Connect::new(catalog().providers, Some("chatgpt"));
        assert_eq!(intent, Some(ConnectIntent::Connect { provider: "chatgpt".into(), method: "chatgpt-oauth".into(), key: None }));
        assert!(matches!(c.step, Step::Providers { .. }), "the caller moves the flow to Waiting when it sends");
    }

    #[test]
    fn ctrl_d_asks_to_disconnect_the_highlighted_provider() {
        let (mut c, _) = Connect::new(catalog().providers, None);
        assert_eq!(c.on_key(ctrl('d')), None, "the appliance setup is not a disconnectable cloud credential");
        c.on_key(key(KeyCode::Down));
        assert_eq!(c.on_key(ctrl('d')), Some(ConnectIntent::Disconnect { provider: "openrouter".into() }));
    }

    #[test]
    fn local_endpoint_is_a_distinct_connect_option_with_masked_optional_key() {
        let (mut flow, intent) = Connect::new(catalog().providers, None);
        assert!(intent.is_none());
        assert_eq!(flow.list()[0].id, "appliance");
        assert_eq!(flow.on_key(key(KeyCode::Enter)), None);
        assert!(matches!(flow.step, Step::LocalEndpoint { .. }));
        flow.on_paste("http://127.0.0.1:1234/v1");
        assert_eq!(flow.on_key(key(KeyCode::Enter)), None);
        flow.on_paste("local-secret");
        assert!(!format!("{:?}", flow.step).contains("local-secret"));
        let intent = flow.on_key(key(KeyCode::Enter));
        assert_eq!(
            intent,
            Some(ConnectIntent::LocalEndpoint {
                endpoint: "http://127.0.0.1:1234/v1".into(),
                key: Some(Secret("local-secret".into())),
            })
        );
        assert!(!format!("{intent:?}").contains("local-secret"));
    }

    #[test]
    fn local_endpoint_api_key_is_optional() {
        let (mut flow, _) = Connect::new(catalog().providers, Some("appliance"));
        flow.on_paste("http://localhost:1234/v1");
        flow.on_key(key(KeyCode::Enter));
        assert_eq!(flow.on_key(key(KeyCode::Enter)), Some(ConnectIntent::LocalEndpoint {
            endpoint: "http://localhost:1234/v1".into(),
            key: None,
        }));
    }
}

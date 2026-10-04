//! Slash commands typed into the composer: which ones the live view handles itself, which go to the sidecar,
//! and which catalogue entries complete a partly typed name.
use crate::protocol::SlashSpec;

#[derive(Clone, Debug, PartialEq)]
pub enum Invocation {
    Quit,
    Help,
    AlreadyLive,
    /// Runs in the sidecar. `command` is lowercase without the slash; `!` marks a direct shell command.
    Remote {
        command: String,
        args: String,
    },
}

/// Reads a submitted draft. `None` means an ordinary prompt: no leading `/` or `!`, or a leading path such as
/// `/etc/hosts is wrong`.
pub fn parse(draft: &str) -> Option<Invocation> {
    let text = draft.trim();
    let multiline = text.contains('\n');
    if let Some(rest) = text.strip_prefix('!') {
        if multiline {
            return None;
        }
        let args = rest.trim();
        return (!args.is_empty()).then(|| Invocation::Remote {
            command: "!".into(),
            args: args.into(),
        });
    }
    let rest = text.strip_prefix('/')?;
    let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let name = name.to_lowercase();
    if multiline && matches!(name.as_str(), "exit" | "quit" | "q" | "help" | "?" | "tui") {
        return None;
    }
    Some(match name.as_str() {
        "exit" | "quit" | "q" => Invocation::Quit,
        "help" | "?" => Invocation::Help,
        "tui" => Invocation::AlreadyLive,
        _ => Invocation::Remote {
            command: name,
            args: args.trim().into(),
        },
    })
}

/// Catalogue entries whose name starts with the typed `/prefix`. Empty unless the draft is a single `/word`.
pub fn matches<'a>(commands: &'a [SlashSpec], draft: &str) -> Vec<&'a SlashSpec> {
    let Some(typed) = draft.strip_prefix('/') else {
        return Vec::new();
    };
    if typed.contains(|c: char| c.is_whitespace() || c == '/') {
        return Vec::new();
    }
    let typed = typed.to_lowercase();
    commands
        .iter()
        .filter(|spec| spec.name.starts_with(&typed))
        .collect()
}

/// True when the usage has a required `<argument>` outside `[optional]` brackets.
pub fn needs_args(usage: &str) -> bool {
    let mut depth = 0usize;
    for c in usage.chars() {
        match c {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            '<' if depth == 0 => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(command: &str, args: &str) -> Invocation {
        Invocation::Remote {
            command: command.into(),
            args: args.into(),
        }
    }

    fn catalogue(names: &[&str]) -> Vec<SlashSpec> {
        names
            .iter()
            .map(|name| SlashSpec {
                name: (*name).into(),
                usage: format!("/{name}"),
                summary: String::new(),
            })
            .collect()
    }

    fn names(found: Vec<&SlashSpec>) -> Vec<&str> {
        found.iter().map(|spec| spec.name.as_str()).collect()
    }

    #[test]
    fn parse_separates_local_remote_and_prompt_drafts() {
        assert_eq!(parse("/quit"), Some(Invocation::Quit));
        assert_eq!(parse("  /Q "), Some(Invocation::Quit));
        assert_eq!(parse("/exit"), Some(Invocation::Quit));
        assert_eq!(parse("/help"), Some(Invocation::Help));
        assert_eq!(parse("/?"), Some(Invocation::Help));
        assert_eq!(parse("/tui"), Some(Invocation::AlreadyLive));
        assert_eq!(parse("/Diff"), Some(remote("diff", "")));
        assert_eq!(
            parse("/commit fix: parser\n\nbody"),
            Some(remote("commit", "fix: parser\n\nbody"))
        );
        assert_eq!(parse("!git status"), Some(remote("!", "git status")));
        assert_eq!(parse("!3"), Some(remote("!", "3")));
        assert_eq!(parse("!"), None);
        assert_eq!(parse("/"), None);
        assert_eq!(parse("/etc/hosts is wrong"), None);
        assert_eq!(parse("fix /diff"), None);
        assert_eq!(parse("/exit\nplease fix the parser"), None);
        assert_eq!(parse("/help\nwhy does this fail?"), None);
        assert_eq!(parse("!ls\nrm -rf build"), None);
        assert_eq!(parse("fix it\n/exit\nthen test"), None);
    }

    #[test]
    fn matches_complete_a_single_slash_word() {
        let commands = catalogue(&["diff", "git", "help", "history"]);
        assert_eq!(names(matches(&commands, "/h")), vec!["help", "history"]);
        assert_eq!(
            names(matches(&commands, "/")),
            vec!["diff", "git", "help", "history"]
        );
        assert_eq!(names(matches(&commands, "/HI")), vec!["history"]);
        assert!(matches(&commands, "/diff ").is_empty());
        assert!(matches(&commands, "/x").is_empty());
        assert!(matches(&commands, "diff").is_empty());
        assert!(matches(&commands, "/etc/").is_empty());
    }

    #[test]
    fn needs_args_ignores_optional_arguments() {
        assert!(needs_args("/tdd <issue>"));
        assert!(needs_args("/image <path> [prompt]"));
        assert!(needs_args("/skill <name> | init <name>"));
        assert!(!needs_args("/history [query|run <n>]"));
        assert!(!needs_args("/checkpoint [name|diff <id> [base]|prune [n]]"));
        assert!(!needs_args("/diff"));
    }
}

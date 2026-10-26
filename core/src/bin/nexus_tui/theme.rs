//! Colour depth and theme tokens for the live TUI. The views draw with 24-bit colours; on a terminal that cannot show
//! them, `downsample` maps every cell of the finished frame to the nearest colour the terminal has (256 or 16), or
//! removes colour entirely (`NO_COLOR`, `TERM=dumb`), keeping bold/reverse so selection and emphasis survive.
use ratatui::{
    buffer::Buffer,
    style::{Color, Modifier},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Depth {
    #[default]
    TrueColor,
    Ansi256,
    Ansi16,
    Mono,
}

impl Depth {
    /// From the environment: `NEXUS_COLOR` (truecolor, 256, 16, none) overrides; a non-empty `NO_COLOR` or
    /// `TERM=dumb` means no colour; `COLORTERM=truecolor|24bit` means 24-bit; a `TERM` naming 256 colours means 256;
    /// anything else is assumed to have the 16 standard colours.
    pub fn detect(var: impl Fn(&str) -> Option<String>) -> Depth {
        let get = |name: &str| var(name).filter(|value| !value.is_empty());
        if let Some(choice) = get("NEXUS_COLOR") {
            match choice.to_ascii_lowercase().as_str() {
                "truecolor" | "24bit" | "24" => return Depth::TrueColor,
                "256" => return Depth::Ansi256,
                "16" | "ansi" => return Depth::Ansi16,
                "none" | "mono" | "0" | "off" => return Depth::Mono,
                _ => {}
            }
        }
        if get("NO_COLOR").is_some() {
            return Depth::Mono;
        }
        let term = get("TERM").unwrap_or_default();
        if term == "dumb" {
            return Depth::Mono;
        }
        if matches!(get("COLORTERM").as_deref(), Some("truecolor" | "24bit")) {
            return Depth::TrueColor;
        }
        if term.contains("256color") {
            return Depth::Ansi256;
        }
        Depth::Ansi16
    }

    pub fn from_env() -> Depth {
        Depth::detect(|name| std::env::var(name).ok())
    }
}

pub fn apply_backend_policy(depth: Depth) {
    crossterm::style::force_color_output(depth != Depth::Mono);
}

/// Maps the colours of every cell to what `depth` can show. A no-op for 24-bit terminals.
pub fn downsample(buffer: &mut Buffer, depth: Depth) {
    if depth == Depth::TrueColor {
        return;
    }
    for cell in buffer.content.iter_mut() {
        if depth == Depth::Mono {
            // A background carried meaning (selection, the status bar, a badge): reverse video keeps it visible.
            if !matches!(cell.bg, Color::Reset) {
                cell.modifier.insert(Modifier::REVERSED);
            }
            cell.fg = Color::Reset;
            cell.bg = Color::Reset;
            continue;
        }
        cell.fg = reduce(cell.fg, depth);
        cell.bg = reduce(cell.bg, depth);
    }
}

fn reduce(color: Color, depth: Depth) -> Color {
    match (color, depth) {
        (Color::Rgb(r, g, b), Depth::Ansi256) => Color::Indexed(nearest_256(r, g, b)),
        (Color::Rgb(r, g, b), Depth::Ansi16) => nearest_16(r, g, b),
        (Color::Indexed(index), Depth::Ansi16) if index >= 16 => {
            let (r, g, b) = rgb_of_256(index);
            nearest_16(r, g, b)
        }
        _ => color,
    }
}

const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];

fn distance(a: (u8, u8, u8), b: (u8, u8, u8)) -> u32 {
    let d = |x: u8, y: u8| (i32::from(x) - i32::from(y)).pow(2) as u32;
    d(a.0, b.0) + d(a.1, b.1) + d(a.2, b.2)
}

/// The xterm 256-colour palette entry (16–255) nearest to an RGB colour.
pub fn nearest_256(r: u8, g: u8, b: u8) -> u8 {
    let level = |v: u8| {
        CUBE.iter()
            .enumerate()
            .min_by_key(|(_, c)| (i32::from(**c) - i32::from(v)).abs())
            .map(|(i, _)| i as u8)
            .unwrap_or(0)
    };
    let (ri, gi, bi) = (level(r), level(g), level(b));
    let cube = 16 + 36 * ri + 6 * gi + bi;
    let cube_rgb = (CUBE[ri as usize], CUBE[gi as usize], CUBE[bi as usize]);
    let average = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
    let gray_index = (average.saturating_sub(8) / 10).min(23) as u8;
    let gray_value = 8 + 10 * gray_index;
    let gray = 232 + gray_index;
    if distance((r, g, b), (gray_value, gray_value, gray_value)) < distance((r, g, b), cube_rgb) {
        gray
    } else {
        cube
    }
}

fn rgb_of_256(index: u8) -> (u8, u8, u8) {
    match index {
        16..=231 => {
            let i = index - 16;
            (CUBE[(i / 36) as usize], CUBE[((i / 6) % 6) as usize], CUBE[(i % 6) as usize])
        }
        232..=255 => {
            let v = 8 + 10 * (index - 232);
            (v, v, v)
        }
        _ => (128, 128, 128),
    }
}

/// The standard 16-colour entry nearest to an RGB colour (xterm's default values).
fn nearest_16(r: u8, g: u8, b: u8) -> Color {
    const TABLE: [((u8, u8, u8), Color); 16] = [
        ((0, 0, 0), Color::Black),
        ((205, 0, 0), Color::Red),
        ((0, 205, 0), Color::Green),
        ((205, 205, 0), Color::Yellow),
        ((0, 0, 238), Color::Blue),
        ((205, 0, 205), Color::Magenta),
        ((0, 205, 205), Color::Cyan),
        ((229, 229, 229), Color::Gray),
        ((127, 127, 127), Color::DarkGray),
        ((255, 0, 0), Color::LightRed),
        ((0, 255, 0), Color::LightGreen),
        ((255, 255, 0), Color::LightYellow),
        ((92, 92, 255), Color::LightBlue),
        ((255, 0, 255), Color::LightMagenta),
        ((0, 255, 255), Color::LightCyan),
        ((255, 255, 255), Color::White),
    ];
    TABLE
        .iter()
        .min_by_key(|(rgb, _)| distance(*rgb, (r, g, b)))
        .map(|(_, color)| *color)
        .unwrap_or(Color::Reset)
}

/// WCAG relative luminance of an sRGB colour.
#[cfg(test)]
pub fn luminance((r, g, b): (u8, u8, u8)) -> f64 {
    let channel = |v: u8| {
        let c = f64::from(v) / 255.0;
        if c <= 0.039_28 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// WCAG contrast ratio between two colours (1.0 to 21.0).
#[cfg(test)]
pub fn contrast(a: (u8, u8, u8), b: (u8, u8, u8)) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    let (hi, lo) = if x > y { (x, y) } else { (y, x) };
    (hi + 0.05) / (lo + 0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let owned: Vec<(String, String)> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| owned.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    #[test]
    fn colour_depth_follows_the_environment_with_an_explicit_override() {
        assert_eq!(Depth::detect(env(&[("COLORTERM", "truecolor"), ("TERM", "xterm")])), Depth::TrueColor);
        assert_eq!(Depth::detect(env(&[("TERM", "xterm-256color")])), Depth::Ansi256);
        assert_eq!(Depth::detect(env(&[("TERM", "xterm")])), Depth::Ansi16);
        assert_eq!(Depth::detect(env(&[("TERM", "dumb"), ("COLORTERM", "truecolor")])), Depth::Mono);
        assert_eq!(Depth::detect(env(&[("NO_COLOR", "1"), ("COLORTERM", "truecolor")])), Depth::Mono);
        assert_eq!(Depth::detect(env(&[("NO_COLOR", ""), ("COLORTERM", "truecolor")])), Depth::TrueColor, "an empty NO_COLOR is unset");
        assert_eq!(Depth::detect(env(&[("NEXUS_COLOR", "16"), ("COLORTERM", "truecolor")])), Depth::Ansi16);
        assert_eq!(Depth::detect(env(&[("NEXUS_COLOR", "none")])), Depth::Mono);
    }

    #[test]
    fn downsampling_maps_to_the_nearest_palette_entry_and_mono_keeps_backgrounds_as_reverse_video() {
        assert_eq!(nearest_256(0, 95, 0), 22);
        assert_eq!(nearest_256(255, 255, 255), 231);
        assert_eq!(nearest_256(18, 18, 18), 233);
        assert_eq!(nearest_16(200, 10, 10), Color::Red);
        let mut buffer = Buffer::empty(ratatui::layout::Rect::new(0, 0, 2, 1));
        buffer.content[0].set_fg(Color::Rgb(0, 200, 0)).set_bg(Color::Rgb(20, 20, 20));
        let mut mono = buffer.clone();
        downsample(&mut buffer, Depth::Ansi16);
        assert_eq!((buffer.content[0].fg, buffer.content[0].bg), (Color::Green, Color::Black));
        downsample(&mut mono, Depth::Mono);
        assert_eq!((mono.content[0].fg, mono.content[0].bg), (Color::Reset, Color::Reset));
        assert!(mono.content[0].modifier.contains(Modifier::REVERSED));
        assert!(!mono.content[1].modifier.contains(Modifier::REVERSED), "cells without a background stay plain");
    }

    #[test]
    fn mono_frames_emit_no_colour_sgr_through_the_real_backend() {
        use ratatui::{
            backend::{Backend, CrosstermBackend},
            buffer::Buffer,
            layout::Rect,
            style::Style,
            widgets::{Paragraph, Widget},
        };

        apply_backend_policy(Depth::Mono);
        let area = Rect::new(0, 0, 6, 1);
        let mut buffer = Buffer::empty(area);
        Paragraph::new("status")
            .style(Style::default().fg(Color::Rgb(1, 2, 3)).bg(Color::Rgb(4, 5, 6)))
            .render(area, &mut buffer);
        downsample(&mut buffer, Depth::Mono);

        let mut output = Vec::new();
        {
            let mut backend = CrosstermBackend::new(&mut output);
            backend
                .draw(buffer.content.iter().enumerate().map(|(index, cell)| {
                    let width = usize::from(area.width);
                    ((index % width) as u16, (index / width) as u16, cell)
                }))
                .unwrap();
            backend.flush().unwrap();
        }
        let output = String::from_utf8(output).unwrap();
        for reset in ["\x1b[39m", "\x1b[49m", "\x1b[59m"] {
            assert!(!output.contains(reset), "monochrome output emitted {reset:?}: {output:?}");
        }
    }

    #[test]
    fn contrast_matches_the_wcag_reference_values() {
        assert!((contrast((0, 0, 0), (255, 255, 255)) - 21.0).abs() < 0.01);
        assert!((contrast((119, 119, 119), (255, 255, 255)) - 4.48).abs() < 0.02);
    }
}

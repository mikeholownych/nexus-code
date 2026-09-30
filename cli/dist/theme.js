import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pc from "picocolors";
export const PRESET_THEMES = {
    default: {
        primary: (t) => pc.cyan(t),
        secondary: (t) => pc.blue(t),
        success: (t) => pc.green(t),
        warning: (t) => pc.yellow(t),
        error: (t) => pc.red(t),
        dim: (t) => pc.dim(pc.gray(t)),
        highlight: (t) => pc.bold(pc.white(t)),
        thought: (t) => pc.magenta(t),
        diffAdded: (t) => pc.green(t),
        diffRemoved: (t) => pc.red(t),
    },
    catppuccin: {
        primary: (t) => pc.cyan(pc.bold(t)), // Sapphire/Sky
        secondary: (t) => pc.blue(t), // Blue
        success: (t) => pc.green(t), // Green
        warning: (t) => pc.yellow(t), // Yellow
        error: (t) => pc.red(t), // Red
        dim: (t) => pc.gray(pc.dim(t)), // Subtext
        highlight: (t) => pc.bold(pc.white(t)),
        thought: (t) => pc.magenta(t), // Mauve
        diffAdded: (t) => pc.green(t),
        diffRemoved: (t) => pc.red(t),
    },
    nord: {
        primary: (t) => pc.cyan(t), // Frost
        secondary: (t) => pc.blue(t), // Deep Frost
        success: (t) => pc.green(t), // Aurora Green
        warning: (t) => pc.yellow(t), // Aurora Yellow
        error: (t) => pc.red(t), // Aurora Red
        dim: (t) => pc.gray(pc.dim(t)), // Polar Night
        highlight: (t) => pc.bold(pc.white(t)),
        thought: (t) => pc.magenta(t), // Aurora Purple
        diffAdded: (t) => pc.green(t),
        diffRemoved: (t) => pc.red(t),
    },
    dracula: {
        primary: (t) => pc.cyan(t),
        secondary: (t) => pc.magenta(t),
        success: (t) => pc.green(t),
        warning: (t) => pc.yellow(t),
        error: (t) => pc.red(t),
        dim: (t) => pc.gray(t),
        highlight: (t) => pc.bold(pc.white(t)),
        thought: (t) => pc.magenta(t),
        diffAdded: (t) => pc.green(t),
        diffRemoved: (t) => pc.red(t),
    },
    monochrome: {
        primary: (t) => pc.bold(t),
        secondary: (t) => pc.underline(t),
        success: (t) => pc.bold(t),
        warning: (t) => pc.underline(t),
        error: (t) => pc.inverse(t),
        dim: (t) => pc.dim(t),
        highlight: (t) => pc.bold(t),
        thought: (t) => pc.dim(t),
        diffAdded: (t) => pc.bold(`+ ${t}`),
        diffRemoved: (t) => pc.dim(`- ${t}`),
    },
};
/**
 * Theme Manager for configurable REPL and CLI terminal coloring (Candidate #26)
 */
export class ThemeManager {
    activeThemeName = "default";
    currentScheme = PRESET_THEMES.default;
    constructor(customThemeName) {
        if (customThemeName && PRESET_THEMES[customThemeName]) {
            this.activeThemeName = customThemeName;
            this.currentScheme = PRESET_THEMES[customThemeName];
        }
        else {
            this.loadConfiguredTheme();
        }
    }
    getThemeName() {
        return this.activeThemeName;
    }
    getScheme() {
        return this.currentScheme;
    }
    setTheme(name) {
        const clean = name.toLowerCase().trim();
        if (PRESET_THEMES[clean]) {
            this.activeThemeName = clean;
            this.currentScheme = PRESET_THEMES[clean];
            return true;
        }
        return false;
    }
    listThemes() {
        return Object.keys(PRESET_THEMES);
    }
    loadConfiguredTheme() {
        const configPaths = [
            path.join(process.cwd(), ".nexus", "theme.json"),
            path.join(os.homedir(), ".config", "nexus", "theme.json"),
            path.join(os.homedir(), ".nexus", "theme.json"),
        ];
        for (const p of configPaths) {
            if (fs.existsSync(p)) {
                try {
                    const content = JSON.parse(fs.readFileSync(p, "utf-8"));
                    if (content.theme && PRESET_THEMES[content.theme]) {
                        this.setTheme(content.theme);
                        return;
                    }
                }
                catch { }
            }
        }
    }
    saveConfiguredTheme(themeName) {
        if (!this.setTheme(themeName))
            return false;
        try {
            const configDir = path.join(os.homedir(), ".config", "nexus");
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            const configFile = path.join(configDir, "theme.json");
            fs.writeFileSync(configFile, JSON.stringify({ theme: themeName }, null, 2), "utf-8");
            return true;
        }
        catch {
            return false;
        }
    }
}

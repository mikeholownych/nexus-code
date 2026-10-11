const expected = Object.freeze({
	CF_NO_OSC_PROGRESS: "1",
	HOME: "/home/mike",
	LANG: "C.UTF-8",
	NO_COLOR: "1",
	PATH: "/usr/bin:/bin",
	XDG_CONFIG_HOME: "/home/mike/.config",
});
const actual = Object.fromEntries(Object.keys(process.env).sort().map((key) => [key, process.env[key]]));
const envIsExact = JSON.stringify(actual) === JSON.stringify(expected);
const cwdIsFixed = process.cwd() === "/";
const noNodeArguments = process.execArgv.length === 0;
const passed = envIsExact && cwdIsFixed && noNodeArguments;
process.stdout.write(JSON.stringify({ passed, envIsExact, cwdIsFixed, noNodeArguments }) + "\n");
if (!passed) process.exitCode = 1;

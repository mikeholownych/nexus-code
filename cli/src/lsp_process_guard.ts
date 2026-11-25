/** Trusted lifetime supervisor: keeps an inherited admission descriptor open while the language server runs. */
import { spawn, type ChildProcess } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("Language server supervisor requires a command.\n");
  process.exitCode = 2;
} else {
  let child: ChildProcess | undefined;
  try {
    // The supervisor intentionally does not pass descriptor 3 through to an untrusted language server.
    child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  } catch (error) {
    process.stderr.write(`Language server supervisor could not start the command: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 127;
  }
  if (child) {
    child.once("error", (error) => {
      process.stderr.write(`Language server supervisor could not start the command: ${error.message}\n`);
    });
    child.once("close", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}

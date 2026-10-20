// Resolve the operator account home without trusting HOME, which test and probe runs isolate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function operatorAccountHome(account = os.userInfo()) {
  if (!account || account.uid !== process.getuid() || typeof account.homedir !== "string" ||
      !path.isAbsolute(account.homedir) || account.homedir.includes("\0")) {
    throw new Error("operator account must identify the current uid and an absolute home directory");
  }
  const home = fs.realpathSync(account.homedir);
  if (home === path.parse(home).root || !fs.statSync(home).isDirectory()) {
    throw new Error("operator account home must be an existing non-root directory");
  }
  return home;
}

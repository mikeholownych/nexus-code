// tsc does not emit data files: copy the JSON data read at runtime (models.dev snapshot, host pins) next to the compiled code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(cli, "dist"), { recursive: true });
for (const name of fs.readdirSync(path.join(cli, "src")).filter((f) => f.endsWith(".json"))) {
  fs.copyFileSync(path.join(cli, "src", name), path.join(cli, "dist", name));
}

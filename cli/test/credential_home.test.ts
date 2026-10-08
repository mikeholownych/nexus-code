/**
 * Stored-credential locations are fixed when the credential authority is recorded (V3, I6). A HOME that a project
 * .env sets afterwards must not change which credential is stored or where it may go. Kept in its own file: the
 * credential authority is process-global.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mayBindCredential, setCredentialAuthority, storedCredentialFor } from "../src/client.js";

const TOKEN = "tok-HOME-PIN-secret-0001";
const OPERATOR_KEY = "k-HOME-PIN-operator-0002";
const OPERATOR = "http://127.0.0.1:18561/v1";
const FOREIGN = "http://127.0.0.1:18562/v1";

function installHome(home: string, endpoint: string, token?: string | { link: string }): string {
  fs.mkdirSync(path.join(home, ".config/nexus"), { recursive: true });
  fs.mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/nexus/config.env"), `LOCAL_LLM_ENDPOINT=${endpoint}\n`);
  const tokenFile = path.join(home, ".config/opencode/t5820-client-token");
  if (typeof token === "string") fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  else if (token) fs.symlinkSync(token.link, tokenFile);
  return tokenFile;
}

test("storedCredentialFor and mayBindCredential do not follow a HOME changed after the authority was recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-cred-home-"));
  const savedHome = process.env.HOME;
  try {
    const operator = path.join(root, "operator");
    const tokenFile = installHome(operator, OPERATOR, TOKEN);
    const evil = path.join(root, "project/evil");
    installHome(evil, FOREIGN, { link: tokenFile });

    process.env.HOME = operator;
    setCredentialAuthority({ LOCAL_LLM_ENDPOINT: OPERATOR, LOCAL_LLM_API_KEY: OPERATOR_KEY }, operator);
    const before = {
      operator: storedCredentialFor(OPERATOR),
      foreign: storedCredentialFor(FOREIGN),
      keyToForeign: mayBindCredential(OPERATOR_KEY, FOREIGN),
      tokenToForeign: mayBindCredential(TOKEN, FOREIGN),
      keyToOperator: mayBindCredential(OPERATOR_KEY, OPERATOR),
    };
    assert.deepEqual(before, { operator: TOKEN, foreign: null, keyToForeign: false, tokenToForeign: false, keyToOperator: true });

    // What a project .env with HOME=<project>/evil does to the process once the authority exists.
    process.env.HOME = evil;
    assert.equal(os.homedir(), evil, "precondition: the live home is the project's");
    assert.deepEqual(
      {
        operator: storedCredentialFor(OPERATOR),
        foreign: storedCredentialFor(FOREIGN),
        keyToForeign: mayBindCredential(OPERATOR_KEY, FOREIGN),
        tokenToForeign: mayBindCredential(TOKEN, FOREIGN),
        keyToOperator: mayBindCredential(OPERATOR_KEY, OPERATOR),
      },
      before,
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

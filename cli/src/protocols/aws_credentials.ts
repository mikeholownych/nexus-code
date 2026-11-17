/**
 * AWS credential chain, read-only, from environment variables and the shared credentials and config files:
 *   1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN
 *   2. the profile (AWS_PROFILE, AWS_DEFAULT_PROFILE, else "default") in AWS_SHARED_CREDENTIALS_FILE
 *      (default ~/.aws/credentials), then in AWS_CONFIG_FILE (default ~/.aws/config)
 * Not supported: SSO, assume-role, credential_process and instance metadata (they need network or code execution).
 * Values are never logged or put in error messages; errors name only the variable, file or profile.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AwsCredentials } from "./aws_sigv4.js";

export interface AwsEnvironment {
  env: Record<string, string | undefined>;
  /** Home directory for the default file locations (tests pass a temporary directory). */
  home?: string;
  readFile?: (file: string) => string | undefined;
}

export type IniFile = Record<string, Record<string, string>>;

/** INI with `[section]` headers, `key = value`, and `#` or `;` comment lines. Linear time; no regular expressions. */
export function parseIni(text: string, configFile = false): IniFile {
  const out: IniFile = {};
  let section: Record<string, string> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      let name = line.slice(1, -1).trim();
      if (configFile) {
        if (name.startsWith("profile ")) name = name.slice(8).trim();
        else if (name !== "default") { section = undefined; continue; }
      }
      section = out[name] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !section) continue;
    section[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

function profileName(env: AwsEnvironment["env"]): string {
  return env.AWS_PROFILE?.trim() || env.AWS_DEFAULT_PROFILE?.trim() || "default";
}

function reader(e: AwsEnvironment): (file: string) => string | undefined {
  return e.readFile ?? ((file) => {
    try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
  });
}

function files(e: AwsEnvironment): { credentials: string; config: string } {
  const home = e.home ?? os.homedir();
  return {
    credentials: e.env.AWS_SHARED_CREDENTIALS_FILE?.trim() || path.join(home, ".aws", "credentials"),
    config: e.env.AWS_CONFIG_FILE?.trim() || path.join(home, ".aws", "config"),
  };
}

export class AwsCredentialError extends Error {}

export function resolveAwsCredentials(e: AwsEnvironment): AwsCredentials {
  const id = e.env.AWS_ACCESS_KEY_ID?.trim();
  const secret = e.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (id && secret) return { accessKeyId: id, secretAccessKey: secret, ...(e.env.AWS_SESSION_TOKEN?.trim() ? { sessionToken: e.env.AWS_SESSION_TOKEN.trim() } : {}) };
  if (id || secret) throw new AwsCredentialError("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be set");
  const profile = profileName(e.env);
  const read = reader(e);
  const f = files(e);
  const sources: Array<[string, boolean]> = [[f.credentials, false], [f.config, true]];
  for (const [file, isConfig] of sources) {
    const text = read(file);
    if (text === undefined) continue;
    const s = parseIni(text, isConfig)[profile];
    const keyId = s?.aws_access_key_id;
    const key = s?.aws_secret_access_key;
    if (keyId && key) return { accessKeyId: keyId, secretAccessKey: key, ...(s.aws_session_token ? { sessionToken: s.aws_session_token } : {}) };
  }
  throw new AwsCredentialError(`no AWS credentials: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or add profile '${profile}' to ${f.credentials}`);
}

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** AWS_REGION, AWS_DEFAULT_REGION, then `region` in the profile of the config file. */
export function resolveAwsRegion(e: AwsEnvironment): string | undefined {
  const fromEnv = e.env.AWS_REGION?.trim() || e.env.AWS_DEFAULT_REGION?.trim();
  if (fromEnv) return fromEnv;
  const text = reader(e)(files(e).config);
  const region = text === undefined ? undefined : parseIni(text, true)[profileName(e.env)]?.region;
  return region || undefined;
}

export function isAwsRegion(value: string): boolean {
  return REGION.test(value);
}

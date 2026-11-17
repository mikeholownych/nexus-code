/**
 * AWS Signature Version 4 on node:crypto (no dependency). Signs one request and returns the headers to add.
 * Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 *
 * Only `host`, `content-type`, `x-amz-date` and `x-amz-security-token` are signed, so the caller may add other headers
 * (request ids, tracing) afterwards without invalidating the signature. The canonical path is the path as sent with
 * each segment encoded once more, which is the rule for every service except S3.
 */
import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Input {
  method: string;
  url: string;
  /** Headers to sign besides host and x-amz-*; only content-type is used. */
  headers?: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
}

const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 unreserved characters stay; everything else is percent-encoded as UTF-8 with upper-case hex. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `YYYYMMDD'T'HHMMSS'Z'` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs = [...params.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicalPath(pathname: string): string {
  return pathname.split("/").map((seg) => (seg === "" ? "" : uriEncode(seg))).join("/") || "/";
}

export interface SigV4Result {
  /** Headers to send in addition to the caller's own (host is implied by the URL). */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export function signSigV4(input: SigV4Input): SigV4Result {
  const url = new URL(input.url);
  const date = amzDate(input.now);
  const dateStamp = date.slice(0, 8);
  const signed: Record<string, string> = { host: url.host, "x-amz-date": date };
  const contentType = Object.entries(input.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  if (contentType !== undefined) signed["content-type"] = contentType.trim();
  if (input.credentials.sessionToken) signed["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service)).update(stringToSign, "utf8").digest("hex");
  const headers: Record<string, string> = {
    "X-Amz-Date": date,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (input.credentials.sessionToken) headers["X-Amz-Security-Token"] = input.credentials.sessionToken;
  return { headers, canonicalRequest, stringToSign, signature };
}

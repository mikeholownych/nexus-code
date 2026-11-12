/**
 * How an inference endpoint URL is identified and persisted.
 *
 * Records (task, session, provider recovery) keep the origin and path only: userinfo, query string and fragment can
 * carry credentials (`https://user:pass@host/v1?api_key=...`) and are never written. Comparison uses the same form,
 * with scheme and host lower-cased and trailing slashes dropped.
 */

function parse(endpoint: string): URL | undefined {
  try {
    return new URL(endpoint.trim());
  } catch {
    return undefined;
  }
}

/** Drops trailing slashes in one pass (no regular expression: input is user-controlled). */
function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

const FAKE_SCHEME = "x-nexus";
/** Longest userinfo or host part looked at in a scheme-less `user:pass@host:port` (keeps the scan linear). */
const BARE_LIMIT = 256;

/** Whitespace, control characters, quotes and angle brackets end a URL-looking token. */
function isBreak(c: number): boolean {
  return c <= 32 || c === 34 || c === 39 || c === 60 || c === 62;
}

const isAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c: number): boolean => isAlpha(c) || (c >= 48 && c <= 57);
const isSchemeChar = (c: number): boolean => isAlnum(c) || c === 43 || c === 45 || c === 46;

/** What follows the userinfo, cut at the first `?` or `#`, without trailing slashes. */
function originAndPath(rest: string): string {
  const q = rest.indexOf("?");
  const h = rest.indexOf("#");
  const cut = q < 0 ? h : h < 0 ? q : Math.min(q, h);
  return trimTrailingSlashes(cut < 0 ? rest : rest.slice(0, cut));
}

interface Scrubbed {
  text: string;
  /** Index in the source where scanning resumes. */
  next: number;
}

/**
 * The part of a URL after `scheme://` (or `//`) reduced to host and path. A token that parses has its userinfo, query and
 * fragment dropped. One that does not parse (a password holding `/`, `?` or `#`) or that parses only by reading a password
 * as a port (`u:1234/x@h`) is cut CONSERVATIVELY, never kept: through the last `@` of the authority, else of the whole
 * token when the authority holds a `:` (it may be `user:password`), else, when the authority is `user:letters` and the
 * line has a later `@`, through that `@` (a password may hold spaces). A token that is ambiguous is over-redacted.
 *
 * `tokEnd` ends the token at whitespace; `lastAt` is the last `@` of the line (-1: do not look past the token, as for a
 * stored endpoint, which is one value).
 */
function scrubAuthority(source: string, scheme: string, tokStart: number, tokEnd: number, lastAt: number): Scrubbed {
  const prefix = scheme ? `${scheme}://` : "//";
  const tok = source.slice(tokStart, tokEnd);
  const delim0 = tok.search(/[/?#\\]/);
  const authority = delim0 < 0 ? tok : tok.slice(0, delim0);
  const colon = authority.startsWith("[") ? -1 : authority.indexOf(":");
  let url: URL | undefined;
  try {
    url = new URL(`${scheme || FAKE_SCHEME}://${tok}`);
  } catch {}
  // A parse that read `user:1234` as host:port, or a `?`, `#`, `\` or `/` as the end of the authority, may have left a
  // password in the path or query: an `@` after the authority makes the token ambiguous, whether or not it has a colon.
  const delimiter = tok.search(/[/?#\\]/);
  const ambiguous = url !== undefined && !url.username && !url.password && delimiter >= 0 && tok.indexOf("@", delimiter) >= 0;
  if (url && !ambiguous) {
    if (scheme) return { text: `${url.protocol}//${url.host}${trimTrailingSlashes(url.pathname)}`, next: tokEnd };
    return { text: url.username || url.password ? `//${url.host}${url.pathname}` : `//${originAndPath(tok)}`, next: tokEnd };
  }
  let at = -1;
  if (authority.includes("@")) at = authority.lastIndexOf("@");
  else if (colon >= 0 || ambiguous) at = tok.lastIndexOf("@");
  if (at >= 0) return { text: prefix + originAndPath(tok.slice(at + 1)), next: tokEnd };
  if (colon >= 0 && lastAt >= tokEnd) {
    let end = lastAt + 1;
    while (end < source.length && !isBreak(source.charCodeAt(end))) end++;
    return { text: prefix + originAndPath(source.slice(lastAt + 1, end)), next: end };
  }
  return { text: prefix + originAndPath(tok), next: tokEnd };
}

/** Every `scheme://...` and `//...` token reduced by `scrubAuthority`, found in one left-to-right scan. */
function scrubSchemeUrls(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let pos = 0;
  let lineEnd = -1;
  let lineLastAt = -1;
  while (true) {
    const j = text.indexOf("//", pos);
    if (j < 0) break;
    pos = j + 2;
    let start = j;
    let scheme = "";
    const prev = j > 0 ? text.charCodeAt(j - 1) : 32;
    if (prev === 58) {
      let k = j - 1;
      while (k > copied && isSchemeChar(text.charCodeAt(k - 1))) k--;
      while (k < j - 1 && !isAlpha(text.charCodeAt(k))) k++;
      if (k >= j - 1) continue;
      scheme = text.slice(k, j - 1);
      start = k;
    } else if (isAlnum(prev) || prev === 47 || prev === 46 || prev === 45 || prev === 95 || prev === 64 || prev === 37) {
      continue;
    }
    let end = j + 2;
    while (end < text.length && !isBreak(text.charCodeAt(end))) end++;
    if (end === j + 2) continue;
    if (j + 2 > lineEnd) {
      const nl = text.indexOf("\n", j + 2);
      lineEnd = nl < 0 ? text.length : nl;
      lineLastAt = -1;
      for (let i = lineEnd - 1; i >= j + 2; i--) if (text.charCodeAt(i) === 64) { lineLastAt = i; break; }
    }
    const out = scrubAuthority(text, scheme, j + 2, end, lineLastAt);
    parts.push(text.slice(copied, start), out.text);
    copied = pos = out.next;
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

/**
 * A scheme-less `user:pass@host:port` or `user:pass@host/path`: userinfo with a colon, then a host that has a port or a
 * path (so `mailto:a@b.example` and `a@b.example` are not touched). Each `@` looks at most BARE_LIMIT characters to either
 * side, so the scan is linear; a longer userinfo is left alone.
 */
function scrubBareUserinfo(text: string): string {
  const parts: string[] = [];
  let copied = 0;
  let at = text.indexOf("@");
  while (at >= 0) {
    const isOpen = (c: number): boolean => isBreak(c) || c === 40 || c === 44;
    let s = at;
    const floor = Math.max(copied, at - BARE_LIMIT);
    while (s > floor && !isOpen(text.charCodeAt(s - 1))) s--;
    // Stopped by the limit, not by a boundary: the userinfo is too long to look at.
    const tooLong = s === floor && floor > copied && !isOpen(text.charCodeAt(s - 1));
    let e = at + 1;
    const ceiling = Math.min(text.length, at + 1 + BARE_LIMIT);
    while (e < ceiling && !isBreak(text.charCodeAt(e))) e++;
    const user = text.slice(s, at);
    const colon = user.indexOf(":");
    if (colon > 0 && colon < user.length - 1 && !user.includes("/") && !tooLong) {
      let host = text.slice(at + 1, e);
      const slash = host.indexOf("/");
      let hostPort = slash < 0 ? host : host.slice(0, slash);
      while (hostPort && ".,;:)]".includes(hostPort[hostPort.length - 1])) hostPort = hostPort.slice(0, -1);
      if (hostPort && (isAlnum(hostPort.charCodeAt(0)) || hostPort[0] === "[") && (slash >= 0 || /:\d+$/.test(hostPort))) {
        parts.push(text.slice(copied, s));
        copied = at + 1;
      }
    }
    at = text.indexOf("@", at + 1);
  }
  if (copied === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

/**
 * Origin and path of an endpoint, without userinfo, query or fragment. A value that is not a URL is cut of those parts as
 * far as it can be (conservatively: see `scrubAuthority`); a missing endpoint (a test or partial configuration) stays missing.
 */
export function persistableEndpoint(endpoint: string): string;
export function persistableEndpoint(endpoint: string | undefined): string | undefined;
export function persistableEndpoint(endpoint: string | undefined): string | undefined {
  if (typeof endpoint !== "string") return undefined;
  const text = endpoint.trim();
  const schemeEnd = text.indexOf("://");
  if (schemeEnd > 0) {
    let k = schemeEnd;
    while (k > 0 && isSchemeChar(text.charCodeAt(k - 1))) k--;
    if (k === 0 && isAlpha(text.charCodeAt(0))) {
      return trimTrailingSlashes(scrubAuthority(text, text.slice(0, schemeEnd), schemeEnd + 3, text.length, -1).text);
    }
  }
  if (text.includes("@") && !text.includes("://")) {
    // `//user:pw@host/v1` or `user:pw@host:8080/v1`: not a scheme URL, so the userinfo is cut as in free text.
    const bare = scrubAuthority(text.startsWith("//") ? text : `//${text}`, "", 2, text.startsWith("//") ? text.length : text.length + 2, -1).text;
    return trimTrailingSlashes(bare.startsWith("//") && !text.startsWith("//") ? bare.slice(2) : bare);
  }
  const url = parse(text);
  if (url) return `${url.protocol}//${url.host}${trimTrailingSlashes(url.pathname)}`;
  return originAndPath(text);
}

/** An endpoint URL for equality: scheme and host lower-cased, trailing slashes dropped, no userinfo, query or fragment. */
export function comparableEndpoint(endpoint: string): string {
  return persistableEndpoint(endpoint);
}

/**
 * Free text with credentials cut out of every URL in it, found by a linear scan (no backtracking pattern): each
 * `scheme://` and `//` token is parsed with `new URL` and reduced to host and path, an unparseable or ambiguous one is cut
 * through its last `@` (over-redaction is preferred to a leak), and a scheme-less `user:pass@host:port` or
 * `user:pass@host/path` loses its userinfo. Text without such a shape is returned unchanged.
 */
export function scrubUrls(text: string): string {
  return scrubBareUserinfo(scrubSchemeUrls(text));
}

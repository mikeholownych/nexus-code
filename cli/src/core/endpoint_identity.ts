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

/** The best effort for a value that is not a URL: cut at the first `?` or `#`, drop `userinfo@` after `scheme://`. */
function stripUnparseable(endpoint: string): string {
  let text = endpoint.trim();
  const cut = [text.indexOf("?"), text.indexOf("#")].filter((i) => i >= 0);
  if (cut.length) text = text.slice(0, Math.min(...cut));
  const schemeEnd = text.indexOf("://");
  if (schemeEnd > 0) {
    const rest = text.slice(schemeEnd + 3);
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf("@");
    if (at >= 0) text = text.slice(0, schemeEnd + 3) + rest.slice(at + 1);
  }
  return trimTrailingSlashes(text);
}

/**
 * Origin and path of an endpoint, without userinfo, query or fragment. An unparseable value is cut of those parts as
 * far as it can be; a missing endpoint (a test or partial configuration) stays missing.
 */
export function persistableEndpoint(endpoint: string): string;
export function persistableEndpoint(endpoint: string | undefined): string | undefined;
export function persistableEndpoint(endpoint: string | undefined): string | undefined {
  if (typeof endpoint !== "string") return undefined;
  const url = parse(endpoint);
  if (!url) return stripUnparseable(endpoint);
  return `${url.protocol}//${url.host}${trimTrailingSlashes(url.pathname)}`;
}

/** An endpoint URL for equality: scheme and host lower-cased, trailing slashes dropped, no userinfo, query or fragment. */
export function comparableEndpoint(endpoint: string): string {
  return persistableEndpoint(endpoint);
}

/**
 * Free text with credentials cut out of every URL in it: userinfo (to the last `@` before the first `/`, whatever
 * characters the password holds) in `//user:pass@host`, scheme-less `user:pass@host:port/path`, and any scheme URL
 * reduced to `persistableEndpoint` form (no query or fragment). Text without such a shape is returned unchanged.
 */
export function scrubUrls(text: string): string {
  return text
    .replace(/(\/\/)[^\s\/@:"'<>]+:[^\/\n]*@/g, "$1")
    .replace(/(?<![\w\/@.:-])[^\s\/@:"'<>]+:[^\s\/@"'<>]+@(?=[\w.-]+(?::\d+)?\/)/g, "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (url) => persistableEndpoint(url));
}

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

/** Origin and path of an endpoint, without userinfo, query or fragment (an unparseable value is returned trimmed of those parts as far as possible). */
export function persistableEndpoint(endpoint: string): string {
  const url = parse(endpoint);
  if (!url) return endpoint.trim().replace(/[?#].*$/, "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1").replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** An endpoint URL for equality: scheme and host lower-cased, trailing slashes dropped, no userinfo, query or fragment. */
export function comparableEndpoint(endpoint: string): string {
  return persistableEndpoint(endpoint);
}

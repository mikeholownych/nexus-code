# DEFECT: safeFetch crashes the process on an unreachable pinned address

| | |
|---|---|
| Base revision | `a12c07091f15f4e7d581907fab110b0653c4c264` (`origin/main`) |
| Branch | `v1/defect-scan-20261023` |
| Affected behavior | `safeFetch()` (used by the model-invoked `fetch_web` tool) aborts the whole Node process when the pinned address fails to connect with `ENETUNREACH` (or `EINVAL`), instead of rejecting the promise. `fetch_web`'s `try/catch` cannot catch an unhandled `'error'` event. |
| Severity | High: remote/untrusted URL choice can terminate the agent session (denial of service, loss of in-flight work). |
| Runtime | Node `v24.11.1` (supported floor is `>=22`) |

## Reproduction (pre-fix)

`safeFetch` passed a custom `lookup` to `http(s).request` to pin the validated DNS address. With that
arrangement, a connect failure other than `ECONNREFUSED` is emitted on the socket before
`ClientRequest` attaches its listener:

```sh
node -e '
const http=require("node:http");
const req=http.request({hostname:"example.invalid",port:80,path:"/",
  lookup:(_h,o,cb)=>{if(typeof o==="function"){cb=o;o={}}cb(null,[{address:"2001:2::1",family:6}])}},
  r=>{console.log(r.statusCode);r.resume()});
req.on("error",e=>console.log("caught",e.code));
req.end();'
```

Observed: `Error: connect ENETUNREACH 2001:2::1:80` → `throw er; // Unhandled 'error' event`, exit 1.
The same happened through the real `safeFetch` path for `http://[2001:2::1]:80/` and for
`http://[2606:4700:4700::1111]:80/` on a host without an IPv6 route.

## Root cause

`lookup`-based pinning depends on Node forwarding every socket connect error to the request. Some
connect failures are emitted before the request installs its socket listener.

## Fix

Connect through a socket created by `safeFetch` itself (`createConnection`) to the already-validated
address: `net.connect` for HTTP and `tls.connect` for HTTPS (SNI retained for hostnames, omitted for IP
literals). DNS pinning is preserved because the hostname is never resolved a second time. Redirects
still re-validate every hop. Also classify IPv4-compatible (`::/96`) and IPv4-translated
(`::ffff:0:0/96`) IPv6 forms by their embedded IPv4 address instead of treating them as public.

## Verification

- `cli/test/fetch_web_ssrf.test.ts`: 10/10 pass after the fix, with isolated `HOME`/`XDG_CONFIG_HOME`.
- New regression test runs the fetch in a child process and fails (child exit 1, unhandled
  `ENETUNREACH`) on the pre-fix source; it passes after the fix.
- New HTTPS tests use a local CA and a certificate with `DNS:pinned.example,IP:127.0.0.1`, proving
  the pinned connection keeps SNI and certificate identity for both a hostname and an IP literal.
- `npx tsc --noEmit -p tsconfig.json`: pass.
- Manual HTTPS probe: `safeFetch("https://example.com/")` → `200`, body returned.
- `git diff --check`: pass.

## Residual risk (not fixed here)

The NAT64 well-known prefix `64:ff9b::/96` is still classified as public even though it embeds an IPv4
address (e.g. `64:ff9b::7f00:1`). It is only reachable on hosts with a NAT64 route, which this host does
not have, so no reproduction was possible; network-specific NAT64 prefixes cannot be recognised without
operator configuration. Teredo (`2001::/32`) is likewise not decoded. Both predate this change and are
recorded here rather than silently fixed.


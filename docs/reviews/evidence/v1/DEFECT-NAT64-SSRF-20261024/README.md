# DEFECT: NAT64 well-known prefix bypasses the SSRF guard and locality classifier

| | |
|---|---|
| Base revision | `57b9285c6cead27b2260bf3113b3fc0b847f8169` (`origin/main`) |
| Branch | `v1/defect-nat64-ssrf` |
| Affected behavior | `isPublicIp`/`isSafeOutboundUrl`/`safeFetch` classified `64:ff9b::/96` (NAT64 well-known prefix, RFC 6052) as ordinary public IPv6, although the low 32 bits are the destination IPv4 address. On an IPv6-only/NAT64 network, `http://[64:ff9b::7f00:1]/` reaches `127.0.0.1`. `classifyLocality` in `core/egress.ts` had the same blind spot and reported `EXTERNAL_PUBLIC`, so an external-boundary egress policy could send data to a loopback/private service. |
| Severity | Medium–high: SSRF/local-only access bypass and a destination trust misclassification, conditional on the host having NAT64 connectivity (common on IPv6-only mobile/ISP networks). |

## Reproduction (pre-fix)

```
isPublicIp("64:ff9b::7f00:1")                      => true
isSafeOutboundUrl("http://[64:ff9b::7f00:1]/")     => { safe: true }
isPublicIp("64:ff9b::a00:1")                       => true
classifyLocality("http://[64:ff9b::7f00:1]:8000")  => EXTERNAL_PUBLIC
```

The same addresses through `127.0.0.1`, `10.0.0.1`, `::ffff:127.0.0.1` were correctly rejected, so the
NAT64 embedding was the only difference.

## Fix

- `isPublicIp` classifies `64:ff9b::/96` by the embedded IPv4 address (loopback, RFC1918, CGNAT,
  link-local, documentation, multicast and reserved are rejected; a genuinely public embedded address
  stays reachable).
- The NAT64 local-use prefix `64:ff9b:1::/48` (RFC 8215) is rejected as not globally reachable.
- `classifyLocality` applies the same two rules, reusing one `classifyIpv4Trust` helper for IPv4 literals,
  IPv4-mapped addresses and the NAT64 embedded address.

## Verification

- `cli/test/fetch_web_ssrf.test.ts`: 10/10. The `isPublicIp` test fails on the pre-fix `tools.ts`
  (`actual: true, expected: false`), and `fetch_web` now refuses `[64:ff9b::7f00:1]`,
  `[64:ff9b::a00:1]:8080` and `[64:ff9b:1::7f00:1]`.
- `cli/test/egress.test.ts`: 28/28. `ACC-TRUST-02` fails on the pre-fix `egress.ts`
  (`EXTERNAL_PUBLIC`/`hostname_external` instead of `LOCAL_APPLIANCE`/`loopback_ip`).
- Combined focused run: 38/38; `npx tsc --noEmit`; `git diff --check`: pass.

## Residual risk

- NAT64 prefixes other than the well-known `/96` and local-use `/48` (operator-specific `/64`, `/56`,
  `/40`, `/32` from RFC 6052) cannot be recognized from the address alone and remain classified as
  ordinary IPv6.
- Teredo (`2001::/32`) and 6to4 are unchanged; 6to4 already classifies by the embedded relay IPv4.
  Teredo's embedded client address is obfuscated and does not route directly to that IPv4.
- The guard still relies on the local stack honoring NAT64; a host with no NAT64 route simply fails the
  connection.

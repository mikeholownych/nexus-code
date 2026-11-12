# D-20 spurious provider outage on a healthy server

Root cause found and fixed (not withdrawn). The audit's notice text (`temporarily unavailable (network_error); waiting 1s
... recovered after 1s`) is the recovery of a `network_error` classified TEMPORARILY_UNAVAILABLE / UNKNOWN. A healthy
HTTP/1.1 server that closes an idle keep-alive connection while the next request is being written (its idle timeout
racing the request) makes undici fail that request with `UND_ERR_SOCKET: other side closed` (or `ECONNRESET`), on a
connection the client had reused. Nothing is wrong with the server and nothing appears in its log. This is not only a fake
artefact: the audit's fake closes tool-call streams right after `[DONE]`, a real server's idle timer does the same.

Reproduction: `cli/test/provider_healthy_server.test.ts` (a server that is healthy but closes any connection on which a
second request arrives, with chat, probe and a `write_file` turn in auto mode through `AutonomousAgent`).
`unit-red-before.txt` is its output with the fix switched off: chat and probe fail with `UND_ERR_SOCKET`, and the agent
turn prints `Provider recovery (step 2): network_error, execution UNKNOWN; next check in 1s`.

Fix (`cli/src/client.ts`, `fetchResendingStale`): the inference POSTs and the availability probe resend when the request
fails with a connection-closed code (`UND_ERR_SOCKET`, `ECONNRESET`, `EPIPE`) within 2 s of the attempt, on an endpoint that
has answered before (a first-use reset is still an outage, sent once), not after an abort or a timeout, only for a URL under a
configured endpoint, only a thrown fetch (never after a response), with a per-endpoint budget of 3 resends per 60 s counted across
requests and cleared when the endpoint answers a request without one (a pool that closed one idle connection has usually closed its siblings). RFC 9112 section 9.3.1
allows it; the recovery design already treats an unreceived inference response as safe to replay. Refused and unresolvable
hosts, TLS and HTTP errors are not resends. A server that answered once and then resets everything is still an outage after
four attempts, and over many requests costs only the budgeted resends (test: five rejected requests, eight sends; unbudgeted, 1005 with the budget raised). Keep-alive reuse is kept (`inference_transport.test.ts` "keep-alive connections are reused").

The D-07 start-up probe: a probe that fails with a connection-level error is `blocking` and gives the start-up notice, but
only a prompt-time re-probe can refuse a prompt, and it asks again first (`provider_status_plain.test.ts` "a prompt goes
through once the provider answers, even though start-up found it down"); a 503, 429, timeout or 401/403 on `/models` is only
a warning (same file, "/models answering 503 ... does not block prompts"). The probe now also resends on the stale-connection
signature (test "a start-up probe that meets the same race").

Residual: a one-off refused or reset connection at the very first request of a process (nothing answered before) still
produces the start-up notice, cleared in effect by the next prompt's re-probe; a stale connection whose failure takes
more than 2 s is not resent; capability discovery requests (`/models` with `X-Nexus-Purpose`) are not resent.

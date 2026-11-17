// One npm registry lookup that survives a transient failure and still fails closed.
//
// A network error, a timeout, a truncated body, HTTP 429 and HTTP 5xx are retried (3 attempts, 1 s then 3 s apart).
// Anything else (404, 403, a package the registry does not know) is a real answer and is not retried. When the attempts
// run out the last error is thrown, so a caller that treats a throw as "could not verify" stays fail-closed.
const retryableStatus = (status) => status === 429 || status >= 500;

export async function fetchRegistryJson(url, options = {}) {
  const {
    fetchImpl = fetch,
    attempts = 3,
    backoffMs = [1000, 3000],
    timeoutMs = 20_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  let lastError;
  let made = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    made = attempt;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const error = new Error(`registry returned HTTP ${response.status}`);
        error.retryable = retryableStatus(response.status);
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error?.retryable === false || attempt === attempts) break;
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(made > 1 ? `${message} (after ${made} attempts)` : message);
}

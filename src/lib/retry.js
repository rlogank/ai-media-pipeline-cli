export function isLikelyRetryableError(error) {
  if (!error) return false;

  const status = error.status || error.statusCode;
  if (typeof status === "number") {
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status >= 500) return true;
  }

  const code = String(error.code || "").toUpperCase();
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EAI_AGAIN") return true;

  const msg = String(error.message || "").toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("rate limit") ||
    msg.includes("temporar") ||
    msg.includes("try again")
  );
}

export async function withRetry(fn, options = {}) {
  const {
    attempts = 5,
    minDelayMs = 1200,
    maxDelayMs = 12000,
    factor = 1.8,
    shouldRetry = isLikelyRetryableError,
    onRetry,
  } = options;

  let nextDelay = minDelayMs;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const retryable = attempt < attempts && shouldRetry(error);
      if (!retryable) break;
      if (typeof onRetry === "function") {
        onRetry({ attempt, nextDelayMs: nextDelay, error });
      }
      await new Promise((resolve) => setTimeout(resolve, nextDelay));
      nextDelay = Math.min(Math.floor(nextDelay * factor), maxDelayMs);
    }
  }

  throw lastError;
}

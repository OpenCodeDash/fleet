const REDACTED = "[REDACTED]";
const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);

/**
 * Return a deep copy of `value` with every known secret value replaced and credential
 * headers blanked. Applied on ingest so secrets never reach durable storage or the event
 * stream (docs/observability.md).
 */
export function redactSecrets(value: unknown, secrets: string[]): unknown {
  const active = secrets.filter((secret) => secret.length > 0);
  return redact(value, active);
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (result.includes(secret)) result = result.split(secret).join(REDACTED);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_HEADERS.has(key.toLowerCase())
        ? REDACTED
        : redact(entry, secrets);
    }
    return result;
  }
  return value;
}

import { createHash } from "node:crypto";

/** Recursively sort object keys so serialization is independent of insertion order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

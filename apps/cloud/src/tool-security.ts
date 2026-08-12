const REDACTED = "[REDACTED]";

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"'\\]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|private[_-]?key|secret)\s*[:=]\s*["']?)[^\s"']+/gi, `$1${REDACTED}`);
}

export function redactToolInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactValue(value)]));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactValue(nested)]));
  }
  return value;
}

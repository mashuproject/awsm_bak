const DATE_FIELD_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function utcMidnight(value: string, label: "From" | "Before"): string | undefined {
  if (value === "") return undefined;
  if (!DATE_FIELD_PATTERN.test(value)) throw new Error(`Enter a valid ${label} date.`);
  const timestamp = `${value}T00:00:00.000Z`;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp)
    throw new Error(`Enter a valid ${label} date.`);
  return timestamp;
}

export function canonicalSearchDateBounds(
  from: string,
  before: string,
): { readonly capturedFrom?: string; readonly capturedBefore?: string } {
  const capturedFrom = utcMidnight(from, "From");
  const capturedBefore = utcMidnight(before, "Before");
  if (capturedFrom !== undefined && capturedBefore !== undefined && capturedBefore < capturedFrom)
    throw new Error("Before must be the same as or later than From.");
  return {
    ...(capturedFrom === undefined ? {} : { capturedFrom }),
    ...(capturedBefore === undefined ? {} : { capturedBefore }),
  };
}

export function normalizedSearchHosts(urls: readonly string[]): readonly string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    try {
      hosts.add(new URL(value).hostname.toLocaleLowerCase("en-US"));
    } catch {
      // Library URLs are authenticated before this view. Ignore an unavailable filter option.
    }
  }
  return [...hosts].sort();
}

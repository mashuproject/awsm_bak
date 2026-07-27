import { DomainValidationError } from "../../domain/errors";

const TOKEN_PATTERN = /[\p{L}\p{M}\p{N}]+/gu;
const SEARCHABLE_CHARACTER_PATTERN = /[\p{L}\p{M}\p{N}]/u;

export interface ParsedSearchPhrase {
  readonly text: string;
  readonly tokens: readonly string[];
}

export interface ParsedSearchQuery {
  readonly normalized: string;
  readonly semanticText: string;
  readonly exactValue: string;
  readonly terms: readonly string[];
  readonly phrases: readonly ParsedSearchPhrase[];
}

interface QueryPart {
  readonly kind: "Phrase" | "Unquoted";
  readonly text: string;
  readonly matchedQuote: boolean;
}

function normalizedWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function tokenizeSearchText(value: string): readonly string[] {
  return Array.from(
    value.normalize("NFC").toLocaleLowerCase("und").matchAll(TOKEN_PATTERN),
    (match) => match[0].normalize("NFC"),
  );
}

function queryParts(value: string): readonly QueryPart[] {
  const parts: QueryPart[] = [];
  let offset = 0;
  while (offset < value.length) {
    const opening = value.indexOf('"', offset);
    if (opening < 0) {
      parts.push({ kind: "Unquoted", text: value.slice(offset), matchedQuote: false });
      break;
    }
    if (opening > offset) {
      parts.push({ kind: "Unquoted", text: value.slice(offset, opening), matchedQuote: false });
    }
    const closing = value.indexOf('"', opening + 1);
    if (closing < 0) {
      parts.push({ kind: "Unquoted", text: value.slice(opening), matchedQuote: false });
      break;
    }
    parts.push({
      kind: "Phrase",
      text: value.slice(opening + 1, closing),
      matchedQuote: true,
    });
    offset = closing + 1;
  }
  return parts;
}

export function parseSearchQuery(value: string): ParsedSearchQuery {
  const canonical = value.normalize("NFC").trim();
  if (canonical.length === 0 || canonical.length > 1_024) {
    throw new DomainValidationError("search.query", "must contain 1 through 1,024 code units");
  }

  const parts = queryParts(canonical)
    .map((part) => ({ ...part, text: normalizedWhitespace(part.text) }))
    .filter((part) => part.text.length > 0);
  const semanticText = normalizedWhitespace(parts.map(({ text }) => text).join(" "));
  if (!SEARCHABLE_CHARACTER_PATTERN.test(semanticText)) {
    throw new DomainValidationError("search.query", "must contain a letter, mark, or number");
  }

  const terms = Array.from(
    new Set(
      parts
        .filter(({ kind }) => kind === "Unquoted")
        .flatMap(({ text }) => tokenizeSearchText(text)),
    ),
  );
  const phrases = parts
    .filter(({ kind, matchedQuote }) => kind === "Phrase" && matchedQuote)
    .map(({ text }) => ({ text, tokens: tokenizeSearchText(text) }))
    .filter(({ tokens }) => tokens.length > 0);
  const normalized = normalizedWhitespace(
    parts
      .map(({ kind, matchedQuote, text }) =>
        kind === "Phrase" && matchedQuote ? `"${text}"` : text,
      )
      .join(" "),
  );

  return {
    normalized,
    semanticText,
    exactValue: semanticText.toLocaleLowerCase("und"),
    terms,
    phrases,
  };
}

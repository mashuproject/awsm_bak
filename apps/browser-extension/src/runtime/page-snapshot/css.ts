export interface CssUrlToken {
  readonly kind: "Import" | "Url";
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly quote: "'" | '"' | "";
}

function whitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

export function tokenizeCssUrls(source: string): readonly CssUrlToken[] {
  const tokens: CssUrlToken[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (source.slice(index, index + 7).toLowerCase() === "@import") {
      let cursor = index + 7;
      while (whitespace(source[cursor])) cursor += 1;
      const quote = source[cursor];
      if (quote === "'" || quote === '"') {
        const valueStart = cursor + 1;
        cursor = valueStart;
        while (cursor < source.length && source[cursor] !== quote) {
          cursor += source[cursor] === "\\" ? 2 : 1;
        }
        if (source[cursor] === quote) {
          tokens.push({
            kind: "Import",
            start: index,
            end: cursor + 1,
            value: source.slice(valueStart, cursor),
            quote,
          });
          index = cursor + 1;
          continue;
        }
      }
    }
    const character = source[index];
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (source.slice(index, index + 4).toLowerCase() !== "url(") {
      index += 1;
      continue;
    }
    let cursor = index + 4;
    while (whitespace(source[cursor])) cursor += 1;
    const quote: "'" | '"' | "" = source[cursor] === "'" ? "'" : source[cursor] === '"' ? '"' : "";
    if (quote !== "") cursor += 1;
    const valueStart = cursor;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if ((quote !== "" && source[cursor] === quote) || (quote === "" && source[cursor] === ")"))
        break;
      cursor += 1;
    }
    const valueEnd = cursor;
    if (quote !== "") {
      if (source[cursor] !== quote) {
        index += 4;
        continue;
      }
      cursor += 1;
      while (whitespace(source[cursor])) cursor += 1;
    }
    if (source[cursor] !== ")") {
      index += 4;
      continue;
    }
    tokens.push({
      kind: "Url",
      start: index,
      end: cursor + 1,
      value: source.slice(valueStart, valueEnd).trim(),
      quote,
    });
    index = cursor + 1;
  }
  return tokens;
}

export function rewriteCssUrls(
  source: string,
  resolve: (value: string) => string | undefined,
): string {
  const tokens = tokenizeCssUrls(source);
  let output = "";
  let offset = 0;
  for (const token of tokens) {
    output += source.slice(offset, token.start);
    const replacement = resolve(token.value);
    const rewritten =
      replacement === undefined
        ? "url(about:blank#awsm-omitted-resource)"
        : `url(${token.quote}${replacement}${token.quote})`;
    output += token.kind === "Import" ? `@import ${rewritten}` : rewritten;
    offset = token.end;
  }
  return output + source.slice(offset);
}

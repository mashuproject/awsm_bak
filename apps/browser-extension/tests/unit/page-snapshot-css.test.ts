import { describe, expect, it } from "vitest";
import { rewriteCssUrls, tokenizeCssUrls } from "../../src/runtime/page-snapshot";

describe("page snapshot CSS URL tokenizer", () => {
  it("finds URL tokens without treating comments or strings as URLs", () => {
    const css =
      '@import "theme.css"; /* url(skip.png) */ .a{background:url("one.png")} .b::before{content:"url(skip2)"} @font-face{src:url(two.woff2)}';
    expect(tokenizeCssUrls(css).map((token) => token.value)).toEqual([
      "theme.css",
      "one.png",
      "two.woff2",
    ]);
  });

  it("rewrites captured references and makes missing references inert", () => {
    expect(
      rewriteCssUrls(".a{background:url(a.png)}.b{src:url('b.woff2')}", (value) =>
        value === "a.png" ? "cid:a@awsm.invalid" : undefined,
      ),
    ).toBe(".a{background:url(cid:a@awsm.invalid)}.b{src:url(about:blank#awsm-omitted-resource)}");
  });
});

import { describe, expect, it } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import {
  decodeCanonicalContentOutcome,
  encodeCanonicalContentOutcome,
} from "../../src/runtime/content/canonical-outcome";

describe("canonical Content outcome", () => {
  it("round-trips the signed Event result and rejects another outcome shape", () => {
    const value = {
      commandId: "content:workflow-1",
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      eventRecordId: randomIdentifier("VaultRecord"),
    } as const;
    const bytes = encodeCanonicalContentOutcome(value);

    expect(decodeCanonicalContentOutcome(bytes)).toEqual(value);
    expect(() => decodeCanonicalContentOutcome(bytes.slice(0, -1))).toThrow();
  });
});

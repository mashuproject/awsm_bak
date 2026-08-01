import { describe, expect, it } from "vitest";

import { randomIdentifier } from "../../src/domain/canonical/identifiers";
import { canonicalSet } from "../../src/domain/canonical/value";
import {
  type CanonicalLibraryProjection,
  decodeCanonicalLibraryProjection,
  encodeCanonicalLibraryProjection,
} from "../../src/runtime/library/canonical-projection";

describe("canonical Library Projection codec", () => {
  it("retains every Collection merge conflict subject and candidate Cause", () => {
    const value = {
      vaultId: randomIdentifier("Vault"),
      generationId: randomIdentifier("Generation"),
      frontier: [randomIdentifier("VaultRecord")],
      captures: [],
      collections: [],
      conflicts: [
        {
          kind: "CollectionMerge",
          reason: "MultipleDestinations",
          subjectCollectionIds: canonicalSet([randomIdentifier("Collection")]),
          candidateRecordIds: canonicalSet(
            Array.from({ length: 10 }, () => randomIdentifier("VaultRecord")),
          ),
        },
      ],
    } as unknown as CanonicalLibraryProjection;

    expect(decodeCanonicalLibraryProjection(encodeCanonicalLibraryProjection(value))).toEqual(
      value,
    );
  });
});

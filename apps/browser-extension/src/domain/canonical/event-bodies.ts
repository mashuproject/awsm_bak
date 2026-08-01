import { bytesEqual } from "../hash";
import { type AuthorityBodyContext, validateAuthorityEventBody } from "./authority-bodies";
import { validateContentEventBody } from "./content-bodies";
import { DEPENDENCY_TYPES, dependencySet, type TypedDependency } from "./dependencies";
import type { Identifier } from "./identifiers";
import { byteString, exactEmptyMap, exactMap, identifierValue, mapValue } from "./schema";
import type { CanonicalValue } from "./value";
import { encodeCanonicalValue } from "./value";

export type CanonicalEventFamily = 1 | 2 | 3;

export interface EventBodyContext extends AuthorityBodyContext {
  readonly generationId: Identifier<"Generation">;
  readonly parentRecordIds: readonly Identifier<"VaultRecord">[];
}

export function validateEventBodyAndDependencies(
  family: CanonicalEventFamily,
  type: number,
  body: CanonicalValue,
  dependencies: readonly TypedDependency[],
  context: EventBodyContext,
): void {
  let expected: readonly TypedDependency[];
  switch (family) {
    case 1:
      expected = validateAuthorityEventBody(type, body, context);
      break;
    case 2:
      expected = validateContentEventBody(type, body);
      break;
    case 3:
      expected = validateLifecycleEventBody(type, body, context);
      break;
    default:
      throw new TypeError("Unknown Event family");
  }
  if (
    !bytesEqual(
      encodeCanonicalValue(dependencySet(dependencies)),
      encodeCanonicalValue(dependencySet(expected)),
    )
  ) {
    throw new TypeError("Event dependencies do not exactly match the Event body");
  }
}

function validateLifecycleEventBody(
  type: number,
  value: CanonicalValue,
  context: EventBodyContext,
): readonly TypedDependency[] {
  switch (type) {
    case 1: {
      const body = exactMap(value, [0, 1, 2, 3, 4, 5, 6], "Vacuum Event body");
      const predecessorGenerationId = identifierValue(
        mapValue(body, 0),
        "Generation",
        "Vacuum predecessor Generation ID",
      );
      if (!bytesEqual(predecessorGenerationId, context.generationId)) {
        throw new TypeError("Vacuum predecessor Generation ID does not match its Event");
      }
      const frontier = mapValue(body, 1);
      if (
        !bytesEqual(encodeCanonicalValue(frontier), encodeCanonicalValue(context.parentRecordIds))
      ) {
        throw new TypeError("Vacuum predecessor Frontier must equal its causal parents");
      }
      identifierValue(mapValue(body, 2), "Generation", "Vacuum successor Generation ID");
      const baselineId = identifierValue(
        mapValue(body, 3),
        "VaultRecord",
        "Vacuum successor Baseline ID",
      );
      byteString(mapValue(body, 4), 32, "Vacuum predecessor state digest");
      byteString(mapValue(body, 5), 32, "Vacuum successor state digest");
      byteString(mapValue(body, 6), 32, "Vacuum omission digest");
      return [{ type: DEPENDENCY_TYPES.VaultBaseline, id: baselineId }];
    }
    case 2:
      exactEmptyMap(value, "Closure Event body");
      return [];
    default:
      throw new TypeError("Unknown Lifecycle Event type");
  }
}

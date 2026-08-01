import type { Identifier } from "../../domain/canonical/identifiers";
import {
  exactCode,
  exactMap,
  identifierValue,
  mapValue,
  textValue,
} from "../../domain/canonical/schema";
import {
  canonicalMap,
  decodeCanonicalValue,
  encodeCanonicalValue,
} from "../../domain/canonical/value";
import { bytesEqual } from "../../domain/hash";
import { assertCanonicalCommandId } from "../capture/canonical-outcome";

const VACUUM_OUTCOME_FORMAT = 1 as const;
const VACUUM_COMMAND_KEY = "awsm.command.vault-vacuum" as const;

export interface CanonicalVacuumOutcome {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly predecessorGenerationId: Identifier<"Generation">;
  readonly successorGenerationId: Identifier<"Generation">;
  readonly vacuumEventRecordId: Identifier<"VaultRecord">;
  readonly successorBaselineId: Identifier<"VaultRecord">;
}

export function encodeCanonicalVacuumOutcome(value: CanonicalVacuumOutcome): Uint8Array {
  assertCanonicalCommandId(value.commandId);
  return encodeCanonicalValue(
    canonicalMap([
      [0, VACUUM_OUTCOME_FORMAT],
      [1, VACUUM_COMMAND_KEY],
      [2, value.commandId],
      [3, value.vaultId],
      [4, value.predecessorGenerationId],
      [5, value.successorGenerationId],
      [6, value.vacuumEventRecordId],
      [7, value.successorBaselineId],
    ]),
  );
}

export function decodeCanonicalVacuumOutcome(bytes: Uint8Array): CanonicalVacuumOutcome {
  const map = exactMap(decodeCanonicalValue(bytes), [...Array(8).keys()], "Vacuum outcome");
  exactCode(mapValue(map, 0), VACUUM_OUTCOME_FORMAT, "Vacuum outcome format");
  if (textValue(mapValue(map, 1), "Vacuum Command key") !== VACUUM_COMMAND_KEY) {
    throw new TypeError("Vacuum Command key is unsupported");
  }
  const value: CanonicalVacuumOutcome = {
    commandId: textValue(mapValue(map, 2), "Vacuum Command ID", { maxUtf8Bytes: 256 }),
    vaultId: identifierValue(mapValue(map, 3), "Vault", "Vacuum outcome Vault ID"),
    predecessorGenerationId: identifierValue(
      mapValue(map, 4),
      "Generation",
      "Vacuum predecessor Generation ID",
    ),
    successorGenerationId: identifierValue(
      mapValue(map, 5),
      "Generation",
      "Vacuum successor Generation ID",
    ),
    vacuumEventRecordId: identifierValue(mapValue(map, 6), "VaultRecord", "Vacuum Event ID"),
    successorBaselineId: identifierValue(
      mapValue(map, 7),
      "VaultRecord",
      "Vacuum successor Baseline ID",
    ),
  };
  assertCanonicalCommandId(value.commandId);
  if (!bytesEqual(encodeCanonicalVacuumOutcome(value), bytes)) {
    throw new TypeError("Vacuum outcome bytes are not canonical");
  }
  return value;
}

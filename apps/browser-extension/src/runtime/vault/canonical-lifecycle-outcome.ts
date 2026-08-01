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

const LIFECYCLE_OUTCOME_FORMAT = 1 as const;
const CLOSURE_COMMAND_KEY = "awsm.command.vault-closure" as const;

export interface CanonicalLifecycleOutcome {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly eventRecordId: Identifier<"VaultRecord">;
}

export function encodeCanonicalLifecycleOutcome(value: CanonicalLifecycleOutcome): Uint8Array {
  assertCanonicalCommandId(value.commandId);
  return encodeCanonicalValue(
    canonicalMap([
      [0, LIFECYCLE_OUTCOME_FORMAT],
      [1, CLOSURE_COMMAND_KEY],
      [2, value.commandId],
      [3, value.vaultId],
      [4, value.generationId],
      [5, value.eventRecordId],
    ]),
  );
}

export function decodeCanonicalLifecycleOutcome(bytes: Uint8Array): CanonicalLifecycleOutcome {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Lifecycle outcome");
  exactCode(mapValue(map, 0), LIFECYCLE_OUTCOME_FORMAT, "Lifecycle outcome format");
  if (textValue(mapValue(map, 1), "Lifecycle Command key") !== CLOSURE_COMMAND_KEY) {
    throw new TypeError("Lifecycle Command key is unsupported");
  }
  const value: CanonicalLifecycleOutcome = {
    commandId: textValue(mapValue(map, 2), "Lifecycle Command ID", { maxUtf8Bytes: 256 }),
    vaultId: identifierValue(mapValue(map, 3), "Vault", "Lifecycle outcome Vault ID"),
    generationId: identifierValue(
      mapValue(map, 4),
      "Generation",
      "Lifecycle outcome Generation ID",
    ),
    eventRecordId: identifierValue(mapValue(map, 5), "VaultRecord", "Lifecycle outcome Event ID"),
  };
  assertCanonicalCommandId(value.commandId);
  if (!bytesEqual(encodeCanonicalLifecycleOutcome(value), bytes)) {
    throw new TypeError("Lifecycle outcome bytes are not canonical");
  }
  return value;
}

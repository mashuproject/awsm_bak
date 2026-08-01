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

const CONTENT_OUTCOME_FORMAT = 1 as const;
const CONTENT_COMMAND_KEY = "awsm.command.content-event" as const;

export interface CanonicalContentOutcome {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly eventRecordId: Identifier<"VaultRecord">;
}

export function encodeCanonicalContentOutcome(value: CanonicalContentOutcome): Uint8Array {
  assertCanonicalCommandId(value.commandId);
  return encodeCanonicalValue(
    canonicalMap([
      [0, CONTENT_OUTCOME_FORMAT],
      [1, CONTENT_COMMAND_KEY],
      [2, value.commandId],
      [3, value.vaultId],
      [4, value.generationId],
      [5, value.eventRecordId],
    ]),
  );
}

export function decodeCanonicalContentOutcome(bytes: Uint8Array): CanonicalContentOutcome {
  const map = exactMap(decodeCanonicalValue(bytes), [0, 1, 2, 3, 4, 5], "Content outcome");
  exactCode(mapValue(map, 0), CONTENT_OUTCOME_FORMAT, "Content outcome format");
  const commandKey = textValue(mapValue(map, 1), "Content Command key");
  if (commandKey !== CONTENT_COMMAND_KEY) throw new TypeError("Content Command key is unsupported");
  const value: CanonicalContentOutcome = {
    commandId: textValue(mapValue(map, 2), "Content Command ID", { maxUtf8Bytes: 256 }),
    vaultId: identifierValue(mapValue(map, 3), "Vault", "Content outcome Vault ID"),
    generationId: identifierValue(mapValue(map, 4), "Generation", "Content outcome Generation ID"),
    eventRecordId: identifierValue(mapValue(map, 5), "VaultRecord", "Content outcome Event ID"),
  };
  assertCanonicalCommandId(value.commandId);
  if (!bytesEqual(encodeCanonicalContentOutcome(value), bytes)) {
    throw new TypeError("Content outcome bytes are not canonical");
  }
  return value;
}

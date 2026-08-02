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

const MEMBER_RECOVERY_OUTCOME_FORMAT = 1 as const;
const MEMBER_RECOVERY_COMMAND_KEY = "awsm.command.member-recovery" as const;

export interface CanonicalMemberRecoveryOutcome {
  readonly commandId: string;
  readonly vaultId: Identifier<"Vault">;
  readonly generationId: Identifier<"Generation">;
  readonly memberId: Identifier<"Member">;
  readonly clientCredentialId: Identifier<"ClientCredential">;
  readonly eventRecordId: Identifier<"VaultRecord">;
}

export function encodeCanonicalMemberRecoveryOutcome(
  value: CanonicalMemberRecoveryOutcome,
): Uint8Array {
  assertCanonicalCommandId(value.commandId);
  return encodeCanonicalValue(
    canonicalMap([
      [0, MEMBER_RECOVERY_OUTCOME_FORMAT],
      [1, MEMBER_RECOVERY_COMMAND_KEY],
      [2, value.commandId],
      [3, value.vaultId],
      [4, value.generationId],
      [5, value.memberId],
      [6, value.clientCredentialId],
      [7, value.eventRecordId],
    ]),
  );
}

export function decodeCanonicalMemberRecoveryOutcome(
  bytes: Uint8Array,
): CanonicalMemberRecoveryOutcome {
  const map = exactMap(
    decodeCanonicalValue(bytes),
    [...Array(8).keys()],
    "Member Recovery outcome",
  );
  exactCode(mapValue(map, 0), MEMBER_RECOVERY_OUTCOME_FORMAT, "Member Recovery outcome format");
  if (textValue(mapValue(map, 1), "Member Recovery Command key") !== MEMBER_RECOVERY_COMMAND_KEY) {
    throw new TypeError("Member Recovery Command key is unsupported");
  }
  const value: CanonicalMemberRecoveryOutcome = {
    commandId: textValue(mapValue(map, 2), "Member Recovery Command ID", { maxUtf8Bytes: 256 }),
    vaultId: identifierValue(mapValue(map, 3), "Vault", "Member Recovery outcome Vault ID"),
    generationId: identifierValue(
      mapValue(map, 4),
      "Generation",
      "Member Recovery outcome Generation ID",
    ),
    memberId: identifierValue(mapValue(map, 5), "Member", "Recovered Member ID"),
    clientCredentialId: identifierValue(
      mapValue(map, 6),
      "ClientCredential",
      "Recovered Client Credential ID",
    ),
    eventRecordId: identifierValue(mapValue(map, 7), "VaultRecord", "Member Recovery Event ID"),
  };
  assertCanonicalCommandId(value.commandId);
  if (!bytesEqual(encodeCanonicalMemberRecoveryOutcome(value), bytes)) {
    throw new TypeError("Member Recovery outcome bytes are not canonical");
  }
  return value;
}

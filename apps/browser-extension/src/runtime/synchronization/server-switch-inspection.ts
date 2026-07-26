import { canonicalRecord, integer, uuid } from "../../domain/validation";
import type {
  StoredAccountMetadataV1,
  StoredAccountVaultV1,
  StoredRecoveryKitV1,
} from "../../drivers/indexeddb/schema";
import { recoveryKitFromWire } from "../recovery/kit";
import type { VerifiedServerSwitchReplica } from "./server-switch-classifier";

interface CandidateAccountStore {
  loadMetadata(scope: "server-switch-candidate"): Promise<StoredAccountMetadataV1 | undefined>;
  loadRecoveryKit(vaultId: string): Promise<StoredRecoveryKitV1 | undefined>;
}

interface CandidateTransport {
  request(
    method: string,
    path: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface CandidateInspection {
  readonly replica?: VerifiedServerSwitchReplica;
  readonly registration?: StoredAccountVaultV1;
  readonly headCursor: number;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export class ServerSwitchCandidateInspector {
  constructor(
    private readonly accounts: CandidateAccountStore,
    private readonly accountTransport: CandidateTransport,
    private readonly deviceTransportForAttached: (vaultId: string) => Promise<CandidateTransport>,
  ) {}

  async inspect(expectedVaultId: string, _localRootKey: Uint8Array): Promise<CandidateInspection> {
    const metadata = await this.accounts.loadMetadata("server-switch-candidate");
    if (metadata === undefined || metadata.scope !== "Account")
      throw integrity("Candidate Account metadata is missing");
    const response = canonicalRecord(
      (await this.accountTransport.request("GET", "/api/account/vault-enrollment")).body,
      "candidateEnrollment",
      ["state", "vaultId", "recoveryKit"],
    );
    if (response.state === "Empty") {
      if (Object.keys(response).length !== 1)
        throw integrity("Empty candidate enrollment has extra fields");
      return { headCursor: 0 };
    }
    if (response.state !== "Attached") throw integrity("Candidate enrollment state is invalid");
    const vaultId = uuid(response.vaultId, "candidateEnrollment.vaultId");
    if (vaultId !== expectedVaultId)
      throw Object.assign(new Error("Candidate Account owns another Vault"), {
        id: "SERVER_SWITCH_VAULT_MISMATCH",
      });
    const [remote, local] = await Promise.all([
      Promise.resolve(recoveryKitFromWire(response.recoveryKit)),
      this.accounts.loadRecoveryKit(vaultId),
    ]);
    if (
      local === undefined ||
      local.recoveryGenerationId !== remote.metadata.recoveryGenerationId ||
      !equal(local.metadata.administratorPublicKey, remote.metadata.administratorPublicKey) ||
      !equal(local.metadata.ciphertextSha256, remote.metadata.ciphertextSha256) ||
      !equal(local.ciphertext, remote.ciphertext)
    )
      throw integrity("Candidate Recovery Kit authority differs");
    const authority = canonicalRecord(
      (
        await (
          await this.deviceTransportForAttached(vaultId)
        ).request("GET", `/api/vaults/${vaultId}`)
      ).body,
      "candidateVault",
      [
        "vaultId",
        "state",
        "generationId",
        "generationNumber",
        "headCursor",
        "activeKeyEpochId",
        "predecessorGenerationId",
      ],
    );
    if (
      uuid(authority.vaultId, "candidateVault.vaultId") !== vaultId ||
      authority.state !== "Active"
    )
      throw integrity("Candidate Vault authority is invalid");
    const generationId = uuid(authority.generationId, "candidateVault.generationId");
    const generationNumber = integer(authority.generationNumber, "candidateVault.generationNumber");
    const headCursor = integer(authority.headCursor, "candidateVault.headCursor");
    const predecessorGenerationId =
      authority.predecessorGenerationId === undefined
        ? undefined
        : uuid(authority.predecessorGenerationId, "candidateVault.predecessorGenerationId");
    return {
      replica: {
        vaultId,
        generation: {
          generationId,
          generationNumber,
          ...(predecessorGenerationId === undefined ? {} : { predecessorGenerationId }),
        },
      },
      registration: {
        version: 1,
        accountId: metadata.accountId,
        vaultId,
        activeRecoveryGenerationId: remote.metadata.recoveryGenerationId,
        activeKeyEpochId: uuid(authority.activeKeyEpochId, "candidateVault.activeKeyEpochId"),
        remoteGenerationId: generationId,
        remoteGenerationNumber: generationNumber,
        deliveryCursor: headCursor,
      },
      headCursor,
    };
  }
}

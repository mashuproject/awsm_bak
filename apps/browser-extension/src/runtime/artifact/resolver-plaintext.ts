import { readArtifactEnvelope } from "../../crypto/artifact-envelope";
import { deriveContextKeyFromCryptoKey } from "../../crypto/hkdf";
import { wipe } from "../../crypto/sodium";
import type { ArtifactReferenceV1 } from "../../domain/artifact-graph";
import { bytesEqual } from "../../domain/hash";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";
import type { VaultKeyring } from "../vault/keyring";

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function integrity(): Error {
  return Object.assign(new Error("The remote Artifact plaintext failed integrity verification."), {
    id: "REMOTE_ARTIFACT_INTEGRITY_FAILED",
  });
}

export async function transientPlaintextStream(input: {
  readonly vaultId: string;
  readonly object: StoredArtifactObjectV1;
  readonly reference: ArtifactReferenceV1;
  readonly keyring: VaultKeyring;
  readonly encrypted: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
}): Promise<ReadableStream<Uint8Array>> {
  if (input.object.objectId !== input.reference.artifactObjectId) throw integrity();
  const epoch = input.keyring.require(input.object.keyEpochId);
  const key = await deriveContextKeyFromCryptoKey(epoch.rootKey, {
    vaultId: input.vaultId,
    keyEpochId: epoch.keyEpochId,
    domain: "vault:artifact:v1",
    contextId: input.object.objectId,
    keyVersion: 1,
  });
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  void readArtifactEnvelope({
    expectedObjectId: input.object.objectId,
    expectedKeyEpochId: epoch.keyEpochId,
    key,
    encrypted: chunks(input.encrypted),
    write: (value) => writer.write(value),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  })
    .then(async (summary) => {
      if (
        summary.envelopeByteLength !== input.object.envelopeByteLength ||
        !bytesEqual(summary.envelopeChecksum, input.object.envelopeChecksum) ||
        summary.plaintextByteLength !== input.reference.plaintextByteLength ||
        !bytesEqual(summary.plaintextChecksum, input.reference.plaintextChecksum)
      )
        throw integrity();
      await writer.close();
    })
    .catch(async (error) =>
      writer.abort(
        error instanceof DOMException && error.name === "AbortError" ? error : integrity(),
      ),
    )
    .finally(async () => wipe(key));
  return output.readable;
}

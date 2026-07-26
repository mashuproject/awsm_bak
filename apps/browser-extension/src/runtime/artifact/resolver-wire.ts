import { bytesEqual } from "../../domain/hash";
import { canonicalRecord, integer, literal, string, timestamp } from "../../domain/validation";
import type { StoredArtifactObjectV1 } from "../../drivers/indexeddb/schema";
import { base64UrlToBytes } from "../account/wire";

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "REMOTE_ARTIFACT_INTEGRITY_FAILED" });
}

export function decodeArtifactDownload(
  value: unknown,
  expected: StoredArtifactObjectV1,
  serverOrigin: string,
): string {
  try {
    const input = canonicalRecord(value, "Artifact download", ["record", "ticket"]);
    const record = canonicalRecord(input.record, "Artifact download record", [
      "state",
      "objectId",
      "objectType",
      "keyEpochId",
      "byteLength",
      "sha256",
    ]);
    const ticket = canonicalRecord(input.ticket, "Artifact download ticket", [
      "method",
      "url",
      "expiresAt",
      "requiredHeaders",
    ]);
    literal(ticket.method, "GET", "Artifact download ticket method");
    timestamp(ticket.expiresAt, "Artifact download ticket expiry");
    canonicalRecord(ticket.requiredHeaders, "Artifact download ticket required headers", []);
    const checksum = base64UrlToBytes(string(record.sha256, "Artifact record checksum"), 32);
    if (
      record.state !== "Committed" ||
      record.objectId !== expected.objectId ||
      record.objectType !== "Artifact" ||
      record.keyEpochId !== expected.keyEpochId ||
      integer(record.byteLength, "Artifact record byte length") !== expected.envelopeByteLength ||
      !bytesEqual(checksum, expected.envelopeChecksum)
    )
      throw integrity("Remote Artifact metadata does not match its Object record.");
    const url = string(ticket.url, "Artifact download URL");
    const parsed = new URL(url, serverOrigin);
    if (
      !url.startsWith("/") ||
      url.startsWith("//") ||
      parsed.origin !== new URL(serverOrigin).origin
    )
      throw integrity("Artifact download ticket changed origin.");
    return url;
  } catch (error) {
    if (error instanceof Error && "id" in error) throw error;
    throw integrity("The Artifact download response is invalid.");
  }
}

import { describe, expect, it } from "vitest";

import {
  decodeCaptureJob,
  decodeCapturePageCommand,
  decodeEncryptedEnvelope,
  decodeLibraryItem,
  decodeRuntimeError,
} from "../../src/domain/decode";
import { DomainValidationError } from "../../src/domain/errors";
import {
  decodeCaptureJob as decodePersistedCaptureJob,
  decodeStoredEvent,
} from "../../src/drivers/indexeddb/decode";

const IDS = {
  bundle: "00000000-0000-4000-8000-000000000003",
  command: "00000000-0000-4000-8000-000000000001",
  device: "00000000-0000-4000-8000-000000000002",
  object: "00000000-0000-4000-8000-000000000005",
} as const;

function validCommand(): Record<string, unknown> {
  return {
    commandId: IDS.command,
    commandType: "CapturePage",
    commandVersion: 1,
    issuingDeviceId: IDS.device,
    createdAt: "2026-07-16T17:00:00.000Z",
    tabId: 42,
    observedUrl: "https://example.test/article",
    captureProfileId: "WebPageSnapshot-v1",
    idempotencyKey: IDS.command,
  };
}

describe("domain boundary decoders", () => {
  it("rejects fields outside canonical persisted Event and Capture Job schemas", () => {
    expect(() =>
      decodeStoredEvent({
        version: 1,
        vaultId: "00000000-0000-4000-8000-000000000001",
        eventId: "00000000-0000-4000-8000-000000000002",
        referencedObjectIds: [],
        orderingTimestamp: "2026-07-18T12:00:00.000Z",
        envelopeBytes: new Uint8Array([1]),
        discardedDraftField: true,
      }),
    ).toThrow(/canonical schema/u);
    expect(() =>
      decodePersistedCaptureJob({
        version: 1,
        vaultId: "00000000-0000-4000-8000-000000000001",
        jobId: "00000000-0000-4000-8000-000000000002",
        commandId: "00000000-0000-4000-8000-000000000003",
        tabId: 1,
        state: "Created",
        stage: "Preflight",
        createdAt: "2026-07-18T12:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z",
        discardedDraftField: true,
      }),
    ).toThrow(/canonical schema/u);
  });
  it("accepts a valid CapturePage command", () => {
    expect(decodeCapturePageCommand(validCommand())).toMatchObject({
      commandId: IDS.command,
      observedUrl: "https://example.test/article",
    });
  });

  it.each([
    ["missing version", { commandVersion: undefined }],
    ["unsupported URL", { observedUrl: "chrome://extensions" }],
    ["malformed identifier", { commandId: "command-1" }],
    ["non-integer tab", { tabId: 4.2 }],
    ["mismatched idempotency key", { idempotencyKey: IDS.bundle }],
  ])("rejects a command with %s", (_label, replacement) => {
    expect(() => decodeCapturePageCommand({ ...validCommand(), ...replacement })).toThrow(
      DomainValidationError,
    );
  });

  it("rejects an unsupported encrypted-envelope version", () => {
    expect(() =>
      decodeEncryptedEnvelope({
        formatVersion: 99,
        objectType: "BundleDescriptor",
        algorithm: "enc:xchacha20poly1305:v1",
        objectId: IDS.object,
        payloadLength: 3,
        nonce: new Uint8Array(24),
        ciphertext: new Uint8Array(19),
      }),
    ).toThrow(DomainValidationError);
  });

  it("decodes persisted Projection and Job records only at version 1", () => {
    expect(
      decodeLibraryItem({
        version: 1,
        bundleId: IDS.bundle,
        descriptorObjectId: IDS.object,
        assignedCollectionId: IDS.command,
        title: "Example",
        originalUrl: "https://example.test/",
        capturedAt: "2026-07-16T17:00:00.000Z",
        artifactRoles: ["PRIMARY"],
        status: "Active",
        warnings: [],
      }).title,
    ).toBe("Example");

    expect(() =>
      decodeCaptureJob({
        version: 1,
        jobId: IDS.command,
        commandId: IDS.command,
        tabId: 42,
        state: "Running",
        stage: "Snapshot",
        createdAt: "2026-07-16T17:00:00.000Z",
        updatedAt: "2026-07-16T17:00:00.000Z",
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects unknown stable error identifiers", () => {
    expect(() =>
      decodeRuntimeError({
        id: "SOMETHING_NEW",
        message: "unknown",
      }),
    ).toThrow(DomainValidationError);
  });

  it.each(["INVALID_VAULT_NAME", "VAULT_NOT_FOUND", "VAULT_CONTEXT_CHANGED", "VAULT_BUSY"])(
    "accepts the multiple-Vault Runtime error %s",
    (id) => {
      expect(decodeRuntimeError({ id, message: "safe" })).toEqual({ id, message: "safe" });
    },
  );
});

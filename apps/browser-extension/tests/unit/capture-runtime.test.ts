import { describe, expect, it, vi } from "vitest";
import type { CaptureMetadataV1 } from "../../src/domain/artifact-graph";
import type { CapturePageCommandV1, LibraryItemV1 } from "../../src/domain/contracts";
import type { AtomicRegistrationV1, CommandOutcomeV1 } from "../../src/drivers/indexeddb";
import { CaptureHostError } from "../../src/hosts/chrome/capture";
import { CaptureRuntime, type CaptureRuntimePorts } from "../../src/runtime/capture/service";

const ids = Array.from(
  { length: 20 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
function fixedId(index: number): string {
  const value = ids[index];
  if (value === undefined) throw new Error("Missing fixed test identifier");
  return value;
}
const timestamp = "2026-07-16T17:00:00.000Z";
const command: CapturePageCommandV1 = {
  commandId: fixedId(0),
  commandType: "CapturePage",
  commandVersion: 1,
  issuingDeviceId: fixedId(1),
  createdAt: timestamp,
  tabId: 7,
  observedUrl: "https://fixture.test/start",
  captureProfileId: "WebPageSnapshot-v1",
  idempotencyKey: fixedId(0),
};
const metadata: CaptureMetadataV1 = {
  version: 1,
  originalUrl: command.observedUrl,
  finalUrl: "https://fixture.test/final",
  title: "Fixture",
  capturedAt: timestamp,
  contentType: "text/html",
  viewport: { width: 800, height: 600 },
  document: { width: 800, height: 1200 },
  browserName: "Chrome",
  browserVersion: "149",
  extensionVersion: "0.1.0",
  captureProfileId: "WebPageSnapshot-v1",
  captureProfileVersion: 1,
};

function outcome(): CommandOutcomeV1 {
  return {
    version: 1,
    commandId: command.commandId,
    status: "Succeeded",
    bundleId: fixedId(3),
    descriptorObjectId: fixedId(4),
    eventId: fixedId(5),
  };
}

function registration(): AtomicRegistrationV1 {
  const result = outcome();
  return {
    objects: [
      {
        version: 1 as const,
        objectId: result.descriptorObjectId,
        objectType: "BundleDescriptor",
        envelopeBytes: new Uint8Array([1]),
      },
      {
        version: 1,
        objectId: fixedId(19),
        objectType: "Artifact" as const,
        envelopeFormat: "artifact:xchacha20poly1305-chunked:v1" as const,
        envelopeByteLength: 10,
        envelopeChecksumAlgorithm: "hash:sha256:v1" as const,
        envelopeChecksum: new Uint8Array(32),
      },
    ],
    graph: {
      bundleId: result.bundleId,
      descriptorObjectId: result.descriptorObjectId,
      artifactObjectIds: [fixedId(19)],
    },
    event: {
      version: 1,
      vaultId: fixedId(10),
      eventId: result.eventId,
      referencedObjectIds: [result.descriptorObjectId, fixedId(19)].toSorted(),
      orderingTimestamp: timestamp,
      envelopeBytes: new Uint8Array([2]),
    },
    projection: {
      version: 1,
      bundleId: result.bundleId,
      envelopeBytes: new Uint8Array([3]),
    },
    outcome: result,
  };
}

function ports(overrides: Partial<CaptureRuntimePorts> = {}): CaptureRuntimePorts {
  let idIndex = 2;
  return {
    isVaultUnlocked: () => true,
    rootKey: () => ({}) as CryptoKey,
    vaultId: fixedId(10),
    deviceId: fixedId(1),
    clientVersion: "0.1.0",
    findOutcome: vi.fn(async () => undefined),
    saveJob: vi.fn(async () => undefined),
    commitRegistration: vi.fn(async (value) => value.outcome),
    preflight: vi.fn(async () => ({ tabId: 7, url: command.observedUrl })),
    collectSnapshot: vi.fn(async () => ({
      metadata,
      documents: [
        {
          originalUrl: metadata.originalUrl,
          finalUrl: metadata.finalUrl,
          bytes: new TextEncoder().encode("<!doctype html><title>Fixture</title>"),
          scrollX: 0,
          scrollY: 0,
        },
      ],
      resources: [],
      omissions: [],
      contentWarnings: [],
      structuredBlocks: [
        {
          blockVersion: 1,
          blockId: "B000001",
          kind: "Paragraph",
          text: "Fixture",
          links: [],
        } as const,
      ],
    })),
    packageSnapshot: vi.fn(async () => ({
      blob: new Blob(["snapshot"]),
      cleanup: vi.fn(async () => undefined),
    })),
    acquireScreenshot: vi.fn(async () => ({
      webpBlob: new Blob([new Uint8Array([137, 80, 78, 71])]),
      warnings: [],
    })),
    collectionContext: vi.fn(async () => ({ items: [], topology: [] })),
    prepareRegistration: vi.fn(async () => registration()),
    prepareArtifact: vi.fn(async (objectId) => ({
      object: {
        version: 1 as const,
        objectId,
        objectType: "Artifact" as const,
        envelopeFormat: "artifact:xchacha20poly1305-chunked:v1" as const,
        envelopeByteLength: 10,
        envelopeChecksumAlgorithm: "hash:sha256:v1" as const,
        envelopeChecksum: new Uint8Array(32),
      },
      plaintextByteLength: 1,
      plaintextChecksum: new Uint8Array(32),
    })),
    removeArtifact: vi.fn(async () => undefined),
    uuid: () => fixedId(idIndex++),
    now: () => timestamp,
    ...overrides,
  };
}

describe("capture Runtime job", () => {
  it("persists stages, commits once, then marks the job succeeded", async () => {
    const fake = ports();
    await expect(new CaptureRuntime(fake).execute(command)).resolves.toEqual(outcome());
    expect(fake.commitRegistration).toHaveBeenCalledOnce();
    expect(vi.mocked(fake.saveJob).mock.calls.map(([job]) => [job.state, job.stage])).toEqual([
      ["Created", "Preflight"],
      ["Running", "Snapshot"],
      ["Running", "Screenshot"],
      ["Running", "Resources"],
      ["Running", "Package"],
      ["Running", "Commit"],
      ["Succeeded", "Commit"],
    ]);
  });

  it("returns an existing outcome without acquiring the live page", async () => {
    const existing = outcome();
    const fake = ports({ findOutcome: vi.fn(async () => existing) });
    await expect(new CaptureRuntime(fake).execute(command)).resolves.toEqual(existing);
    expect(fake.preflight).not.toHaveBeenCalled();
    expect(fake.saveJob).not.toHaveBeenCalled();
  });

  it("fails before creating a job when preflight rejects", async () => {
    const fake = ports({
      preflight: vi.fn(async () => Promise.reject(new CaptureHostError("UNSUPPORTED_URL", "safe"))),
    });
    await expect(new CaptureRuntime(fake).execute(command)).rejects.toMatchObject({
      id: "UNSUPPORTED_URL",
    });
    expect(fake.saveJob).not.toHaveBeenCalled();
    expect(fake.commitRegistration).not.toHaveBeenCalled();
  });

  it("records mandatory snapshot failure without constructing or committing a Bundle", async () => {
    const fake = ports({
      collectSnapshot: vi.fn(async () =>
        Promise.reject(new CaptureHostError("PAGE_SNAPSHOT_FAILED", "safe")),
      ),
    });
    await expect(new CaptureRuntime(fake).execute(command)).rejects.toMatchObject({
      id: "PAGE_SNAPSHOT_FAILED",
    });
    expect(fake.prepareRegistration).not.toHaveBeenCalled();
    expect(fake.commitRegistration).not.toHaveBeenCalled();
    expect(vi.mocked(fake.saveJob).mock.calls.at(-1)?.[0]).toMatchObject({
      state: "Failed",
      errorId: "PAGE_SNAPSHOT_FAILED",
    });
  });

  it("commits the mandatory snapshot when the screenshot returns a warning", async () => {
    const fake = ports({
      acquireScreenshot: vi.fn(async () => ({
        warnings: ["SCREENSHOT_CAPTURE_FAILED"] as const,
      })),
    });
    await new CaptureRuntime(fake).execute(command);
    expect(fake.prepareRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ warnings: ["SCREENSHOT_CAPTURE_FAILED"] }),
    );
    expect(vi.mocked(fake.prepareRegistration).mock.calls[0]?.[0].artifacts).toHaveLength(3);
    expect(fake.commitRegistration).toHaveBeenCalledOnce();
  });

  it("records an independent optional Artifact failure and still commits the complete produced graph", async () => {
    let prepareCalls = 0;
    const base = ports();
    const prepareArtifact = vi.fn(
      async (...args: Parameters<CaptureRuntimePorts["prepareArtifact"]>) => {
        prepareCalls += 1;
        if (prepareCalls === 1) throw new Error("structured storage failed");
        return base.prepareArtifact(...args);
      },
    );
    const fake = ports({ prepareArtifact });
    await new CaptureRuntime(fake).execute(command);
    expect(fake.prepareRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        warnings: ["STRUCTURED_CONTENT_EXTRACTION_FAILED"],
      }),
    );
    expect(vi.mocked(fake.prepareRegistration).mock.calls[0]?.[0].artifacts).toHaveLength(3);
    expect(fake.commitRegistration).toHaveBeenCalledOnce();
  });

  it("records the matching stable Collection identity during registration", async () => {
    const existing: LibraryItemV1 = {
      version: 1,
      bundleId: fixedId(12),
      descriptorObjectId: fixedId(13),
      assignedCollectionId: fixedId(14),
      title: "Earlier",
      originalUrl: `${metadata.originalUrl}#earlier`,
      capturedAt: "2026-07-16T16:00:00.000Z",
      artifactRoles: ["PRIMARY"],
      status: "Active",
      warnings: [],
    };
    const fake = ports({
      collectionContext: vi.fn(async () => ({
        items: [existing],
        topology: [],
      })),
    });
    await new CaptureRuntime(fake).execute(command);
    expect(fake.prepareRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ collectionId: existing.assignedCollectionId }),
    );
  });

  it("leaves a Running Commit job if termination occurs after atomic commit", async () => {
    const saveJob = vi.fn(async (job) => {
      if (job.state === "Succeeded") throw new Error("worker terminated");
    });
    const fake = ports({ saveJob });
    await expect(new CaptureRuntime(fake).execute(command)).rejects.toThrow("worker terminated");
    expect(fake.commitRegistration).toHaveBeenCalledOnce();
    expect(saveJob.mock.calls.at(-2)?.[0]).toMatchObject({
      state: "Running",
      stage: "Commit",
    });
  });
});

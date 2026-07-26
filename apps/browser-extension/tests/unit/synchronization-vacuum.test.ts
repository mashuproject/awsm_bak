import { describe, expect, it, vi } from "vitest";
import { encodeEncryptedEnvelope } from "../../src/crypto/envelope";
import { SynchronizedVacuumActivator } from "../../src/runtime/synchronization/vacuum";

function generationEnvelope(objectId: string): Uint8Array {
  return encodeEncryptedEnvelope({
    formatVersion: 1,
    objectType: "VaultGeneration",
    algorithm: "enc:xchacha20poly1305:v1",
    keyEpochId: "01900000-0000-7000-8000-000000000500",
    objectId,
    payloadLength: 0,
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array(16),
  });
}

describe("synchronized Vault Vacuum", () => {
  it("activates the fenced server successor before committing local authority", async () => {
    const vaultId = "01900000-0000-7000-8000-000000000501";
    const predecessor = "01900000-0000-7000-8000-000000000502";
    const successor = "01900000-0000-7000-8000-000000000503";
    const retained = "01900000-0000-7000-8000-000000000504";
    const order: string[] = [];
    const request = vi.fn(async (method: string, path: string) => {
      order.push(`${method} ${path}`);
      if (path.endsWith("/generation-candidates")) {
        return {
          status: 201,
          body: {
            upload: {
              uploadId: "01900000-0000-7000-8000-000000000505",
              partSizeBytes: 3,
              receivedParts: [],
            },
            ticket: { url: "/parts/{partNumber}" },
          },
        };
      }
      if (path.endsWith("/activate"))
        return {
          status: 200,
          body: { generationId: successor, generationNumber: 1, headCursor: 8 },
        };
      return { status: method === "PUT" ? 204 : 200, body: {} };
    });
    const commitLocal = vi.fn(async () => {
      order.push("LOCAL COMMIT");
    });
    const activator = new SynchronizedVacuumActivator(
      vaultId,
      0,
      7,
      {
        listStoredObjects: async () => [
          {
            version: 1,
            objectId: retained,
            objectType: "BundleDescriptor",
            envelopeBytes: new Uint8Array([9]),
          },
        ],
        listStoredEvents: async () => [],
      },
      { request, putTransfer: async () => undefined },
      commitLocal,
      {
        persistCandidate: async () => {
          order.push("PERSIST CANDIDATE");
        },
        markRemoteActivated: async () => {
          order.push("MARK REMOTE ACTIVATED");
        },
      },
    );

    await activator.activate({
      jobId: crypto.randomUUID(),
      objectIds: [],
      eventIds: [],
      eventsToAdd: [],
      bundleIds: [],
      expectedGenerationId: predecessor,
      generation: {
        version: 1,
        generationId: successor,
        generationNumber: 1,
        predecessorGenerationId: predecessor,
        envelopeBytes: generationEnvelope(successor),
      },
      head: {
        version: 1,
        vaultId,
        generationId: successor,
        generationNumber: 1,
        appendedObjectIds: [],
        appendedEventIds: [],
      },
      deletedArtifactObjectIds: [],
    });

    expect(order.findIndex((entry) => entry.endsWith("/activate"))).toBeLessThan(
      order.indexOf("LOCAL COMMIT"),
    );
    expect(order[0]).toBe("PERSIST CANDIDATE");
    expect(order.indexOf("MARK REMOTE ACTIVATED")).toBeGreaterThan(
      order.findIndex((entry) => entry.endsWith("/activate")),
    );
    expect(order.indexOf("MARK REMOTE ACTIVATED")).toBeLessThan(order.indexOf("LOCAL COMMIT"));
    expect(commitLocal).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGenerationId: predecessor }),
      8,
    );
  });

  for (const failurePoint of ["candidate", "seal", "activate"] as const) {
    it(`does not commit local authority when authentication expires at ${failurePoint}`, async () => {
      const vaultId = crypto.randomUUID();
      const predecessor = crypto.randomUUID();
      const successor = crypto.randomUUID();
      const authentication = Object.assign(new Error("expired"), {
        id: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED",
      });
      const commitLocal = vi.fn(async () => undefined);
      const markRemoteActivated = vi.fn(async () => undefined);
      const activator = new SynchronizedVacuumActivator(
        vaultId,
        0,
        7,
        { listStoredObjects: async () => [], listStoredEvents: async () => [] },
        {
          request: async (method, path) => {
            if (
              (failurePoint === "candidate" && path.endsWith("/generation-candidates")) ||
              (failurePoint === "seal" && path.endsWith("/seal")) ||
              (failurePoint === "activate" && path.endsWith("/activate"))
            )
              throw authentication;
            if (path.endsWith("/generation-candidates"))
              return {
                status: 201,
                body: {
                  upload: {
                    uploadId: crypto.randomUUID(),
                    partSizeBytes: 1024,
                    receivedParts: [],
                  },
                  ticket: { url: "/parts/{partNumber}" },
                },
              };
            if (path.endsWith("/activate"))
              return {
                status: 200,
                body: { generationId: successor, generationNumber: 1, headCursor: 8 },
              };
            return { status: method === "PUT" ? 204 : 200, body: {} };
          },
          putTransfer: async () => undefined,
        },
        commitLocal,
        {
          persistCandidate: async () => undefined,
          markRemoteActivated,
        },
      );

      await expect(
        activator.activate({
          jobId: crypto.randomUUID(),
          objectIds: [],
          eventIds: [],
          eventsToAdd: [],
          bundleIds: [],
          expectedGenerationId: predecessor,
          generation: {
            version: 1,
            generationId: successor,
            generationNumber: 1,
            predecessorGenerationId: predecessor,
            envelopeBytes: generationEnvelope(successor),
          },
          head: {
            version: 1,
            vaultId,
            generationId: successor,
            generationNumber: 1,
            appendedObjectIds: [],
            appendedEventIds: [],
          },
          deletedArtifactObjectIds: [],
        }),
      ).rejects.toBe(authentication);
      expect(markRemoteActivated).not.toHaveBeenCalled();
      expect(commitLocal).not.toHaveBeenCalled();
    });
  }
});

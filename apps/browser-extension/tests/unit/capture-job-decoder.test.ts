import { expect, it } from "vitest";
import { decodeCaptureJob } from "../../src/drivers/indexeddb/decode";

it("rejects fields outside the non-sensitive canonical Capture Job schema", () => {
  expect(() =>
    decodeCaptureJob({
      version: 1,
      vaultId: "00000000-0000-4000-8000-000000000010",
      jobId: "00000000-0000-4000-8000-000000000001",
      commandId: "00000000-0000-4000-8000-000000000002",
      tabId: 7,
      state: "Running",
      stage: "Snapshot",
      createdAt: "2026-07-16T17:00:00.000Z",
      updatedAt: "2026-07-16T17:00:01.000Z",
      url: "https://secret.test",
      pageBytes: new Uint8Array([1]),
    }),
  ).toThrowError(/canonical schema/u);
});

it("preserves the operational recent-capture dismissal flag", () => {
  expect(
    decodeCaptureJob({
      version: 1,
      vaultId: "00000000-0000-4000-8000-000000000010",
      jobId: "00000000-0000-4000-8000-000000000001",
      commandId: "00000000-0000-4000-8000-000000000002",
      tabId: 7,
      state: "Succeeded",
      stage: "Commit",
      createdAt: "2026-07-16T17:00:00.000Z",
      updatedAt: "2026-07-16T17:00:01.000Z",
      noticeDismissed: true,
    }),
  ).toMatchObject({ noticeDismissed: true });
});

it("rejects an unsupported format or missing Vault capture-job context", () => {
  const job = {
    version: 1,
    vaultId: "00000000-0000-4000-8000-000000000010",
    jobId: "00000000-0000-4000-8000-000000000001",
    commandId: "00000000-0000-4000-8000-000000000002",
    tabId: 7,
    state: "Created",
    stage: "Preflight",
    createdAt: "2026-07-16T17:00:00.000Z",
    updatedAt: "2026-07-16T17:00:00.000Z",
  };
  expect(() => decodeCaptureJob({ ...job, version: 99 })).toThrowError(/version/u);
  expect(() => decodeCaptureJob({ ...job, vaultId: undefined })).toThrowError(/vaultId/u);
});

import { describe, expect, it, vi } from "vitest";
import type { ServerSwitchJobV1 } from "../../src/drivers/indexeddb/schema";
import { ServerSwitchService } from "../../src/runtime/synchronization/server-switch";

const head = {
  version: 1 as const,
  vaultId: "01900000-0000-7000-8000-000000000001",
  generationId: "01900000-0000-7000-8000-000000000002",
  generationNumber: 3,
  appendedObjectIds: [],
  appendedEventIds: [],
};

function fixture(existing?: ServerSwitchJobV1) {
  let job = existing;
  const jobs = {
    loadJob: vi.fn(async () => job),
    saveJob: vi.fn(async (next: ServerSwitchJobV1) => {
      job = next;
    }),
    deleteJob: vi.fn(async (jobId: string) => {
      if (job?.jobId !== jobId) throw new Error("stale");
      job = undefined;
    }),
  };
  const accounts = {
    eraseAuthenticated: vi.fn(async () => undefined),
    hasAuthenticatedSecrets: vi.fn(async () => true),
    saveAuthenticated: vi.fn(async () => undefined),
  };
  const uuids = [
    "01900000-0000-7000-8000-000000000010",
    "01900000-0000-7000-8000-000000000011",
    "01900000-0000-7000-8000-000000000012",
  ];
  const service = new ServerSwitchService(
    jobs,
    accounts,
    () => "2026-07-20T00:00:00.000Z",
    () => uuids.shift() ?? "01900000-0000-7000-8000-000000000099",
  );
  return { service, jobs, accounts, current: () => job };
}

async function begun() {
  const value = fixture();
  await value.service.begin({
    sourceOrigin: "https://source.example",
    candidateOrigin: "https://candidate.example",
    candidateRegistration: { enabled: false },
    vaultId: head.vaultId,
    expectedLocalHead: head,
  });
  return value;
}

describe("ServerSwitchService lifecycle", () => {
  it("stages candidate authentication without changing source authority", async () => {
    const value = await begun();
    expect(value.accounts.eraseAuthenticated).toHaveBeenCalledWith("server-switch-candidate");
    expect(value.current()).toMatchObject({
      sourceOrigin: "https://source.example",
      candidateOrigin: "https://candidate.example",
      candidateRegistration: { enabled: false },
      state: "AuthenticationRequired",
      stage: "AuthenticateCandidate",
      expectedLocalHead: head,
      candidateAuthorityChanged: false,
    });
  });

  it("rejects the active origin and an inconsistent Vault fence", async () => {
    const value = fixture();
    await expect(
      value.service.begin({
        sourceOrigin: "https://source.example",
        candidateOrigin: "https://source.example",
        candidateRegistration: { enabled: false },
        vaultId: head.vaultId,
        expectedLocalHead: head,
      }),
    ).rejects.toMatchObject({ id: "SERVER_INCOMPATIBLE" });
    await expect(
      value.service.begin({
        sourceOrigin: "https://source.example",
        candidateOrigin: "https://candidate.example",
        candidateRegistration: { enabled: false },
        vaultId: "01900000-0000-7000-8000-000000000099",
        expectedLocalHead: head,
      }),
    ).rejects.toMatchObject({ id: "VAULT_CONTEXT_CHANGED" });
  });

  it("cancels only the matching read-only job and erases candidate credentials", async () => {
    const value = await begun();
    const jobId = value.current()?.jobId ?? "";
    await expect(
      value.service.cancel("01900000-0000-7000-8000-000000000099"),
    ).rejects.toMatchObject({ id: "VAULT_CONTEXT_CHANGED" });
    await value.service.cancel(jobId);
    expect(value.accounts.eraseAuthenticated).toHaveBeenCalledWith("server-switch-candidate");
    expect(value.current()).toBeUndefined();
  });

  it("forbids cancellation after the applying boundary", async () => {
    const value = await begun();
    const job = value.current();
    if (job === undefined) throw new Error("missing job");
    await value.jobs.saveJob({
      ...job,
      state: "Running",
      stage: "PrepareRemote",
      direction: "PublishLocal",
    });
    await expect(value.service.cancel(job.jobId)).rejects.toMatchObject({ id: "VAULT_BUSY" });
    expect(value.current()).toMatchObject({ stage: "PrepareRemote" });
  });

  it("retries a failure from authentication when candidate secrets are absent", async () => {
    const value = await begun();
    const job = value.current();
    if (job === undefined) throw new Error("missing job");
    value.accounts.hasAuthenticatedSecrets.mockResolvedValue(false);
    await value.jobs.saveJob({
      ...job,
      state: "Failed",
      stage: "Compare",
      errorId: "SERVER_INCOMPATIBLE",
    });
    await value.service.retry(job.jobId);
    expect(value.current()).toMatchObject({
      state: "AuthenticationRequired",
      stage: "AuthenticateCandidate",
      retryCount: 1,
    });
    expect(value.current()).not.toHaveProperty("errorId");
  });
});

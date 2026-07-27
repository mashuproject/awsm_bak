import { describe, expect, it } from "vitest";
import { isAppRequest } from "../../src/app/protocol";

describe("application request routing", () => {
  it("removes manual locking and accepts the MHTML download command", () => {
    expect(isAppRequest({ type: "LockVault", expectedVaultId: "vault-id" })).toBe(false);
    expect(
      isAppRequest({
        type: "DownloadMhtml",
        expectedVaultId: "vault-id",
        bundleId: "bundle-id",
      }),
    ).toBe(true);
  });

  it("does not claim offscreen operations or application-state notifications", () => {
    expect(isAppRequest({ type: "awsm:stitch-screenshot" })).toBe(false);
    expect(isAppRequest({ type: "AppStateChanged" })).toBe(false);
    expect(isAppRequest({ type: "GetState" })).toBe(true);
  });

  it("rejects superseded local passphrase requests", () => {
    expect(isAppRequest({ type: "UnlockPassphrase", passphrase: "not supported" })).toBe(false);
    expect(
      isAppRequest({
        type: "CreateVault",
        name: "Amber Archive",
        passphrase: "not supported",
      }),
    ).toBe(false);
  });

  it("accepts only the fieldless synchronization wake", () => {
    expect(isAppRequest({ type: "WakeSynchronization" })).toBe(true);
    expect(isAppRequest({ type: "WakeSynchronization", reason: "poll" })).toBe(false);
  });

  it("accepts only a strict unversioned synchronization-server detachment Command", () => {
    expect(
      isAppRequest({
        type: "StopUsingSynchronizationServer",
        expectedVaultId: "01900000-0000-7000-8000-000000000001",
      }),
    ).toBe(true);
    expect(isAppRequest({ type: "StopUsingSynchronizationServer" })).toBe(false);
    expect(
      isAppRequest({
        type: "StopUsingSynchronizationServer",
        expectedVaultId: "01900000-0000-7000-8000-000000000001",
        contactServer: true,
      }),
    ).toBe(false);
  });

  it("accepts only the fieldless local-device reset", () => {
    expect(isAppRequest({ type: "ResetLocalDevice" })).toBe(true);
    expect(isAppRequest({ type: "ResetLocalDevice", deleteServerData: true })).toBe(false);
  });

  it("routes only canonical Server Switch Commands and rejects the superseded change Command", () => {
    expect(
      isAppRequest({
        type: "BeginServerSwitch",
        candidateOrigin: "https://candidate.example.test",
        expectedVaultId: "vault",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "LoginServerSwitchCandidate",
        username: "reader_test",
        password: "secret",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "SignupServerSwitchCandidate",
        username: "reader_test",
        password: "secret",
      }),
    ).toBe(false);
    expect(isAppRequest({ type: "CancelServerSwitch", jobId: "job" })).toBe(true);
    expect(isAppRequest({ type: "RetryServerSwitch", jobId: "job" })).toBe(true);
    expect(
      isAppRequest({
        type: "ChangeSyncServer",
        serverOrigin: "https://candidate.example.test",
      }),
    ).toBe(false);
    expect(
      isAppRequest({
        type: "BeginServerSwitch",
        candidateOrigin: "https://candidate.example.test",
      }),
    ).toBe(false);
    expect(
      isAppRequest({
        type: "CancelServerSwitch",
        jobId: "job",
        candidateOrigin: "leak",
      }),
    ).toBe(false);
  });

  it("routes scoped Export and cancellation requests", () => {
    expect(
      isAppRequest({
        type: "ExportVault",
        expectedVaultId: "vault",
        passphrase: "secret",
      }),
    ).toBe(true);
    expect(isAppRequest({ type: "ExportVault", expectedVaultId: "vault" })).toBe(false);
    expect(
      isAppRequest({
        type: "CancelVaultExport",
        expectedVaultId: "vault",
        jobId: "job",
      }),
    ).toBe(true);
  });

  it("routes only explicit maximum-security replacement Commands", () => {
    expect(
      isAppRequest({
        type: "PrepareVaultReplacement",
        expectedVaultId: "vault",
        safelyStoredConfirmed: true,
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "PrepareVaultReplacement",
        expectedVaultId: "vault",
      }),
    ).toBe(false);
    expect(
      isAppRequest({
        type: "ConfirmVaultReplacement",
        replacementId: "replacement",
        recoveryPhrase: "twelve words",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "CancelVaultReplacement",
        replacementId: "replacement",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "RetryVaultReplacement",
        expectedVaultId: "vault",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "ConfirmVaultReplacement",
        replacementId: "replacement",
        recoveryPhrase: "twelve words",
        entropy: "must-not-cross-the-boundary",
      }),
    ).toBe(false);
  });

  it("requires an explicit stale Replica recovery decision", () => {
    expect(
      isAppRequest({
        type: "DiscardStaleReplica",
        expectedVaultId: "vault",
        exportDecision: "Exported",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "DiscardStaleReplica",
        expectedVaultId: "vault",
        exportDecision: "SkipConfirmed",
      }),
    ).toBe(true);
    expect(isAppRequest({ type: "DiscardStaleReplica", expectedVaultId: "vault" })).toBe(false);
  });

  it("routes only canonical Workspace-scoped Import requests", () => {
    expect(isAppRequest({ type: "BeginVaultImport", sourceByteLength: 42 })).toBe(true);
    expect(isAppRequest({ type: "BeginVaultImport", sourceByteLength: -1 })).toBe(false);
    expect(
      isAppRequest({
        type: "ReportVaultImportProgress",
        jobId: "job",
        acquiredBytes: 21,
      }),
    ).toBe(true);
    expect(isAppRequest({ type: "CompleteVaultImportStaging", jobId: "job" })).toBe(true);
    expect(isAppRequest({ type: "ImportVault", jobId: "job", passphrase: "secret" })).toBe(true);
    expect(isAppRequest({ type: "ImportVault", jobId: "job" })).toBe(false);
    expect(isAppRequest({ type: "CancelVaultImport", jobId: "job" })).toBe(true);
    expect(
      isAppRequest({
        type: "CancelVaultImport",
        jobId: "job",
        expectedVaultId: "not-applicable",
      }),
    ).toBe(false);
  });

  it("accepts only canonical Vault-scoped Artifact session requests", () => {
    expect(
      isAppRequest({
        type: "OpenArtifact",
        expectedVaultId: "vault",
        bundleId: "bundle",
        role: "CONTENT_STRUCTURED",
      }),
    ).toBe(true);
    expect(
      isAppRequest({
        type: "OpenArtifact",
        expectedVaultId: "vault",
        bundleId: "bundle",
        role: "ARBITRARY_FILE",
      }),
    ).toBe(false);
    expect(
      isAppRequest({
        type: "ReadArtifactChunk",
        expectedVaultId: "vault",
        sessionId: "session",
      }),
    ).toBe(true);
    expect(isAppRequest({ type: "ReadArtifactChunk", expectedVaultId: "vault" })).toBe(false);
  });
});

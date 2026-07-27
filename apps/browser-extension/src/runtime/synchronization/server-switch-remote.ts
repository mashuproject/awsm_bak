import type {
  ServerSwitchCheckpointV1,
  ServerSwitchJobV1,
  StoredAccountVaultV1,
  SynchronizationCheckpointV1,
  SynchronizationJobV1,
} from "../../drivers/indexeddb/schema";
import { bytesToBase64Url } from "../account/wire";
import type { ArtifactStore } from "../artifact";
import { noRuntimeFaultCheckpoint, type RuntimeFaultCheckpoint } from "../fault-checkpoint";
import type { VaultRecordsV1 } from "../vault/contracts";
import { UploadRunner } from "./upload";

export interface ServerSwitchRelayFaults {
  readonly beforeSourceArtifactRead?: () => Promise<void>;
  readonly afterCandidateUploadPart?: () => Promise<void>;
}

interface SwitchState {
  loadJob(): Promise<ServerSwitchJobV1 | undefined>;
  saveJob(job: ServerSwitchJobV1): Promise<void>;
  loadCheckpoint(
    jobId: string,
    kind: ServerSwitchCheckpointV1["kind"],
    entityId: string,
  ): Promise<ServerSwitchCheckpointV1 | undefined>;
  saveCheckpoint(checkpoint: ServerSwitchCheckpointV1): Promise<void>;
}

interface SwitchAccount {
  loadAccountVault(scope: "server-switch-candidate"): Promise<StoredAccountVaultV1 | undefined>;
  saveAccountVault(
    registration: StoredAccountVaultV1,
    scope: "server-switch-candidate",
  ): Promise<void>;
}

interface SwitchSource {
  getVaultHead(): ReturnType<ConstructorParameters<typeof UploadRunner>[1]["getVaultHead"]>;
  listStoredObjects(): ReturnType<
    ConstructorParameters<typeof UploadRunner>[1]["listStoredObjects"]
  >;
  listStoredEvents(): ReturnType<ConstructorParameters<typeof UploadRunner>[1]["listStoredEvents"]>;
}

interface SwitchTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }>;
  putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void>;
  useAccessToken?(accessToken: string): void;
}

export interface ServerSwitchAttachmentAuthority {
  readonly recoveryGeneration: unknown;
  readonly keyEpochs: readonly {
    readonly keyEpochId: string;
    readonly ordinal: number;
    readonly activatedAt: string;
  }[];
  readonly activeKeyEpochId: string;
  readonly deviceCertificate: unknown;
  readonly deviceKeyEnvelopes: readonly unknown[];
  readonly deviceProofSignature: string;
  readonly acceptDeviceSession?: (session: unknown) => Promise<void>;
}

function integrity(message: string): Error {
  return Object.assign(new Error(message), { id: "SYNCHRONIZATION_INTEGRITY_FAILED" });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw integrity(`${field} is invalid`);
  return value as Record<string, unknown>;
}

async function checksum(bytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
  );
}

async function derivedIdempotencyKey(namespace: string, label: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${label}`)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ServerSwitchRemoteApplicator {
  constructor(
    private readonly state: SwitchState,
    private readonly accounts: SwitchAccount,
    private readonly source: SwitchSource,
    private readonly artifacts: Pick<ArtifactStore, "openEncrypted">,
    private readonly transport: SwitchTransport,
    private readonly faultCheckpoint: RuntimeFaultCheckpoint = noRuntimeFaultCheckpoint,
    private readonly relayFaults?: ServerSwitchRelayFaults,
    private readonly attachmentAuthority?: (
      vaultId: string,
      activeKeyEpochId: string,
      firstEpochActivatedAt: string,
    ) => Promise<ServerSwitchAttachmentAuthority>,
  ) {}

  async publishLocal(records: VaultRecordsV1, now = new Date().toISOString()): Promise<void> {
    const loaded = await this.state.loadJob();
    if (
      loaded?.state !== "Running" ||
      loaded.stage !== "PrepareRemote" ||
      loaded.direction !== "PublishLocal" ||
      loaded.vaultId !== records.metadata.vaultId ||
      loaded.expectedLocalHead.generationId !== records.head.generationId
    )
      throw integrity("Publish-local Server Switch context is incomplete");
    let job: ServerSwitchJobV1 = loaded;
    const registration = await this.accounts.loadAccountVault("server-switch-candidate");
    if (registration?.vaultId !== job.vaultId || registration.activeKeyEpochId === undefined)
      throw integrity("Candidate registration is missing");
    await this.attachGeneration(job, registration, records);

    job = await this.transferClosure(job, registration, records, async (current) => {
      await this.transport.request(
        "POST",
        `/api/vaults/${current.vaultId}/complete`,
        { generationId: records.head.generationId },
        current.candidateIdempotencyKey,
      );
      const activated: ServerSwitchJobV1 = {
        ...current,
        stage: "ActivateRemote",
        candidateAuthorityChanged: true,
        updatedAt: now,
      };
      await this.state.saveJob(activated);
      await this.faultCheckpoint.reach("server-switch:after-remote-activation");
      return activated;
    });
    await this.state.saveJob({ ...job, stage: "PromoteContext", updatedAt: now });
  }

  async fastForwardCandidate(
    records: VaultRecordsV1,
    now = new Date().toISOString(),
  ): Promise<void> {
    const loaded = await this.state.loadJob();
    if (
      loaded?.state !== "Running" ||
      loaded.stage !== "PrepareRemote" ||
      loaded.direction !== "FastForwardCandidate" ||
      loaded.candidateGenerationId === undefined ||
      loaded.candidateGenerationNumber === undefined ||
      loaded.candidateHeadCursor === undefined ||
      records.generation.predecessorGenerationId !== loaded.candidateGenerationId ||
      records.generation.generationNumber !== loaded.candidateGenerationNumber + 1 ||
      loaded.expectedLocalHead.generationId !== records.head.generationId
    )
      throw integrity("Candidate fast-forward context is incomplete");
    let job: ServerSwitchJobV1 = loaded;
    const predecessorGenerationId = loaded.candidateGenerationId;
    const predecessorGenerationNumber = loaded.candidateGenerationNumber;
    const predecessorHeadCursor = loaded.candidateHeadCursor;
    const loadedRegistration = await this.accounts.loadAccountVault("server-switch-candidate");
    if (
      loadedRegistration?.vaultId !== job.vaultId ||
      loadedRegistration.remoteGenerationId !== predecessorGenerationId ||
      loadedRegistration.remoteGenerationNumber !== predecessorGenerationNumber ||
      loadedRegistration.deliveryCursor !== predecessorHeadCursor
    )
      throw integrity("Candidate fast-forward registration changed");
    let registration: StoredAccountVaultV1 = loadedRegistration;
    await this.createGenerationCandidate(job, records);
    job = await this.transferClosure(
      job,
      registration,
      records,
      async (current) => {
        const [objects, events] = await Promise.all([
          this.source.listStoredObjects(),
          this.source.listStoredEvents(),
        ]);
        const retainedIds = [
          ...objects.map((entry) => entry.objectId),
          ...events.map((entry) => entry.eventId),
        ].toSorted();
        if (new Set(retainedIds).size !== retainedIds.length)
          throw integrity("Successor retained closure contains duplicate IDs");
        const pageSize = 1_000;
        const pageCount = Math.ceil(retainedIds.length / pageSize);
        for (let page = 0; page < pageCount; page += 1)
          await this.transport.request(
            "PUT",
            `/api/vaults/${current.vaultId}/generation-candidates/${records.generation.generationId}/retained-pages/${page}`,
            { recordIds: retainedIds.slice(page * pageSize, (page + 1) * pageSize) },
            await derivedIdempotencyKey(current.candidateIdempotencyKey, `retained:${page}`),
          );
        await this.transport.request(
          "POST",
          `/api/vaults/${current.vaultId}/generation-candidates/${records.generation.generationId}/seal`,
          {
            pageCount,
            recordCount: retainedIds.length,
            sha256: await checksum(
              new TextEncoder().encode(retainedIds.map((id) => `${id}\n`).join("")),
            ),
          },
          await derivedIdempotencyKey(current.candidateIdempotencyKey, "seal"),
        );
        const activated = record(
          (
            await this.transport.request(
              "POST",
              `/api/vaults/${current.vaultId}/generation-candidates/${records.generation.generationId}/activate`,
              {
                predecessorGenerationId,
                predecessorGenerationNumber,
                headCursor: predecessorHeadCursor,
              },
              await derivedIdempotencyKey(current.candidateIdempotencyKey, "activate"),
            )
          ).body,
          "Activated candidate Generation",
        );
        if (
          activated.generationId !== records.generation.generationId ||
          activated.generationNumber !== records.generation.generationNumber ||
          activated.headCursor !== predecessorHeadCursor + 1
        )
          throw integrity("Activated candidate Generation head is invalid");
        registration = {
          ...registration,
          remoteGenerationId: records.generation.generationId,
          remoteGenerationNumber: records.generation.generationNumber,
          deliveryCursor: activated.headCursor,
        };
        await this.accounts.saveAccountVault(registration, "server-switch-candidate");
        const next: ServerSwitchJobV1 = {
          ...current,
          stage: "ActivateRemote",
          candidateGenerationId: records.generation.generationId,
          candidateGenerationNumber: records.generation.generationNumber,
          candidateHeadCursor: activated.headCursor,
          candidateAuthorityChanged: true,
          updatedAt: now,
        };
        await this.state.saveJob(next);
        await this.faultCheckpoint.reach("server-switch:after-remote-activation");
        return next;
      },
      false,
    );
    await this.state.saveJob({ ...job, stage: "PromoteContext", updatedAt: now });
  }

  async union(records: VaultRecordsV1, now = new Date().toISOString()): Promise<void> {
    const loaded = await this.state.loadJob();
    if (
      loaded?.state !== "Running" ||
      loaded.stage !== "PrepareRemote" ||
      loaded.direction !== "Union" ||
      loaded.candidateGenerationId !== records.head.generationId ||
      loaded.candidateGenerationNumber !== records.head.generationNumber ||
      loaded.candidateHeadCursor === undefined ||
      loaded.expectedLocalHead.generationId !== records.head.generationId
    )
      throw integrity("Union Server Switch context is incomplete");
    let registration = await this.accounts.loadAccountVault("server-switch-candidate");
    if (
      registration?.vaultId !== loaded.vaultId ||
      registration.remoteGenerationId !== loaded.candidateGenerationId ||
      registration.deliveryCursor !== loaded.candidateHeadCursor
    )
      throw integrity("Union candidate registration changed");
    let job = await this.transferClosure(loaded, registration, records, async (current) => current);
    const listed = record((await this.transport.request("GET", "/api/vaults")).body, "Vault list");
    if (!Array.isArray(listed.vaults) || listed.vaults.length !== 1)
      throw integrity("Union candidate Vault disappeared");
    const remote = record(listed.vaults[0], "Union candidate Vault");
    if (remote.vaultId !== loaded.vaultId) throw integrity("Union candidate Vault changed");
    if (
      remote.generationId !== records.head.generationId ||
      remote.generationNumber !== records.head.generationNumber
    )
      throw Object.assign(new Error("Union candidate Generation changed"), {
        id: "VAULT_GENERATION_SUPERSEDED",
      });
    if (
      typeof remote.headCursor !== "number" ||
      !Number.isSafeInteger(remote.headCursor) ||
      remote.headCursor < loaded.candidateHeadCursor
    )
      throw integrity("Union candidate cursor regressed");
    registration = { ...registration, deliveryCursor: remote.headCursor };
    await this.accounts.saveAccountVault(registration, "server-switch-candidate");
    job = {
      ...job,
      stage: "PrepareLocal",
      candidateHeadCursor: remote.headCursor,
      candidateAuthorityChanged: remote.headCursor > loaded.candidateHeadCursor,
      updatedAt: now,
    };
    await this.state.saveJob(job);
  }

  private async transferClosure(
    initialJob: ServerSwitchJobV1,
    registration: StoredAccountVaultV1,
    records: VaultRecordsV1,
    activate: (job: ServerSwitchJobV1) => Promise<ServerSwitchJobV1>,
    commitEvents = true,
  ): Promise<ServerSwitchJobV1> {
    let job = initialJob;
    let uploadStage: SynchronizationJobV1["stage"] = "UploadObjects";
    const uploadSource =
      initialJob.direction === "Union"
        ? this.source
        : {
            listStoredObjects: () => this.source.listStoredObjects(),
            listStoredEvents: () => this.source.listStoredEvents(),
            getVaultHead: async () => {
              const [head, objects, events] = await Promise.all([
                this.source.getVaultHead(),
                this.source.listStoredObjects(),
                this.source.listStoredEvents(),
              ]);
              if (head === undefined) return undefined;
              return {
                appendedObjectIds: objects.map((entry) => entry.objectId).toSorted(),
                appendedEventIds: events.map((entry) => entry.eventId).toSorted(),
              };
            },
          };
    const adapter = {
      latestSynchronizationJob: async (): Promise<SynchronizationJobV1> => ({
        version: 1,
        jobId: job.jobId,
        accountId: registration.accountId,
        vaultId: job.vaultId,
        generationId: records.head.generationId,
        generationNumber: records.head.generationNumber,
        state: "Running",
        stage: uploadStage,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        snapshotCursor: 0,
        completedItems: job.completedItems,
        totalItems: job.totalItems,
        processedBytes: job.processedBytes,
        totalBytes: job.totalBytes,
        retryCount: job.retryCount,
        attachIdempotencyKey: job.attachIdempotencyKey,
      }),
      saveSynchronizationJob: async (value: SynchronizationJobV1): Promise<void> => {
        uploadStage = value.stage;
        job = {
          ...job,
          completedItems: value.completedItems,
          processedBytes: value.processedBytes,
          updatedAt: value.updatedAt,
        };
        await this.state.saveJob(job);
      },
      synchronizationCheckpoint: async (
        _vaultId: string,
        kind: "Object" | "Event",
        entityId: string,
      ): Promise<SynchronizationCheckpointV1 | undefined> => {
        const checkpoint = await this.state.loadCheckpoint(job.jobId, kind, entityId);
        return checkpoint === undefined ? undefined : { ...checkpoint, vaultId: job.vaultId, kind };
      },
      saveSynchronizationCheckpoint: async (
        checkpoint: SynchronizationCheckpointV1,
      ): Promise<void> => {
        const { vaultId: _vaultId, ...scoped } = checkpoint;
        await this.state.saveCheckpoint({ ...scoped, jobId: job.jobId });
      },
    };
    await new UploadRunner(
      adapter,
      uploadSource,
      this.artifacts,
      this.transport,
      async () => {
        job = await activate(job);
      },
      commitEvents,
      async (body) => {
        if (initialJob.direction !== "Union") return;
        const committed = record(body, "Committed candidate Event");
        if (
          typeof committed.cursor !== "number" ||
          !Number.isSafeInteger(committed.cursor) ||
          initialJob.candidateHeadCursor === undefined ||
          committed.cursor < initialJob.candidateHeadCursor
        )
          throw integrity("Committed candidate Event cursor is invalid");
        if (committed.cursor > initialJob.candidateHeadCursor && !job.candidateAuthorityChanged) {
          job = { ...job, candidateAuthorityChanged: true, updatedAt: new Date().toISOString() };
          await this.state.saveJob(job);
          await this.faultCheckpoint.reach("server-switch:after-first-union-event");
        }
      },
      undefined,
      {
        ...(this.relayFaults?.beforeSourceArtifactRead === undefined
          ? {}
          : { beforeArtifactRead: this.relayFaults.beforeSourceArtifactRead }),
        ...(this.relayFaults?.afterCandidateUploadPart === undefined
          ? {}
          : { afterUploadPart: this.relayFaults.afterCandidateUploadPart }),
      },
    ).run(initialJob.updatedAt);
    return job;
  }

  private async createGenerationCandidate(
    job: ServerSwitchJobV1,
    records: VaultRecordsV1,
  ): Promise<void> {
    const registration = await this.accounts.loadAccountVault("server-switch-candidate");
    if (
      registration?.activeKeyEpochId === undefined ||
      job.candidateGenerationId === undefined ||
      job.candidateGenerationNumber === undefined ||
      job.candidateHeadCursor === undefined
    )
      throw integrity("Candidate predecessor fence is missing");
    const generation = records.generation;
    let checkpoint = await this.state.loadCheckpoint(
      job.jobId,
      "Generation",
      generation.generationId,
    );
    if (checkpoint?.state === "Durable" || checkpoint?.state === "Committed") return;
    checkpoint ??= {
      version: 1,
      jobId: job.jobId,
      kind: "Generation",
      entityId: generation.generationId,
      state: "Prepared",
      createIdempotencyKey: job.candidateIdempotencyKey,
      completeIdempotencyKey: await derivedIdempotencyKey(
        job.candidateIdempotencyKey,
        "generation-upload-complete",
      ),
      receivedParts: [],
    };
    await this.state.saveCheckpoint(checkpoint);
    const created = record(
      (
        await this.transport.request(
          "POST",
          `/api/vaults/${job.vaultId}/generation-candidates`,
          {
            generationId: generation.generationId,
            generationNumber: generation.generationNumber,
            predecessorGenerationId: job.candidateGenerationId,
            headCursor: job.candidateHeadCursor,
            generationObject: {
              objectId: generation.generationId,
              objectType: "VaultGeneration",
              keyEpochId: registration.activeKeyEpochId,
              byteLength: generation.envelopeBytes.byteLength,
              sha256: await checksum(generation.envelopeBytes),
            },
          },
          checkpoint.createIdempotencyKey,
        )
      ).body,
      "Generation candidate",
    );
    const upload = record(created.upload, "Generation candidate upload");
    const ticket = record(created.ticket, "Generation candidate ticket");
    if (
      typeof upload.uploadId !== "string" ||
      typeof upload.partSizeBytes !== "number" ||
      !Number.isSafeInteger(upload.partSizeBytes) ||
      upload.partSizeBytes <= 0 ||
      !Array.isArray(upload.receivedParts) ||
      typeof ticket.url !== "string"
    )
      throw integrity("Generation candidate transfer is invalid");
    checkpoint = {
      ...checkpoint,
      state: "Uploading",
      uploadId: upload.uploadId,
      receivedParts: upload.receivedParts.map(Number).toSorted((left, right) => left - right),
    };
    await this.state.saveCheckpoint(checkpoint);
    for (
      let part = 0;
      part * upload.partSizeBytes < generation.envelopeBytes.byteLength;
      part += 1
    ) {
      if (checkpoint.receivedParts.includes(part)) continue;
      const first = part * upload.partSizeBytes;
      await this.transport.putTransfer(
        ticket.url,
        part,
        generation.envelopeBytes.subarray(
          first,
          Math.min(first + upload.partSizeBytes, generation.envelopeBytes.byteLength),
        ),
      );
    }
    await this.transport.request(
      "POST",
      `/api/vaults/${job.vaultId}/uploads/${upload.uploadId}/complete`,
      undefined,
      checkpoint.completeIdempotencyKey,
    );
    await this.state.saveCheckpoint({ ...checkpoint, state: "Durable" });
  }

  private async attachGeneration(
    job: ServerSwitchJobV1,
    registration: StoredAccountVaultV1,
    records: VaultRecordsV1,
  ): Promise<void> {
    const generation = records.generation;
    let checkpoint = await this.state.loadCheckpoint(
      job.jobId,
      "Generation",
      generation.generationId,
    );
    if (checkpoint?.state === "Durable" || checkpoint?.state === "Committed") return;
    checkpoint ??= {
      version: 1,
      jobId: job.jobId,
      kind: "Generation",
      entityId: generation.generationId,
      state: "Prepared",
      createIdempotencyKey: job.attachIdempotencyKey,
      completeIdempotencyKey: crypto.randomUUID(),
      receivedParts: [],
    };
    await this.state.saveCheckpoint(checkpoint);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(generation.envelopeBytes)),
    );
    const activeKeyEpochId = registration.activeKeyEpochId;
    if (activeKeyEpochId === undefined) throw integrity("Candidate Key Epoch is missing");
    const authority = await this.attachmentAuthority?.(
      job.vaultId,
      activeKeyEpochId,
      records.metadata.createdAt,
    );
    if (authority === undefined) throw integrity("Vault attachment authority is missing");
    const attached = record(
      (
        await this.transport.request(
          "POST",
          "/api/vaults",
          {
            vaultId: job.vaultId,
            generationId: generation.generationId,
            generationNumber: generation.generationNumber,
            keyEpochs: authority.keyEpochs,
            activeKeyEpochId: authority.activeKeyEpochId,
            recoveryGeneration: authority.recoveryGeneration,
            deviceCertificate: authority.deviceCertificate,
            deviceKeyEnvelopes: authority.deviceKeyEnvelopes,
            deviceProofSignature: authority.deviceProofSignature,
            generationObject: {
              objectId: generation.generationId,
              objectType: "VaultGeneration",
              keyEpochId: registration.activeKeyEpochId,
              byteLength: generation.envelopeBytes.byteLength,
              sha256: bytesToBase64Url(digest),
            },
          },
          checkpoint.createIdempotencyKey,
        )
      ).body,
      "Vault attachment",
    );
    const upload = record(attached.upload, "Vault attachment upload");
    const ticket = record(attached.ticket, "Vault attachment ticket");
    const session = record(attached.session, "Vault attachment session");
    if (typeof session.accessToken !== "string")
      throw integrity("Vault attachment Device session is invalid");
    this.transport.useAccessToken?.(session.accessToken);
    await authority.acceptDeviceSession?.(session);
    if (
      typeof upload.uploadId !== "string" ||
      typeof upload.partSizeBytes !== "number" ||
      !Number.isSafeInteger(upload.partSizeBytes) ||
      upload.partSizeBytes <= 0 ||
      !Array.isArray(upload.receivedParts) ||
      typeof ticket.url !== "string"
    )
      throw integrity("Vault attachment transfer is invalid");
    checkpoint = {
      ...checkpoint,
      state: "Uploading",
      uploadId: upload.uploadId,
      receivedParts: upload.receivedParts.map(Number).toSorted((left, right) => left - right),
    };
    await this.state.saveCheckpoint(checkpoint);
    for (
      let part = 0;
      part * upload.partSizeBytes < generation.envelopeBytes.byteLength;
      part += 1
    ) {
      if (checkpoint.receivedParts.includes(part)) continue;
      const first = part * upload.partSizeBytes;
      await this.transport.putTransfer(
        ticket.url,
        part,
        generation.envelopeBytes.subarray(
          first,
          Math.min(first + upload.partSizeBytes, generation.envelopeBytes.byteLength),
        ),
      );
    }
    await this.transport.request(
      "POST",
      `/api/vaults/${job.vaultId}/uploads/${upload.uploadId}/complete`,
      undefined,
      checkpoint.completeIdempotencyKey,
    );
    await this.state.saveCheckpoint({ ...checkpoint, state: "Durable" });
  }
}

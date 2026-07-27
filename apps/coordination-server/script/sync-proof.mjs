import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createInitialVaultAuthority } from "./plan15-proof-authority.mjs";

const baseUrl = process.env.AWSM_PROOF_BASE_URL;
const cableUrl = process.env.AWSM_PROOF_CABLE_URL;
assert(baseUrl, "AWSM_PROOF_BASE_URL is required");
assert(cableUrl, "AWSM_PROOF_CABLE_URL is required");
let credential;
let activeKeyEpochId;
let requestSequence = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("base64url");
}

function encryptArtifact(plaintext, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptArtifact(wrapper, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, wrapper.subarray(0, 12));
  decipher.setAuthTag(wrapper.subarray(12, 28));
  return Buffer.concat([decipher.update(wrapper.subarray(28)), decipher.final()]);
}

function requestId() {
  requestSequence += 1;
  return randomUUID();
}

async function control(method, path, body, { idempotencyKey, expected = [200] } = {}) {
  const headers = {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": requestId(),
  };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return { response, payload };
}

async function putPart(url, partNumber, bytes) {
  const response = await fetch(`${baseUrl}${url.replace("{partNumber}", String(partNumber))}`, {
    method: "PUT",
    headers: {
      "Awsm-Protocol-Version": "1",
      "Awsm-Request-ID": requestId(),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-SHA256": sha256(bytes),
    },
    body: bytes,
  });
  assert.equal(response.status, 204);
}

async function beginUpload(vaultId, generationId, objectId, objectType, bytes, eventMetadata) {
  const body = {
    objectId,
    objectType,
    keyEpochId: activeKeyEpochId,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    targetGenerationId: generationId,
    ...(eventMetadata ? { eventMetadata } : {}),
  };
  const { payload } = await control("POST", `/api/vaults/${vaultId}/uploads`, body, {
    idempotencyKey: randomUUID(),
    expected: [201],
  });
  return { ...payload, bytes };
}

async function finishUpload(vaultId, started, startAt = 0) {
  const { upload, ticket, bytes } = started;
  for (let part = startAt; part < upload.partCount; part += 1) {
    const first = part * upload.partSizeBytes;
    const last = Math.min(first + upload.partSizeBytes, bytes.byteLength);
    await putPart(ticket.url, part, bytes.subarray(first, last));
  }
  const { payload } = await control(
    "POST",
    `/api/vaults/${vaultId}/uploads/${upload.uploadId}/complete`,
    undefined,
    { idempotencyKey: randomUUID() },
  );
  assert.equal(payload.state, "DurableUncommitted");
  return payload;
}

async function openCable(vaultId) {
  const issued = await control("POST", "/api/cable-tickets", undefined, {
    expected: [201],
  });
  const socketUrl = `${cableUrl}?ticket=${encodeURIComponent(issued.payload.ticket)}`;
  const socket = new WebSocket(socketUrl, ["actioncable-v1-json", "actioncable-unsupported"]);
  const messages = [];
  let confirmedResolve;
  const confirmed = new Promise((resolve) => (confirmedResolve = resolve));
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    if (frame.type === "welcome") {
      socket.send(
        JSON.stringify({
          command: "subscribe",
          identifier: JSON.stringify({
            channel: "VaultChangesChannel",
            vaultId,
          }),
        }),
      );
    } else if (frame.type === "confirm_subscription") {
      confirmedResolve();
    } else if (frame.message) {
      messages.push(frame.message);
    }
  });
  await Promise.race([
    confirmed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cable subscription timeout")), 10_000),
    ),
  ]);
  return { socket, messages, ticket: issued.payload.ticket };
}

async function expectCableReplayRejected(rawTicket) {
  const socket = new WebSocket(`${cableUrl}?ticket=${encodeURIComponent(rawTicket)}`, [
    "actioncable-v1-json",
    "actioncable-unsupported",
  ]);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type === "welcome") {
          reject(new Error("Consumed Cable ticket was accepted again"));
        }
      });
      socket.addEventListener("close", resolve);
      socket.addEventListener("error", resolve);
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Cable replay rejection timeout")), 10_000),
    ),
  ]);
}

async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const username = `proof_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
const password = `coordination proof ${randomUUID()}`;
const signupResponse = await fetch(`${baseUrl}/sign_up`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    "account[username]": username,
    "account[password]": password,
    "account[password_confirmation]": password,
  }),
  redirect: "manual",
});
assert.equal(signupResponse.status, 302);
const signup = await control("POST", "/api/sessions", { username, password });
credential = signup.payload.accessToken;
const refreshed = await control(
  "POST",
  "/api/session/refresh",
  { refreshToken: signup.payload.refreshToken },
  { expected: [200] },
);
credential = refreshed.payload.accessToken;
await control("DELETE", "/api/session", undefined, { expected: [204] });
credential = undefined;
const login = await control("POST", "/api/sessions", { username, password }, { expected: [200] });
credential = login.payload.accessToken;

const policy = (await control("GET", "/api/service-policy")).payload;
assert.equal(policy.recoveryRetentionDays, 90);
assert.equal(policy.uploadPartSizeBytes, 8_388_608);

const generationZeroBytes = Buffer.from("opaque-generation-zero");
const authority = createInitialVaultAuthority(login.payload.sessionId, generationZeroBytes);
const { vaultId, generationId: generationZeroId, keyEpochId } = authority;
activeKeyEpochId = keyEpochId;
const attachKey = randomUUID();
const attached = (
  await control("POST", "/api/vaults", authority.body, {
    idempotencyKey: attachKey,
    expected: [201],
  })
).payload;
credential = attached.session.accessToken;
await putPart(attached.ticket.url, 0, generationZeroBytes);
await control(
  "POST",
  `/api/vaults/${vaultId}/uploads/${attached.upload.uploadId}/complete`,
  undefined,
  {
    idempotencyKey: randomUUID(),
  },
);

const replicaTwo = await openCable(vaultId);
await expectCableReplayRejected(replicaTwo.ticket);
await control(
  "POST",
  `/api/vaults/${vaultId}/complete`,
  { generationId: generationZeroId },
  {
    idempotencyKey: randomUUID(),
  },
);
await waitFor(
  () => replicaTwo.messages.find((message) => message.latestCursor === 1),
  "initial Cable hint",
);

const artifactId = randomUUID();
const artifactPlaintext = Buffer.alloc(policy.uploadPartSizeBytes + 17, 0x5a);
const artifactKey = randomBytes(32);
const artifactBytes = encryptArtifact(artifactPlaintext, artifactKey);
const replicaOneLocalArtifacts = new Map([[artifactId, artifactBytes]]);
const replicaOneRemoteOnlyArtifacts = new Set();
const artifact = await beginUpload(
  vaultId,
  generationZeroId,
  artifactId,
  "Artifact",
  artifactBytes,
);
await putPart(artifact.ticket.url, 0, artifactBytes.subarray(0, artifact.upload.partSizeBytes));
const resumed = (await control("GET", `/api/vaults/${vaultId}/uploads/${artifact.upload.uploadId}`))
  .payload;
assert.deepEqual(resumed.receivedParts, [0]);
await finishUpload(vaultId, artifact, 1);

const descriptorId = randomUUID();
const descriptor = await beginUpload(
  vaultId,
  generationZeroId,
  descriptorId,
  "BundleDescriptor",
  Buffer.from("opaque-descriptor"),
);
const eventId = randomUUID();
const dependencies = [artifactId, descriptorId].sort();
const event = await beginUpload(
  vaultId,
  generationZeroId,
  eventId,
  "Event",
  Buffer.from("opaque-event"),
  {
    orderingTimestamp: "2026-01-01T00:00:00.000Z",
    dependencyObjectIds: dependencies,
  },
);
await finishUpload(vaultId, event);
const commitBody = {
  generationId: generationZeroId,
  generationNumber: 0,
  eventObjectId: eventId,
  dependencyObjectIds: dependencies,
};
await control("POST", `/api/vaults/${vaultId}/commits`, commitBody, {
  idempotencyKey: randomUUID(),
  expected: [409],
}).then(({ payload }) => assert.equal(payload.outcome, "OBJECT_NOT_DURABLE"));
await finishUpload(vaultId, descriptor);
const commitKey = randomUUID();
const committed = (
  await control("POST", `/api/vaults/${vaultId}/commits`, commitBody, {
    idempotencyKey: commitKey,
  })
).payload;
assert.equal(committed.cursor, 2);
assert.equal(
  (
    await control("POST", `/api/vaults/${vaultId}/commits`, commitBody, {
      idempotencyKey: commitKey,
    })
  ).payload.cursor,
  2,
);
await waitFor(
  () => replicaTwo.messages.find((message) => message.latestCursor === 2),
  "commit Cable hint",
);

const changes = (await control("GET", `/api/vaults/${vaultId}/changes?after=0&limit=100`)).payload;
assert.equal(changes.snapshotCursor, 2);
const activeBefore = (await control("GET", `/api/vaults/${vaultId}/records?limit=100`)).payload;
assert(activeBefore.records.some((record) => record.objectId === eventId));
const durableArtifact = activeBefore.records.find((record) => record.objectId === artifactId);
const durableEvent = activeBefore.records.find((record) => record.objectId === eventId);
assert.deepEqual(
  {
    objectType: durableArtifact?.objectType,
    byteLength: durableArtifact?.byteLength,
    sha256: durableArtifact?.sha256,
  },
  {
    objectType: "Artifact",
    byteLength: artifactBytes.byteLength,
    sha256: sha256(artifactBytes),
  },
);
assert.deepEqual(durableEvent?.dependencyObjectIds, dependencies);
replicaOneLocalArtifacts.delete(artifactId);
replicaOneRemoteOnlyArtifacts.add(artifactId);
assert.equal(replicaOneLocalArtifacts.has(artifactId), false);
assert.equal(replicaOneRemoteOnlyArtifacts.has(artifactId), true);
const download = (
  await control("POST", `/api/vaults/${vaultId}/records/${artifactId}/downloads`, undefined, {
    idempotencyKey: randomUUID(),
  })
).payload;
const midpoint = Math.floor(artifactBytes.byteLength / 2);
const firstRange = await fetch(`${baseUrl}${download.ticket.url}`, {
  headers: {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": requestId(),
    Range: `bytes=0-${midpoint - 1}`,
  },
});
const secondRange = await fetch(`${baseUrl}${download.ticket.url}`, {
  headers: {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": requestId(),
    Range: `bytes=${midpoint}-`,
  },
});
const rebuilt = Buffer.concat([
  Buffer.from(await firstRange.arrayBuffer()),
  Buffer.from(await secondRange.arrayBuffer()),
]);
assert.equal(sha256(rebuilt), sha256(artifactBytes));
assert.deepEqual(decryptArtifact(rebuilt, artifactKey), artifactPlaintext);
replicaOneLocalArtifacts.set(artifactId, rebuilt);
replicaOneRemoteOnlyArtifacts.delete(artifactId);
assert.equal(replicaOneLocalArtifacts.has(artifactId), true);
assert.equal(replicaOneRemoteOnlyArtifacts.has(artifactId), false);

const staleSuccessorId = randomUUID();
const staleGenerationBytes = Buffer.from("stale-successor");
const staleCandidate = (
  await control(
    "POST",
    `/api/vaults/${vaultId}/generation-candidates`,
    {
      generationId: staleSuccessorId,
      generationNumber: 1,
      predecessorGenerationId: generationZeroId,
      headCursor: 2,
      generationObject: {
        objectId: staleSuccessorId,
        objectType: "VaultGeneration",
        keyEpochId: activeKeyEpochId,
        byteLength: staleGenerationBytes.byteLength,
        sha256: sha256(staleGenerationBytes),
      },
    },
    { idempotencyKey: randomUUID(), expected: [201] },
  )
).payload;
await putPart(staleCandidate.ticket.url, 0, staleGenerationBytes);
await control(
  "POST",
  `/api/vaults/${vaultId}/uploads/${staleCandidate.upload.uploadId}/complete`,
  undefined,
  { idempotencyKey: randomUUID() },
);

const lateEventId = randomUUID();
const lateEvent = await beginUpload(
  vaultId,
  generationZeroId,
  lateEventId,
  "Event",
  Buffer.from("late-event"),
  {
    orderingTimestamp: "2025-01-01T00:00:00.000Z",
    dependencyObjectIds: [],
  },
);
await finishUpload(vaultId, lateEvent);
await control(
  "POST",
  `/api/vaults/${vaultId}/commits`,
  {
    generationId: generationZeroId,
    generationNumber: 0,
    eventObjectId: lateEventId,
    dependencyObjectIds: [],
  },
  { idempotencyKey: randomUUID() },
);
await control(
  "POST",
  `/api/vaults/${vaultId}/generation-candidates/${staleSuccessorId}/activate`,
  {
    predecessorGenerationId: generationZeroId,
    predecessorGenerationNumber: 0,
    headCursor: 2,
  },
  { idempotencyKey: randomUUID(), expected: [409] },
).then(({ payload }) => assert.equal(payload.outcome, "VAULT_HEAD_CHANGED"));
await control(
  "DELETE",
  `/api/vaults/${vaultId}/generation-candidates/${staleSuccessorId}`,
  undefined,
  {
    idempotencyKey: randomUUID(),
    expected: [204],
  },
);

const currentRecords = (await control("GET", `/api/vaults/${vaultId}/records?limit=100`)).payload
  .records;
const retainedIds = currentRecords.map((record) => record.objectId).sort();
const successorId = randomUUID();
const successorBytes = Buffer.from("canonical-successor");
const successor = (
  await control(
    "POST",
    `/api/vaults/${vaultId}/generation-candidates`,
    {
      generationId: successorId,
      generationNumber: 1,
      predecessorGenerationId: generationZeroId,
      headCursor: 3,
      generationObject: {
        objectId: successorId,
        objectType: "VaultGeneration",
        keyEpochId: activeKeyEpochId,
        byteLength: successorBytes.byteLength,
        sha256: sha256(successorBytes),
      },
    },
    { idempotencyKey: randomUUID(), expected: [201] },
  )
).payload;
await putPart(successor.ticket.url, 0, successorBytes);
await control(
  "POST",
  `/api/vaults/${vaultId}/uploads/${successor.upload.uploadId}/complete`,
  undefined,
  { idempotencyKey: randomUUID() },
);
await control(
  "PUT",
  `/api/vaults/${vaultId}/generation-candidates/${successorId}/retained-pages/0`,
  { recordIds: retainedIds },
  {
    idempotencyKey: randomUUID(),
    expected: [204],
  },
);
await control(
  "POST",
  `/api/vaults/${vaultId}/generation-candidates/${successorId}/seal`,
  {
    pageCount: 1,
    recordCount: retainedIds.length,
    sha256: sha256(Buffer.from(retainedIds.map((id) => `${id}\n`).join(""))),
  },
  { idempotencyKey: randomUUID() },
);
await control(
  "POST",
  `/api/vaults/${vaultId}/generation-candidates/${successorId}/activate`,
  {
    predecessorGenerationId: generationZeroId,
    predecessorGenerationNumber: 0,
    headCursor: 3,
  },
  { idempotencyKey: randomUUID() },
);

const recovery = (await control("GET", `/api/vaults/${vaultId}/recoveries`)).payload.recoveries[0];
assert.equal(recovery.generationId, generationZeroId);
const recoveryRecords = (
  await control("GET", `/api/vaults/${vaultId}/recoveries/${generationZeroId}/records?limit=100`)
).payload.records;
assert(recoveryRecords.length > 0);
await control(
  "POST",
  `/api/vaults/${vaultId}/recoveries/${generationZeroId}/records/${eventId}/downloads`,
  undefined,
  {
    idempotencyKey: randomUUID(),
  },
);

replicaTwo.socket.close();
const postActivationId = randomUUID();
const postActivation = await beginUpload(
  vaultId,
  successorId,
  postActivationId,
  "Event",
  Buffer.from("poll-only"),
  {
    orderingTimestamp: "2024-01-01T00:00:00.000Z",
    dependencyObjectIds: [],
  },
);
await finishUpload(vaultId, postActivation);
await control(
  "POST",
  `/api/vaults/${vaultId}/commits`,
  {
    generationId: successorId,
    generationNumber: 1,
    eventObjectId: postActivationId,
    dependencyObjectIds: [],
  },
  { idempotencyKey: randomUUID() },
);
const pollOnly = (await control("GET", `/api/vaults/${vaultId}/changes?after=4&limit=100`)).payload;
assert(pollOnly.changes.some((change) => change.event?.objectId === postActivationId));

const purge = (
  await control("POST", `/api/vaults/${vaultId}/purges`, undefined, {
    idempotencyKey: randomUUID(),
    expected: [202],
  })
).payload;
let lastPurgeState;
try {
  await waitFor(
    async () => {
      const state = (await control("GET", `/api/vaults/${vaultId}/purges/${purge.purgeId}`))
        .payload;
      lastPurgeState = {
        state: state.state,
        stage: state.stage,
        retryCount: state.retryCount,
        outcome: state.outcome,
      };
      if (state.state === "FailedRetryable")
        throw new Error(
          `Purge failed retryably: ${JSON.stringify(lastPurgeState)}`,
        );
      return state.state === "Succeeded" ? state : false;
    },
    "purge completion",
    30_000,
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}; last purge state: ${JSON.stringify(lastPurgeState)}`,
    { cause: error },
  );
}
await control(
  "GET",
  `/api/vaults/${vaultId}/recoveries/${generationZeroId}/records?limit=100`,
  undefined,
  {
    expected: [410],
  },
).then(({ payload }) => assert.equal(payload.outcome, "RECOVERY_EXPIRED"));
await control("POST", `/api/vaults/${vaultId}/records/${artifactId}/downloads`, undefined, {
  idempotencyKey: randomUUID(),
});

process.stdout.write(
  "two replicas converged through HTTP, Cable, polling, remote-only Artifact restoration, Generation recovery, and verified purge\n",
);

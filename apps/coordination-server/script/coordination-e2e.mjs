import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInitialVaultAuthority } from "./plan15-proof-authority.mjs";

const baseUrl = process.env.AWSM_COORDINATION_E2E_BASE_URL;
const cableUrl = process.env.AWSM_COORDINATION_E2E_CABLE_URL;
const composeFile = process.env.AWSM_COORDINATION_E2E_COMPOSE_FILE;
assert(baseUrl, "AWSM_COORDINATION_E2E_BASE_URL is required");
assert(cableUrl, "AWSM_COORDINATION_E2E_CABLE_URL is required");
assert(composeFile, "AWSM_COORDINATION_E2E_COMPOSE_FILE is required");

let credential;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("base64url");
}

function compose(...args) {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
}

async function request(method, path, body, options = {}) {
  const headers = {
    "Awsm-Protocol-Version": "1",
    "Awsm-Request-ID": randomUUID(),
  };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json();
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) {
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function putPart(url, bytes) {
  const response = await fetch(`${baseUrl}${url.replace("{partNumber}", "0")}`, {
    method: "PUT",
    headers: {
      "Awsm-Protocol-Version": "1",
      "Awsm-Request-ID": randomUUID(),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-SHA256": sha256(bytes),
    },
    body: bytes,
  });
  assert.equal(response.status, 204);
}

async function uploadEvent(vaultId, generationId, keyEpochId, objectId, bytes) {
  const started = await request(
    "POST",
    `/api/vaults/${vaultId}/uploads`,
    {
      objectId,
      objectType: "Event",
      keyEpochId,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      targetGenerationId: generationId,
      eventMetadata: {
        orderingTimestamp: new Date().toISOString(),
        dependencyObjectIds: [],
      },
    },
    { idempotencyKey: randomUUID(), expected: [201] },
  );
  await putPart(started.ticket.url, bytes);
  await request(
    "POST",
    `/api/vaults/${vaultId}/uploads/${started.upload.uploadId}/complete`,
    undefined,
    { idempotencyKey: randomUUID() },
  );
}

async function commitEvent(vaultId, generationId, objectId) {
  return request(
    "POST",
    `/api/vaults/${vaultId}/commits`,
    {
      generationId,
      generationNumber: 0,
      eventObjectId: objectId,
      dependencyObjectIds: [],
    },
    { idempotencyKey: randomUUID() },
  );
}

async function readiness(expectedStatus) {
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, expectedStatus);
  assert.equal(payload.components.database, "ready");
  assert.equal(payload.components.opaqueByteStorage, "ready");
  assert.equal(
    payload.components.ephemeralCoordination,
    expectedStatus === "ready" ? "ready" : "unavailable",
  );
}

async function waitForReadiness(expectedStatus, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await readiness(expectedStatus);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out waiting for ${expectedStatus} readiness: ${lastError?.message}`);
}

async function openCable(vaultId) {
  const issued = await request("POST", "/api/cable-tickets", undefined, {
    expected: [201],
  });
  const socket = new WebSocket(`${cableUrl}?ticket=${encodeURIComponent(issued.ticket)}`, [
    "actioncable-v1-json",
    "actioncable-unsupported",
  ]);
  const messages = [];
  const confirmed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Cable subscription timeout")), 10_000);
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
        clearTimeout(timeout);
        resolve();
      } else if (frame.message) {
        messages.push(frame.message);
      }
    });
  });
  await confirmed;
  return { socket, messages };
}

async function waitForMessage(messages, cursor, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (messages.some((message) => message.latestCursor === cursor)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Cable cursor ${cursor}`);
}

const username = `resilience_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
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
const login = await request("POST", "/api/sessions", { username, password });
credential = login.accessToken;
const generationBytes = Buffer.from("opaque-resilience-generation");
const authority = createInitialVaultAuthority(login.sessionId, generationBytes);
const { vaultId, generationId, keyEpochId } = authority;
const attached = await request("POST", "/api/vaults", authority.body, {
  idempotencyKey: randomUUID(),
  expected: [201],
});
credential = attached.session.accessToken;
await putPart(attached.ticket.url, generationBytes);
await request(
  "POST",
  `/api/vaults/${vaultId}/uploads/${attached.upload.uploadId}/complete`,
  undefined,
  { idempotencyKey: randomUUID() },
);
await request(
  "POST",
  `/api/vaults/${vaultId}/complete`,
  { generationId },
  { idempotencyKey: randomUUID() },
);
await readiness("ready");

compose("stop", "redis-coordination-e2e");
await waitForReadiness("degraded");

const unavailable = await request("POST", "/api/cable-tickets", undefined, {
  expected: [503],
});
assert.deepEqual(
  { outcome: unavailable.outcome, retryable: unavailable.retryable },
  { outcome: "AUTHENTICATION_UNAVAILABLE", retryable: true },
);

const outageEventId = randomUUID();
await uploadEvent(
  vaultId,
  generationId,
  keyEpochId,
  outageEventId,
  Buffer.from("opaque-event-during-redis-outage"),
);
const outageCommit = await commitEvent(vaultId, generationId, outageEventId);
assert.equal(outageCommit.cursor, 2);
const outageChanges = await request("GET", `/api/vaults/${vaultId}/changes?after=1&limit=100`);
assert(outageChanges.changes.some((change) => change.event?.objectId === outageEventId));

compose("up", "--detach", "--wait", "redis-coordination-e2e");
await waitForReadiness("ready");

const cable = await openCable(vaultId);
const recoveryEventId = randomUUID();
await uploadEvent(
  vaultId,
  generationId,
  keyEpochId,
  recoveryEventId,
  Buffer.from("opaque-event-after-redis-recovery"),
);
const recoveryCommit = await commitEvent(vaultId, generationId, recoveryEventId);
assert.equal(recoveryCommit.cursor, 3);
await waitForMessage(cable.messages, 3);
cable.socket.close();

process.stdout.write(
  "coordination E2E kept polling available during Redis loss and recovered ticket issuance and cross-process Cable delivery\n",
);

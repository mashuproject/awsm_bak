import { type Identifier, identifier } from "../../domain/canonical/identifiers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64_URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const USERNAME = /^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/u;
const HOST_OUTCOMES = new Set([
  "authentication_required",
  "access_denied",
  "replica_not_found",
  "item_not_found",
  "item_integrity_conflict",
  "outer_envelope_invalid",
  "range_invalid",
  "upload_incomplete",
  "upload_expired",
  "quota_exceeded",
  "rate_limited",
  "cursor_invalid",
  "request_conflict",
  "service_unavailable",
  "protocol_invalid",
]);

export interface CanonicalOpaqueInventoryItem {
  readonly storageItemId: Identifier<"StorageItem">;
  readonly storageClass: 1 | 2;
  readonly byteLength: number;
  readonly ciphertextDigest: Uint8Array;
  readonly locator: Uint8Array;
}

export interface CanonicalOpaqueInventoryPage {
  readonly snapshotCursor: number;
  readonly nextPosition: Identifier<"StorageItem"> | null;
  readonly items: readonly CanonicalOpaqueInventoryItem[];
}

export class CanonicalHostedReplicaHttpError extends Error {
  override readonly name = "CanonicalHostedReplicaHttpError";

  constructor(
    readonly outcome: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds: number | null,
    readonly status: number,
  ) {
    super(`Replica Host request failed: ${outcome}`);
  }
}

function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new TypeError(`${field} must be a lowercase UUID`);
  return value;
}

function username(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 32 || !USERNAME.test(value)) {
    throw new TypeError(`${field} must be a canonical username`);
  }
  return value;
}

function secret(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) {
    throw new TypeError(`${field} must be a bounded nonempty string`);
  }
  return value;
}

function accountCredential(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    throw new TypeError(`${field} must be a bounded nonempty string`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string") throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical RFC 3339 timestamp`);
  }
  return milliseconds;
}

function endpoint(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0 ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    parsed.href !== value
  ) {
    throw new TypeError("Hosted Replica HTTP endpoint must be a canonical HTTPS URL");
  }
  return parsed;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${field} contains missing or unknown fields`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${field} is outside the accepted bounds`);
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64Url32(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !BASE64_URL_32.test(value)) {
    throw new TypeError(`${field} must be a canonical 32-byte base64url value`);
  }
  let binary: string;
  try {
    binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
  } catch {
    throw new TypeError(`${field} must be canonical base64url`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || base64Url(bytes) !== value) {
    throw new TypeError(`${field} must be canonical base64url`);
  }
  return bytes;
}

function protocolHeader(response: Response): void {
  if (response.redirected || response.headers.get("Awsm-Protocol-Version") !== "1") {
    throw new TypeError("Replica Host response does not satisfy the canonical protocol boundary");
  }
}

function responseMediaType(response: Response): string | null {
  const value = response.headers.get("Content-Type");
  return value === null ? null : (value.split(";", 1)[0]?.trim().toLowerCase() ?? null);
}

async function decodeJson(response: Response): Promise<unknown> {
  if (responseMediaType(response) !== "application/json") {
    throw new TypeError("Replica Host JSON response has an invalid media type");
  }
  return response.json();
}

async function hostFailure(response: Response): Promise<never> {
  protocolHeader(response);
  const payload = exactObject(
    await decodeJson(response),
    ["outcome", "retryable", "request_id", "retry_after_seconds"],
    "Replica Host outcome",
  );
  if (typeof payload.outcome !== "string" || !HOST_OUTCOMES.has(payload.outcome)) {
    throw new TypeError("Replica Host outcome is unknown");
  }
  if (typeof payload.retryable !== "boolean") {
    throw new TypeError("Replica Host outcome retryability is invalid");
  }
  uuid(String(payload.request_id), "Replica Host request ID");
  const retryAfterSeconds =
    payload.retry_after_seconds === null
      ? null
      : safeInteger(payload.retry_after_seconds, "Replica Host retry delay", 0, 2_147_483_647);
  throw new CanonicalHostedReplicaHttpError(
    payload.outcome,
    payload.retryable,
    retryAfterSeconds,
    response.status,
  );
}

function parseInventoryItem(value: unknown): CanonicalOpaqueInventoryItem {
  const item = exactObject(
    value,
    ["storage_item_id", "storage_class", "byte_length", "ciphertext_digest", "locator"],
    "Replica Host inventory item",
  );
  const storageClass =
    item.storage_class === "compact" ? 1 : item.storage_class === "streamable" ? 2 : null;
  if (storageClass === null) throw new TypeError("Replica Host inventory storage class is invalid");
  return {
    storageItemId: identifier(
      "StorageItem",
      base64Url32(item.storage_item_id, "Replica Host inventory Storage Item ID"),
    ),
    storageClass,
    byteLength: safeInteger(
      item.byte_length,
      "Replica Host inventory byte length",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    ciphertextDigest: base64Url32(
      item.ciphertext_digest,
      "Replica Host inventory ciphertext digest",
    ),
    locator: base64Url32(item.locator, "Replica Host inventory opaque locator"),
  };
}

function parseInventoryPage(value: unknown, requestedLimit: number): CanonicalOpaqueInventoryPage {
  const page = exactObject(
    value,
    ["snapshot_cursor", "next_position", "items"],
    "Replica Host inventory page",
  );
  if (!Array.isArray(page.items) || page.items.length > requestedLimit) {
    throw new TypeError("Replica Host inventory page exceeds the requested bound");
  }
  return {
    snapshotCursor: safeInteger(
      page.snapshot_cursor,
      "Replica Host inventory snapshot cursor",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    nextPosition:
      page.next_position === null
        ? null
        : identifier(
            "StorageItem",
            base64Url32(page.next_position, "Replica Host inventory next position"),
          ),
    items: page.items.map(parseInventoryItem),
  };
}

export interface CanonicalHostedReplicaSession {
  readonly username: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: number;
}

function parseSession(value: unknown): CanonicalHostedReplicaSession {
  const session = exactObject(
    value,
    [
      "account",
      "session_id",
      "access_token",
      "access_expires_at",
      "refresh_token",
      "refresh_expires_at",
    ],
    "Replica Host authenticated session",
  );
  const account = exactObject(
    session.account,
    ["username", "inactive_deletion_at"],
    "Replica Host session Account",
  );
  username(account.username, "Replica Host Account username");
  timestamp(account.inactive_deletion_at, "Replica Host Account inactivity time");
  return {
    username: username(account.username, "Replica Host Account username"),
    sessionId: uuid(String(session.session_id), "Replica Host session ID"),
    accessToken: secret(session.access_token, "Replica Host access token"),
    accessExpiresAt: timestamp(session.access_expires_at, "Replica Host access expiry"),
    refreshToken: secret(session.refresh_token, "Replica Host refresh token"),
    refreshExpiresAt: timestamp(session.refresh_expires_at, "Replica Host refresh expiry"),
  };
}

export class CanonicalHostedReplicaSessionHttp {
  private readonly endpoint: URL;

  constructor(
    private readonly configuration: {
      readonly endpoint: string;
      readonly fetcher?: typeof fetch;
    },
  ) {
    this.endpoint = endpoint(configuration.endpoint);
  }

  async signIn(input: {
    readonly username: string;
    readonly password: string;
  }): Promise<CanonicalHostedReplicaSession> {
    return this.post("api/sessions", {
      username: username(input.username, "Replica Host sign-in username"),
      password: accountCredential(input.password, "Replica Host sign-in password"),
    });
  }

  async refresh(input: { readonly refreshToken: string }): Promise<CanonicalHostedReplicaSession> {
    return this.post("api/session/refresh", {
      refresh_token: accountCredential(input.refreshToken, "Replica Host refresh token"),
    });
  }

  private async post(
    path: string,
    body: Record<string, string>,
  ): Promise<CanonicalHostedReplicaSession> {
    let response: Response;
    try {
      response = await (this.configuration.fetcher ?? fetch)(new URL(path, this.endpoint), {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Awsm-Protocol-Version": "1",
          "Awsm-Request-ID": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw Object.assign(new Error("Replica Host transport is unavailable", { cause }), {
        id: "REMOTE_TRANSPORT_UNAVAILABLE",
        retryable: true,
      });
    }
    if (!response.ok) return hostFailure(response);
    protocolHeader(response);
    return parseSession(await decodeJson(response));
  }
}

export class CanonicalHostedReplicaHttp {
  private readonly endpoint: URL;

  constructor(
    private readonly configuration: {
      readonly endpoint: string;
      readonly bearerToken: string;
      readonly fetcher?: typeof fetch;
    },
  ) {
    this.endpoint = endpoint(configuration.endpoint);
    if (configuration.bearerToken.length === 0) {
      throw new TypeError("Hosted Replica HTTP bearer credential must not be empty");
    }
  }

  async inventory(input: {
    readonly replicaHandle: string;
    readonly snapshotCursor?: number;
    readonly position?: Identifier<"StorageItem">;
    readonly limit: number;
  }): Promise<CanonicalOpaqueInventoryPage> {
    uuid(input.replicaHandle, "Hosted Replica handle");
    const limit = safeInteger(input.limit, "Inventory page limit", 1, 500);
    if (input.snapshotCursor === undefined && input.position !== undefined) {
      throw new TypeError("Inventory position requires an observed snapshot cursor");
    }
    const url = this.path(`api/replicas/${input.replicaHandle}/inventory`);
    url.searchParams.set("limit", String(limit));
    if (input.snapshotCursor !== undefined) {
      url.searchParams.set(
        "snapshot_cursor",
        String(
          safeInteger(
            input.snapshotCursor,
            "Inventory snapshot cursor",
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        ),
      );
    }
    if (input.position !== undefined) url.searchParams.set("position", base64Url(input.position));
    const response = await this.request(url, "application/json");
    if (!response.ok) return hostFailure(response);
    protocolHeader(response);
    return parseInventoryPage(await decodeJson(response), limit);
  }

  async item(input: {
    readonly replicaHandle: string;
    readonly storageItemId: Identifier<"StorageItem">;
    readonly byteLength: number;
  }): Promise<ReadableStream<Uint8Array>> {
    uuid(input.replicaHandle, "Hosted Replica handle");
    const byteLength = safeInteger(
      input.byteLength,
      "Opaque item byte length",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const response = await this.request(
      this.path(`api/replicas/${input.replicaHandle}/items/${base64Url(input.storageItemId)}`),
      "application/octet-stream",
    );
    if (!response.ok) return hostFailure(response);
    protocolHeader(response);
    if (
      response.status !== 200 ||
      response.body === null ||
      responseMediaType(response) !== "application/octet-stream" ||
      response.headers.get("Content-Length") !== String(byteLength)
    ) {
      throw new TypeError("Replica Host opaque item response does not match the requested bytes");
    }
    return response.body;
  }

  private path(path: string): URL {
    return new URL(path, this.endpoint);
  }

  private async request(url: URL, accept: string): Promise<Response> {
    try {
      return await (this.configuration.fetcher ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.configuration.bearerToken}`,
          "Awsm-Protocol-Version": "1",
          "Awsm-Request-ID": crypto.randomUUID(),
        },
      });
    } catch (cause) {
      throw Object.assign(new Error("Replica Host transport is unavailable", { cause }), {
        id: "REMOTE_TRANSPORT_UNAVAILABLE",
        retryable: true,
      });
    }
  }
}

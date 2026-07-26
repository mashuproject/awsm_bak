import { bytesToBase64Url } from "../account/wire";

interface AccessTokens {
  accessToken(): Promise<string>;
}

export class SynchronizationHttp {
  private accessTokenOverride: string | undefined;

  constructor(
    private readonly origin: string,
    private readonly tokens: AccessTokens,
    private readonly fetcher: typeof fetch = fetch,
    private readonly operationSignal?: AbortSignal,
  ) {}

  useAccessToken(accessToken: string): void {
    this.accessTokenOverride = accessToken;
  }

  private signal(): AbortSignal {
    const timeout = AbortSignal.timeout(15_000);
    return this.operationSignal === undefined
      ? timeout
      : AbortSignal.any([this.operationSignal, timeout]);
  }

  private async fetch(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher.call(globalThis, input, init);
    } catch (cause) {
      throw Object.assign(new Error("Synchronization request failed.", { cause }), {
        id: "SYNCHRONIZATION_INTERRUPTED",
      });
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const token = this.accessTokenOverride ?? (await this.tokens.accessToken());
    const response = await this.fetch(`${this.origin}${path}`, {
      method,
      signal: this.signal(),
      redirect: "manual",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${token}`,
        "Awsm-Protocol-Version": "1",
        "Awsm-Request-ID": crypto.randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.operationSignal?.throwIfAborted();
    const payload =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok || response.redirected) {
      const outcome =
        typeof payload === "object" &&
        payload !== null &&
        "outcome" in payload &&
        typeof payload.outcome === "string"
          ? payload.outcome
          : response.status === 401
            ? "SYNCHRONIZATION_AUTHENTICATION_REQUIRED"
            : "SYNCHRONIZATION_INTERRUPTED";
      throw Object.assign(new Error(String(outcome)), {
        id: String(outcome),
        status: response.status,
        method,
        path,
        origin: this.origin,
        responseBody: payload,
      });
    }
    return { status: response.status, body: payload };
  }

  async putTransfer(url: string, part: number, bytes: Uint8Array): Promise<void> {
    const partUrl = url.replace("{partNumber}", String(part));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
    const response = await this.fetch(`${this.origin}${partUrl}`, {
      method: "PUT",
      signal: this.signal(),
      redirect: "manual",
      credentials: "omit",
      headers: {
        "Awsm-Protocol-Version": "1",
        "Awsm-Request-ID": crypto.randomUUID(),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-SHA256": bytesToBase64Url(digest),
      },
      body: Uint8Array.from(bytes),
    });
    this.operationSignal?.throwIfAborted();
    if (response.status !== 204)
      throw Object.assign(new Error("Transfer failed"), {
        id: "SYNCHRONIZATION_INTERRUPTED",
      });
  }

  async getTransfer(url: string, expectedByteLength: number): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetch(`${this.origin}${url}`, {
      method: "GET",
      signal: this.signal(),
      redirect: "manual",
      credentials: "omit",
      headers: {
        "Awsm-Protocol-Version": "1",
        "Awsm-Request-ID": crypto.randomUUID(),
      },
    });
    this.operationSignal?.throwIfAborted();
    if (
      !response.ok ||
      response.redirected ||
      response.body === null ||
      response.headers.get("Content-Length") !== String(expectedByteLength)
    )
      throw Object.assign(new Error("Download transfer failed"), {
        id: "SYNCHRONIZATION_INTERRUPTED",
      });
    return response.body;
  }
}

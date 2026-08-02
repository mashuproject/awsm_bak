import { browser } from "wxt/browser";

import type { CanonicalApplicationRequest } from "./canonical-application";
import { isCanonicalApplicationStateChanged } from "./canonical-application-host";

export class CanonicalApplicationClientError extends Error {
  readonly id: string;

  constructor(id: string, message: string) {
    super(message);
    this.name = "CanonicalApplicationClientError";
    this.id = id;
  }
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function protocolError(): CanonicalApplicationClientError {
  return new CanonicalApplicationClientError(
    "APPLICATION_PROTOCOL_INVALID",
    "The local application returned an invalid response.",
  );
}

function failure(value: unknown): CanonicalApplicationClientError | undefined {
  if (!plainRecord(value) || !exactKeys(value, ["ok", "error"]) || value.ok !== false)
    return undefined;
  if (!plainRecord(value.error) || !exactKeys(value.error, ["id", "message"])) return undefined;
  const { id, message } = value.error;
  if (
    typeof id !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,127}$/u.test(id) ||
    typeof message !== "string" ||
    message.length < 1 ||
    message.length > 1_024
  ) {
    return undefined;
  }
  return new CanonicalApplicationClientError(id, message);
}

export async function sendCanonicalApplicationRequest<T>(
  request: CanonicalApplicationRequest,
): Promise<T> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage(request);
  } catch {
    throw new CanonicalApplicationClientError(
      "APPLICATION_UNAVAILABLE",
      "The local application is unavailable.",
    );
  }
  if (plainRecord(response) && exactKeys(response, ["ok", "value"]) && response.ok === true) {
    return response.value as T;
  }
  throw failure(response) ?? protocolError();
}

export function subscribeCanonicalApplicationState(listener: () => void): () => void {
  const receiver = (message: unknown): undefined => {
    if (isCanonicalApplicationStateChanged(message)) listener();
    return undefined;
  };
  browser.runtime.onMessage.addListener(receiver);
  return () => browser.runtime.onMessage.removeListener(receiver);
}

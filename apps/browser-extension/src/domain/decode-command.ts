import type { CapturePageCommandV1 } from "./contracts";
import { DomainValidationError } from "./errors";
import { httpUrl, integer, literal, record, timestamp, uuid } from "./validation";

export function decodeCapturePageCommand(value: unknown): CapturePageCommandV1 {
  const input = record(value, "command");
  const commandId = uuid(input.commandId, "command.commandId");
  const idempotencyKey = uuid(input.idempotencyKey, "command.idempotencyKey");
  if (commandId !== idempotencyKey) {
    throw new DomainValidationError("command.idempotencyKey", "must equal the Command identifier");
  }

  return {
    commandId,
    commandType: literal(input.commandType, "CapturePage", "command.commandType"),
    commandVersion: literal(input.commandVersion, 1, "command.commandVersion"),
    issuingDeviceId: uuid(input.issuingDeviceId, "command.issuingDeviceId"),
    createdAt: timestamp(input.createdAt, "command.createdAt"),
    tabId: integer(input.tabId, "command.tabId"),
    observedUrl: httpUrl(input.observedUrl, "command.observedUrl"),
    captureProfileId: literal(
      input.captureProfileId,
      "WebPageSnapshot-v1",
      "command.captureProfileId",
    ),
    idempotencyKey,
  };
}

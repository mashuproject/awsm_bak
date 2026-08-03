import type { CanonicalPrimaryCaptureInput } from "../runtime/capture/canonical-prepare";
import type { CanonicalClientRuntime } from "../runtime/client/canonical-runtime";

export type CanonicalApplicationRequest =
  | { readonly type: "GetState" }
  | {
      readonly type: "BeginVaultCreation";
      readonly expectedVaultId: string | null;
      readonly label: string | null;
    }
  | {
      readonly type: "ConfirmVaultCreation";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelVaultCreation"; readonly setupId: string }
  | {
      readonly type: "SelectVault";
      readonly expectedVaultId: string | null;
      readonly vaultId: string;
    }
  | {
      readonly type: "CaptureActivePage";
      readonly expectedVaultId: string;
      readonly tabId?: number;
    }
  | { readonly type: "BeginVaultFork"; readonly expectedVaultId: string }
  | {
      readonly type: "ConfirmVaultFork";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelVaultFork"; readonly setupId: string }
  | {
      readonly type: "RecoverMember";
      readonly expectedVaultId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "BeginRecoveryPhraseReplacement"; readonly expectedVaultId: string }
  | {
      readonly type: "ConfirmRecoveryPhraseReplacement";
      readonly setupId: string;
      readonly recoveryPhrase: string;
    }
  | { readonly type: "CancelRecoveryPhraseReplacement"; readonly setupId: string }
  | { readonly type: "CloseVault"; readonly expectedVaultId: string }
  | { readonly type: "VacuumVault"; readonly expectedVaultId: string }
  | { readonly type: "ListLibrary"; readonly expectedVaultId: string }
  | { readonly type: "ListRemotes"; readonly expectedVaultId: string }
  | {
      readonly type: "CreateHostedReplica";
      readonly expectedVaultId: string;
      readonly endpoint: string;
      readonly name: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly type: "MaterializeHostedReplica";
      readonly expectedVaultId: string;
      readonly remoteId: string;
    };

type CanonicalApplicationRuntime = Pick<
  CanonicalClientRuntime,
  | "state"
  | "beginVaultCreation"
  | "confirmVaultCreation"
  | "cancelVaultCreation"
  | "selectVault"
  | "capture"
  | "beginVaultFork"
  | "confirmVaultFork"
  | "cancelVaultFork"
  | "recoverMember"
  | "beginRecoveryPhraseReplacement"
  | "confirmRecoveryPhraseReplacement"
  | "cancelRecoveryPhraseReplacement"
  | "closeVault"
  | "vacuumVault"
  | "listLibrary"
  | "listRemotes"
  | "createHostedReplica"
  | "materializeHostedReplica"
>;

interface CanonicalApplicationPageCapture {
  captureActivePage(tabId?: number): Promise<{
    readonly originalUrl: string;
    readonly finalUrl: string;
    readonly title: string;
    readonly capturedAt: number;
    readonly primary: CanonicalPrimaryCaptureInput;
  }>;
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

function text(value: unknown): value is string {
  return typeof value === "string";
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function tabId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function decodeCanonicalApplicationRequest(value: unknown): CanonicalApplicationRequest {
  if (!plainRecord(value) || !text(value.type)) {
    throw new TypeError("Unsupported application Command");
  }
  switch (value.type) {
    case "GetState":
      if (exactKeys(value, ["type"])) return { type: value.type };
      break;
    case "BeginVaultCreation":
      if (
        exactKeys(value, ["type", "expectedVaultId", "label"]) &&
        nullableText(value.expectedVaultId) &&
        nullableText(value.label)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          label: value.label,
        };
      }
      break;
    case "ConfirmVaultCreation":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelVaultCreation":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "SelectVault":
      if (
        exactKeys(value, ["type", "expectedVaultId", "vaultId"]) &&
        nullableText(value.expectedVaultId) &&
        text(value.vaultId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, vaultId: value.vaultId };
      }
      break;
    case "CaptureActivePage":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
        };
      }
      if (
        exactKeys(value, ["type", "expectedVaultId", "tabId"]) &&
        text(value.expectedVaultId) &&
        tabId(value.tabId)
      ) {
        return { type: value.type, expectedVaultId: value.expectedVaultId, tabId: value.tabId };
      }
      break;
    case "BeginVaultFork":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ConfirmVaultFork":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelVaultFork":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "RecoverMember":
      if (
        exactKeys(value, ["type", "expectedVaultId", "recoveryPhrase"]) &&
        text(value.expectedVaultId) &&
        text(value.recoveryPhrase)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          recoveryPhrase: value.recoveryPhrase,
        };
      }
      break;
    case "BeginRecoveryPhraseReplacement":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ConfirmRecoveryPhraseReplacement":
      if (
        exactKeys(value, ["type", "setupId", "recoveryPhrase"]) &&
        text(value.setupId) &&
        text(value.recoveryPhrase)
      ) {
        return { type: value.type, setupId: value.setupId, recoveryPhrase: value.recoveryPhrase };
      }
      break;
    case "CancelRecoveryPhraseReplacement":
      if (exactKeys(value, ["type", "setupId"]) && text(value.setupId)) {
        return { type: value.type, setupId: value.setupId };
      }
      break;
    case "CloseVault":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "VacuumVault":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ListLibrary":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "ListRemotes":
      if (exactKeys(value, ["type", "expectedVaultId"]) && text(value.expectedVaultId)) {
        return { type: value.type, expectedVaultId: value.expectedVaultId };
      }
      break;
    case "CreateHostedReplica":
      if (
        exactKeys(value, ["type", "expectedVaultId", "endpoint", "name", "username", "password"]) &&
        text(value.expectedVaultId) &&
        text(value.endpoint) &&
        text(value.name) &&
        text(value.username) &&
        text(value.password)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          endpoint: value.endpoint,
          name: value.name,
          username: value.username,
          password: value.password,
        };
      }
      break;
    case "MaterializeHostedReplica":
      if (
        exactKeys(value, ["type", "expectedVaultId", "remoteId"]) &&
        text(value.expectedVaultId) &&
        text(value.remoteId)
      ) {
        return {
          type: value.type,
          expectedVaultId: value.expectedVaultId,
          remoteId: value.remoteId,
        };
      }
      break;
  }
  throw new TypeError("Unsupported application Command");
}

export class CanonicalApplication {
  constructor(
    private readonly runtime: CanonicalApplicationRuntime,
    private readonly now: () => number = Date.now,
    private readonly pageCapture?: CanonicalApplicationPageCapture,
    private readonly createCaptureCommandId: () => string = () => crypto.randomUUID(),
    private readonly notifyStateChanged: () => void | Promise<void> = () => undefined,
  ) {}

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = await operation();
    await this.notifyStateChanged();
    return result;
  }

  async handle(value: unknown): Promise<unknown> {
    const request = decodeCanonicalApplicationRequest(value);
    switch (request.type) {
      case "GetState":
        return this.runtime.state();
      case "BeginVaultCreation":
        return this.mutate(() =>
          this.runtime.beginVaultCreation({
            expectedVaultId: request.expectedVaultId,
            label: request.label,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmVaultCreation":
        return this.mutate(() =>
          this.runtime.confirmVaultCreation({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelVaultCreation":
        return this.mutate(() => this.runtime.cancelVaultCreation(request.setupId));
      case "SelectVault":
        return this.mutate(() =>
          this.runtime.selectVault({
            expectedVaultId: request.expectedVaultId,
            vaultId: request.vaultId,
          }),
        );
      case "CaptureActivePage": {
        if (this.pageCapture === undefined) {
          throw Object.assign(new Error("Browser page capture is unavailable."), {
            id: "CAPTURE_UNAVAILABLE",
          });
        }
        const captured = await this.pageCapture.captureActivePage(request.tabId);
        return this.mutate(() =>
          this.runtime.capture({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            ...captured,
          }),
        );
      }
      case "BeginVaultFork":
        return this.mutate(() =>
          this.runtime.beginVaultFork({
            expectedVaultId: request.expectedVaultId,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmVaultFork":
        return this.mutate(() =>
          this.runtime.confirmVaultFork({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelVaultFork":
        return this.mutate(() => this.runtime.cancelVaultFork(request.setupId));
      case "RecoverMember":
        return this.mutate(() =>
          this.runtime.recoverMember({
            expectedVaultId: request.expectedVaultId,
            recoveryPhrase: request.recoveryPhrase,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "BeginRecoveryPhraseReplacement":
        return this.mutate(() =>
          this.runtime.beginRecoveryPhraseReplacement({
            expectedVaultId: request.expectedVaultId,
            assertedAt: this.now(),
          }),
        );
      case "ConfirmRecoveryPhraseReplacement":
        return this.mutate(() =>
          this.runtime.confirmRecoveryPhraseReplacement({
            setupId: request.setupId,
            recoveryPhrase: request.recoveryPhrase,
          }),
        );
      case "CancelRecoveryPhraseReplacement":
        return this.mutate(() => this.runtime.cancelRecoveryPhraseReplacement(request.setupId));
      case "CloseVault":
        return this.mutate(() =>
          this.runtime.closeVault({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "VacuumVault":
        return this.mutate(() =>
          this.runtime.vacuumVault({
            expectedVaultId: request.expectedVaultId,
            commandId: this.createCaptureCommandId(),
            assertedAt: this.now(),
          }),
        );
      case "ListLibrary":
        return this.runtime.listLibrary(request.expectedVaultId);
      case "ListRemotes":
        return this.runtime.listRemotes(request.expectedVaultId);
      case "CreateHostedReplica": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.createHostedReplica(input));
      }
      case "MaterializeHostedReplica": {
        const { type: _type, ...input } = request;
        return this.mutate(() => this.runtime.materializeHostedReplica(input));
      }
    }
  }
}

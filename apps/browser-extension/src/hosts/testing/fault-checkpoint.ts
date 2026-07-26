import type { RuntimeFaultCheckpoint } from "../../runtime/fault-checkpoint";

const MESSAGE_TYPE = "awsm:test-fault-control";

interface ArmedCheckpoint {
  readonly name: string;
  readonly failureId?: string;
  reached: boolean;
  release: () => void;
  readonly promise: Promise<void>;
}

export class TestingFaultCheckpoint implements RuntimeFaultCheckpoint {
  private armed: ArmedCheckpoint | undefined;
  private lastFailure:
    | {
        readonly name: string;
        readonly message: string;
        readonly id?: string;
        readonly status?: number;
        readonly method?: string;
        readonly path?: string;
      }
    | undefined;

  recordFailure(value: unknown): void {
    if (!(value instanceof Error)) {
      this.lastFailure = { name: "UnknownError", message: "Non-Error synchronization failure" };
      return;
    }
    const id = "id" in value && typeof value.id === "string" ? value.id : undefined;
    const status = "status" in value && typeof value.status === "number" ? value.status : undefined;
    const method = "method" in value && typeof value.method === "string" ? value.method : undefined;
    const path = "path" in value && typeof value.path === "string" ? value.path : undefined;
    this.lastFailure = {
      name: value.name,
      message: value.message,
      ...(id === undefined ? {} : { id }),
      ...(status === undefined ? {} : { status }),
      ...(method === undefined ? {} : { method }),
      ...(path === undefined ? {} : { path }),
    };
  }

  async reach(name: string, signal?: AbortSignal): Promise<void> {
    const armed = this.armed;
    if (armed === undefined || armed.name !== name) return;
    armed.reached = true;
    const failureId =
      name === "vacuum:before-candidate"
        ? "SYNCHRONIZATION_AUTHENTICATION_REQUIRED"
        : armed.failureId;
    if (failureId !== undefined) throw Object.assign(new Error(failureId), { id: failureId });
    if (signal === undefined) return armed.promise;
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await Promise.race([armed.promise, aborted]);
    signal.throwIfAborted();
  }

  handle(value: unknown): unknown {
    if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
    const input = value as Record<string, unknown>;
    if (input.type !== MESSAGE_TYPE || typeof input.action !== "string") return undefined;
    if (
      (input.action === "arm" || input.action === "arm-authentication-expiry") &&
      typeof input.checkpoint === "string"
    ) {
      this.lastFailure = undefined;
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.armed = {
        name: input.checkpoint,
        ...(input.action === "arm-authentication-expiry"
          ? { failureId: "SYNCHRONIZATION_AUTHENTICATION_REQUIRED" }
          : typeof input.failureId === "string"
            ? { failureId: input.failureId }
            : {}),
        reached: false,
        release,
        promise,
      };
      return { ok: true };
    }
    if (input.action === "status")
      return {
        ok: true,
        checkpoint: this.armed?.name,
        reached: this.armed?.reached ?? false,
        rejects: this.armed?.failureId !== undefined,
        lastFailure: this.lastFailure,
      };
    if (input.action === "release") {
      this.armed?.release();
      this.armed = undefined;
      return { ok: true };
    }
    return { ok: false };
  }
}

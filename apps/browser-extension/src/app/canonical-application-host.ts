export interface CanonicalApplicationMessageResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly id: string;
    readonly message: string;
  };
}

interface CanonicalApplicationPort {
  handle(message: unknown): Promise<unknown>;
}

interface RuntimeMessageHost {
  readonly onMessage: {
    addListener(listener: (message: unknown) => Promise<CanonicalApplicationMessageResponse>): void;
  };
}

function knownFailure(error: unknown): CanonicalApplicationMessageResponse {
  if (
    error instanceof Error &&
    typeof (error as Error & { readonly id?: unknown }).id === "string" &&
    /^[A-Z][A-Z0-9_]{1,127}$/u.test((error as Error & { readonly id: string }).id) &&
    error.message.length > 0 &&
    error.message.length <= 1_024
  ) {
    return {
      ok: false,
      error: { id: (error as Error & { readonly id: string }).id, message: error.message },
    };
  }
  return {
    ok: false,
    error: {
      id: "APPLICATION_FAILED",
      message: "The local application could not complete that action.",
    },
  };
}

export function installCanonicalApplicationMessageHandler(
  runtime: RuntimeMessageHost,
  application: CanonicalApplicationPort,
): void {
  runtime.onMessage.addListener(async (message) => {
    try {
      return { ok: true, value: await application.handle(message) };
    } catch (error) {
      return knownFailure(error);
    }
  });
}

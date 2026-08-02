export interface CanonicalPopupState {
  readonly selectedVaultId?: string;
  readonly vaults: readonly unknown[];
}

export interface CanonicalPopupView {
  readonly state: CanonicalPopupState;
  readonly library: readonly unknown[];
}

export interface CanonicalPopupClient {
  request(request: {
    readonly type: "GetState" | "ListLibrary";
    readonly expectedVaultId?: string;
  }): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export class CanonicalPopupController {
  private active = false;
  private generation = 0;
  private renderedGeneration = -1;
  private reconciliation: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly client: CanonicalPopupClient,
    private readonly render: (view: CanonicalPopupView) => void,
  ) {}

  async start(): Promise<void> {
    if (this.active) throw new Error("The canonical popup controller is already active.");
    this.active = true;
    this.unsubscribe = this.client.subscribe(() => {
      void this.invalidate();
    });
    await this.invalidate();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private invalidate(): Promise<void> {
    this.generation += 1;
    if (this.reconciliation === undefined) {
      this.reconciliation = this.reconcile().finally(() => {
        this.reconciliation = undefined;
        if (this.active && this.renderedGeneration !== this.generation) void this.invalidate();
      });
    }
    return this.reconciliation;
  }

  private async reconcile(): Promise<void> {
    while (this.active) {
      const generation = this.generation;
      const state = (await this.client.request({ type: "GetState" })) as CanonicalPopupState;
      if (!this.active || generation !== this.generation) continue;
      const library =
        state.selectedVaultId === undefined
          ? []
          : ((await this.client.request({
              type: "ListLibrary",
              expectedVaultId: state.selectedVaultId,
            })) as readonly unknown[]);
      if (!this.active || generation !== this.generation) continue;
      this.render({ state, library });
      this.renderedGeneration = generation;
      return;
    }
  }
}

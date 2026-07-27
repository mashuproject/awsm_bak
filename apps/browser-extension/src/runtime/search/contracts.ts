export interface EmbeddingProviderIdentity {
  readonly version: 1;
  readonly kind: "LocalMiniLm" | "RemoteOpenAiCompatible";
  readonly endpointOrigin?: string;
  readonly endpointPathHash?: string;
  readonly model: string;
  readonly modelRevision?: string;
  readonly dimensions: number;
  readonly pooling: "Mean";
  readonly normalized: true;
}

export interface EmbeddingProvider {
  readonly identity: EmbeddingProviderIdentity;
  readonly maximumBatchItems: number;
  readonly maximumInputBytes: number;
  embed(input: {
    readonly purpose: "Document" | "Query" | "Probe";
    readonly texts: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly Float32Array[]>;
  dispose(): Promise<void>;
}

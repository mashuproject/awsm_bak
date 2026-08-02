import type { Identifier } from "../../domain/canonical/identifiers";
import { bytesEqual } from "../../domain/hash";
import type { CanonicalPullSynchronizationJob, CanonicalReplicaRemote } from "./canonical-state";

type PullJobSummary = Pick<CanonicalPullSynchronizationJob, "stage" | "state" | "progress">;

export type CanonicalMultiRemotePullResult =
  | {
      readonly remoteId: string;
      readonly status: "Disabled" | "Failed";
    }
  | {
      readonly remoteId: string;
      readonly status: "Active" | "Completed" | "Waiting";
      readonly progress: CanonicalPullSynchronizationJob["progress"];
    };

function status(job: PullJobSummary): Extract<CanonicalMultiRemotePullResult, { status: string }> {
  switch (job.state) {
    case 1:
      return { remoteId: "", status: "Active", progress: job.progress };
    case 2:
      return { remoteId: "", status: "Waiting", progress: job.progress };
    case 3:
      return { remoteId: "", status: "Completed", progress: job.progress };
    case 4:
      return { remoteId: "", status: "Failed" };
  }
}

/** Pulls each local Remote serially so one local Replica state transition is observed at a time. */
export class CanonicalMultiRemotePullService {
  constructor(
    private readonly dependencies: {
      readonly list: (vaultId: Identifier<"Vault">) => Promise<readonly CanonicalReplicaRemote[]>;
      readonly pull: (input: {
        readonly vaultId: Identifier<"Vault">;
        readonly remoteId: string;
      }) => Promise<PullJobSummary>;
    },
  ) {}

  async pull(input: {
    readonly vaultId: Identifier<"Vault">;
  }): Promise<readonly CanonicalMultiRemotePullResult[]> {
    const remotes = await this.dependencies.list(input.vaultId);
    const remoteIds = new Set<string>();
    for (const remote of remotes) {
      if (!bytesEqual(remote.vaultId, input.vaultId)) {
        throw new TypeError("Replica Remote is outside the selected Vault");
      }
      if (remoteIds.has(remote.remoteId)) {
        throw new TypeError("Selected Vault repeats a Replica Remote identity");
      }
      remoteIds.add(remote.remoteId);
    }
    const results: CanonicalMultiRemotePullResult[] = [];
    for (const remote of remotes.toSorted((left, right) =>
      left.remoteId.localeCompare(right.remoteId),
    )) {
      if (!remote.enabled) {
        results.push({ remoteId: remote.remoteId, status: "Disabled" });
        continue;
      }
      try {
        const result = status(
          await this.dependencies.pull({ vaultId: input.vaultId, remoteId: remote.remoteId }),
        );
        results.push({ ...result, remoteId: remote.remoteId });
      } catch {
        results.push({ remoteId: remote.remoteId, status: "Failed" });
      }
    }
    return results;
  }
}

import { browser } from "wxt/browser";

import { CanonicalIndexedDb } from "../drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../drivers/indexeddb/canonical-schema";
import { ChromeCaptureHost } from "../hosts/chrome/api";
import { FirefoxCaptureHost } from "../hosts/firefox/api";
import { CanonicalOpfsArtifactStore } from "../hosts/shared/canonical-artifact-store";
import {
  CanonicalBrowserPageCapture,
  type CanonicalBrowserPageCapturePort,
} from "../hosts/shared/canonical-browser-page-capture";
import type { CanonicalArtifactStore } from "../runtime/artifact/canonical-store";
import { CanonicalCaptureService } from "../runtime/capture/canonical-service";
import { CanonicalClientRuntime } from "../runtime/client/canonical-runtime";
import { CanonicalLibraryProjectionService } from "../runtime/library/canonical-projection";
import { CanonicalReplayService } from "../runtime/projection/canonical-replay";
import { CanonicalHostedArtifactHydrationService } from "../runtime/synchronization/canonical-hosted-artifact-hydration";
import { CanonicalHostedCompactMaterializationService } from "../runtime/synchronization/canonical-hosted-compact-materialization";
import { CanonicalHostedPullService } from "../runtime/synchronization/canonical-hosted-pull-service";
import { CanonicalHostedReplicaSetupService } from "../runtime/synchronization/canonical-hosted-replica-setup";
import { CanonicalMultiRemotePullService } from "../runtime/synchronization/canonical-multi-remote-pull-service";
import { CanonicalPullSynchronizationJobService } from "../runtime/synchronization/canonical-pull-synchronization-job-service";
import { CanonicalRemoteMaterializationLedgerService } from "../runtime/synchronization/canonical-remote-materialization-ledger-service";
import { CanonicalReplicaRemoteService } from "../runtime/synchronization/canonical-remote-service";
import { CanonicalVaultService } from "../runtime/vault/canonical-service";
import { CanonicalApplication } from "./canonical-application";
import {
  CANONICAL_APPLICATION_STATE_CHANGED,
  installCanonicalApplicationMessageHandler,
} from "./canonical-application-host";

export interface CanonicalBackgroundApplicationOptions {
  readonly vaults: CanonicalVaultService;
  readonly artifacts: CanonicalArtifactStore;
  readonly pageCapture: CanonicalBrowserPageCapturePort;
  readonly now?: () => number;
  readonly createCaptureCommandId?: () => string;
  readonly notifyStateChanged?: () => void | Promise<void>;
  readonly remotes?: Pick<CanonicalReplicaRemoteService, "list">;
  readonly hostedReplicaSetup?: Pick<CanonicalHostedReplicaSetupService, "create">;
  readonly hostedCompactMaterializer?: Pick<
    CanonicalHostedCompactMaterializationService,
    "materialize"
  >;
  readonly multiRemotePull?: Pick<CanonicalMultiRemotePullService, "pull">;
  readonly hostedArtifactHydrator?: Pick<CanonicalHostedArtifactHydrationService, "hydrate">;
}

export function createCanonicalBackgroundApplication(
  input: CanonicalBackgroundApplicationOptions,
): CanonicalApplication {
  const captures = new CanonicalCaptureService(input.vaults, input.artifacts);
  const library = new CanonicalLibraryProjectionService(input.vaults, input.artifacts);
  const runtime = new CanonicalClientRuntime(
    input.vaults,
    captures,
    library,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ...(input.remotes === undefined ? {} : { remotes: input.remotes }),
      ...(input.hostedReplicaSetup === undefined
        ? {}
        : { hostedReplicaSetup: input.hostedReplicaSetup }),
      ...(input.hostedCompactMaterializer === undefined
        ? {}
        : { hostedCompactMaterializer: input.hostedCompactMaterializer }),
      ...(input.multiRemotePull === undefined ? {} : { multiRemotePull: input.multiRemotePull }),
      ...(input.hostedArtifactHydrator === undefined
        ? {}
        : { hostedArtifactHydrator: input.hostedArtifactHydrator }),
    },
  );
  return new CanonicalApplication(
    runtime,
    input.now,
    input.pageCapture,
    input.createCaptureCommandId,
    input.notifyStateChanged,
  );
}

function browserPageCapture(): CanonicalBrowserPageCapture {
  const firefox = browser.runtime.getManifest().browser_specific_settings?.gecko !== undefined;
  return new CanonicalBrowserPageCapture(
    firefox ? new FirefoxCaptureHost() : new ChromeCaptureHost(),
    browser.runtime.getManifest().version,
  );
}

export function startCanonicalBackground(): void {
  const storage = new CanonicalIndexedDb();
  const vaults = new CanonicalVaultService(storage, NORMAL_STORAGE_REALM);
  const artifacts = new CanonicalOpfsArtifactStore();
  const remotes = new CanonicalReplicaRemoteService(storage, NORMAL_STORAGE_REALM);
  const hostedCompactMaterializer = new CanonicalHostedCompactMaterializationService({
    remotes,
    replays: new CanonicalReplayService(vaults),
    ledger: new CanonicalRemoteMaterializationLedgerService(storage, NORMAL_STORAGE_REALM),
  });
  const hostedPull = new CanonicalHostedPullService({
    remotes,
    vaults,
    jobs: new CanonicalPullSynchronizationJobService(storage, NORMAL_STORAGE_REALM),
  });
  const multiRemotePull = new CanonicalMultiRemotePullService({
    list: remotes.list.bind(remotes),
    pull: hostedPull.pull.bind(hostedPull),
  });
  const hostedArtifactHydrator = new CanonicalHostedArtifactHydrationService({
    remotes,
    vaults,
    artifacts,
  });
  const application = createCanonicalBackgroundApplication({
    vaults,
    artifacts,
    pageCapture: browserPageCapture(),
    remotes,
    hostedReplicaSetup: new CanonicalHostedReplicaSetupService({ remotes }),
    hostedCompactMaterializer,
    multiRemotePull,
    hostedArtifactHydrator,
    notifyStateChanged: () =>
      browser.runtime.sendMessage(CANONICAL_APPLICATION_STATE_CHANGED).catch(() => undefined),
  });
  installCanonicalApplicationMessageHandler(browser.runtime, application);
}

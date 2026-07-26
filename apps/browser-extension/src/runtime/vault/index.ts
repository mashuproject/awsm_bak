export type {
  DeviceKeySlotV1,
  PreparedVault,
  PrepareVaultInput,
  VaultMetadataV1,
  VaultRecordsV1,
  VaultRepository,
  VaultVerifierV1,
} from "./contracts";
export { VaultServiceError, type VaultServiceErrorId } from "./errors";
export {
  importVaultKeyring,
  importVaultRootKey,
  type VaultEpochKey,
  VaultKeyring,
} from "./keyring";
export {
  InvalidVaultNameError,
  normalizeVaultName,
  suggestVaultName,
  vaultNameComparisonKey,
} from "./name";
export {
  decodeVaultNameEvent,
  decryptVaultNameProjection,
  type PrepareVaultNameChangeInput,
  prepareVaultNameChange,
} from "./name-crypto";
export {
  reduceVaultNameProjection,
  type VaultNameEventV1,
  type VaultNameProjectionV1,
} from "./name-projection";
export { VaultService } from "./service";
export {
  type ActiveVaultContext,
  type WorkspaceContextDependencies,
  WorkspaceContextManager,
} from "./workspace-context";
export {
  createWorkspaceNameCacheKey,
  decryptWorkspaceVaultName,
  encryptWorkspaceVaultName,
  type WorkspaceVaultNameCacheV1,
} from "./workspace-name-cache";
export {
  type VaultDirectoryEntryV1,
  type VaultSummary,
  type WorkspaceBusyState,
  WorkspaceService,
  type WorkspaceServiceRepository,
  type WorkspaceState,
  type WorkspaceVaultStatus,
} from "./workspace-service";

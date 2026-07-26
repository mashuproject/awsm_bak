import { VaultKeyring } from "../../src/runtime/vault/keyring";

export const TEST_KEY_EPOCH_ID = "00000000-0000-4000-8000-000000000009";

export function testKeyring(rootKey: CryptoKey, keyEpochId = TEST_KEY_EPOCH_ID): VaultKeyring {
  return new VaultKeyring(keyEpochId, [{ keyEpochId, ordinal: 0, rootKey }]);
}

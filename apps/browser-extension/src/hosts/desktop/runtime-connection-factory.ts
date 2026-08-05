import { CanonicalIndexedDb } from "../../drivers/indexeddb/canonical-database";
import { NORMAL_STORAGE_REALM } from "../../drivers/indexeddb/canonical-schema";
import { requestDesktopRuntimePermission } from "./permission";
import { CanonicalDesktopRuntimeConnection } from "./runtime-connection";
import { CanonicalDesktopRuntimeGrantStore } from "./runtime-grant-store";

let connectionPromise: Promise<CanonicalDesktopRuntimeConnection> | undefined;

export function getDesktopRuntimeConnection(): Promise<CanonicalDesktopRuntimeConnection> {
  connectionPromise ??= createDesktopRuntimeConnection();
  return connectionPromise;
}

async function createDesktopRuntimeConnection(): Promise<CanonicalDesktopRuntimeConnection> {
  const storage = new CanonicalIndexedDb();
  const wrappingKey = await storage.getOrCreateInstallationWrappingKey(NORMAL_STORAGE_REALM);
  return new CanonicalDesktopRuntimeConnection({
    store: new CanonicalDesktopRuntimeGrantStore(storage, NORMAL_STORAGE_REALM, wrappingKey),
    requestPermission: requestDesktopRuntimePermission,
  });
}

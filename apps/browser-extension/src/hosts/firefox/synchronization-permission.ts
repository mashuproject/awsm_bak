export const FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES = [
  "websiteContent",
  "browsingActivity",
  "authenticationInfo",
  "personallyIdentifyingInfo",
] as const;

export interface FirefoxSynchronizationPermissions {
  readonly origins?: readonly string[];
  readonly data_collection?: readonly string[];
}

export interface FirefoxSynchronizationPermissionApi {
  getAll(): Promise<FirefoxSynchronizationPermissions>;
  request(permissions: {
    readonly origins?: readonly string[];
    readonly data_collection?: readonly string[];
  }): Promise<boolean>;
}

export function firefoxServerPermissionPattern(serverOrigin: string): string {
  const url = new URL(serverOrigin);
  return `${url.protocol}//${url.hostname}/*`;
}

export function hasFirefoxSynchronizationDataPermission(
  permissions: FirefoxSynchronizationPermissions,
): boolean {
  const granted = new Set(permissions.data_collection ?? []);
  return FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES.every((category) => granted.has(category));
}

export function hasFirefoxSynchronizationPermission(
  permissions: FirefoxSynchronizationPermissions,
  originPattern: string,
): boolean {
  return (
    hasFirefoxSynchronizationDataPermission(permissions) &&
    (permissions.origins ?? []).includes(originPattern)
  );
}

export async function requestFirefoxSynchronizationPermission(
  api: FirefoxSynchronizationPermissionApi,
  originPattern: string,
): Promise<boolean> {
  return requestFirefoxSynchronizationPermissions(api, [originPattern]);
}

export async function requestFirefoxSynchronizationPermissions(
  api: FirefoxSynchronizationPermissionApi,
  originPatterns: readonly string[],
): Promise<boolean> {
  const origins = [...new Set(originPatterns)].toSorted();
  if (origins.length === 0)
    throw new TypeError("At least one Firefox synchronization origin is required");
  return api.request({
    origins,
    data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES,
  });
}

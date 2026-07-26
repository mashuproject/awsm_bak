import type { AccountConfigurationV1 } from "../../drivers/indexeddb/schema";

export const HOSTED_SERVER_ORIGIN = "https://awsm.foo";

export type ServerSelectionErrorId = "SERVER_INCOMPATIBLE" | "SERVER_PERMISSION_DENIED";

class ServerSelectionError extends Error {
  constructor(readonly id: ServerSelectionErrorId) {
    super(id);
    this.name = "ServerSelectionError";
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
  );
}

export function validateServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ServerSelectionError("SERVER_INCOMPATIBLE");
  }
  const safeTransport =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (
    !safeTransport ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ServerSelectionError("SERVER_INCOMPATIBLE");
  }
  return url.origin;
}

export function serverPermissionPattern(origin: string): string {
  return `${validateServerOrigin(origin)}/*`;
}

interface ProbeResult {
  readonly status: number;
  readonly redirected: boolean;
  readonly body: unknown;
}

export interface ServerConfigurationHost {
  requestPermission(pattern: string): Promise<boolean>;
  probe(url: string): Promise<ProbeResult>;
  commit(configuration: AccountConfigurationV1): Promise<void>;
}

export interface DiscoveredServer {
  readonly serverOrigin: string;
  readonly registration:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly signUpUrl: string };
}

function compatibleInformation(
  value: unknown,
  serverOrigin: string,
): DiscoveredServer["registration"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).toSorted().join("\n") !==
      ["capabilities", "protocolVersion", "registration", "service"].toSorted().join("\n") ||
    body.service !== "AWSM Coordination Server" ||
    body.protocolVersion !== "1" ||
    typeof body.capabilities !== "object" ||
    body.capabilities === null
  )
    return undefined;
  const capabilities = body.capabilities as Record<string, unknown>;
  if (
    Object.keys(capabilities).toSorted().join("\n") !==
      [
        "accountPassword",
        "accountVaultLimit",
        "completeReplicaSynchronization",
        "deviceEnrollment",
        "deviceRevocation",
      ]
        .toSorted()
        .join("\n") ||
    capabilities.accountPassword !== true ||
    capabilities.accountVaultLimit !== 1 ||
    capabilities.completeReplicaSynchronization !== true ||
    capabilities.deviceEnrollment !== "RecoveryPhrase" ||
    capabilities.deviceRevocation !== true ||
    typeof body.registration !== "object" ||
    body.registration === null
  )
    return undefined;
  const registration = body.registration as Record<string, unknown>;
  if (registration.enabled === false && Object.keys(registration).length === 1)
    return { enabled: false };
  if (
    registration.enabled === true &&
    Object.keys(registration).toSorted().join("\n") === ["enabled", "signUpUrl"].join("\n") &&
    typeof registration.signUpUrl === "string"
  ) {
    const signUpUrl = new URL(registration.signUpUrl);
    if (signUpUrl.origin === serverOrigin && signUpUrl.pathname === "/sign_up")
      return { enabled: true, signUpUrl: signUpUrl.href };
  }
  return undefined;
}

export async function configureSyncServer(
  input: string,
  host: ServerConfigurationHost,
): Promise<AccountConfigurationV1> {
  const discovered = await discoverSyncServer(input, host);
  const configuration = { version: 1, mode: "Configured", ...discovered } as const;
  await host.commit(configuration);
  return configuration;
}

export async function validateSyncServer(
  input: string,
  host: Pick<ServerConfigurationHost, "requestPermission" | "probe">,
): Promise<DiscoveredServer> {
  return discoverSyncServer(input, host);
}

async function discoverSyncServer(
  input: string,
  host: Pick<ServerConfigurationHost, "requestPermission" | "probe">,
): Promise<DiscoveredServer> {
  const serverOrigin = validateServerOrigin(input);
  let permissionGranted = false;
  try {
    permissionGranted = await host.requestPermission(serverPermissionPattern(serverOrigin));
  } catch {
    throw new ServerSelectionError("SERVER_PERMISSION_DENIED");
  }
  if (!permissionGranted) {
    throw new ServerSelectionError("SERVER_PERMISSION_DENIED");
  }
  let response: ProbeResult;
  try {
    response = await host.probe(`${serverOrigin}/api/server-information`);
  } catch {
    throw new ServerSelectionError("SERVER_INCOMPATIBLE");
  }
  const registration = compatibleInformation(response.body, serverOrigin);
  if (response.redirected || response.status !== 200 || registration === undefined) {
    throw new ServerSelectionError("SERVER_INCOMPATIBLE");
  }
  return { serverOrigin, registration };
}

import { remoteSearchPermissionPattern } from "../../runtime/search/remote-endpoint";
import { FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES } from "../firefox/synchronization-permission";

export interface SearchProviderPermissionState {
  readonly origins?: readonly string[];
  readonly data_collection?: readonly string[];
}

export interface SearchProviderPermissionApi {
  getAll(): Promise<SearchProviderPermissionState>;
  contains?(input: { readonly origins: readonly string[] }): Promise<boolean>;
  request(input: {
    readonly origins: readonly string[];
    readonly data_collection?: readonly string[];
  }): Promise<boolean>;
}

export class SearchProviderPermission {
  readonly pattern: string;

  constructor(
    endpoint: string,
    private readonly api: SearchProviderPermissionApi,
    private readonly firefox: boolean,
  ) {
    this.pattern = remoteSearchPermissionPattern(endpoint);
  }

  async present(): Promise<boolean> {
    const permissions = await this.api.getAll();
    const originPresent =
      this.api.contains === undefined
        ? (permissions.origins ?? []).includes(this.pattern)
        : await this.api.contains({ origins: [this.pattern] });
    if (!originPresent) return false;
    if (!this.firefox) return true;
    const categories = new Set(permissions.data_collection ?? []);
    return FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES.every((category) => categories.has(category));
  }

  async acquire(): Promise<boolean> {
    if (await this.present()) return true;
    return this.api.request({
      origins: [this.pattern],
      ...(this.firefox ? { data_collection: FIREFOX_SYNCHRONIZATION_DATA_CATEGORIES } : {}),
    });
  }
}

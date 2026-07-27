export const LOCAL_MODEL_DOWNLOAD_ORIGINS = [
  "https://huggingface.co/*",
  "https://*.hf.co/*",
] as const;

export interface LocalModelPermissionApi {
  contains(permission: { readonly origins: readonly string[] }): Promise<boolean>;
  request(permission: { readonly origins: readonly string[] }): Promise<boolean>;
  remove(permission: { readonly origins: readonly string[] }): Promise<boolean>;
}

export class LocalModelDownloadPermission {
  constructor(private readonly api: LocalModelPermissionApi) {}

  async acquire(): Promise<boolean> {
    const permission = { origins: LOCAL_MODEL_DOWNLOAD_ORIGINS };
    if (await this.api.contains(permission)) return true;
    return this.api.request(permission);
  }

  release(): Promise<boolean> {
    return this.api.remove({ origins: LOCAL_MODEL_DOWNLOAD_ORIGINS });
  }
}

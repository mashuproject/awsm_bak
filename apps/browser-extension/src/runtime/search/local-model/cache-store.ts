import { DomainValidationError } from "../../../domain/errors";
import type { LocalModelGenerationPointer, LocalModelGenerationStore } from "./download";
import type { LocalMiniLmManifest } from "./manifest";

const POINTER_CACHE = "awsm-search-model-pointer-v1";
const POINTER_REQUEST = new Request("https://awsm.invalid/search-model/current");
const FILE_ORIGIN = "https://awsm.invalid/search-model/file/";

function fileRequest(path: string): Request {
  if (path.length === 0 || path.startsWith("/") || path.includes(".."))
    throw new DomainValidationError("localModel.cachePath", "is invalid");
  return new Request(`${FILE_ORIGIN}${path.split("/").map(encodeURIComponent).join("/")}`);
}

function decodePointer(value: unknown): LocalModelGenerationPointer {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("manifestId" in value) ||
    typeof value.manifestId !== "string" ||
    !("generationName" in value) ||
    typeof value.generationName !== "string" ||
    !value.generationName.startsWith("awsm-search-model-")
  )
    throw new DomainValidationError("localModel.pointer", "is invalid");
  return { manifestId: value.manifestId, generationName: value.generationName };
}

export class CacheStorageLocalModelStore implements LocalModelGenerationStore {
  constructor(private readonly storage: CacheStorage = caches) {}

  async putFile(generationName: string, path: string, response: Response): Promise<void> {
    await (await this.storage.open(generationName)).put(fileRequest(path), response);
  }

  async deleteFile(generationName: string, path: string): Promise<void> {
    await (await this.storage.open(generationName)).delete(fileRequest(path));
  }

  async promote(manifestId: string, generationName: string): Promise<void> {
    const pointer = JSON.stringify({ manifestId, generationName });
    await (await this.storage.open(POINTER_CACHE)).put(
      POINTER_REQUEST,
      new Response(pointer, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      }),
    );
  }

  async current(): Promise<LocalModelGenerationPointer | undefined> {
    const response = await (await this.storage.open(POINTER_CACHE)).match(POINTER_REQUEST);
    if (response === undefined) return undefined;
    try {
      return decodePointer(await response.json());
    } catch (error) {
      if (error instanceof DomainValidationError) throw error;
      throw new DomainValidationError("localModel.pointer", "is not valid JSON");
    }
  }

  async deleteGeneration(generationName: string): Promise<void> {
    await this.storage.delete(generationName);
  }

  async isReady(manifest: LocalMiniLmManifest): Promise<boolean> {
    const pointer = await this.current();
    if (pointer?.manifestId !== manifest.manifestId) return false;
    const generation = await this.storage.open(pointer.generationName);
    for (const file of manifest.files) {
      const response = await generation.match(fileRequest(file.path));
      if (response === undefined || response.headers.get("content-length") !== String(file.bytes))
        return false;
    }
    return true;
  }

  async file(path: string): Promise<Response | undefined> {
    const pointer = await this.current();
    if (pointer === undefined) return undefined;
    return (await this.storage.open(pointer.generationName)).match(fileRequest(path));
  }

  async deleteCurrent(): Promise<void> {
    const pointer = await this.current();
    await (await this.storage.open(POINTER_CACHE)).delete(POINTER_REQUEST);
    if (pointer !== undefined) await this.storage.delete(pointer.generationName);
  }
}

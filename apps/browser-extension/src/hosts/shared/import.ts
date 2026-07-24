import { uuid } from "../../domain/validation";

const TEMP_DIRECTORY = "awsm-vault-imports";

async function importDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TEMP_DIRECTORY, { create: true });
}

function temporaryName(jobId: string): string {
  return `${uuid(jobId, "vaultImport.jobId")}.awsm.tmp`;
}

function importStorageError(error: unknown): unknown {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? Object.assign(new Error("There is not enough local storage to import this Vault."), {
        id: "STORAGE_QUOTA_EXCEEDED",
      })
    : error;
}

export async function streamImportSource(input: {
  readonly source: Blob;
  readonly writable: Pick<FileSystemWritableFileStream, "write">;
  readonly onProgress: (acquiredBytes: number) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<number> {
  const reader = input.source.stream().getReader();
  let acquiredBytes = 0;
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      acquiredBytes += next.value.byteLength;
      if (!Number.isSafeInteger(acquiredBytes) || acquiredBytes > input.source.size) {
        throw new Error("Import source exceeded its declared byte length.");
      }
      await input.writable.write(Uint8Array.from(next.value).buffer);
      await input.onProgress(acquiredBytes);
    }
    if (acquiredBytes !== input.source.size) {
      throw new Error("Import source staging was truncated.");
    }
    return acquiredBytes;
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class VaultImportHost {
  async stage(input: {
    readonly jobId: string;
    readonly source: Blob;
    readonly onProgress: (acquiredBytes: number) => void | Promise<void>;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const directory = await importDirectory();
    const name = temporaryName(input.jobId);
    let writable: FileSystemWritableFileStream | undefined;
    try {
      const handle = await directory.getFileHandle(name, { create: true });
      writable = await handle.createWritable({ keepExistingData: false });
      await streamImportSource({
        source: input.source,
        writable,
        onProgress: input.onProgress,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      await writable.close();
      if ((await handle.getFile()).size !== input.source.size) {
        throw new Error("Import source staging was truncated.");
      }
    } catch (error) {
      await writable?.abort().catch(() => undefined);
      await directory.removeEntry(name).catch(() => undefined);
      throw importStorageError(error);
    }
  }

  async open(jobId: string): Promise<File> {
    const directory = await importDirectory();
    return (await directory.getFileHandle(temporaryName(jobId))).getFile();
  }

  async cleanup(jobId: string): Promise<void> {
    const directory = await importDirectory();
    await directory.removeEntry(temporaryName(jobId)).catch((error) => {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    });
  }
}

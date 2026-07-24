const STAGING_DIRECTORY = "awsm-temporary-files";

async function directory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(STAGING_DIRECTORY, { create: true });
}

export interface StagedPlaintextFile {
  readonly blob: Blob;
  cleanup(): Promise<void>;
}

export async function stagePlaintextFile(
  suffix: string,
  write: (output: WritableStream<Uint8Array>) => Promise<void>,
): Promise<StagedPlaintextFile> {
  const name = `${crypto.randomUUID()}${suffix}`;
  const root = await directory();
  const handle = await root.getFileHandle(name, { create: true });
  const destination = await handle.createWritable({ keepExistingData: false });
  const bridge = new TransformStream<Uint8Array, Uint8Array>();
  const pipe = bridge.readable.pipeTo(destination);
  try {
    await write(bridge.writable);
    await pipe;
    const blob = await handle.getFile();
    return {
      blob,
      cleanup: async () => {
        await root.removeEntry(name).catch((error) => {
          if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
        });
      },
    };
  } catch (error) {
    await bridge.writable.abort(error).catch(() => undefined);
    await destination.abort().catch(() => undefined);
    await root.removeEntry(name).catch(() => undefined);
    throw error;
  }
}

export async function reconcileTemporaryFiles(): Promise<void> {
  const root = await directory();
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === "file") await root.removeEntry(name);
  }
}

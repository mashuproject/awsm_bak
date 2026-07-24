import { configure, ZipWriter } from "@zip.js/zip.js";

configure({ useWebWorkers: false });

interface SyncAccessHandle {
  close(): void;
  flush(): void;
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
}

function generatedBytes(length: number): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= length) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, length - emitted);
      const chunk = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) {
        chunk[index] = (emitted + index) % 251;
      }
      emitted += size;
      controller.enqueue(chunk);
    },
  });
}

self.onmessage = async (event: MessageEvent<{ name: string; sourceBytes: number }>) => {
  const { name, sourceBytes } = event.data;
  let access: SyncAccessHandle | undefined;
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    access = await (
      handle as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncAccessHandle>;
      }
    ).createSyncAccessHandle();
    access.truncate(0);
    let offset = 0;
    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        const written = access?.write(chunk, { at: offset }) ?? 0;
        if (written !== chunk.byteLength) throw new Error("The OPFS write was incomplete.");
        offset += written;
      },
      close() {
        access?.flush();
      },
    });
    const writer = new ZipWriter(output, {
      bufferedWrite: false,
      zip64: true,
    });
    await writer.add(
      "generated.bin",
      {
        readable: generatedBytes(sourceBytes),
        size: sourceBytes,
      },
      { level: 0 },
    );
    await writer.close();
    access.close();
    access = undefined;
    self.postMessage({ size: offset });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  } finally {
    access?.close();
  }
};

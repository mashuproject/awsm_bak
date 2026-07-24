import { describe, expect, it } from "vitest";
import { streamImportSource } from "../../src/hosts/shared/import";

describe("Vault Import source streaming", () => {
  it("copies a multi-gigabyte logical source with one bounded chunk retained", async () => {
    const chunkSize = 1024 * 1024;
    const totalBytes = 4 * 1024 * 1024 * 1024 + chunkSize;
    const chunk = new Uint8Array(chunkSize);
    let writes = 0;
    let produced = 0;
    let maximumWriteBytes = 0;
    const source = {
      size: totalBytes,
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced >= totalBytes) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
            produced += chunkSize;
          },
        }),
    } as Blob;
    let progress = 0;
    await expect(
      streamImportSource({
        source,
        writable: {
          write(value) {
            const byteLength =
              value instanceof Blob
                ? value.size
                : value instanceof ArrayBuffer
                  ? value.byteLength
                  : ArrayBuffer.isView(value)
                    ? value.byteLength
                    : 0;
            maximumWriteBytes = Math.max(maximumWriteBytes, byteLength);
            writes += 1;
            return Promise.resolve();
          },
        },
        onProgress: (value) => {
          expect(value).toBeGreaterThan(progress);
          progress = value;
        },
      }),
    ).resolves.toBe(totalBytes);
    expect(progress).toBe(totalBytes);
    expect(maximumWriteBytes).toBe(chunkSize);
    expect(writes).toBe(totalBytes / chunkSize);
  });
});

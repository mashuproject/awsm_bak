import { xchachaEncrypt } from "../../crypto/xchacha";

const MAGIC = new TextEncoder().encode("AWSMTR1");
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

function decodeSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TypeError("Desktop transfer secret is invalid.");
  const binary = atob(`${value.replaceAll("-", "+").replaceAll("_", "/")}=`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== KEY_BYTES) throw new TypeError("Desktop transfer secret is invalid.");
  return bytes;
}

/** Seals a Complete Export/credential package for the one-use desktop handoff. */
export async function sealDesktopTransfer(input: {
  readonly secret: string;
  readonly plaintext: Uint8Array;
}): Promise<Uint8Array> {
  const key = decodeSecret(input.secret);
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await xchachaEncrypt({
      plaintext: input.plaintext,
      aad: MAGIC,
      nonce,
      key,
    });
    const result = new Uint8Array(MAGIC.byteLength + nonce.byteLength + ciphertext.byteLength);
    result.set(MAGIC, 0);
    result.set(nonce, MAGIC.byteLength);
    result.set(ciphertext, MAGIC.byteLength + nonce.byteLength);
    return result;
  } finally {
    key.fill(0);
  }
}

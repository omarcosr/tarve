import { createHash as createNativeHash } from "tjs:hashing";
import { Buffer } from "./buffer";

const encoder = new TextEncoder();

export function createHash(algorithm: string) {
  const hash = createNativeHash(algorithm);
  return {
    update(data: string | Uint8Array) {
      hash.update(typeof data === "string" ? encoder.encode(data) : data);
      return this;
    },
    digest(encoding?: "hex" | "base64"): any {
      const hex = hash.digest("hex");
      if (encoding === "hex") return hex;
      const bytes = Buffer.fromValue(hex, "hex");
      return encoding === "base64" ? bytes.toString("base64") : bytes;
    },
  };
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function randomBytes(size: number): Buffer {
  return Buffer.fromValue(crypto.getRandomValues(new Uint8Array(size)));
}

export default { createHash, randomBytes, randomUUID };

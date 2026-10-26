import { expect, test } from "bun:test";
import { remoteLibrary } from "./remote";

test("remote calls frame requests and copy buffer results as the C ABI does", () => {
  const response = new Uint8Array(8 + 5);
  const view = new DataView(response.buffer);
  view.setInt32(0, 5, true);
  view.setUint32(4, 5, true);
  response.set(new TextEncoder().encode("hello"), 8);
  const written: number[] = [];
  let position = 0;
  const library = remoteLibrary(-1, {
    write(source, offset, length) { written.push(...source.subarray(offset, offset + length)); return length; },
    // One byte at a time: partial reads must be completed.
    read(target, offset) { target[offset] = response[position++]!; return 1; },
  });
  const buffer = new Uint8Array(16);
  expect(library.symbols.tarve_poll_event(buffer, buffer.length)).toBe(5);
  expect(new TextDecoder().decode(buffer.subarray(0, 5))).toBe("hello");
  // op 3 (poll), payload length 4, capacity 16.
  expect(written).toEqual([3, 4, 0, 0, 0, 16, 0, 0, 0]);
});

test("a closed bridge fails instead of hanging", () => {
  const library = remoteLibrary(-1, { write: (_, __, length) => length, read: () => 0 });
  expect(() => library.symbols.tarve_abi_version()).toThrow("closed the bridge");
});

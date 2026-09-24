import { dlopen } from "bun:ffi";
export function openLibrary(path: string) {
  return dlopen(path, {
    tarve_abi_version: { args: [], returns: "u32" },
    tarve_start: { args: ["buffer", "u32"], returns: "i32" },
    tarve_send: { args: ["buffer", "u32"], returns: "i32" },
    tarve_event_pipe_name: { args: ["buffer", "u32"], returns: "i32" },
    tarve_poll_event: { args: ["buffer", "u32"], returns: "i32" },
    tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
    tarve_join: { args: [], returns: "i32" },
  } as const);
}

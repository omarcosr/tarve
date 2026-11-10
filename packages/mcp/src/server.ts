/**
 * A Model Context Protocol server (tools only) over newline-delimited JSON-RPC 2.0, the MCP
 * stdio transport. No SDK: the same code runs on Bun, Node.js and txiki.js.
 */

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations?: ToolAnnotations;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Shown to the model on initialize: what the server is for and how to use it. */
  instructions?: string;
}

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

type Id = string | number | null;
interface JsonRpcResponse { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } }

export const ErrorCode = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

/** Answers one JSON-RPC message (request or notification); `undefined` for notifications. */
export function createHandler(tools: readonly Tool[], info: ServerInfo): (message: unknown) => Promise<JsonRpcResponse | undefined> {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        };
      }
      case "ping": return {};
      case "tools/list":
        return { tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) };
      case "tools/call": {
        const tool = typeof params.name === "string" ? byName.get(params.name) : undefined;
        if (!tool) throw new RpcError(ErrorCode.invalidParams, `Unknown tool: ${String(params.name)}`);
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
        try {
          return await tool.run(args);
        } catch (error) {
          // Tool failures go to the model as results it can act on, not as protocol errors.
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }
      default: throw new RpcError(ErrorCode.methodNotFound, `Method not found: ${method}`);
    }
  }
  return async message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: ErrorCode.invalidRequest, message: "Invalid request" } };
    }
    const { id, method, params } = message as { id?: Id; method?: unknown; params?: unknown };
    // A response or a notification (initialized, cancelled): nothing to answer.
    if (typeof method !== "string") return undefined;
    if (id === undefined) return undefined;
    try {
      const result = await dispatch(method, params && typeof params === "object" ? params as Record<string, unknown> : {});
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ErrorCode.internal;
      return { jsonrpc: "2.0", id, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  };
}

export interface StdioStreams {
  input: { setEncoding?(encoding: "utf8"): unknown; on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown; on(event: "end" | "close", listener: () => void): unknown };
  output: { write(chunk: string): unknown };
}

/** Serves MCP on stdin/stdout until stdin ends. Only protocol messages go to stdout. */
export function serveStdio(tools: readonly Tool[], info: ServerInfo, streams: StdioStreams = { input: process.stdin, output: process.stdout }): Promise<void> {
  const handle = createHandler(tools, info);
  const send = (response: unknown) => { streams.output.write(JSON.stringify(response) + "\n"); };
  const decoder = new TextDecoder();
  let buffer = "";
  const pending = new Set<Promise<void>>();
  const receive = (line: string) => {
    let message: unknown;
    try { message = JSON.parse(line); } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.parse, message: "Parse error" } });
      return;
    }
    const task = (async () => {
      if (Array.isArray(message)) {
        const responses = (await Promise.all(message.map(handle))).filter(Boolean);
        if (responses.length) send(responses);
      } else {
        const response = await handle(message);
        if (response) send(response);
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  streams.input.setEncoding?.("utf8");
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (buffer.trim()) receive(buffer);
      void Promise.allSettled([...pending]).then(() => resolve());
    };
    streams.input.on("data", chunk => {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.trim()) receive(line);
      }
    });
    streams.input.on("end", finish);
    streams.input.on("close", finish);
  });
}

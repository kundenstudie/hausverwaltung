// Helper zum Bauen von Fetch-Request-Objekten für das direkte Aufrufen der
// Route-Handler (REST + MCP) im node-Testkontext — ohne laufenden HTTP-Server.

export function bearerRequest(
  rawToken: string | null,
  opts: { url?: string; method?: string; body?: unknown } = {},
): Request {
  const headers = new Headers();
  if (rawToken) headers.set("authorization", `Bearer ${rawToken}`);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(opts.url ?? "http://test.local/api/v1/me", {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export function mcpRequest(
  rawToken: string | null,
  method: string,
  params?: unknown,
): Request {
  const body = { jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) };
  return bearerRequest(rawToken, { url: "http://test.local/api/mcp", method: "POST", body });
}

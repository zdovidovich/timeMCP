#!/usr/bin/env node

// Интеграционный тест для Streamable HTTP транспорта (timeserver-http.js).
// Выполняет полный цикл: initialize -> notifications/initialized -> tools/list -> tools/call -> DELETE.

const BASE = process.env.MCP_URL || "http://127.0.0.1:3000/mcp";
const API_KEY = process.env.MCP_API_KEY || "";

function headers(sessionId) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

async function readBody(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    // берём последний data: с JSON-RPC ответом
    const datas = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    return datas;
  }
  const text = await res.text();
  return text ? [JSON.parse(text)] : [];
}

const health = await fetch(BASE.replace(/\/mcp$/, "/health"));
console.log("HEALTH", health.status, await health.json());

// 1. initialize
let res = await fetch(BASE, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }),
});
const sessionId = res.headers.get("mcp-session-id");
const [initResult] = await readBody(res);
console.log("INITIALIZE", res.status, "session:", sessionId);
console.log("server:", initResult?.result?.serverInfo, "proto:", initResult?.result?.protocolVersion);
if (!sessionId) throw new Error("No Mcp-Session-Id header!");

// 2. initialized notification
res = await fetch(BASE, {
  method: "POST",
  headers: headers(sessionId),
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
console.log("NOTIFY", res.status);

// 3. tools/list
res = await fetch(BASE, {
  method: "POST",
  headers: headers(sessionId),
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
});
const [listResult] = await readBody(res);
console.log("TOOLS", listResult?.result?.tools?.map((t) => t.name));

// 4. tools/call get_current_time
res = await fetch(BASE, {
  method: "POST",
  headers: headers(sessionId),
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_current_time", arguments: { format: "utc" } },
  }),
});
const [callResult] = await readBody(res);
console.log("CALL", callResult?.result?.content?.[0]?.text);

// 5. tools/call format_timestamp
res = await fetch(BASE, {
  method: "POST",
  headers: headers(sessionId),
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "format_timestamp", arguments: { timestamp: 1703097600000, format: "iso" } },
  }),
});
const [call2] = await readBody(res);
console.log("CALL2", call2?.result?.content?.[0]?.text);

// 6. POST без session id -> 400
res = await fetch(BASE, {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
});
console.log("NO_SESSION_STATUS", res.status);

// 7. DELETE сессии
res = await fetch(BASE, { method: "DELETE", headers: headers(sessionId) });
console.log("DELETE", res.status);

// 8. После DELETE сессия неизвестна -> 404
res = await fetch(BASE, {
  method: "POST",
  headers: headers(sessionId),
  body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
});
console.log("AFTER_DELETE_STATUS", res.status);

// 9. Проверка аутентификации (если задан MCP_API_KEY)
if (API_KEY) {
  // без токена -> 401
  const noAuthHeaders = headers();
  delete noAuthHeaders["Authorization"];
  res = await fetch(BASE, {
    method: "POST",
    headers: noAuthHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} }),
  });
  console.log("NO_AUTH_STATUS", res.status);
  if (res.status !== 401) throw new Error("Expected 401 without token!");

  // с неверным токеном -> 401
  res = await fetch(BASE, {
    method: "POST",
    headers: { ...headers(), Authorization: "Bearer wrong-key-123" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize", params: {} }),
  });
  console.log("BAD_AUTH_STATUS", res.status);
  if (res.status !== 401) throw new Error("Expected 401 with wrong token!");
} else {
  console.log("AUTH_TESTS SKIPPED (MCP_API_KEY not set)");
}

console.log("ALL OK");

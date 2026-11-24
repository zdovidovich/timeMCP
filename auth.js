// Общий middleware аутентификации по API-ключу для HTTP-транспортов MCP.
//
// Ключ читается из переменной окружения MCP_API_KEY (или TIME_API_KEY).
// Если переменная не задана — аутентификация отключена (сервер работает открыто).
//
// Клиент подключается со стандартным заголовком:
//   Authorization: Bearer <MCP_API_KEY>
//
// Дополнительно поддерживаются (для удобства):
//   X-API-Key: <MCP_API_KEY>
//   ?api_key=<MCP_API_KEY>  (query-параметр — полезно для GET/DELETE /mcp в браузере)

import { timingSafeEqual } from "crypto";

export const API_KEY_ENV = "MCP_API_KEY";

function getExpectedKey() {
  const key = process.env[API_KEY_ENV] || process.env.TIME_API_KEY;
  return key && key.trim() ? key.trim() : null;
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function extractToken(req) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }
  const xkey = req.headers["x-api-key"];
  if (typeof xkey === "string" && xkey.trim()) return xkey.trim();
  const q = req.query?.api_key;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

/**
 * Express-middleware: проверяет Bearer-токен, если задан MCP_API_KEY.
 * health-check (/health) всегда доступен без ключа.
 */
export function bearerAuth(req, res, next) {
  const expected = getExpectedKey();

  if (!expected) {
    // Аутентификация не настроена — пропускаем, но предупреждаем один раз.
    if (!bearerAuth._warned) {
      bearerAuth._warned = true;
      console.warn(
        `[auth] ${API_KEY_ENV} is not set — server runs WITHOUT authentication. ` +
          `Set ${API_KEY_ENV} to require "Authorization: Bearer <key>".`
      );
    }
    return next();
  }

  if (req.path === "/health") return next();

  const token = extractToken(req);
  if (token && safeEqual(token, expected)) return next();

  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid API key" },
    id: null,
  });
}

export function authStatus() {
  return getExpectedKey() ? "enabled" : "disabled";
}

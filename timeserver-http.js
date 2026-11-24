#!/usr/bin/env node

// MCP Time Server — транспорт Streamable HTTP (спецификация MCP 2025-03-26).
// Единая точка входа /mcp:
//   POST   /mcp  — JSON-RPC сообщения клиента (initialize, tools/list, tools/call и т.д.)
//   GET    /mcp  — серверный SSE-поток для данной сессии (опционально)
//   PUT    /mcp  — возобновление/изменение потока
//   DELETE /mcp  — завершение сессии
// Идентификатор сессии передаётся в заголовке Mcp-Session-Id.
//
// Аутентификация: если задана переменная окружения MCP_API_KEY, все запросы
// к /mcp должны содержать заголовок  Authorization: Bearer <MCP_API_KEY>.
// Без переменной сервер работает открыто (в лог выводится предупреждение).
//
// Старый вариант на основе SSE сохранён в timeserver-sse.js.

import { randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTimeTools } from "./timeserver-streamable-tools.js";
import { bearerAuth, authStatus, API_KEY_ENV } from "./auth.js";

const SERVER_NAME = "time-server";
const SERVER_VERSION = "0.2.0";

function createMcpServer() {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerTimeTools(server);
  return server;
}

class TimeServerStreamableHTTP {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;

    // Карта активных сессий: sessionId -> { server, transport }
    this.sessions = new Map();

    this.setupExpress();
  }

  setupExpress() {
    // Enable CORS for all routes.
    // Разрешаем заголовок сессии и учим браузерные клиенты его читать.
    this.app.use(
      cors({
        origin: "*",
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "X-API-Key", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
        exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
      })
    );

    // Health check endpoint (всегда доступен без ключа)
    this.app.get("/health", (req, res) => {
      res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        transport: "streamable-http",
        auth: authStatus(),
        sessions: this.sessions.size,
      });
    });

    // Аутентификация по API-ключу: Authorization: Bearer <MCP_API_KEY>.
    // Если MCP_API_KEY не задан — middleware пропускает все запросы.
    this.app.use(bearerAuth);

    // Парсим JSON-тело POST-запросов, чтобы проверять тип сообщения (initialize)
    this.app.use(express.json());

    // MCP Streamable HTTP endpoint
    this.app.post("/mcp", (req, res) => this.handlePost(req, res));
    this.app.get("/mcp", (req, res) => this.handleAny(req, res));
    this.app.delete("/mcp", (req, res) => this.handleAny(req, res));
  }

  async handlePost(req, res) {
    const sessionId = req.headers["mcp-session-id"];

    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // Новая сессия создаётся только по запросу initialize.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, { server, transport });
        console.log(`Session initialized: ${sid}`);
      },
    });

    // Закрываем MCP-сервер и удаляем сессию, когда закрывается транспорт.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.sessions.has(sid)) {
        console.log(`Transport closed for session: ${sid}`);
        this.sessions.get(sid).server.close().catch(() => {});
        this.sessions.delete(sid);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);

    // Проверяем, что это initialize-запрос (одиночный или пакет из нескольких сообщений).
    const body = req.body;
    const isInitialize = Array.isArray(body)
      ? body.some((m) => isInitializeRequest(m))
      : isInitializeRequest(body);

    if (!isInitialize) {
      if (sessionId) {
        // Запрос со неизвестной/просроченной сессией
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found or terminated" },
          id: body?.id ?? null,
        });
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: body?.id ?? null,
        });
      }
      await server.close().catch(() => {});
      return;
    }

    await transport.handleRequest(req, res, body);
  }

  async handleAny(req, res) {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const session = this.sessions.get(sessionId);
    await session.transport.handleRequest(req, res);
  }

  run() {
    this.httpServer = this.app.listen(this.port, "0.0.0.0", () => {
      console.log(`MCP Time Server (Streamable HTTP) running on http://0.0.0.0:${this.port}`);
      console.log(`Health check:  http://0.0.0.0:${this.port}/health`);
      console.log(`MCP endpoint:  http://0.0.0.0:${this.port}/mcp`);
      console.log(
        authStatus() === "enabled"
          ? `Auth: REQUIRED (Authorization: Bearer <${API_KEY_ENV}>)`
          : `Auth: DISABLED (set ${API_KEY_ENV} to require an API key)`
      );
    });

    const shutdown = () => {
      console.log("Shutting down...");
      for (const { server, transport } of this.sessions.values()) {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      }
      this.httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

const server = new TimeServerStreamableHTTP();
server.run();

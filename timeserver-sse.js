// Старый вариант MCP Time Server на основе транспорта HTTP + SSE
// (спецификация MCP 2024-11-05, устаревшая).
//
// GET  /sse — открытие SSE-потока; сервер присылает event "endpoint" с URL для POST
// POST /messages?sessionId=... — JSON-RPC сообщения клиента
//
// Актуальный вариант — Streamable HTTP: см. timeserver-http.js

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { registerTimeTools } from "./timeserver-streamable-tools.js";
import { bearerAuth, authStatus, API_KEY_ENV } from "./auth.js";

class TimeServerSSE {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.transport = null;

    this.server = new Server(
      {
        name: "time-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    registerTimeTools(this.server);
    this.setupExpress();
  }

  setupExpress() {
    // Enable CORS for all routes (Authorization должен быть разрешён для Bearer-токена)
    this.app.use(
      cors({
        origin: "*",
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "X-API-Key"],
      })
    );
    this.app.use(express.json());

    // Health check endpoint (всегда доступен без ключа)
    this.app.get("/health", (req, res) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString(), transport: "sse", auth: authStatus() });
    });

    // Аутентификация по API-ключу: Authorization: Bearer <MCP_API_KEY>
    this.app.use(bearerAuth);
  }

  async run() {
    // Establish SSE connection on GET /mcp
    this.app.get("/mcp", async (req, res) => {
      if (this.transport) {
        res.status(409).send("SSE connection already established (single-session server)");
        return;
      }
      this.transport = new SSEServerTransport("/messages", res);
      await this.server.connect(this.transport);
    });

    // Handle POST messages for the established SSE session
    this.app.post("/messages", async (req, res) => {
      if (!this.transport) {
        res.status(500).send("SSE connection not established");
        return;
      }
      await this.transport.handlePostMessage(req, res);
    });

    // Start Express server
    this.app.listen(this.port, "0.0.0.0", () => {
      console.log(`MCP Time Server (legacy SSE) running on http://0.0.0.0:${this.port}`);
      console.log(`Health check: http://0.0.0.0:${this.port}/health`);
      console.log(`SSE endpoint: http://0.0.0.0:${this.port}/mcp`);
      console.log(`POST messages: http://0.0.0.0:${this.port}/messages?sessionId=...`);
      console.log(
        authStatus() === "enabled"
          ? `Auth: REQUIRED (Authorization: Bearer <${API_KEY_ENV}>)`
          : `Auth: DISABLED (set ${API_KEY_ENV} to require an API key)`
      );
    });
  }
}

const server = new TimeServerSSE();
server.run().catch(console.error);

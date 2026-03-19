/**
 * Host-side MCP Bridge.
 *
 * Manages a Unix domain socket for container communication and
 * an HTTP/SSE connection to the real remote MCP server.
 * Gates tools/call and resources/read via the permission system.
 */
import fs from 'node:fs';
import net from 'node:net';

import { logger } from './logger.js';
import { checkPermissionRule } from './permission-rule-engine/rule-engine.js';
import { generateRuleProposal } from './permission-rule-generator.js';
import type { PermissionRequest } from './credential-proxy.js';

export interface BridgeConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpBridgeDeps {
  sendPermissionRequest: (req: PermissionRequest) => Promise<number | null>;
  groupFolder: string;
  chatJid: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingPermission {
  resolve: (decision: 'allow' | 'deny') => void;
  timeout: ReturnType<typeof setTimeout>;
}

const AUTO_ALLOW_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'prompts/list',
  'prompts/get',
  'notifications/initialized',
]);

const GATED_METHODS = new Set(['tools/call', 'resources/read']);

const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface McpBridge {
  handleJsonRpc: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  resolvePermission: (requestId: string, decision: string) => void;
  /** Start listening on a Unix socket. Returns cleanup function. */
  listen: (socketPath: string) => Promise<() => void>;
  /** Cached tools list from handshake (for Haiku context). */
  readonly toolsList: unknown[] | null;
}

export function createMcpBridge(
  config: BridgeConfig,
  deps: McpBridgeDeps,
): McpBridge {
  const pendingPermissions = new Map<string, PendingPermission>();
  let toolsList: unknown[] | null = null;

  function resolvePermission(requestId: string, decision: string): void {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingPermissions.delete(requestId);
    pending.resolve(decision === 'deny' ? 'deny' : 'allow');
  }

  function buildSubject(
    method: string,
    params: Record<string, unknown>,
  ): string {
    if (method === 'tools/call') {
      const toolName =
        typeof params.name === 'string' ? params.name : '<unknown>';
      return `mcp__${config.name}__${toolName}`;
    }
    if (method === 'resources/read') {
      const uri =
        typeof params.uri === 'string' ? params.uri : '<unknown>';
      return `mcp__${config.name}__resource:${uri}`;
    }
    return `mcp__${config.name}__${method}`;
  }

  async function checkPermission(
    method: string,
    params: Record<string, unknown>,
  ): Promise<'allow' | 'deny'> {
    const subject = buildSubject(method, params);

    // Check rule engine first
    const ruleDecision = checkPermissionRule('mcp', subject, deps.groupFolder);
    if (ruleDecision) return ruleDecision;

    // No rule match — send Telegram approval
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Generate Haiku rule proposal eagerly (before sending Telegram message)
    const proposal = await generateRuleProposal('mcp', subject);

    const decisionPromise = new Promise<'allow' | 'deny'>((resolve) => {
      const timeout = setTimeout(() => {
        pendingPermissions.delete(requestId);
        resolve('deny');
      }, PERMISSION_TIMEOUT_MS);
      pendingPermissions.set(requestId, { resolve, timeout });
    });

    try {
      await deps.sendPermissionRequest({
        requestId,
        egressType: 'mcp',
        subject,
        groupFolder: deps.groupFolder,
        chatJid: deps.chatJid,
        proposal,
        toolInput: method === 'tools/call' ? params.arguments : params,
      });
    } catch (err) {
      logger.error({ requestId, err }, 'Failed to send MCP permission request');
      resolvePermission(requestId, 'deny');
    }

    return decisionPromise;
  }

  async function forwardToUpstream(
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    // TODO Task 5: implement HTTP/SSE forwarding to remote MCP server
    // For now, return a placeholder error
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: 'Upstream forwarding not yet implemented',
      },
    };
  }

  async function handleJsonRpc(
    request: JsonRpcRequest,
  ): Promise<JsonRpcResponse> {
    const { method, params } = request;

    // Auto-allow safe methods
    if (AUTO_ALLOW_METHODS.has(method)) {
      const response = await forwardToUpstream(request);
      // Cache tools list for Haiku context
      if (method === 'tools/list' && response.result) {
        const result = response.result as { tools?: unknown[] };
        toolsList = result.tools ?? null;
      }
      return response;
    }

    // Gate tools/call and resources/read
    if (GATED_METHODS.has(method)) {
      const decision = await checkPermission(
        method,
        (params ?? {}) as Record<string, unknown>,
      );
      if (decision === 'deny') {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32600,
            message: `Permission denied: ${buildSubject(method, (params ?? {}) as Record<string, unknown>)}`,
          },
        };
      }
      return forwardToUpstream(request);
    }

    // Unknown methods — forward without gating
    return forwardToUpstream(request);
  }

  async function listen(socketPath: string): Promise<() => void> {
    // Clean up stale socket
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }

    const server = net.createServer((conn) => {
      conn.on('error', (err) => {
        logger.error({ err, name: config.name }, 'Bridge: connection error');
      });

      let buffer = '';
      let processing = false;
      const pendingLines: string[] = [];

      async function processLine(line: string): Promise<void> {
        try {
          const request = JSON.parse(line) as JsonRpcRequest;
          const response = await handleJsonRpc(request);
          conn.write(`${JSON.stringify(response)}\n`);
        } catch (err) {
          logger.error({ err }, 'Bridge: failed to process JSON-RPC message');
        }
      }

      async function drain(): Promise<void> {
        if (processing) return;
        processing = true;
        while (pendingLines.length > 0) {
          const nextLine = pendingLines.shift();
          if (nextLine !== undefined) {
            await processLine(nextLine);
          }
        }
        processing = false;
      }

      conn.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          pendingLines.push(line);
        }
        void drain();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, resolve);
    });

    logger.info({ name: config.name, socketPath }, 'MCP bridge listening');

    return () => {
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      for (const [, pending] of pendingPermissions) {
        clearTimeout(pending.timeout);
        pending.resolve('deny');
      }
      pendingPermissions.clear();
    };
  }

  return {
    handleJsonRpc,
    resolvePermission,
    listen,
    get toolsList() {
      return toolsList;
    },
  };
}

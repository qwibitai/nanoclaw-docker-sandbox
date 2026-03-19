/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Permission approval:
 *   When `approvalCallbacks` is passed, all non-Anthropic traffic requires
 *   explicit approval via Telegram. HTTP and HTTPS (CONNECT) are both handled.
 */

import fs from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type RequestOptions,
  type Server,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { DATA_DIR } from './config.js';
import { insertPermissionRule } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  checkPermissionRule,
  type EgressType,
} from './permission-rule-engine/rule-engine.js';
import {
  generateRuleProposal,
  type RuleProposal,
} from './permission-rule-generator.js';

// Create proxy agent for upstream HTTPS requests if proxy env vars are set
const envProxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY;
const upstreamProxyAgent = envProxyUrl
  ? new HttpsProxyAgent(envProxyUrl)
  : undefined;

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export interface PermissionRequest {
  requestId: string;
  egressType: EgressType;
  subject: string; // Full URL or hostname:port
  groupFolder: string;
  chatJid: string;
  proposal: RuleProposal | null;
  /** Tool input / arguments for MCP gated calls (optional, used for display). */
  toolInput?: unknown;
}

export interface PermissionApprovalCallbacks {
  /** Returns the group folder and chatJid for the container making the request.
   *  The proxy has no direct way to know which container's request it is
   *  (containers connect via host.docker.internal), so the host passes a resolver. */
  resolveGroup: (
    remoteAddress: string,
  ) => { groupFolder: string; chatJid: string } | null;
  /** Send a 3-button (or 2-button if proposal is null) Telegram message.
   *  Returns the Telegram message ID so it can be tracked for restart cleanup. */
  sendPermissionRequest: (req: PermissionRequest) => Promise<number | null>;
  /** Called when a Telegram button is tapped. */
  onPermissionResponse: (
    requestId: string,
    decision: 'once' | 'always' | 'deny',
    proposal: RuleProposal | null,
    groupFolder: string,
  ) => void;
}

// ---------------------------------------------------------------------------
// Pending messages log (restart cleanup)
// ---------------------------------------------------------------------------

const PENDING_PROXY_MESSAGES_FILE = path.join(
  DATA_DIR,
  'pending-proxy-messages.jsonl',
);

interface PendingProxyMessage {
  messageId: number;
  chatJid: string;
  requestId: string;
  ts: string;
}

function appendPendingMessage(entry: PendingProxyMessage): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_PROXY_MESSAGES_FILE), {
      recursive: true,
    });
    fs.appendFileSync(
      PENDING_PROXY_MESSAGES_FILE,
      `${JSON.stringify(entry)}\n`,
      'utf-8',
    );
  } catch {
    // Non-critical — do not let logging failures break the proxy
  }
}

export function clearPendingProxyMessages(): void {
  try {
    fs.writeFileSync(PENDING_PROXY_MESSAGES_FILE, '', 'utf-8');
  } catch {
    /* ignore */
  }
}

export function loadPendingProxyMessages(): PendingProxyMessage[] {
  try {
    const content = fs.readFileSync(PENDING_PROXY_MESSAGES_FILE, 'utf-8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PendingProxyMessage);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Permission approval
// ---------------------------------------------------------------------------

const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface PendingPermission {
  resolve: (decision: 'allow' | 'deny') => void;
  egressType: EgressType;
  proposal: RuleProposal | null;
  groupFolder: string;
}

/** Pending permission requests: requestId → pending data */
const pendingPermissions = new Map<string, PendingPermission>();

// ---------------------------------------------------------------------------
// Unified permission resolver registry
// ---------------------------------------------------------------------------
// Both the proxy (for HTTP/HTTPS) and MCP bridges register their resolvers
// here. When a Telegram button is tapped, handleProxyPermissionResponse checks
// both the proxy's own pendingPermissions and this registry.

/** Metadata stored alongside a registered resolver. */
export interface PermissionResolverEntry {
  resolve: (decision: 'allow' | 'deny') => void;
  egressType: EgressType;
  proposal: RuleProposal | null;
  groupFolder: string;
}

const permissionResolverRegistry = new Map<string, PermissionResolverEntry>();

/** Register a permission resolver so Telegram callbacks can route to it. */
export function registerPermissionResolver(
  requestId: string,
  entry: PermissionResolverEntry,
): void {
  permissionResolverRegistry.set(requestId, entry);
}

/** @internal — exposed for tests only. */
export function _getRegistrySize(): number {
  return permissionResolverRegistry.size;
}

/** Called by Telegram callback handler when a button is tapped */
export function resolvePermission(
  requestId: string,
  decision: 'allow' | 'deny',
): void {
  pendingPermissions.get(requestId)?.resolve(decision);
  pendingPermissions.delete(requestId);
}

export async function checkWithApproval(
  egressType: EgressType,
  subject: string,
  groupFolder: string,
  chatJid: string,
  callbacks: PermissionApprovalCallbacks,
): Promise<'allow' | 'deny'> {
  // Check rule engine first
  const ruleDecision = checkPermissionRule(egressType, subject, groupFolder);
  if (ruleDecision !== undefined) {
    return ruleDecision;
  }

  // No matching rule — call Haiku then send Telegram
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const proposal = await generateRuleProposal(egressType, subject);

  const messageId = await callbacks.sendPermissionRequest({
    requestId,
    egressType,
    subject,
    groupFolder,
    chatJid,
    proposal,
  });

  if (messageId !== null) {
    appendPendingMessage({
      messageId,
      chatJid,
      requestId,
      ts: new Date().toISOString(),
    });
  }

  // Block until response or timeout
  return new Promise<'allow' | 'deny'>((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestId);
      resolve('deny');
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(requestId, {
      resolve: (decision) => {
        clearTimeout(timer);
        resolve(decision);
      },
      egressType,
      proposal,
      groupFolder,
    });
  });
}

// ---------------------------------------------------------------------------
// Tunnel helper (used by both passthrough and approved CONNECT)
// ---------------------------------------------------------------------------

function openTunnel(
  host: string,
  clientSocket: import('stream').Duplex,
  head: Buffer,
): void {
  const [targetHost, targetPortStr] = host.split(':');
  const targetPort = parseInt(targetPortStr ?? '443', 10);
  const targetSocket = net.connect(targetPort, targetHost, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });
  targetSocket.on('error', () => {
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
  });
  clientSocket.on('error', () => targetSocket.destroy());
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  approvalCallbacks: PermissionApprovalCallbacks,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  function isAnthropicHost(reqHost: string): boolean {
    return (
      reqHost === 'api.anthropic.com' ||
      (upstreamUrl.hostname !== '' && reqHost === upstreamUrl.hostname)
    );
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // Determine target host for permission check.
        // Direct requests (URL starts with '/') are always Anthropic API calls
        // routed via ANTHROPIC_BASE_URL — never subject to permission checks.
        // HTTP proxy requests (absolute URL) may be external traffic to gate.
        const reqHost = (req.headers.host ?? '').split(':')[0] ?? '';
        const isDirectApiRequest = (req.url ?? '').startsWith('/');
        const isAnthropicReq = isDirectApiRequest || isAnthropicHost(reqHost);

        // Permission check for non-Anthropic HTTP traffic
        if (!isAnthropicReq) {
          const group = approvalCallbacks.resolveGroup(
            req.socket.remoteAddress ?? '',
          );
          if (!group) {
            logger.warn(
              { url: req.url },
              'Permission check: cannot resolve group, denying HTTP request',
            );
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }

          const fullUrl = `http://${req.headers.host ?? reqHost}${req.url ?? '/'}`;
          const decision = await checkWithApproval(
            'http',
            fullUrl,
            group.groupFolder,
            group.chatJid,
            approvalCallbacks,
          );

          if (decision === 'deny') {
            res.writeHead(403);
            res.end('Forbidden');
            return;
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers.connection;
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers.authorization) {
            delete headers.authorization;
            if (oauthToken) {
              headers.authorization = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
            agent: isHttps ? upstreamProxyAgent : undefined,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    // CONNECT handler for HTTPS tunneling
    server.on('connect', async (req, clientSocket: net.Socket, head) => {
      const connectHost = req.url ?? '';

      // Allow Anthropic API through without permission check
      const connectHostname = connectHost.split(':')[0] ?? '';
      const isAnthropicConnect =
        isAnthropicHost(connectHostname) ||
        connectHostname === upstreamUrl.hostname;

      if (isAnthropicConnect) {
        openTunnel(connectHost, clientSocket, head);
        return;
      }

      const group = approvalCallbacks.resolveGroup(
        clientSocket.remoteAddress ?? '',
      );
      if (!group) {
        logger.warn(
          { host: connectHost },
          'Permission check: cannot resolve group, denying CONNECT',
        );
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      const decision = await checkWithApproval(
        'connect',
        connectHost,
        group.groupFolder,
        group.chatJid,
        approvalCallbacks,
      );

      if (decision === 'deny') {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }

      openTunnel(connectHost, clientSocket, head);
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Handle a permission approval response from Telegram.
 * Called when a user taps a button on a proxy permission message.
 * 'always' persists the rule to the DB; 'once' just allows this request.
 */
export function handleProxyPermissionResponse(
  requestId: string,
  decision: 'once' | 'always' | 'deny',
): void {
  // Check proxy's own pending map first (existing behavior)
  const proxyPending = pendingPermissions.get(requestId);
  // Also check the unified registry (for bridge permissions)
  const registryEntry = permissionResolverRegistry.get(requestId);

  const pending = proxyPending ?? registryEntry;

  if (decision === 'always' && pending?.proposal) {
    insertPermissionRule({
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      egress_type: pending.egressType,
      pattern: pending.proposal.pattern,
      effect: 'allow',
      scope: pending.proposal.scope,
      group_folder:
        pending.proposal.scope === 'group' ? pending.groupFolder : null,
      description: pending.proposal.description,
      source: 'telegram',
      created_at: new Date().toISOString(),
    });
  }

  const resolved: 'allow' | 'deny' = decision !== 'deny' ? 'allow' : 'deny';

  if (proxyPending) {
    resolvePermission(requestId, resolved);
  }
  if (registryEntry) {
    permissionResolverRegistry.delete(requestId);
    registryEntry.resolve(resolved);
  }
}

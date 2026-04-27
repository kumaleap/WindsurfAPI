/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, removeAccount,
} from './auth.js';
import { handleChatCompletions } from './handlers/chat.js';
import { handleMessages, handleCountTokens } from './handlers/messages.js';
import { handleModels } from './handlers/models.js';
import { handleResponses } from './handlers/responses.js';
import { handleDashboardApi } from './dashboard/api.js';
import { config, log, hasDashboardPassword } from './config.js';
import { VERSION_INFO } from './version-info.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_SIZE = 10 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function extractToken(req) {
  // Anthropic SDK + OAI SDK compatibility: accept either header.
  const authHeader = (req.headers['authorization'] || '').trim();
  if (authHeader) return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  const apiKeyHeader = (req.headers['x-api-key'] || '').trim();
  if (apiKeyHeader) return apiKeyHeader;

  return '';
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  });
  res.end(data);
}

function prepareStreamResponse(req, res) {
  req.socket?.setNoDelay?.(true);
  req.socket?.setKeepAlive?.(true, 30_000);
  res.flushHeaders?.();
}

function isDashboardAccessEnabled() {
  return !!(hasDashboardPassword() || config.apiKey || config.allowOpenDashboard);
}

function writeDashboardDisabledPage(res) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard Disabled</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0b1020; color:#e5e7eb; margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; }
    .card { max-width:720px; width:100%; background:#111827; border:1px solid #374151; border-radius:16px; padding:24px; box-sizing:border-box; }
    h1 { margin:0 0 12px; font-size:24px; }
    p { margin:0 0 10px; line-height:1.6; color:#cbd5e1; }
    code { background:#1f2937; padding:2px 6px; border-radius:6px; color:#f9fafb; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Dashboard 已禁用</h1>
    <p>当前未设置 <code>DASHBOARD_PASSWORD</code> 或 <code>API_KEY</code>，因此 dashboard 默认不对外开放。</p>
    <p>如需启用，请在环境变量中设置其中任一认证项；只有明确设置 <code>ALLOW_OPEN_DASHBOARD=true</code> 时，才允许无认证访问。</p>
  </div>
</body>
</html>`;
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function route(req, res) {
  const { method } = req;
  const path = req.url.split('?')[0];

  if (method === 'OPTIONS') return json(res, 204, '');
  if (path === '/health') {
    return json(res, 200, {
      status: 'ok',
      version: VERSION_INFO.version,
      uptime: Math.round(process.uptime()),
    });
  }

  // ─── Dashboard ─────────────────────────────────────────
  // Silent 204 for favicon — browsers request it from every page; otherwise
  // the later Bearer-token check produces noise in the dashboard console.
  if (path === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  if (path === '/dashboard' || path === '/dashboard/') {
    if (!isDashboardAccessEnabled()) return writeDashboardDisabledPage(res);
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(html);
    } catch {
      return json(res, 500, { error: 'Dashboard not found' });
    }
  }

  if (path.startsWith('/dashboard/api/')) {
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        const rawBody = await readBody(req);
        body = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch (err) {
        if (err?.statusCode === 413) return json(res, 413, { error: 'Request body too large' });
        return json(res, 400, { error: 'Invalid JSON' });
      }
    }
    const subpath = path.slice('/dashboard/api'.length);
    return handleDashboardApi(method, subpath, body, req, res);
  }

  if (path === '/auth/status' || path === '/auth/accounts' || path.startsWith('/auth/accounts/') || path === '/auth/login') {
    if (!validateApiKey(extractToken(req))) {
      return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
    }
  }

  // ─── Auth management (admin API key required) ─────────

  if (path === '/auth/status') {
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  if (path === '/auth/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // DELETE /auth/accounts/:id
  if (path.startsWith('/auth/accounts/') && method === 'DELETE') {
    const id = path.split('/')[3];
    const ok = removeAccount(id);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err?.statusCode === 413) return json(res, 413, { error: 'Request body too large' });
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // Support batch: { accounts: [{email,password}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
            let result;
            if (acct.api_key) {
              result = addAccountByKey(acct.api_key, acct.label);
            } else if (acct.token) {
              result = await addAccountByToken(acct.token, acct.label);
            } else if (acct.email && acct.password) {
              result = await addAccountByEmail(acct.email, acct.password);
            } else {
              results.push({ error: 'Missing credentials' });
              continue;
            }
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else if (body.email && body.password) {
        account = await addAccountByEmail(body.email, body.password);
      } else {
        return json(res, 400, { error: 'Provide api_key, token, or email+password' });
      }

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      return json(res, 401, { error: err.message });
    }
  }

  // ─── API endpoints (require API key) ────────────────────

  if (!validateApiKey(extractToken(req))) {
    return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if ((path === '/v1/responses' || path === '/responses') && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err?.statusCode === 413) {
        return json(res, 413, { error: { message: 'Request body too large', type: 'invalid_request' } });
      }
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }

    const result = await handleResponses(body);
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      prepareStreamResponse(req, res);
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err?.statusCode === 413) {
        return json(res, 413, { error: { message: 'Request body too large', type: 'invalid_request' } });
      }
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request' } });
    }
    if (body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages must contain at least 1 item', type: 'invalid_request' } });
    }

    const result = await handleChatCompletions(body);
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      prepareStreamResponse(req, res);
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  // Anthropic Messages API — Claude Code compatibility
  if (path === '/v1/messages/count_tokens' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, { type: 'error', error: { type: 'api_error', message: 'No active accounts' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err?.statusCode === 413) {
        return json(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: 'Request body too large' } });
      }
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    const result = handleCountTokens(body);
    return json(res, result.status, result.body);
  }

  // Anthropic Messages API — Claude Code compatibility
  if (path === '/v1/messages' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, { type: 'error', error: { type: 'api_error', message: 'No active accounts' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err?.statusCode === 413) {
        return json(res, 413, { type: 'error', error: { type: 'invalid_request_error', message: 'Request body too large' } });
      }
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } });
    }
    const result = await handleMessages(body);
    if (result.stream) {
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      prepareStreamResponse(req, res);
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found' } });
}

export function startServer() {
  const activeRequests = new Set();

  const server = http.createServer(async (req, res) => {
    activeRequests.add(res);
    res.on('close', () => activeRequests.delete(res));
    try {
      await route(req, res);
    } catch (err) {
      log.error('Handler error:', err);
      if (!res.headersSent) {
        if (err?.statusCode === 413) {
          json(res, 413, { error: { message: 'Request body too large', type: 'invalid_request' } });
        } else {
          json(res, 500, { error: { message: 'Internal error', type: 'server_error' } });
        }
      }
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let retryCount = 0;
  const maxRetries = 10;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > maxRetries) {
        log.error(`Port ${config.port} still in use after ${maxRetries} retries. Exiting.`);
        process.exit(1);
      }
      log.warn(`Port ${config.port} in use, retry ${retryCount}/${maxRetries} in 3s...`);
      setTimeout(() => server.listen(config.port, '0.0.0.0'), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: '0.0.0.0' }, () => {
    log.info(`Server on http://0.0.0.0:${config.port}`);
    log.info('  POST /v1/chat/completions');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login          (add account)');
    log.info('  GET  /auth/accounts       (list accounts)');
    log.info('  DELETE /auth/accounts/:id (remove account)');
  });
  return server;
}

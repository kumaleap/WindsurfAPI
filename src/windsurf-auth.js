import http from 'http';
import https from 'https';
import { parseFields, writeBoolField, writeStringField } from './proto.js';

const WINDSURF_POST_AUTH_URL = new URL('https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth');
const WINDSURF_GET_CURRENT_USER_URL = new URL('https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetCurrentUser');

function createProxyTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.host.replace(/:\d+$/, '');
    const proxyPort = proxy.port || 8080;
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
        ...(proxy.username ? {
          'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}`,
        } : {}),
      },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      }
    });
    req.on('error', (err) => reject(new Error(`Proxy tunnel: ${err.message}`)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Proxy tunnel timeout'));
    });
    req.end();
  });
}

function isDevinContext(auth) {
  return auth.token.startsWith('devin-session-token$')
    || !!auth.devinAuth1Token
    || !!auth.devinAccountId
    || !!auth.devinPrimaryOrgId;
}

function authHeaders(auth) {
  const headers = {
    'x-auth-token': auth.token,
  };
  if (isDevinContext(auth)) {
    headers['x-devin-session-token'] = auth.token;
    if (auth.devinAccountId) headers['x-devin-account-id'] = auth.devinAccountId;
    if (auth.devinAuth1Token) headers['x-devin-auth1-token'] = auth.devinAuth1Token;
    if (auth.devinPrimaryOrgId) headers['x-devin-primary-org-id'] = auth.devinPrimaryOrgId;
  }
  return headers;
}

function trimConnectEnvelope(buf) {
  if (buf.length <= 5) return buf;
  const declared = buf.readUInt32BE(1);
  if ((buf[0] & 0x7e) === 0 && declared > 0 && declared + 5 === buf.length) {
    return buf.subarray(5);
  }
  return buf;
}

function postProto(url, body, { proxy = null, headers = {} } = {}) {
  return new Promise(async (resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/proto',
        Origin: 'https://windsurf.com',
        Referer: 'https://windsurf.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Length': body.length,
        ...headers,
      },
    };

    const onRes = (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(bufs),
          headers: res.headers,
        });
      });
      res.on('error', reject);
    };

    try {
      let req;
      if (proxy && proxy.host) {
        const socket = await createProxyTunnel(proxy, url.hostname, 443);
        opts.socket = socket;
        opts.agent = false;
        req = https.request(opts, onRes);
      } else {
        req = https.request(opts, onRes);
      }
      req.on('error', (err) => reject(new Error(`Request: ${err.message}`)));
      req.setTimeout(20000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

function readStringField(fields, num) {
  const field = fields.find(f => f.field === num && f.wireType === 2);
  return field ? field.value.toString('utf8') : '';
}

function parseOrg(payload) {
  const fields = parseFields(payload);
  const id = readStringField(fields, 1);
  if (!id) return null;
  return {
    id,
    name: readStringField(fields, 2),
  };
}

function parsePostAuthResponse(body) {
  const fields = parseFields(trimConnectEnvelope(body));
  const sessionToken = readStringField(fields, 1);
  if (!sessionToken) throw new Error('WindsurfPostAuth response missing session_token');
  return {
    sessionToken,
    orgs: fields
      .filter(f => f.field === 2 && f.wireType === 2)
      .map(f => parseOrg(f.value))
      .filter(Boolean),
    auth1Token: readStringField(fields, 3) || null,
    accountId: readStringField(fields, 4) || null,
    primaryOrgId: readStringField(fields, 5) || null,
  };
}

function parseCurrentUserResponse(body) {
  const fields = parseFields(trimConnectEnvelope(body));
  const userMessage = fields.find(f => f.field === 1 && f.wireType === 2);
  const teamMessage = fields.find(f => f.field === 4 && f.wireType === 2);
  const statusMessage = fields.find(f => f.field === 6 && f.wireType === 2);
  const userFields = userMessage ? parseFields(userMessage.value) : [];
  const teamFields = teamMessage ? parseFields(teamMessage.value) : [];
  const statusFields = statusMessage ? parseFields(statusMessage.value) : [];

  const email = readStringField(userFields, 3);
  if (!email) throw new Error('GetCurrentUser response missing email');

  const planName = [2, 3, 4, 5, 6, 7]
    .map(n => readStringField(statusFields, n) || readStringField(teamFields, n))
    .find(v => v && !v.includes('@')) || '';

  return {
    email,
    apiKey: readStringField(userFields, 1),
    name: readStringField(userFields, 2) || email.split('@')[0] || '',
    userId: readStringField(userFields, 6) || '',
    teamId: readStringField(teamFields, 1) || readStringField(userFields, 7) || '',
    planName,
  };
}

export async function windsurfPostAuth(auth1Token, { orgId = '', proxy = null } = {}) {
  const body = Buffer.concat([
    writeStringField(1, auth1Token),
    orgId ? writeStringField(2, orgId) : Buffer.alloc(0),
  ]);
  const res = await postProto(WINDSURF_POST_AUTH_URL, body, {
    proxy,
    headers: {
      Referer: 'https://windsurf.com/account/login',
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WindsurfPostAuth HTTP ${res.status}`);
  }
  return parsePostAuthResponse(res.body);
}

export async function windsurfGetCurrentUser(auth, { proxy = null } = {}) {
  const body = Buffer.concat([
    writeStringField(1, auth.token),
    writeBoolField(2, true),
    writeBoolField(3, true),
    writeBoolField(4, true),
  ]);
  const res = await postProto(WINDSURF_GET_CURRENT_USER_URL, body, {
    proxy,
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      Priority: 'u=1, i',
      'x-debug-email': '',
      'x-debug-team-name': '',
      ...authHeaders(auth),
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GetCurrentUser HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
  }
  return parseCurrentUserResponse(res.body);
}

export async function resolveWindsurfAuthToken(inputToken, { proxy = null } = {}) {
  const token = String(inputToken || '').trim();
  if (!token) throw new Error('Missing auth string');

  if (token.startsWith('auth1_')) {
    const postAuth = await windsurfPostAuth(token, { proxy });
    const effectiveAuth1 = postAuth.auth1Token || token;
    const auth = {
      token: postAuth.sessionToken,
      devinAuth1Token: effectiveAuth1,
      devinAccountId: postAuth.accountId || null,
      devinPrimaryOrgId: postAuth.primaryOrgId || postAuth.orgs[0]?.id || null,
    };
    const user = await windsurfGetCurrentUser(auth, { proxy });
    return {
      provider: 'auth1',
      authToken: effectiveAuth1,
      sessionToken: postAuth.sessionToken,
      devinAccountId: auth.devinAccountId,
      devinPrimaryOrgId: auth.devinPrimaryOrgId,
      orgs: postAuth.orgs,
      ...user,
    };
  }

  if (token.startsWith('devin-session-token$')) {
    const auth = { token };
    const user = await windsurfGetCurrentUser(auth, { proxy });
    return {
      provider: 'session',
      authToken: token,
      sessionToken: token,
      devinAccountId: null,
      devinPrimaryOrgId: null,
      orgs: [],
      ...user,
    };
  }

  throw new Error('Unsupported auth string. Expected auth1_... or devin-session-token$...');
}

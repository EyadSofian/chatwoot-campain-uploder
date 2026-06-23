import express from 'express';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registerJobRoutes } from './jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CHATWOOT_URL = (process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, '');
const CHATWOOT_API_TOKEN = (process.env.CHATWOOT_API_TOKEN || '').trim();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,api_access_token,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api/jobs', express.json({ limit: '25mb' }));
registerJobRoutes(app);

app.use('/api/chatwoot', express.json({ limit: '1mb' }));

const SAFE_SERVER_CHATWOOT_ROUTES = [
  { method: 'GET', pattern: /^\/accounts\/\d+\/labels$/ },
  { method: 'GET', pattern: /^\/accounts\/\d+\/inboxes$/ },
  { method: 'GET', pattern: /^\/accounts\/\d+\/inboxes\/\d+$/ },
  { method: 'POST', pattern: /^\/accounts\/\d+\/inboxes\/\d+\/sync_templates$/ },
  { method: 'GET', pattern: /^\/accounts\/\d+\/inbox_members\/\d+$/ },
  { method: 'GET', pattern: /^\/accounts\/\d+\/teams$/ }
];

function isSafeServerChatwootRoute(method, pathName) {
  return SAFE_SERVER_CHATWOOT_ROUTES.some((route) => (
    route.method === method.toUpperCase() && route.pattern.test(pathName)
  ));
}

app.all('/api/chatwoot/*', async (req, res) => {
  try {
    const pathName = `/${req.params[0] || ''}`;
    if (!isSafeServerChatwootRoute(req.method, pathName)) {
      return res.status(404).json({ error: 'Unsupported Chatwoot server route' });
    }
    if (!CHATWOOT_API_TOKEN) {
      return res.status(500).json({ error: 'CHATWOOT_API_TOKEN is not configured on the server' });
    }

    const chatwootRes = await fetch(`${CHATWOOT_URL}/api/v1${pathName}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: CHATWOOT_API_TOKEN
      },
      body: ['GET', 'HEAD'].includes(req.method.toUpperCase()) ? undefined : JSON.stringify(req.body || {})
    });
    const text = await chatwootRes.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    res.status(chatwootRes.status).json(data);
  } catch (err) {
    console.error('Server Chatwoot API error:', err.message);
    res.status(502).json({ error: 'Server Chatwoot API error', message: err.message });
  }
});

app.use(express.static(join(__dirname, '../public')));

app.use('/api/v1', (req, res) => {
  const targetUrl = new URL(CHATWOOT_URL);
  const isHttps = targetUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: '/api/v1' + req.url,
    method: req.method,
    headers: { ...req.headers, host: targetUrl.hostname }
  };
  const proxy = lib.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Proxy error', message: err.message });
  });
  req.pipe(proxy, { end: true });
});

app.listen(PORT, () => console.log(`Running on port ${PORT} → ${CHATWOOT_URL}`));

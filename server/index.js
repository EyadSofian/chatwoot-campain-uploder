import express from 'express';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const CHATWOOT_URL = (process.env.CHATWOOT_URL || 'https://chat.engosoft.com').replace(/\/$/, '');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,api_access_token,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
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

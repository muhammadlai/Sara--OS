#!/usr/bin/env node
/**
 * Voice Center — local control surface for the Voice Worker.
 * Serves the existing dashboard plus /api/voice* for live status and approval.
 * Bind 0.0.0.0 so Arena / LAN previews work. Browser uses same-origin /api.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceWorker, summarizeJob } from './voice-worker.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DASH = join(ROOT, 'dashboard');
const PORT = Number(process.env.VOICE_CENTER_PORT || process.env.PORT || 8787);
const HOST = process.env.VOICE_CENTER_HOST || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  const file = normalize(join(DASH, rel.replace(/^\//, '')));
  if (!file.startsWith(DASH) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

const worker = createVoiceWorker({
  configPath: join(ROOT, 'workspace/voice.yaml'),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/voice') {
      return json(res, 200, await worker.status());
    }
    if (req.method === 'GET' && url.pathname === '/api/voice/jobs') {
      return json(res, 200, worker.store.listJobs().map(summarizeJob));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/voice/jobs/')) {
      const id = url.pathname.split('/').pop();
      const job = worker.store.readJob(id);
      return job ? json(res, 200, job) : json(res, 404, { error: 'job_not_found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/voice/request') {
      const body = await readBody(req);
      return json(res, 200, worker.requestVoice(body));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/approve')) {
      const id = url.pathname.split('/')[4];
      return json(res, 200, await worker.approve(id));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/generate')) {
      const id = url.pathname.split('/')[4];
      return json(res, 200, await worker.generate(id));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/cancel')) {
      const id = url.pathname.split('/')[4];
      return json(res, 200, await worker.cancel(id));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/edit')) {
      const id = url.pathname.split('/')[4];
      const body = await readBody(req);
      return json(res, 200, await worker.edit(id, body.text || body.response_text || ''));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/deliver')) {
      const id = url.pathname.split('/')[4];
      const body = await readBody(req);
      return json(res, 200, worker.deliver(id, body));
    }
    serveStatic(req, res, url);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Voice Center http://${HOST}:${PORT}`);
});

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore, initRepository } from './store.mjs';

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.join(SOURCE_ROOT, 'dashboard');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/assets/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
  '/assets/dashboard.js': ['dashboard.js', 'application/javascript; charset=utf-8'],
};

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendStatic(response, file, contentType) {
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  fs.createReadStream(path.join(ASSET_ROOT, file)).pipe(response);
}

export function createDashboardServer({ repo }) {
  const initialized = initRepository(repo);
  const store = new EventStore(initialized.repo);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'method not allowed' });
    if (requestUrl.pathname === '/api/overview') {
      return sendJson(response, 200, {
        repo: initialized.repo,
        generatedAt: new Date().toISOString(),
        summary: store.dashboardSummary(),
        tasks: store.listTasks({ limit: 500 }),
        events: store.recentEvents({ limit: 300 }),
        refs: store.refs(),
      });
    }
    const asset = STATIC_FILES[requestUrl.pathname];
    if (asset) return sendStatic(response, ...asset);
    return sendJson(response, 404, { error: 'not found' });
  });
  server.once('close', () => store.close());
  return server;
}

export async function startDashboard({ repo, host = '127.0.0.1', port = 3210 }) {
  const server = createDashboardServer({ repo });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return { server, url: `http://${host}:${address.port}` };
}

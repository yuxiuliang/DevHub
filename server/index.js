import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { handleApi } from './api.js';
import { ROOT } from './store.js';
import { detectWorkers } from './adapters.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 7373);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (await handleApi(req, res, url)) return;
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(WEB, path));
    if (!file.startsWith(WEB)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.stack || e));
    }
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  // 启动时探测一次，让 dsh 这类不在 PATH 上的 CLI 也能被解析到绝对路径
  detectWorkers().catch(() => {});
  console.log('');
  console.log('  DevHub 已启动');
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log('');
  console.log('  数据目录: ' + join(ROOT, '.data'));
  console.log('  Ctrl+C 停止');
  console.log('');
});

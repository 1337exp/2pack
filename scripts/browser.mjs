// Run the in-browser check: compile the library and the spec vectors to plain JS, copy the page next to them,
// serve the folder on localhost and print the address. Open it in any browser; the tab title says PASS or FAIL.
//   npm run browser            (port 4173, or a free one if it is taken; PORT=5000 to choose)
// Собирает библиотеку и эталонные векторы в JS, кладёт рядом страницу и отдаёт папку на localhost.
// Откройте адрес в любом браузере: заголовок вкладки покажет PASS или FAIL.
//
// Browsers refuse ES modules from file://, hence the tiny server. No dependencies: Node's http only.

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.browser');

rmSync(out, { recursive: true, force: true });
execSync('npx tsc -p tsconfig.browser.json', { cwd: root, stdio: 'inherit' });
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'check.js']) copyFileSync(join(root, 'examples', 'browser', f), join(out, f));

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file = join(out, normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    if (!file.startsWith(out)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    try {
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(await readFile(file));
    } catch {
        res.writeHead(404).end('not found');
    }
});

const announce = () => console.log(`\n2pack browser check: http://localhost:${server.address().port}\nCtrl+C to stop.`);
server.once('error', () => server.listen(0, '127.0.0.1', announce)); // the port was taken: ask the OS for a free one
server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', announce);

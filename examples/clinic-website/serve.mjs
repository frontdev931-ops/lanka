import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const clean = (value) => String(value ?? '').replace(/[^A-Za-z0-9_:/.-]/g, '');
export function createFixture(lankaUrl, formKey) {
  const html = page.replaceAll('__LANKA_URL__', clean(lankaUrl)).replaceAll('__FORM_KEY__', clean(formKey));
  return createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && path === '/original-submit') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const fields = new URLSearchParams(body);
      const success = fields.get('form_fields[message]') !== 'reject fixture';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success }));
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    res.writeHead(404).end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4100);
  createFixture(process.env.LANKA_URL ?? 'http://localhost:3000', process.env.FORM_KEY)
    .listen(port, '127.0.0.1', () => console.log(`Form fixture at http://localhost:${port}`));
}

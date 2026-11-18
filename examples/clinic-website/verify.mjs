import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createFixture } from './serve.mjs';

test('Elementor copies only accepted submissions to the local test API', async (t) => {
  const lanka = new URL(process.env.TEST_LANKA_URL);
  assert(['localhost', '127.0.0.1'].includes(lanka.hostname), 'Use a local LANKA test instance');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  const site = new URL(`http://127.0.0.1:${process.env.FIXTURE_PORT ?? 43117}`);

  async function api(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(new URL(`/backend${path}`, lanka), {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  const { accessToken: token } = await api('/auth/register', {
    method: 'POST',
    body: {
      acceptTerms: true, clinicName: 'Form fixture', name: 'Test owner',
      email: `fixture-${crypto.randomUUID()}@example.com`, password: 'fixture-only-password',
    },
  });
  const { formKey } = await api('/automations/leads', { method: 'PATCH', token, body: { enabled: true, origins: [site.origin] } });
  const fixture = createFixture(lanka.origin, formKey);
  fixture.listen(Number(site.port), site.hostname);
  await once(fixture, 'listening');
  t.after(() => { fixture.close(); });

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const attempts = [];
  let lankaUnavailable = false;
  await page.route(`**/backend/leads/${formKey}`, async (route) => {
    const body = new URLSearchParams(route.request().postData());
    attempts.push(body);
    if (lankaUnavailable) {
      await route.fulfill({ status: 503, json: { message: 'Fixture outage' }, headers: { 'Access-Control-Allow-Origin': site.origin } });
    } else {
      await route.continue();
    }
  });
  let originalRequests = 0;
  page.on('request', (request) => {
    if (request.url() === new URL('/original-submit', site).href) originalRequests++;
  });
  await page.addInitScript(() => {
    window.copyEvents = [];
    for (const name of ['lanka:sent', 'lanka:failed']) {
      document.addEventListener(name, (event) => window.copyEvents.push({ name, detail: event.detail }));
    }
  });
  await page.goto(new URL('/?utm_source=google&utm_medium=cpc&utm_campaign=fixture&token=private#hidden', site).href, {
    referer: 'https://referrer.example/path?token=private',
  });
  const form = page.locator('[data-id="4229aa4d"] form');
  const message = form.getByLabel('Message');
  const submit = form.getByRole('button', { name: 'Send' });
  const originalShows = (text) => form.locator('output').getByText(text, { exact: true }).waitFor();
  const copyEvent = async (count, name) => {
    await page.waitForFunction((length) => window.copyEvents.length >= length, count);
    const event = await page.evaluate((index) => window.copyEvents[index], count - 1);
    assert.equal(event.name, name);
    return event.detail;
  };
  const inquiries = async () => (await api('/inquiries', { token })).rows;
  async function fill(text) {
    await form.getByLabel('Name', { exact: true }).fill('Fixture Visitor');
    await form.getByLabel('Phone').fill('0501112233');
    await message.fill(text);
  }

  await submit.click();
  assert.equal(await form.locator(':invalid').count(), 2);
  assert.equal(originalRequests, 0);
  await fill('reject fixture');
  await submit.click();
  await originalShows('Original form rejected');
  const other = page.locator('[data-id="ba0657"] form');
  await other.getByRole('button').click();
  await other.getByText('Original form accepted', { exact: true }).waitFor();
  assert.equal(attempts.length, 0);
  assert.equal((await inquiries()).length, 0);

  await fill('Consultation fixture');
  await form.getByLabel('Unmapped field').fill('private-other-field');
  await submit.click();
  await originalShows('Original form accepted');
  const first = await copyEvent(1, 'lanka:sent');
  assert(first.id && !first.duplicate);
  assert.equal(await message.inputValue(), '');
  assert.equal(attempts.length, 1);
  const params = attempts[0];
  const originalId = params.get('submission_id');
  assert(originalId);
  params.delete('submission_id');
  assert.deepEqual(Object.fromEntries(params), {
    form_id: '4229aa4d', page_url: site.href, referrer: 'https://referrer.example',
    name: 'Fixture Visitor', phone: '0501112233', message: 'Consultation fixture',
    utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fixture',
  });
  params.set('submission_id', originalId);
  const [row] = await inquiries();
  assert(row);
  assert.deepEqual(
    [row.id, row.formId, row.via, row.landing, row.utmSource, row.utmCampaign],
    [first.id, '4229aa4d', 'WEBSITE_FORM', site.href, 'google', 'fixture'],
  );

  // Replaying the browser payload exercises server idempotency with a new HTTP request.
  const retry = await fetch(new URL(`/backend/leads/${formKey}`, lanka), {
    method: 'POST', headers: { Origin: site.origin }, body: params,
  });
  assert.deepEqual(await retry.json(), { ok: true, id: first.id, duplicate: true });
  assert.equal((await inquiries()).length, 1);

  await fill('Consultation fixture');
  await submit.click();
  const second = await copyEvent(2, 'lanka:sent');
  assert(second.id && second.id !== first.id && !second.duplicate);
  assert.equal((await inquiries()).length, 2);

  lankaUnavailable = true;
  await fill('Consultation during outage');
  await submit.click();
  await originalShows('Original form accepted');
  assert.equal(await message.inputValue(), '');
  assert.equal((await copyEvent(3, 'lanka:failed')).status, 503);
  assert.equal(attempts.length, 4);
  assert.equal(attempts[2].get('submission_id'), attempts[3].get('submission_id'));
  assert.equal((await inquiries()).length, 2);
});

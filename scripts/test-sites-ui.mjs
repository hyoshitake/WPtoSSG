import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const base = 'http://localhost:3000';
try {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${base}/list`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  const api = await fetch(`${base}/api/sites`);
  assert.equal(api.status, 200);
  assert.ok(Array.isArray((await api.json()).sites));
  assert.equal((await fetch(`${base}/api/sites/issue18-missing`)).status, 404);
  let release;
  await page.route('**/api/sites', async route => {
    await new Promise(r => { release = r; });
    await route.fulfill({ json: { sites: [] } });
  });
  await page.goto(`${base}/list`);
  await page.getByRole('status').waitFor();
  while (!release) await new Promise(r => setTimeout(r, 10));
  release();
  await page.getByText('保存済みのサイトはありません。', { exact: false }).waitFor();
  await page.unroute('**/api/sites');
  await page.route('**/api/sites', route => route.fulfill({ status: 503, json: { error: '取得失敗テスト' } }));
  await page.reload();
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: '再試行' }).waitFor();
  const version = { id: 'v1', jobId: 'j1', siteKey: 'example-com', source: 'conversion', savedAt: '2026-01-01T00:00:00Z', report: { successCount: 2, failedCount: 1, warnings: 1 }, diagnostic: { riskLevel: 'medium', reasons: ['フォームを検出'], evidence: [{ type: 'selector', location: '#contact' }] } };
  await page.route('**/api/sites/example-com', route => route.fulfill({ json: { name: 'example.com', siteKey: 'example-com', siteUrl: 'https://example.com', latest: version, versions: [version] } }));
  await page.goto(`${base}/list/example-com`);
  await page.getByText('フォームを検出', { exact: true }).waitFor();
  await page.getByText('selector: #contact', { exact: true }).waitFor();
  assert.equal(await page.getByText('成果物を利用できません', { exact: false }).count(), 2);
  await page.getByRole('link', { name: 'このサイトを編集', exact: false }).click();
  await page.getByText('対象サイト: example-com', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '編集を開始（準備中）' }).isDisabled(), true);
  console.log('sites API and UI: passed');
} finally { await browser.close(); }

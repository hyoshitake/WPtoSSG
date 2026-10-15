import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readPublicSite } from '../apps/worker/dist/publicSite.js';
import { rotateAndWriteLocal } from '../apps/worker/dist/localOutput.js';

const root = await mkdtemp(path.join(tmpdir(), 'wptossg-public-'));
const siteKey = 'example-com';
const options = { localOutputDir: root, sites: [
  { siteKey, siteUrl: 'https://example.com/', latest: { artifactBackend: 'local' } },
] };
const file = (relativePath, content, mimeType = 'text/html') => ({ relativePath, content: Buffer.from(content), mimeType });
const read = (url = '', archive) => readPublicSite('example.com', url, archive, options);
const firstFiles = [
  file('example.com/index.html', '<h1>old</h1><a href="about.html">about</a><img src="../assets/image.png">'),
  file('example.com/about.html', '<a href="index.html">home</a><a href="https://external.test/">external</a>'),
  file('assets/style.css', 'a {background:url(image.png)}', 'text/css'),
  file('assets/main.js', 'import "./module.js";', 'text/javascript'),
  file('assets/module.js', 'export const version = "old";', 'text/javascript'),
  file('assets/image.png', [0, 1, 2, 255], 'image/png'),
  file('public-routes.json', JSON.stringify({ 'example.com/about.html': '/about/' }), 'application/json'),
];
try {
  process.env.GOOGLE_DRIVE_ENABLED = 'false';
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  await rotateAndWriteLocal('first', { siteKey, files: firstFiles, outputDir: root });
  let result = await read();
  assert.match(result.mime, /^text\/html/);
  assert.match(result.body.toString(), /<h1>old<\/h1>/);
  assert.match(result.body.toString(), /href="\/sites\/example.com\/about\/"/);
  assert.match((await read('about/')).body.toString(), /https:\/\/external.test\//);
  assert.equal((await read('assets/style.css')).mime, 'text/css; charset=utf-8');
  assert.equal((await read('assets/main.js')).mime, 'text/javascript; charset=utf-8');
  assert.deepEqual((await read('assets/image.png')).body, Buffer.from([0, 1, 2, 255]));

  const second = await rotateAndWriteLocal('second', {
    siteKey, files: [file('example.com/index.html', '<h1>new</h1>')], outputDir: root,
    archiveTimestamp: '2026-10-15T00:00:00.000Z',
  });
  const archive = path.basename(second.archiveFolderId);
  assert.match((await read()).body.toString(), /<h1>new<\/h1>/);
  result = await read('', archive);
  assert.match(result.body.toString(), /<h1>old<\/h1>/);
  assert.match(result.body.toString(), new RegExp(`/about/\\?archive=${archive}`));
  assert.match(result.body.toString(), new RegExp(`/assets/image.png\\?archive=${archive}`));
  assert.match((await read('about/', archive)).body.toString(), new RegExp(`index.html\\?archive=${archive}`));
  assert.match((await read('assets/style.css', archive)).body.toString(), new RegExp(`image.png\\?archive=${archive}`));
  assert.match((await read('assets/main.js', archive)).body.toString(), new RegExp(`module.js\\?archive=${archive}`));
  assert.deepEqual((await read('assets/image.png', archive)).body, Buffer.from([0, 1, 2, 255]));
  assert.equal(await read('', 'missing'), undefined);
  assert.equal(await read('assets/style.css'), undefined); // Never mix archived and current files.
  assert.equal(await read('missing/'), undefined);
  assert.equal(await read('../secret'), undefined);
  assert.equal(await read('', '../current'), undefined);
  assert.equal(await readPublicSite('unknown.test', '', undefined, options), undefined);

  const current = path.join(root, 'sites', siteKey, 'current');
  await writeFile(path.join(root, 'secret.txt'), 'secret');
  await symlink(path.join(root, 'secret.txt'), path.join(current, 'leak.txt'));
  assert.equal(await read('leak.txt'), undefined);
  await symlink(root, path.join(current, 'outside'));
  assert.equal(await read('outside/secret.txt'), undefined);
  await symlink(root, path.join(root, 'sites', siteKey, 'archive', 'outside'));
  assert.equal(await read('secret.txt', 'outside'), undefined);

  // Old outputs that predate public-routes.json remain readable without regeneration.
  await rm(path.join(root, 'sites', siteKey, 'archive', archive, 'public-routes.json'));
  assert.match((await read('', archive)).body.toString(), /<h1>old<\/h1>/);
  await mkdir(path.join(current, 'assets'), { recursive: true });
  await symlink('loop.css', path.join(current, 'assets', 'loop.css'));
  await assert.rejects(read('assets/loop.css'), { code: 'ELOOP' });
  console.log('Local hosting: latest/archive, HTML/CSS/JS/images, legacy outputs, isolation and errors passed');
} finally {
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { rewritePublicContent, safeSegments } from '../apps/worker/dist/publicSite.js';
import { rotateAndUpload } from '../apps/worker/dist/driveUpload.js';

const html = rewritePublicContent(`<a href="about.html">About</a><a href="https://outside.test/a">External</a>
<img src="../assets/image.png"><img srcset="../assets/a.png 1x, ../assets/b.png 2x">
<link href="/wp-content/style.css"><style>a {background:url(../assets/bg.png)}</style>`,
  'text/html', 'example.com', 'example.com/index.html', '2026-10-15');
assert.match(html, /href="\/sites\/example.com\/about.html\?archive=2026-10-15"/);
assert.match(html, /src="\/sites\/example.com\/assets\/image.png\?archive=2026-10-15"/);
assert.match(html, /https:\/\/outside.test\/a/);
assert.match(html, /\/sites\/example.com\/wp-content\/style.css\?archive=2026-10-15/);
assert.match(html, /assets\/a.png\?archive=2026-10-15 1x/);
assert.match(html, /assets\/bg.png\?archive=2026-10-15/);
const css = rewritePublicContent('@import "sub.css";a{background:url(../img/a.png)}', 'text/css', 'example.com', 'assets/css/style.css', 'old');
assert.match(css, /assets\/css\/sub.css\?archive=old/);
assert.match(css, /assets\/img\/a.png\?archive=old/);
for (const path of ['../secret', 'a/../b', 'a\\b', 'a/\0b']) assert.throws(() => safeSegments(path));

// In-memory Drive verifies visibility during upload and publication/rollback.
function fakeDrive(failUpload = false, failPublish = false) {
  const nodes = new Map([
    ['sites', { name: 'sites', parent: 'root', mimeType: 'application/vnd.google-apps.folder' }],
    ['site', { name: 'example-com', parent: 'sites', mimeType: 'application/vnd.google-apps.folder', appProperties: { publishedFolderId: 'old' } }],
    ['old', { name: 'current', parent: 'site', mimeType: 'application/vnd.google-apps.folder' }],
  ]);
  let sequence = 0;
  return { nodes, files: {
    async get({ fileId }) { return { data: nodes.get(fileId) }; },
    async list({ q }) {
      const parent = q.match(/^'([^']+)'/)[1];
      const name = q.match(/name\s*=\s*'([^']+)'/)[1];
      return { data: { files: [...nodes].filter(([, n]) => n.parent === parent && n.name === name).map(([id, node]) => ({ id, mimeType: node.mimeType })) } };
    },
    async create({ requestBody, media }) {
      assert.equal(nodes.get('site').appProperties.publishedFolderId, 'old');
      if (media && failUpload) throw new Error('upload failed');
      const id = `new-${++sequence}`;
      nodes.set(id, { ...requestBody, parent: requestBody.parents[0] });
      return { data: { id } };
    },
    async update({ fileId, requestBody, addParents }) {
      if (requestBody?.appProperties && failPublish) throw new Error('switch failed');
      Object.assign(nodes.get(fileId), requestBody, addParents ? { parent: addParents } : {});
      return { data: { id: fileId } };
    },
  } };
}
process.env.GOOGLE_DRIVE_ENABLED = 'true';
for (const [failUpload, failPublish] of [[false, false], [true, false], [false, true]]) {
  const drive = fakeDrive(failUpload, failPublish);
  const result = await rotateAndUpload('job', { siteKey: 'example-com', files: [
    { relativePath: 'example.com/index.html', content: Buffer.from('hello'), mimeType: 'text/html' },
  ], driveClient: drive, rootFolderId: 'root', retryDelayMs: 0 });
  assert.equal(drive.nodes.get('old').name, 'current');
  assert.equal(drive.nodes.get('site').appProperties.publishedFolderId, 'old');
  if (failUpload) { assert.equal(result.publish, undefined); continue; }
  if (failPublish) {
    await assert.rejects(result.publish());
    assert.equal(drive.nodes.get('old').name, 'current');
    assert.equal(drive.nodes.get('site').appProperties.publishedFolderId, 'old');
  } else {
    await result.publish();
    assert.equal(drive.nodes.get('site').appProperties.publishedFolderId, result.currentFolderId);
    assert.equal(result.archiveFolderId, 'old');
    assert.equal(drive.nodes.get('old').parent, [...drive.nodes].find(([, n]) => n.name === 'archive')[0]);
  }
}
console.log('public site rewriting, traversal, upload isolation, publication and rollback passed');

const { readPublicSite } = await import('../apps/worker/dist/publicSite.js');
const reader = fakeDrive();
reader.nodes.get('old').appProperties = undefined;
reader.nodes.set('html', { name: 'index.html', parent: 'host', mimeType: 'text/html' });
reader.nodes.set('host', { name: 'example.com', parent: 'old', mimeType: 'application/vnd.google-apps.folder' });
reader.files.get = async ({ fileId, alt }) => alt === 'media'
  ? { data: Buffer.from('<h1>published</h1>') }
  : { data: reader.nodes.get(fileId) };
const options = { driveClient: reader, rootFolderId: 'root', sites: [
  { siteKey: 'example-com', siteUrl: 'https://example.com/', latest: { artifactBackend: 'google-drive' } },
] };
assert.match((await readPublicSite('example.com', '', undefined, options)).body.toString(), /published/);
assert.equal(await readPublicSite('example.com', '', 'missing', options), undefined);
assert.equal(await readPublicSite('example.com', '', '', options), undefined);
assert.equal(await readPublicSite('example.com', '../secret', undefined, options), undefined);
assert.equal(await readPublicSite('missing.test', '', undefined, options), undefined);
assert.equal(await readPublicSite('example.com', '/missing/', undefined, options), undefined);
reader.nodes.set('archives', { name: 'archive', parent: 'site', mimeType: 'application/vnd.google-apps.folder' });
reader.nodes.get('old').parent = 'archives';
reader.nodes.get('old').name = 'v1';
assert.match((await readPublicSite('example.com', '', 'v1', options)).body.toString(), /published/);
// Current remains available by its published ID while the folder is being rotated.
assert.match((await readPublicSite('example.com', '', undefined, options)).body.toString(), /published/);
assert.equal(await readPublicSite('example.com', '', '../old', options), undefined);
reader.files.list = async () => { throw new Error('Drive unavailable'); };
await assert.rejects(readPublicSite('example.com', '', undefined, options), /Drive unavailable/);
console.log('Drive reader: current, missing archive/site/file, traversal and outage passed');
const mapped = rewritePublicContent('<a href="about.html">about</a><img src="/wp-content/pic.png">',
  'text/html', 'example.com', 'example.com/index.html', 'v1', {
    'example.com/about.html': '/about/', 'wp-content/pic.png': '/assets/wp-content/pic.png',
  });
assert.match(mapped, /\/sites\/example.com\/about\/\?archive=v1/);
assert.match(mapped, /\/sites\/example.com\/assets\/wp-content\/pic.png\?archive=v1/);

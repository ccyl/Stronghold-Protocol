import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAssetUrls, createAssetDownload } from '../../public/js/assetDownload.js';
import { sha256Hex16, modelHashOf } from '../../public/js/assetPack.js';

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const file = () => new Response('asset', { headers: { 'content-type': 'application/octet-stream' } });
function fixture(assets, get, local = { groups: {} }, fx = null, sources = null) {
  return async (url, options) => url === '/data/assets.json' ? json(assets)
    : url === '/data/local-assets.json' ? local === null ? new Response('', { status: 404 }) : json(local)
      : url === '/data/local-fx.json' ? fx === null ? new Response('', { status: 404 }) : json(fx)
        // No source map unless a test supplies one: the queue then takes every file from this server, as before.
        : url === '/data/asset-sources.json' ? sources === null ? new Response('', { status: 404 }) : json(sources)
          : get(url, options);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('all model pages/local scenes/fonts are deduplicated; audio matches the playback URL', () => {
  const urls = collectAssetUrls({ a: { skel: '/assets/~1234567890abcdef/model.skel', atlas: '/assets/model.atlas',
    textures: ['/assets/one.png', '/assets/two.png'] }, b: '/assets/one.png', audio: '/assets/~1234567890abcdef/audio/bgm/a.mp3',
  source: 'https://external.test/a.png', invalid: '//external.test/x', font: '/fonts/a.woff2' },
  { groups: { scene: { binary: { path: '/assets/local/scene.bin' } } } });
  assert.equal(urls.length, 7);
  assert.ok(urls.includes('/assets/local/scene.bin'));
  assert.ok(urls.includes('/assets/two.png'));
  assert.equal(urls.at(-1), '/media/~1234567890abcdef/bgm/a');
  assert.ok(!urls.some((url) => url.includes('external')));
});

test('does nothing before click, bounds concurrency and consumes full bodies without decoding', async () => {
  let active = 0, max = 0, calls = 0;
  const queue = createAssetDownload({ concurrency: 2, fetch: fixture(
    ['/assets/a', '/assets/b', '/assets/c'].reduce((o, url) => ({ ...o, [url]: url }), {}),
    async (_url, options) => {
      assert.equal(options.cache, 'default');
      calls++; active++; max = Math.max(max, active);
      await tick();
      active--;
      return file();
    }) });
  assert.equal(calls, 0);
  const first = queue.start();
  assert.equal(queue.start(), first);
  await first;
  assert.equal(max, 2);
  assert.deepEqual([queue.get().phase, queue.get().total, queue.get().done, queue.get().bytes], ['complete', 3, 3, 15]);
});

test('failed files stay incomplete and manual retry skips successful files', async () => {
  const calls = [];
  let missing = true;
  const queue = createAssetDownload({ retries: 0, fetch: fixture({ a: '/assets/a', b: '/assets/b' }, async (url) => {
    calls.push(url);
    return url === '/assets/b' && missing ? new Response('missing', { status: 404 }) : file();
  }) });
  await queue.start();
  assert.equal(queue.get().phase, 'partial');
  assert.equal(queue.get().done, 1);
  assert.deepEqual(queue.get().failures, [{ url: '/assets/b', status: 404 }]);
  missing = false;
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(calls.filter((u) => u === '/assets/a').length, 1);
  assert.equal(calls.filter((u) => u === '/assets/b').length, 2);
});

test('HTML fallbacks, empty and partial responses never count as downloaded', async () => {
  const responses = {
    '/assets/a': new Response('<html>missing</html>', { headers: { 'content-type': 'text/html' } }),
    '/assets/b': new Response('', { status: 200 }),
    '/assets/c': new Response('part', { status: 206 }),
  };
  const queue = createAssetDownload({ fetch: fixture(Object.keys(responses), async (url) => responses[url]) });
  // A malformed root manifest is rejected before processing.
  await queue.start();
  assert.equal(queue.get().phase, 'error');
  const valid = createAssetDownload({ fetch: fixture({ files: Object.keys(responses) }, async (url) => responses[url]) });
  await valid.start();
  assert.equal(valid.get().phase, 'partial');
  assert.equal(valid.get().done, 0);
  assert.equal(valid.get().failures.length, 3);
});

test('an aborted body is unfinished; resume retains earlier successes and retries the interrupted file', async () => {
  const calls = [];
  let reading;
  const begun = new Promise((resolve) => { reading = resolve; });
  let hold = true;
  const queue = createAssetDownload({ concurrency: 1, fetch: fixture({ a: '/assets/a', b: '/assets/b' }, async (url, { signal }) => {
    calls.push(url);
    if (url === '/assets/a' || !hold) return file();
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array([1, 2]));
      signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
      reading();
    } }));
  }) });
  const run = queue.start();
  await begun;
  queue.pause();
  await run;
  assert.equal(queue.get().phase, 'paused');
  assert.equal(queue.get().done, 1);
  assert.equal(queue.get().failures.length, 0);
  hold = false;
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.deepEqual(calls, ['/assets/a', '/assets/b', '/assets/b']);
});

test('timeouts and transient errors retry a bounded number of times', async () => {
  let calls = 0;
  const queue = createAssetDownload({ timeoutMs: 10, retries: 1, fetch: fixture({ a: '/assets/a' }, (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) });
  await queue.start();
  assert.equal(calls, 2);
  assert.equal(queue.get().phase, 'partial');
  let tries = 0;
  const recovered = createAssetDownload({ fetch: fixture({ a: '/assets/a' }, async () => ++tries === 1 ? new Response('', { status: 503 }) : file()) });
  await recovered.start();
  assert.equal(tries, 2);
  assert.equal(recovered.get().phase, 'complete');
});

test('optional local manifest absence is disclosed; failed base manifest is never complete', async () => {
  const queue = createAssetDownload({ fetch: fixture({ a: '/assets/a' }, async () => file(), null) });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(queue.get().localMissing, true);
  const broken = createAssetDownload({ fetch: async () => new Response('missing', { status: 404 }) });
  await broken.start();
  assert.equal(broken.get().phase, 'error');
  assert.equal(broken.get().total, 0);
});

test('0.3.0 manifest groups stay in the queue: extra dubs, stats art and a local device file', () => {
  const urls = collectAssetUrls({
    voiceEn: { char_a: { battle: '/assets/~abcdef0123456789/audio/voice/en/char_a/battle.mp3' } },
    voiceKr: { char_a: { battle: '/assets/audio/voice/kr/char_a/battle.mp3' } },
    voiceNative: { char_a: { battle: '/assets/audio/voice/native/char_a/battle.mp3' } },
    ui: { stats: { trophy: '/assets/ui/stats/trophy.png' } },
  }, {
    groups: { 'mesh/trap_110': { model: { path: '/assets/local/mesh/trap_110/trap_1106_achplat.bin' } } },
  });
  assert.ok(urls.includes('/media/~abcdef0123456789/voice/en/char_a/battle'));
  assert.ok(urls.includes('/media/voice/kr/char_a/battle'));
  assert.ok(urls.includes('/media/voice/native/char_a/battle'));
  assert.ok(urls.includes('/assets/ui/stats/trophy.png'));
  assert.ok(urls.includes('/assets/local/mesh/trap_110/trap_1106_achplat.bin'));
  assert.equal(urls.filter((url) => url.startsWith('/media/')).length, 3);
});

test('a completed check reads updated manifests and downloads newly supplied files', async () => {
  const manifest = { a: '/assets/a' };
  const calls = [];
  const queue = createAssetDownload({ fetch: fixture(manifest, async (url) => { calls.push(url); return file(); }) });
  await queue.start();
  manifest.b = '/assets/b';
  await queue.start();
  assert.equal(queue.get().done, 2);
  assert.deepEqual(calls, ['/assets/a', '/assets/a', '/assets/b']);
});

test('the official battle effects manifest (/data/local-fx.json, DESIGN §33) is queued when the host has it', async () => {
  const got = [];
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    fetch: fixture({ a: '/assets/~1234567890abcdef/a.png' }, async (url) => { got.push(url); return file(); }, { groups: {} },
      { format: 'fx-manifest', groups: { 'fx/prefabs': { common_hit_01: { path: '/assets/~fedcba0987654321/local/fx/prefabs/common_hit_01.json' } } } }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.ok(got.includes('/assets/~fedcba0987654321/local/fx/prefabs/common_hit_01.json'));
  assert.ok(got.includes('/assets/~1234567890abcdef/a.png'));
});

test('a source map (data/asset-sources.json) takes every named file from the repository, verified, under the served URL', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const imgHash = await sha256Hex16(enc('img-bytes'));
  const audHash = await sha256Hex16(enc('aud-bytes'));
  const imgUrl = `/assets/~${imgHash}/char/a.png`;
  const audUrl = `/assets/~${audHash}/audio/bgm/a.mp3`;
  const audMedia = `/media/~${audHash}/bgm/a`;
  const sources = {
    'assets/char/a.png': ['https://repo.test/char/a.png'],
    'assets/audio/bgm/a.mp3': ['https://repo.test/bgm/a.mp3'],
  };
  const serverHits = [], repoHits = [];
  const caches = fakeCaches();
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    cachesApi: () => caches.api,
    fetch: fixture({ img: imgUrl, aud: audUrl }, async (url) => {
      if (url.startsWith('https://repo.test/')) {
        repoHits.push(url);
        return new Response(url.endsWith('a.png') ? enc('img-bytes') : enc('aud-bytes'), { headers: { 'content-type': 'application/octet-stream' } });
      }
      serverHits.push(url);
      return file();
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(queue.get().fromSource, 2, 'both files came from the repository');
  assert.deepEqual(serverHits, [], 'the host was never asked for a file the map names');
  assert.deepEqual(repoHits.sort(), ['https://repo.test/bgm/a.mp3', 'https://repo.test/char/a.png']);
  // Stored under the served URL and its /media/ alias: the service worker answers what the game requests.
  const stored = [...caches.entries.keys()];
  assert.ok(stored.includes(imgUrl), `img url stored (${stored.join(', ')})`);
  assert.ok(stored.includes(audUrl), 'audio url stored');
  assert.ok(stored.includes(audMedia), 'audio /media/ alias stored');
  assert.ok(stored.includes('/sp-imported-index.json'), 'the import index lists them');
});

test('a file the map does not name, or whose repository copy fails its hash, still comes from this server', async () => {
  const hash = await sha256Hex16(new TextEncoder().encode('good'));
  const kept = `/assets/~${hash}/char/kept.png`;
  const wrong = `/assets/~${hash}/char/wrong.png`;
  const plain = `/assets/char/plain.png`;
  const sources = { 'assets/char/kept.png': ['https://repo.test/kept.png'], 'assets/char/wrong.png': ['https://repo.test/wrong.png'] };
  const serverHits = [];
  const caches = fakeCaches();
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    cachesApi: () => caches.api,
    fetch: fixture({ kept, wrong, plain }, async (url) => {
      if (url === 'https://repo.test/kept.png') return new Response(new TextEncoder().encode('good'), { headers: { 'content-type': 'application/octet-stream' } });
      if (url === 'https://repo.test/wrong.png') return new Response(new TextEncoder().encode('tampered'), { headers: { 'content-type': 'application/octet-stream' } });
      serverHits.push(url);
      return file();
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete', JSON.stringify(queue.get().failures));
  assert.equal(queue.get().fromSource, 1, 'only the verified repository copy counts');
  // The tampered source (a hash that does not match) and the unmapped file both fall back to the host. An unhashed
  // URL has no hash to check, so it is never taken from a repository either.
  assert.ok(serverHits.includes(plain), `unmapped file from the server (${serverHits.join(', ')})`);
  assert.ok(serverHits.some((url) => url.includes('wrong')), `tampered file from the server (${serverHits.join(', ')})`);
  assert.ok(!caches.entries.has(wrong), 'a hash mismatch is never stored');
  assert.ok(caches.entries.has(kept), 'the verified one is stored');
});

test('a host without data/asset-sources.json keeps downloading every file from this server', async () => {
  const got = [];
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    fetch: fixture({ a: '/assets/~1234567890abcdef/a.png' }, async (url) => { got.push(url); return file(); }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(queue.get().fromSource, 0);
  assert.deepEqual(got, ['/assets/~1234567890abcdef/a.png']);
});

test('a Spine model is taken from the repository only as a whole, checked by its model hash', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const parts = { 'a.skel': enc('skel'), 'a.atlas': enc('atlas'), 'a.png': enc('png') };
  const hashes = [await sha256Hex16(parts['a.skel']), await sha256Hex16(parts['a.atlas']), await sha256Hex16(parts['a.png'])];
  const model = await modelHashOf(hashes);
  const dir = `/assets/~${model}/spine/op/a/front`;
  const manifest = { chars: { a: { spine: { front: {
    skel: `${dir}/a.skel`, atlas: `${dir}/a.atlas`, textures: [`${dir}/a.png`],
  } } } } };
  const sources = {
    'assets/spine/op/a/front/a.skel': ['https://repo.test/a.skel'],
    'assets/spine/op/a/front/a.atlas': ['https://repo.test/a.atlas'],
    'assets/spine/op/a/front/a.png': ['https://repo.test/a.png'],
  };
  const serverHits = [], repoHits = [];
  const caches = fakeCaches();
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    cachesApi: () => caches.api,
    fetch: fixture(manifest, async (url) => {
      if (url.startsWith('https://repo.test/')) { repoHits.push(url); return new Response(parts[url.slice(url.lastIndexOf('/') + 1)], { headers: { 'content-type': 'application/octet-stream' } }); }
      serverHits.push(url);
      return file();
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete', JSON.stringify(queue.get().failures));
  assert.equal(queue.get().fromSource, 1, 'the model counts once');
  assert.deepEqual(serverHits, [], 'no member of a verified model comes from the host');
  assert.deepEqual(repoHits.sort(), ['https://repo.test/a.atlas', 'https://repo.test/a.png', 'https://repo.test/a.skel']);
  for (const name of ['a.skel', 'a.atlas', 'a.png']) assert.ok(caches.entries.has(`${dir}/${name}`), `${name} stored under its served URL`);
});

test('a Spine model mixes sources: the rewritten atlas from this server completes the parts taken from a repository', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const parts = { 'b.skel': enc('skel'), 'b.atlas': enc('atlas-served'), 'b.png': enc('png') };
  const hashes = [await sha256Hex16(parts['b.skel']), await sha256Hex16(parts['b.atlas']), await sha256Hex16(parts['b.png'])];
  const model = await modelHashOf(hashes);
  const dir = `/assets/~${model}/spine/op/b/front`;
  const manifest = { chars: { b: { spine: { front: {
    skel: `${dir}/b.skel`, atlas: `${dir}/b.atlas`, textures: [`${dir}/b.png`],
  } } } } };
  // The atlas is the part the asset pipeline rewrites after the download, so the map never names it: it is read from
  // this server to complete the model hash, while the skel and the page come from the repository.
  const sources = { 'assets/spine/op/b/front/b.skel': ['https://repo.test/b.skel'], 'assets/spine/op/b/front/b.png': ['https://repo.test/b.png'] };
  const served = [], repoTaken = [];
  const caches = fakeCaches();
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    cachesApi: () => caches.api,
    fetch: fixture(manifest, async (url) => {
      if (url.startsWith('https://repo.test/')) { repoTaken.push(url); return new Response(parts[url.slice(url.lastIndexOf('/') + 1)], { headers: { 'content-type': 'application/octet-stream' } }); }
      served.push(url);
      return new Response(parts[url.slice(url.lastIndexOf('/') + 1)], { headers: { 'content-type': 'application/octet-stream' } });
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete', JSON.stringify(queue.get().failures));
  assert.equal(queue.get().fromSource, 1);
  assert.deepEqual(repoTaken.sort(), ['https://repo.test/b.png', 'https://repo.test/b.skel']);
  assert.deepEqual(served, [`${dir}/b.atlas`], 'only the part the map does not name is asked of this server');
  assert.ok(caches.entries.has(`${dir}/b.skel`) && caches.entries.has(`${dir}/b.png`), 'the repository parts are stored');
  assert.ok(!caches.entries.has(`${dir}/b.atlas`), 'the server-served part is not duplicated into the import cache');
});

test('a Spine model whose repository copy does not match the model hash comes from this server entirely', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const hashes = [await sha256Hex16(enc('skel')), await sha256Hex16(enc('atlas')), await sha256Hex16(enc('png'))];
  const model = await modelHashOf(hashes);
  const dir = `/assets/~${model}/spine/op/c/front`;
  const manifest = { chars: { c: { spine: { front: {
    skel: `${dir}/c.skel`, atlas: `${dir}/c.atlas`, textures: [`${dir}/c.png`],
  } } } } };
  const sources = {
    'assets/spine/op/c/front/c.skel': ['https://repo.test/c.skel'],
    'assets/spine/op/c/front/c.atlas': ['https://repo.test/c.atlas'],
    'assets/spine/op/c/front/c.png': ['https://repo.test/c.png'],
  };
  const served = [];
  const queue = createAssetDownload({
    lookupImported: async () => new Set(),
    cachesApi: () => fakeCaches().api,
    fetch: fixture(manifest, async (url) => {
      // The repository's page is not the one this build hashes: the model hash cannot be confirmed, so nothing is
      // stored and every member falls back to the host.
      if (url === 'https://repo.test/c.png') return new Response(enc('tampered-png'), { headers: { 'content-type': 'application/octet-stream' } });
      if (url.startsWith('https://repo.test/')) return new Response(enc(url.slice(url.lastIndexOf('/') + 1, -4)), { headers: { 'content-type': 'application/octet-stream' } });
      served.push(url);
      return file();
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete');
  assert.equal(queue.get().fromSource, 0);
  assert.deepEqual(served.sort(), [`${dir}/c.atlas`, `${dir}/c.png`, `${dir}/c.skel`]);
});

test('a source list is a ladder: the first address that answers wins and is remembered for the files after it', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const oneHash = await sha256Hex16(enc('one'));
  const twoHash = await sha256Hex16(enc('two'));
  const one = `/assets/~${oneHash}/char/one.png`;
  const two = `/assets/~${twoHash}/char/two.png`;
  // The raw.githubusercontent.com address first, the jsDelivr backup the generator adds after it (tools/fetch-assets.mjs).
  const sources = {
    'assets/char/one.png': ['https://blocked.test/one.png', 'https://backup.test/one.png'],
    'assets/char/two.png': ['https://blocked.test/two.png', 'https://backup.test/two.png'],
  };
  const hits = [];
  const queue = createAssetDownload({
    concurrency: 1,
    lookupImported: async () => new Set(),
    cachesApi: () => fakeCaches().api,
    fetch: fixture({ one, two }, async (url) => {
      hits.push(url);
      if (url.startsWith('https://blocked.test/')) return new Response('', { status: 503 });
      if (url.startsWith('https://backup.test/')) return new Response(url.includes('one') ? enc('one') : enc('two'), { headers: { 'content-type': 'application/octet-stream' } });
      return file();
    }, { groups: {} }, null, { version: 1, sources }),
  });
  await queue.start();
  assert.equal(queue.get().phase, 'complete', JSON.stringify(queue.get().failures));
  assert.equal(queue.get().fromSource, 2, 'both files came from the backup address');
  assert.equal(hits.filter((u) => u.startsWith('https://blocked.test/')).length, 1, 'the dead address is tried once, not per file');
  assert.deepEqual(hits.filter((u) => u.startsWith('https://backup.test/')).length, 2);
});

/** A CacheStorage stub: the remote path stores bodies and the import index through it. */
function fakeCaches() {
  const entries = new Map();
  const cache = {
    async put(key, response) { entries.set(typeof key === 'string' ? key : key.url, response); },
    async match(key) { return entries.get(typeof key === 'string' ? key : key.url) || undefined; },
    async keys() { return [...entries.keys()]; },
  };
  return { entries, api: { async open() { return cache; } } };
}

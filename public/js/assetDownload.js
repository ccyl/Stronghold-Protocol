// Explicit title-screen predownload. Two sources, one queue:
//
//   * the community client dumps the asset plan resolves (data/asset-sources.json, tools/fetch-assets.mjs
//     --write-source-map) — the browser fetches each file straight from the repository, checks it against the hash in
//     the served URL and stores it in the import cache (assetCache.js), which the service worker answers; the host's
//     upstream is not used at all;
//   * this server, for a file the map does not name (a locally generated font, a local-client extraction), for a host
//     without the map, or when a repository copy is unreachable or fails its hash — the same-origin request the title
//     screen has always made, into the HTTP cache.
//
// The URL is always the served, content-hashed one: a single cache key the game reads through the worker (import) or
// the browser (HTTP). That is why a remote copy is stored under the served URL and never under the repository's.
//
// Verification is the importer's (assetPack.js), because the hashes are the served view's: a standalone file's URL
// carries its own sha256, while every member of a Spine model carries the *model* hash — the members' file hashes
// joined by newlines. A model is taken from the repository only when all of its members are there and the recomputed
// model hash matches; otherwise its members fall back to this server.
//
// A URL a local import (assetPack.js) already stored is marked done and never requested again.
import { mediaUrl } from './media.js';
import { listImportedPaths, IMPORTED_ASSET_CACHE, putImportedAsset, addImportedPaths } from './assetCache.js';
import { plainRel, cacheUrlsFor, sha256Hex16, modelHashOf, planFromManifests, mergeLocalManifests } from './assetPack.js';

/**
 * The served files of the given manifests, each with the served (content-hashed) URL, its /media/ alias (audio: a
 * download manager pops up for a URL that ends in a media extension, so the game and this queue use the alias —
 * media.js) and the rel / hash a source lookup needs.
 *
 * Only content-hashed `/assets/~…` and `/fonts/~…` entries are returned: an unhashed URL cannot be checked against a
 * source, so it only ever comes from this server (rel set, hash null). The extra dub banks (voiceEn / voiceKr /
 * voiceNative), the statistics-page art and local groups (the 射击台 mesh) are walked like any other entry; a cosmetic
 * plugin's own files are `/p/<id>/<hash8>/…`, are not in these manifests and are not queued here.
 * @param {...any} manifests the served /data/assets.json, /data/local-assets.json and /data/local-fx.json
 * @returns {{ url: string, media: string, rel: string, hash: string | null }[]} models/images first, audio last
 */
export function collectAssetFiles(...manifests) {
  const byUrl = new Map();
  const visit = (value) => {
    if (typeof value === 'string') {
      if (!/^\/(?:assets|fonts)\/[^/]/.test(value) || /[?#\\]/.test(value)) return;
      const plain = plainRel(value);
      const url = plain ? plain.url : value;
      if (byUrl.has(url)) return;
      byUrl.set(url, { url, media: mediaUrl(url), rel: plain ? plain.rel : value.slice(1), hash: plain ? plain.hash : null });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child);
    }
  };
  manifests.forEach(visit);
  // Fetch models/images before audio, so an interrupted download still improves battle visuals.
  return [...byUrl.values()].sort((a, b) => Number(a.media.startsWith('/media/')) - Number(b.media.startsWith('/media/')) || a.url.localeCompare(b.url));
}

/** The served URLs of {@link collectAssetFiles} (the /media/ alias for audio), in the same order. */
export function collectAssetUrls(...manifests) {
  return collectAssetFiles(...manifests).map((file) => file.media);
}

/** The pathname a stored URL is listed under (assetCache.js IMPORTED_INDEX_URL). */
function pathnameOf(url) {
  try { return new URL(url, 'http://localhost').pathname; } catch { return ''; }
}

/**
 * A bounded, pausable download queue. A file counts only after its entire body arrives (and, from a source, verifies).
 * `sourcesUrl` is the served download-source map; `cachesApi` the CacheStorage the remote copies go into.
 */
export function createAssetDownload({ fetch: doFetch = (...args) => globalThis.fetch(...args),
  concurrency = 4, timeoutMs = 60000, retries = 2, lookupImported = listImportedPaths,
  sourcesUrl = '/data/asset-sources.json', cachesApi = () => globalThis.caches } = {}) {
  let state = { phase: 'idle', total: 0, done: 0, bytes: 0, failures: [], localMissing: false, cached: 0, fromSource: 0 };
  let files = null, running = null, controller = null, paused = false, lastNotice = 0;
  /** The served manifests read this run: the source plan is built from the very objects the queue was filled from. */
  let manifests = null;
  /**
   * The source host that last answered: tried first for every file after it. A raw.githubusercontent.com blocked on
   * this network then costs one failed attempt, not one per file (the jsDelivr backup address in data/asset-sources.json
   * takes over), which is what keeps a 16k-file predownload usable behind a slow or filtered link.
   */
  let preferredHost = '';
  const complete = new Set(), failures = new Map(), listeners = new Set();
  const emit = (force = false) => {
    if (!force && Date.now() - lastNotice < 100) return;
    lastNotice = Date.now();
    state = { ...state, done: complete.size, failures: [...failures.values()] };
    for (const listener of listeners) listener(state);
  };

  async function request(url, json = false, optional = false) {
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      const timer = setTimeout(cancel, timeoutMs);
      try {
        const response = await doFetch(url, { signal: abort.signal, cache: json ? 'no-cache' : 'default' });
        if (optional && response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok || response.status === 206) {
          await response.body?.cancel();
          throw Object.assign(new Error('Asset request failed'), { status: response.status });
        }
        // Static hosts sometimes send their HTML fallback with status 200 for missing art.
        if (/text\/html/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw Object.assign(new Error('Unexpected HTML response'), { status: 'html' });
        }
        if (json) return await response.json();
        let size = 0;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              state = { ...state, bytes: state.bytes + value.byteLength };
              emit();
            }
          } finally { reader.releaseLock(); }
        } else {
          size = (await response.arrayBuffer()).byteLength;
          state = { ...state, bytes: state.bytes + size };
        }
        if (!size) throw Object.assign(new Error('Empty asset response'), { status: 'empty' });
        return;
      } catch (error) {
        if (paused) throw error;
        const transient = !error.status || error.status >= 500 || [408, 429].includes(error.status);
        if (!transient || attempt >= retries) throw Object.assign(error, { url });
        // Keep retries bounded and avoid hammering a struggling server.
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        if (paused) throw error;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancel);
      }
    }
  }

  /**
   * The download sources of every rel (data/asset-sources.json), or null when the host has none (or the request
   * fails). A plain fetch outside the queue's timeout / retry / pause wiring: an optional map must never change how a
   * file download behaves.
   */
  async function loadSources() {
    try {
      const response = await doFetch(sourcesUrl, { cache: 'no-cache' });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const map = await response.json();
      return map && typeof map === 'object' && map.sources && typeof map.sources === 'object' ? map.sources : null;
    } catch { return null; }
  }

  /** Host of a URL, or '' when it is not one. */
  function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
  }

  /** Bytes from the first source URL that answers with a full body, or null (a 404 moves on to the next source). */
  async function fetchFromSource(urls) {
    const ordered = preferredHost
      ? [...urls.filter((u) => hostOf(u) === preferredHost), ...urls.filter((u) => hostOf(u) !== preferredHost)]
      : urls;
    for (const url of ordered) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      const timer = setTimeout(cancel, timeoutMs);
      try {
        const response = await doFetch(url, { signal: abort.signal, cache: 'default' });
        if (!response.ok) { await response.body?.cancel(); continue; }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.byteLength) continue;
        preferredHost = hostOf(url);
        return bytes;
      } catch {
        if (paused) return null;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancel);
      }
    }
    return null;
  }

  /**
   * The repository jobs of the plan: one per standalone file, one per Spine model (all of its members at once, or
   * none — the served URL of every member carries the model hash, so a member on its own cannot be checked).
   */
  function sourceJobs(plan, sources) {
    const jobs = [];
    const grouped = new Set();
    for (const group of plan.groups) for (const member of group.members) grouped.add(member.rel);
    for (const [rel, spec] of plan.files) {
      if (grouped.has(rel)) continue;
      const urls = sources[rel];
      if (Array.isArray(urls) && urls.length) jobs.push({ kind: 'file', rel, spec, urls });
    }
    for (const group of plan.groups) {
      // A part the map does not name (a locally rewritten atlas) is read from this server to complete the model hash;
      // at least one part must come from a repository for the job to be worth doing.
      const members = group.members.map((member) => ({ member, urls: sources[member.rel] }));
      if (members.some((m) => Array.isArray(m.urls) && m.urls.length)) jobs.push({ kind: 'model', rel: group.members[0].rel, group, members });
    }
    return jobs;
  }

  async function run() {
    try {
      if (!files) {
        state = { ...state, phase: 'preparing', error: null };
        emit(true);
        // Sequential manifest reads keep cancellation simple and never leave a rejected sibling promise.
        const assets = await request('/data/assets.json', true);
        const local = await request('/data/local-assets.json', true, true);
        // the official battle effects' files (DESIGN §33): optional, like the local manifest
        const fx = await request('/data/local-fx.json', true, true);
        if (!assets || typeof assets !== 'object' || Array.isArray(assets)
          || (local !== null && (!local || typeof local !== 'object' || !local.groups))
          || (fx !== null && (!fx || typeof fx !== 'object' || !fx.groups))) throw new Error('Invalid asset manifest');
        const list = collectAssetFiles(assets, local, fx);
        if (!list.length) throw new Error('Empty asset manifest');
        files = list;
        manifests = { assets, local, fx };
        state = { ...state, total: files.length, localMissing: local === null };
      }
      if (paused) return;
      let imported = null;
      try { imported = await lookupImported(); } catch { imported = null; }
      if (paused) return;
      let cached = 0;
      if (imported && typeof imported.has === 'function') {
        for (const file of files) {
          if (imported.has(file.url) || imported.has(file.media) || imported.has(pathnameOf(file.url)) || imported.has(pathnameOf(file.media))) {
            cached++;
            complete.add(file.url);
          }
        }
      }
      state = { ...state, cached };
      if (paused) return;
      const sources = await loadSources();
      if (paused) return;
      state = { ...state, phase: 'downloading' };
      failures.clear();
      emit(true);
      // The import cache the remote copies go into (the service worker answers those URLs); opened once, lazily.
      let cache = null, stored = null, fromSource = 0;
      const openCache = async () => {
        if (cache) return cache;
        const api = cachesApi();
        if (!api?.open) throw new Error('CacheStorage unavailable');
        cache = await api.open(IMPORTED_ASSET_CACHE);
        return cache;
      };
      /** Store `bytes` under every served URL that names them (the file's, its aliases, a source's own URL). */
      const store = async (url, bytes, spec) => {
        const urls = new Set(cacheUrlsFor(url));
        if (spec) {
          const hash = await sha256Hex16(bytes);
          if (spec.hash === hash) for (const u of cacheUrlsFor(spec.url)) urls.add(u);
          for (const alt of spec.alts || []) if (alt.hash === hash) for (const u of cacheUrlsFor(alt.url)) urls.add(u);
        }
        await putImportedAsset(await openCache(), [...urls], bytes);
        for (const u of urls) { const path = pathnameOf(u); if (path) stored.add(path); }
      };
      // The repository phase first: what it takes, this server is never asked for.
      if (sources && manifests?.assets) {
        const plan = planFromManifests(manifests.assets, mergeLocalManifests(manifests.local, manifests.fx));
        if (plan.files.size || plan.groups.length) {
          stored = new Set();
          const jobs = sourceJobs(plan, sources).filter((job) => job.kind !== 'file' || !complete.has(job.spec.url));
          let next = 0;
          const worker = async () => {
            while (!paused && next < jobs.length) {
              const job = jobs[next++];
              const take = async () => {
                if (job.kind === 'file') {
                  const bytes = await fetchFromSource(job.urls);
                  if (!bytes || await sha256Hex16(bytes) !== job.spec.hash) return false;
                  await store(job.spec.url, bytes, job.spec);
                  state = { ...state, bytes: state.bytes + bytes.byteLength };
                  complete.add(job.spec.url);
                  return true;
                }
                const bodies = [], fromRepo = [];
                for (const m of job.members) {
                  let bytes = m.urls ? await fetchFromSource(m.urls) : null;
                  if (bytes) fromRepo.push(true);
                  else {
                    // This server answers for a part the map does not name, and for a repository copy that failed:
                    // the model hash below still covers it, so nothing unverified is ever stored.
                    bytes = await fetchFromSource([m.member.url]);
                    fromRepo.push(false);
                  }
                  if (!bytes) return false;
                  bodies.push(bytes);
                }
                const hashes = [];
                for (const bytes of bodies) hashes.push(await sha256Hex16(bytes));
                if (await modelHashOf(hashes) !== job.group.hash) return false;
                for (let i = 0; i < job.members.length; i++) {
                  const { member } = job.members[i];
                  // Only a part that came from a repository is stored: one this server served is already there, and
                  // this fetch put it in the browser's own cache.
                  if (fromRepo[i]) await store(member.url, bodies[i], plan.files.get(member.rel));
                  state = { ...state, bytes: state.bytes + bodies[i].byteLength };
                  complete.add(member.url);
                }
                return true;
              };
              try { if (await take()) { fromSource++; state = { ...state, fromSource }; } } catch { /* this server serves it below */ }
              emit();
            }
          };
          await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
        }
      }
      if (paused) return;
      // Whatever is left — an unmapped file, a host without the map, an unreachable repository, a hash that did not
      // match — comes from this server, exactly as before.
      const queue = files.filter((file) => !complete.has(file.url));
      let next = 0;
      const worker = async () => {
        while (!paused && next < queue.length) {
          const file = queue[next++];
          try {
            await request(file.media);
            complete.add(file.url);
          } catch (error) {
            if (!paused) failures.set(file.url, { url: file.media, status: error.status || 'network' });
          }
          emit();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
      if (stored?.size) { try { await addImportedPaths(await openCache(), stored); } catch { /* the entries stay; Cache.keys() may still list them */ } }
      if (!paused) state = { ...state, phase: failures.size ? 'partial' : 'complete' };
    } catch (error) {
      if (!paused) state = { ...state, phase: 'error', error: { url: error.url, status: error.status || 'manifest' } };
    } finally {
      if (paused) state = { ...state, phase: 'paused' };
      emit(true);
    }
  }

  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (running) return running;
      paused = false;
      controller = new AbortController();
      // A new check after completion revalidates the manifest and all files through the HTTP cache.
      if (state.phase === 'complete') {
        files = null; manifests = null; preferredHost = ''; complete.clear();
        state = { phase: 'idle', total: 0, done: 0, bytes: 0, failures: [], localMissing: false, cached: 0, fromSource: 0 };
      }
      running = run().finally(() => { running = null; });
      return running;
    },
    pause() { if (running) { paused = true; controller.abort(); } },
  };
}

export const assetDownload = createAssetDownload();

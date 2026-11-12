/**
 * Queue API endpoint resolution with automatic failover.
 *
 * In production, the queue is mounted as a Vercel Service on the same origin
 * under /face-search-api. A separately deployed queue can still be configured
 * as a fallback with VITE_QUEUE_FALLBACK_URL.
 *
 * Candidates are probed in order against the lightweight `/health` endpoint
 * and the first healthy one is cached for subsequent requests.
 */

const HEALTH_TIMEOUT_MS = 4000;
const PROBE_TTL_MS = 60 * 1000;

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

const devQueueBase = () => {
  if (typeof location === 'undefined') return null;
  // Vite dev server runs on 5173; the queue dev server listens on 4102.
  return `${location.origin.replace(/:\d+/, ':4102')}/api`;
};

const primaryQueueBase = () => {
  if (typeof location === 'undefined') return null;
  if (import.meta.env?.DEV) return devQueueBase();
  return '/face-search-api/api';
};

const fallbackQueueBase = () => {
  const configured = import.meta.env?.VITE_QUEUE_FALLBACK_URL;
  const base = configured || 'https://face-search-queue.vercel.app';
  return `${stripTrailingSlash(base)}/api`;
};

/**
 * Ordered list of queue API base URLs to try (primary first, then fallback).
 * Duplicates are removed so an already-Vercel-hosted portal does not probe
 * the same origin twice.
 */
export const getQueueApiBaseUrls = () => {
  const urls = [primaryQueueBase(), fallbackQueueBase()].filter(Boolean);
  return [...new Set(urls.map(stripTrailingSlash))];
};

const probeHealth = async (base, signal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(`${base}/health`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    // Service is up; treat a degraded Redis as reachable so the UI can surface
    // the real error from the actual request instead of a silent failover loop.
    return body?.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

let cachedBase = null;
let cachedAt = 0;
let pendingResolution = null;

/**
 * Resolve the currently reachable queue API base URL.
 * Results are cached briefly to avoid probing on every request.
 */
export const resolveQueueApiBaseUrl = async ({ force = false } = {}) => {
  const fresh = cachedBase && Date.now() - cachedAt < PROBE_TTL_MS;
  if (!force && fresh) return cachedBase;
  if (pendingResolution) return pendingResolution;

  const candidates = getQueueApiBaseUrls();

  pendingResolution = (async () => {
    for (const base of candidates) {
      if (await probeHealth(base)) {
        cachedBase = base;
        cachedAt = Date.now();
        return base;
      }
    }
    // Nothing responded to the health probe. Default to the first candidate so
    // callers still issue a request and surface a concrete, actionable error.
    cachedBase = candidates[0] ?? null;
    cachedAt = Date.now();
    return cachedBase;
  })();

  try {
    return await pendingResolution;
  } finally {
    pendingResolution = null;
  }
};

/**
 * Drop the cached healthy endpoint so the next call re-probes. Call this after
 * a network-level failure so the other candidate gets a chance.
 */
export const invalidateQueueApiBaseUrl = () => {
  cachedBase = null;
  cachedAt = 0;
};

/**
 * fetch() against the queue API with automatic failover between candidates.
 * Network-level failures (server down, DNS, timeout) move to the next
 * candidate; real HTTP responses (including 4xx/5xx) are returned as-is.
 */
export const queueApiFetch = async (path, options = {}) => {
  const candidates = getQueueApiBaseUrls();
  const preferred = (await resolveQueueApiBaseUrl()) ?? candidates[0];
  const ordered = [preferred, ...candidates.filter((c) => c !== preferred)];

  let lastError = null;
  for (const base of ordered) {
    try {
      const res = await fetch(`${base}${path}`, options);
      // A response means the server is reachable — cache and return it.
      cachedBase = base;
      cachedAt = Date.now();
      return res;
    } catch (err) {
      lastError = err;
      invalidateQueueApiBaseUrl();
    }
  }
  throw lastError ?? new Error('Queue API unreachable');
};

export default getQueueApiBaseUrls;

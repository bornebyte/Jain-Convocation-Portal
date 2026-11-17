const CACHE_CONFIG = {
  courses: { ttl: 1 * 60 * 1000 }, // 1 minute
  gallery: { ttl: 1 * 60 * 1000 }  // 1 minute
};

export const cacheManager = {
  get: (key, refreshStamp = 0) => {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;

      const { value, timestamp, retryCount = 0, refreshStamp: entryStamp = 0 } = JSON.parse(item);
      const ttl = CACHE_CONFIG[key]?.ttl;

      // Entry was written before the last forced refresh. Compared by stamp value
      // instead of timestamps so a skewed device clock can't keep stale data alive
      // (or force a refetch on every reload).
      const isStaleRefresh = refreshStamp > 0 && entryStamp !== refreshStamp;

      // Don't use cache if retry count >= 3, it predates the last forced refresh, or TTL expired
      if (retryCount >= 3 || isStaleRefresh || (ttl && Date.now() - timestamp > ttl)) {
        localStorage.removeItem(key);
        return null;
      }

      return value;
    } catch {
      return null;
    }
  },

  set: (key, value, retry = false, refreshStamp = 0) => {
    try {
      const existing = localStorage.getItem(key);
      const retryCount = retry && existing ? JSON.parse(existing).retryCount + 1 : 0;

      localStorage.setItem(key, JSON.stringify({
        value,
        timestamp: Date.now(),
        refreshStamp,
        retryCount
      }));
    } catch {
      // Ignore storage errors
    }
  }
};

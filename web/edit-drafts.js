export const cloneDraft = (value) => JSON.parse(JSON.stringify(value));

export function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** Drafts survive a page reload in the same browser session; no server writes. */
export function createDraftCache(prefix, providedStorage) {
  const entries = new Map();
  let storage = providedStorage;
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { storage = null; }
  }
  const key = (id) => prefix + encodeURIComponent(id);
  return {
    get(id) {
      if (entries.has(id)) return entries.get(id);
      try {
        const value = JSON.parse(storage?.getItem(key(id)) || 'null');
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          entries.set(id, value);
          return value;
        }
      } catch { /* A corrupted/unavailable browser cache must not block editing. */ }
      return null;
    },
    set(id, value) {
      entries.set(id, value);
      try { storage?.setItem(key(id), JSON.stringify(value)); } catch { /* Keep the in-memory draft. */ }
      return value;
    },
    delete(id) {
      entries.delete(id);
      try { storage?.removeItem(key(id)); } catch { /* Keep editing usable. */ }
    },
  };
}

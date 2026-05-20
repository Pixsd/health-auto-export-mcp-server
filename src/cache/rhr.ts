// Past-day queries are cached indefinitely (immutable data).
// Queries that include today are cached for 30 minutes.
export const CURRENT_DAY_TTL_MS = 30 * 60 * 1000;

type McpTextContent = { content: Array<{ type: 'text'; text: string }> };

interface RhrCacheEntry {
    result: McpTextContent;
    cachedAt: number;
    ttl: number; // Infinity for historical data
}

const rhrCache = new Map<string, RhrCacheEntry>();

export function getRhrCached(key: string): McpTextContent | null {
    const entry = rhrCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttl) {
        rhrCache.delete(key);
        return null;
    }
    return entry.result;
}

export function setRhrCache(key: string, result: McpTextContent, ttl: number): void {
    rhrCache.set(key, { result, cachedAt: Date.now(), ttl });
}

// Returns the value at the p-th percentile (0–1) of a pre-sorted array.
export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return NaN;
    const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[idx]!;
}

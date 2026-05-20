// HealthKit localises sleep-stage labels based on the device language.
// These sets cover all known localisations of each category.

export const DEEP_SLEEP_LABELS = new Set([
    'AsleepDeep', // English
    'Profondo',   // Italian
    'Profond',    // French
    'Tief',       // German
    'Profundo',   // Spanish / Portuguese
    'Диплей',     // Russian (approximate, rarely exported)
]);

// Non-sleep stages to exclude from the "all-sleep" fallback.
export const NON_SLEEP_LABELS = new Set([
    // Awake
    'Awake', 'Sveglio', 'Éveillé', 'Wach', 'Despierto', 'Desperto', 'Eveillé',
    // In Bed (not actual sleep)
    'InBed', 'In Bed', 'A letto', 'Im Bett', 'Au lit', 'En cama', 'Na cama',
]);

export type SleepInterval = { startDate: string; endDate: string; value: string };

/**
 * Selects the most specific available sleep intervals and returns the method label.
 *
 * Prefers deep-sleep-only intervals (locale-aware). Falls back to all non-awake,
 * non-in-bed sleep stages when the device language is not in DEEP_SLEEP_LABELS.
 */
export function selectSleepIntervals(
    intervals: SleepInterval[],
): { selected: SleepInterval[]; method: string } {
    const deep = intervals.filter((s) => DEEP_SLEEP_LABELS.has(s.value));
    if (deep.length > 0) return { selected: deep, method: 'deep_sleep_p5' };
    return {
        selected: intervals.filter((s) => !NON_SLEEP_LABELS.has(s.value)),
        method: 'all_sleep_p5',
    };
}

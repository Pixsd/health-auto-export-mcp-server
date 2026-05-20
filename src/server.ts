import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const HAE_HOST = process.env.HAE_HOST || 'localhost';
const HAE_PORT = parseInt(process.env.HAE_PORT || '9000');
const DEFAULT_TIMEOUT = parseInt(process.env.HAE_TIMEOUT || '86400000');

const server = new McpServer({
    name: 'Health Auto Export',
    version: '1.0.0',
});

// Helper function to send JSON-RPC request to Health Auto Export iOS app
async function sendRequest(
    toolName: string,
    args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    const requestId = Math.floor(Math.random() * 1000);
    const jsonrpcRequest = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'callTool',
        params: {
            name: toolName,
            arguments: args,
        },
    };

    const message = JSON.stringify(jsonrpcRequest);

    return new Promise((resolve) => {
        const client = new net.Socket();
        let responseData = '';
        let hasResponded = false;

        client.setTimeout(DEFAULT_TIMEOUT);

        client.connect(HAE_PORT, HAE_HOST, () => {
            client.write(message);
        });

        client.on('data', (data) => {
            responseData += data.toString();
        });

        client.on('end', () => {
            if (!hasResponded) {
                hasResponded = true;
                if (responseData) {
                    try {
                        const parsedResponse = JSON.parse(responseData);
                        resolve({
                            content: [
                                { type: 'text', text: JSON.stringify(parsedResponse, null, 2) },
                            ],
                        });
                    } catch {
                        resolve({
                            content: [{ type: 'text', text: responseData }],
                        });
                    }
                } else {
                    resolve({
                        content: [{ type: 'text', text: 'No response data received' }],
                    });
                }
            }
        });

        client.on('error', (error) => {
            if (!hasResponded) {
                hasResponded = true;
                if (responseData) {
                    try {
                        const parsedResponse = JSON.parse(responseData);
                        resolve({
                            content: [
                                { type: 'text', text: JSON.stringify(parsedResponse, null, 2) },
                            ],
                        });
                    } catch {
                        resolve({ content: [{ type: 'text', text: responseData }] });
                    }
                } else {
                    resolve({
                        content: [
                            {
                                type: 'text',
                                text: `Failed to connect to Health Auto Export at ${HAE_HOST}:${HAE_PORT}: ${error.message}`,
                            },
                        ],
                    });
                }
            }
        });

        client.on('timeout', () => {
            if (!hasResponded) {
                hasResponded = true;
                client.destroy();
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: `Request to Health Auto Export timed out after ${DEFAULT_TIMEOUT}ms`,
                        },
                    ],
                });
            }
        });

        client.on('close', () => {
            if (!hasResponded) {
                hasResponded = true;
                resolve({
                    content: [
                        {
                            type: 'text',
                            text: 'Connection to Health Auto Export closed unexpectedly',
                        },
                    ],
                });
            }
        });
    });
}

// Low-level TCP call that returns the raw parsed JSON response (throws on error).
// Used by tools that need to combine and process multiple data sources.
function callTCPRaw(toolName: string, args: Record<string, unknown>): Promise<any> {
    const requestId = Math.floor(Math.random() * 1000);
    const message = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'callTool',
        params: { name: toolName, arguments: args },
    });
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        let raw = '';
        client.setTimeout(DEFAULT_TIMEOUT);
        client.connect(HAE_PORT, HAE_HOST, () => client.write(message));
        client.on('data', (d) => { raw += d.toString(); });
        client.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
        client.on('error', reject);
        client.on('timeout', () => { client.destroy(); reject(new Error('TCP timeout')); });
    });
}

// Parse a Health Auto Export date string ("2026-05-09 08:01:00 +0200") into a Date.
function parseHAEDate(s: string): Date {
    return new Date(s.replace(' ', 'T').replace(/ (?=[+-])/, ''));
}

// Returns the value at the p-th percentile (0–1) of a pre-sorted array.
function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return NaN;
    const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[idx]!;
}

// HealthKit localizes sleep-stage labels based on device language.
// These sets cover all known localizations of each category.
const DEEP_SLEEP_LABELS = new Set([
    'AsleepDeep',  // English
    'Profondo',    // Italian
    'Profond',     // French
    'Tief',        // German
    'Profundo',    // Spanish / Portuguese
    'Диплей',      // Russian (approximate, rarely exported)
]);
// Non-sleep stages to exclude from the "all-sleep" fallback.
const NON_SLEEP_LABELS = new Set([
    // Awake
    'Awake', 'Sveglio', 'Éveillé', 'Wach', 'Despierto', 'Desperto', 'Eveillé',
    // In Bed (not actual sleep)
    'InBed', 'In Bed', 'A letto', 'Im Bett', 'Au lit', 'En cama', 'Na cama',
]);

type SleepInterval = { startDate: string; endDate: string; value: string };
/** Selects the most specific available sleep intervals and returns the method label. */
function selectSleepIntervals(
    intervals: SleepInterval[],
): { selected: SleepInterval[]; method: string } {
    const deep = intervals.filter((s) => DEEP_SLEEP_LABELS.has(s.value));
    if (deep.length > 0) return { selected: deep, method: 'deep_sleep_p5' };
    return {
        selected: intervals.filter((s) => !NON_SLEEP_LABELS.has(s.value)),
        method: 'all_sleep_p5',
    };
}

// Shared zone constants used by both get_workout_heart_rate_zones and get_workout_trimp.
const TRIMP_ZONE_PARAMS = {
    z1: { weight: 1.0, hrr_pct: 0.55 },
    z2: { weight: 2.0, hrr_pct: 0.65 },
    z3: { weight: 3.0, hrr_pct: 0.75 },
    z4: { weight: 4.5, hrr_pct: 0.85 },
    z5: { weight: 6.0, hrr_pct: 0.95 },
} as const;

// Computes seconds spent in each HR zone for a workout using the Karvonen/HRR method.
function calcWorkoutZoneSec(
    samples: Array<{ Avg: number; date: string }>,
    workoutEndMs: number,
    rhr: number,
    reserve: number,
): { z1: number; z2: number; z3: number; z4: number; z5: number; below_rhr: number } {
    const sec = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0, below_rhr: 0 };
    for (let i = 0; i < samples.length; i++) {
        const sMs = parseHAEDate(samples[i]!.date).getTime();
        const nextMs = i < samples.length - 1
            ? parseHAEDate(samples[i + 1]!.date).getTime()
            : workoutEndMs;
        const durSec = Math.max(0, (nextMs - sMs) / 1000);
        const pct = (samples[i]!.Avg - rhr) / reserve;
        if      (pct < 0)    sec.below_rhr += durSec;
        else if (pct < 0.60) sec.z1 += durSec;
        else if (pct < 0.70) sec.z2 += durSec;
        else if (pct < 0.80) sec.z3 += durSec;
        else if (pct < 0.90) sec.z4 += durSec;
        else                 sec.z5 += durSec;
    }
    return sec;
}

// ── RHR in-memory cache ───────────────────────────────────────────────────────
// Past-day queries are cached indefinitely (immutable data).
// Queries that include today are cached for 30 minutes.
const CURRENT_DAY_TTL_MS = 30 * 60 * 1000;

interface RhrCacheEntry {
    result: { content: Array<{ type: 'text'; text: string }> };
    cachedAt: number;
    ttl: number; // Infinity for historical data
}

const rhrCache = new Map<string, RhrCacheEntry>();

function getRhrCached(key: string): RhrCacheEntry['result'] | null {
    const entry = rhrCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > entry.ttl) {
        rhrCache.delete(key);
        return null;
    }
    return entry.result;
}

function setRhrCache(key: string, result: RhrCacheEntry['result'], ttl: number): void {
    rhrCache.set(key, { result, cachedAt: Date.now(), ttl });
}

// Health Metrics
server.registerTool(
    'get_health_metrics',
    {
        description: 'Get health metrics data (heart rate, steps, sleep, blood glucose, etc.) for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
            metrics: z
                .string()
                .optional()
                .describe(
                    'Metrics to export as comma-separated list (e.g., \'heart_rate,step_count\'). Leave empty for all metrics.',
                ),
            interval: z
                .string()
                .optional()
                .describe('Aggregation interval: \'minutes\', \'hours\', or \'days\' (default: \'hours\')'),
            aggregate: z
                .boolean()
                .optional()
                .describe('Whether to aggregate metrics (default: true)'),
        },
    },
    async ({ start, end, metrics, interval, aggregate }) => {
        return sendRequest('health_metrics', {
            start,
            end,
            metrics: metrics || '',
            interval: interval || 'hours',
            aggregate: aggregate ?? true,
        });
    },
);

// Workouts
server.registerTool(
    'get_workouts',
    {
        description: 'Get workout data (exercise sessions) for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
            includeMetadata: z
                .boolean()
                .optional()
                .describe('Include health metric metadata (default: true)'),
            includeRoutes: z
                .boolean()
                .optional()
                .describe('Include GPS route data (default: false)'),
            metadataAggregation: z
                .string()
                .optional()
                .describe('Aggregation interval for metadata: \'seconds\' or \'minutes\' (default: \'minutes\')'),
        },
    },
    async ({ start, end, includeMetadata, includeRoutes, metadataAggregation }) => {
        return sendRequest('workouts', {
            start,
            end,
            includeMetadata: includeMetadata ?? true,
            includeRoutes: includeRoutes ?? false,
            metadataAggregation: metadataAggregation || 'minutes',
        });
    },
);

// Symptoms
server.registerTool(
    'get_symptoms',
    {
        description: 'Get symptoms data for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('symptoms', { start, end });
    },
);

// State of Mind
server.registerTool(
    'get_state_of_mind',
    {
        description: 'Get state of mind (mood/emotion) data for a specified date range from Apple Health (iOS 18+)',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('state_of_mind', { start, end });
    },
);

// Medications
server.registerTool(
    'get_medications',
    {
        description: 'Get medications data for a specified date range from Apple Health (iOS 26+)',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('medications', { start, end });
    },
);

// Cycle Tracking
server.registerTool(
    'get_cycle_tracking',
    {
        description: 'Get menstrual cycle tracking data for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('cycle_tracking', { start, end });
    },
);

// ECG
server.registerTool(
    'get_ecg',
    {
        description: 'Get ECG (electrocardiogram) data for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('ecg', { start, end });
    },
);

// Heart Notifications
server.registerTool(
    'get_heart_notifications',
    {
        description: 'Get heart notification events (irregular rhythm, high/low heart rate alerts) for a specified date range from Apple Health',
        inputSchema: {
            start: z
                .string()
                .describe('Start timestamp (e.g., \'2025-01-18 00:00:00 -0500\')'),
            end: z
                .string()
                .describe('End timestamp (e.g., \'2025-01-18 23:59:59 -0500\')'),
        },
    },
    async ({ start, end }) => {
        return sendRequest('heart_notifications', { start, end });
    },
);

// Resting Heart Rate (scientific method)
server.registerTool(
    'get_resting_heart_rate',
    {
        description: `Calculates the user's Resting Heart Rate (RHR) per day using a scientifically rigorous method.

METHODOLOGY:
  1. Fetches raw heart rate samples (every minute, no aggregation) for the requested period.
  2. Fetches sleep analysis data for the same period to identify sleep stages.
  3. Attempts to keep only heart rate samples inside deep-sleep (NREM stage 3) windows.
     HealthKit localises sleep-stage labels based on the device language:
       English → "AsleepDeep", Italian → "Profondo", French → "Profond",
       German → "Tief", Spanish/Portuguese → "Profundo".
     If no matching deep-sleep intervals are found (unknown locale), falls back to all
     sleep stages excluding Awake / InBed. The "method" field in the output indicates which
     path was taken: "deep_sleep_p5" (deep sleep only) or "all_sleep_p5" (all sleep fallback).
  4. Groups samples by the calendar date of the sleep interval's start (so a night spanning
     midnight is attributed to the date the person went to sleep).
  5. Computes the 5th percentile of HR values within each day's sleep windows. Using the
     5th percentile (rather than the minimum) makes the estimate robust to isolated artefacts
     and micro-arousals that briefly spike HR.

OUTPUT per day:
  - date              : calendar date (YYYY-MM-DD)
  - rhr_bpm           : 5th-percentile HR during deep sleep (the scientific RHR estimate)
  - samples_count     : number of raw HR samples used in the calculation
  - deep_sleep_minutes: total minutes of deep sleep (or all sleep if fallback) recorded
  - method            : "deep_sleep_p5" or "all_sleep_p5" depending on locale detection

IMPORTANT NOTES:
  - Days with no deep-sleep data (Apple Watch not worn at night, or no NREM deep stage
    recorded) are omitted from results. Check "days_without_data" in the summary.
  - The result differs from Apple's built-in "resting_heart_rate" metric, which samples HR
    during any low-movement period throughout the day. This tool is more conservative and
    precise because it restricts to deep sleep only.
  - Requires Apple Watch to be worn during sleep and Health Auto Export premium access.
  - Use get_health_metrics with metrics="resting_heart_rate" if you want Apple's own estimate.

RECOMMENDED USE:
  - Cardiovascular fitness tracking over weeks/months
  - Detecting overtraining, illness onset, or recovery state (RHR rises 5-7 bpm above
    personal baseline are clinically significant early-warning signals)
  - Comparing trends before/after lifestyle interventions`,
        inputSchema: {
            start: z
                .string()
                .describe(
                    'Start of the date range, inclusive. Format: "YYYY-MM-DD HH:mm:ss ±HHMM" ' +
                    '(e.g. "2026-05-01 00:00:00 +0200"). Use 00:00:00 for the start of the day.',
                ),
            end: z
                .string()
                .describe(
                    'End of the date range, inclusive. Format: "YYYY-MM-DD HH:mm:ss ±HHMM" ' +
                    '(e.g. "2026-05-20 23:59:59 +0200"). Use 23:59:59 for the end of the day.',
                ),
        },
    },
    async ({ start, end }) => {
        const cacheKey = `${start}|${end}`;
        const cached = getRhrCached(cacheKey);
        if (cached) return cached;

        // Fetch raw HR samples and sleep analysis in parallel.
        // IMPORTANT: HAE groups sleep stages by the session's *start night*, so a session
        // that begins at 23:00 on day D and ends at 07:00 on day D+1 is only returned when
        // querying day D, NOT day D+1. We therefore extend the sleep query 1 day backward
        // so that early-morning stages (00:00–08:00) of the previous night are included.
        const sleepStart = new Date(parseHAEDate(start).getTime() - 86_400_000);
        const sleepStartStr = sleepStart.toISOString().replace('T', ' ').slice(0, 19) + ' +0000';

        const [hrRes, sleepRes] = await Promise.all([
            callTCPRaw('health_metrics', {
                start,
                end,
                metrics: 'heart_rate',
                interval: 'minutes',
                aggregate: false,
            }),
            callTCPRaw('health_metrics', {
                start: sleepStartStr,
                end,
                metrics: 'sleep_analysis',
                interval: 'minutes',
                aggregate: false,
            }),
        ]);

        const hrMetric = (hrRes.result?.data?.metrics as any[] ?? [])
            .find((m: any) => m.name === 'heart_rate');
        const sleepMetric = (sleepRes.result?.data?.metrics as any[] ?? [])
            .find((m: any) => m.name === 'sleep_analysis');

        const hrSamples: Array<{ date: string; Avg: number }> = hrMetric?.data ?? [];
        const sleepIntervals: Array<{ startDate: string; endDate: string; value: string }> =
            sleepMetric?.data ?? [];

        // Keep only deep sleep intervals (locale-aware). Falls back to all non-awake sleep
        // if the device language is not in DEEP_SLEEP_LABELS.
        const { selected: usedDeep, method: sleepMethod } = selectSleepIntervals(sleepIntervals);

        const deepIntervals = usedDeep
            .map((s) => ({
                dayKey: s.startDate.slice(0, 10),
                startMs: parseHAEDate(s.startDate).getTime(),
                endMs: parseHAEDate(s.endDate).getTime(),
                durationMin: Math.round(
                    (parseHAEDate(s.endDate).getTime() - parseHAEDate(s.startDate).getTime()) / 60_000,
                ),
            }));

        // Map HR samples into deep-sleep windows, grouped by day
        const dayData = new Map<string, { hrValues: number[]; deepMinutes: number }>();

        for (const interval of deepIntervals) {
            if (!dayData.has(interval.dayKey)) {
                dayData.set(interval.dayKey, { hrValues: [], deepMinutes: 0 });
            }
            const entry = dayData.get(interval.dayKey)!;
            entry.deepMinutes += interval.durationMin;

            for (const sample of hrSamples) {
                const t = parseHAEDate(sample.date).getTime();
                if (t >= interval.startMs && t <= interval.endMs && typeof sample.Avg === 'number') {
                    entry.hrValues.push(sample.Avg);
                }
            }
        }

        // Compute 5th percentile per day
        const results = Array.from(dayData.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, { hrValues, deepMinutes }]) => {
                const sorted = [...hrValues].sort((a, b) => a - b);
                const rhr = percentile(sorted, 0.05);
                return {
                    date,
                    rhr_bpm: Math.round(rhr * 10) / 10,
                    samples_count: hrValues.length,
                    deep_sleep_minutes: deepMinutes,
                    method: sleepMethod,
                };
            });

        const daysWithoutSamples = results
            .filter((r) => r.samples_count === 0)
            .map((r) => r.date);

        const validResults = results.filter((r) => r.samples_count > 0);

        const summary = {
            days_with_data: validResults.length,
            days_without_data: daysWithoutSamples,
            avg_rhr_bpm:
                validResults.length > 0
                    ? Math.round(
                        (validResults.reduce((s, r) => s + r.rhr_bpm, 0) / validResults.length) * 10,
                    ) / 10
                    : null,
            min_rhr_bpm: validResults.length > 0 ? Math.min(...validResults.map((r) => r.rhr_bpm)) : null,
            max_rhr_bpm: validResults.length > 0 ? Math.max(...validResults.map((r) => r.rhr_bpm)) : null,
        };

        const response = {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify({ summary, daily: validResults }, null, 2),
                },
            ],
        };

        // Cache: past queries forever, queries including today for 30 minutes
        const today = new Date().toISOString().slice(0, 10);
        const endDay = end.slice(0, 10);
        const ttl = endDay >= today ? CURRENT_DAY_TTL_MS : Infinity;
        setRhrCache(cacheKey, response, ttl);

        return response;
    },
);

// Maximum Heart Rate estimation (measured from workout data + validated formulas)
server.registerTool(
    'estimate_max_hr',
    {
        description: `Estimates the user's maximum heart rate (HRmax) by combining direct measurement from workout history with validated age-based formulas.

WHY THIS MATTERS:
  HRmax is required for the Karvonen HR-reserve method used in get_workout_heart_rate_zones
  and get_workout_trimp. A wrong HRmax shifts ALL zone boundaries and makes TRIMP inaccurate.
  Age-based formulas have SD ±10–12 bpm — a large error for zone-based training.

METHODOLOGY:
  1. Fetches workouts for the last 90 days (default). 90 days (3 months) is the clinical
     standard for "recent HRmax": it covers a full training block, is sufficient to capture
     at least one near-maximal effort for most active individuals, and avoids the age-related
     drift risk of longer windows. Extend to 180–365 days if you are highly seasonal or
     have had an injury-limited period in the past 3 months.
  2. For each workout with ≥10 HR samples, extracts the single highest "Max" reading.
  3. Computes two measured estimates:
       - peak_hr_observed : absolute highest HR ever recorded. Robust if the user has had
         at least one genuine all-out effort. Potentially affected by rare motion artifacts.
       - peak_hr_p95      : 95th percentile of per-workout peak HRs. Even more reliable:
         if 5 % of your hard sessions reached this HR, it is almost certainly real.
  4. Also computes formula estimates for reference:
       - Tanaka (2001): 208 − 0.7 × age  [best population formula; SD ≈ ±7 bpm]
       - Fox (1971):    220 − age         [classic, higher error; SD ≈ ±10–12 bpm]
  5. Recommends the measured p95 when it exceeds Tanaka (i.e. you've demonstrably hit a
     higher HR than the population average). Otherwise falls back to Tanaka.
     Rule of thumb: if measured p95 ≥ Tanaka − 5, prefer the measured value.

OUTPUT:
  - recommended_max_hr_bpm : the value to use in zone / TRIMP calculations
  - recommended_source      : "measured_p95" | "tanaka_formula" | "no_data"
  - measured.peak_hr_observed_bpm : single highest HR ever recorded
  - measured.peak_hr_p95_bpm      : 95th-percentile of per-workout peaks (more robust)
  - measured.workouts_analyzed    : number of workouts with usable HR data
  - measured.top_5_workouts       : the 5 sessions that reached the highest HR
  - formulas.tanaka_2001          : 208 − 0.7 × age
  - formulas.fox_1971             : 220 − age`,
        inputSchema: {
            age: z
                .number()
                .int()
                .min(10)
                .max(100)
                .describe('Age in years. Required for formula estimates.'),
            lookback_days: z
                .number()
                .int()
                .min(30)
                .max(730)
                .optional()
                .describe('Days of workout history to analyse. Default 90 (3 months — clinical standard for "recent HRmax": covers a full training block and captures at least one near-maximal effort for most athletes, while keeping response times fast).'),
        },
    },
    async ({ age, lookback_days = 90 }) => {
        const now = new Date();
        const resolvedEnd = `${now.toISOString().slice(0, 10)} 23:59:59 +0000`;
        const resolvedStart = `${new Date(now.getTime() - lookback_days * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +0000`;

        const res = await callTCPRaw('workouts', {
            start: resolvedStart,
            end: resolvedEnd,
            includeMetadata: true,
            includeRoutes: false,
            metadataAggregation: 'minutes',  // minute-level aggregation keeps response small; we only need heartRate.max.qty
        });

        const allWorkouts: any[] = res.result?.data?.workouts ?? [];

        // Use the pre-aggregated heartRate.max.qty — no need to iterate heartRateData samples
        type WorkoutPeak = { date: string; name: string; id: string; peak_bpm: number; duration_min: number };
        const workoutPeaks: WorkoutPeak[] = allWorkouts
            .map((w: any) => {
                const peak: number = w.heartRate?.max?.qty ?? NaN;
                return {
                    date: (w.start as string).slice(0, 10),
                    name: (w.name as string) ?? 'Unknown',
                    id: w.id as string,
                    peak_bpm: peak,
                    duration_min: Math.round((w.duration as number) / 60),
                };
            })
            .filter((w) => isFinite(w.peak_bpm) && w.peak_bpm > 0)
            .sort((a, b) => b.peak_bpm - a.peak_bpm);

        const tanaka = Math.round(208 - 0.7 * age);
        const fox = 220 - age;

        if (workoutPeaks.length === 0) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        recommended_max_hr_bpm: tanaka,
                        recommended_source: 'no_data',
                        measured: null,
                        formulas: { tanaka_2001: tanaka, fox_1971: fox },
                        lookback_days,
                        note: 'No workouts with HR data found. Using Tanaka formula.',
                    }, null, 2),
                }],
            };
        }

        const peakObserved = workoutPeaks[0]!.peak_bpm;
        const sortedAsc = [...workoutPeaks.map((w) => w.peak_bpm)].sort((a, b) => a - b);
        const p95 = Math.round(percentile(sortedAsc, 0.95));

        const useMeasured = p95 >= tanaka - 5;
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    recommended_max_hr_bpm: useMeasured ? p95 : tanaka,
                    recommended_source: useMeasured ? 'measured_p95' : 'tanaka_formula',
                    measured: {
                        peak_hr_observed_bpm: peakObserved,
                        peak_hr_p95_bpm: p95,
                        workouts_analyzed: workoutPeaks.length,
                        top_5_workouts: workoutPeaks.slice(0, 5),
                    },
                    formulas: { tanaka_2001: tanaka, fox_1971: fox },
                    lookback_days,
                }, null, 2),
            }],
        };
    },
);

// Workout Heart Rate Zones (Karvonen / HRR method)
server.registerTool(
    'get_workout_heart_rate_zones',
    {
        description: `Calculates time spent in each heart rate zone for every workout in the given date range, using the Karvonen Heart Rate Reserve (HRR) method.

METHODOLOGY (Karvonen / HRR):
  For each HR sample in a workout:
    pct = (hr_sample_avg - rhr) / (max_hr - rhr)

  Zone boundaries:
    Z1 (Recovery / Easy):   pct < 0.60
    Z2 (Aerobic Base):      0.60 ≤ pct < 0.70
    Z3 (Aerobic):           0.70 ≤ pct < 0.80
    Z4 (Threshold):         0.80 ≤ pct < 0.90
    Z5 (VO2 Max / Maximal): pct ≥ 0.90

  Time is computed from the actual duration between consecutive HR samples, not
  just sample count — giving accurate minutes per zone even with irregular sampling.
  Samples where pct < 0 (HR below RHR, e.g. during warm-up rest) are counted in
  "below_rhr_min".

REQUIRED INPUTS:
  - max_hr : user's maximum heart rate in bpm.
             Use 220 - age as a rough estimate, or a field-tested value (e.g. from
             a max-effort test or the maxHeartRate recorded in a previous hard workout).
  - rhr    : resting heart rate in bpm.
             Call get_resting_heart_rate first for a scientifically accurate value,
             or pass Apple's resting_heart_rate metric from get_health_metrics.

OUTPUT per workout:
  - id, name, start, duration_min
  - avg_hr, max_hr_recorded
  - zones     : { z1_min, z2_min, z3_min, z4_min, z5_min, below_rhr_min }
  - zones_pct : same values as % of total tracked time (useful for comparing workouts of different lengths)
  - method         : "karvonen_hrr"
  - hr_reserve_used: max_hr - rhr (for auditing)

NOTE: Workouts with no heartRateData (Apple Watch not worn) are included with zones = null.`,
        inputSchema: {
            start: z
                .string()
                .optional()
                .describe('Start of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to 365 days ago if omitted.'),
            end: z
                .string()
                .optional()
                .describe('End of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to today if omitted.'),
            workout_id: z
                .string()
                .optional()
                .describe('Filter to a single workout by its UUID (from get_workouts or get_workout_trimp). When provided, start/end can be omitted.'),
            max_hr: z
                .number()
                .describe('Maximum heart rate in bpm (e.g. 185). Use 220 - age as estimate if unknown.'),
            rhr: z
                .number()
                .describe('Resting heart rate in bpm. Call get_resting_heart_rate first for best accuracy.'),
        },
    },
    async ({ start, end, workout_id, max_hr, rhr }) => {
        const now = new Date();
        const resolvedEnd = end ?? `${now.toISOString().slice(0, 10)} 23:59:59 +0000`;
        const resolvedStart = start ?? `${new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +0000`;
        const res = await callTCPRaw('workouts', {
            start: resolvedStart,
            end: resolvedEnd,
            includeMetadata: true,
            includeRoutes: false,
            metadataAggregation: 'seconds',
        });

        const allWorkouts: any[] = res.result?.data?.workouts ?? [];
        const workouts = workout_id ? allWorkouts.filter((w: any) => w.id === workout_id) : allWorkouts;
        const reserve = max_hr - rhr;

        const results = workouts.map((w: any) => {
            const samples: Array<{ Avg: number; date: string }> = w.heartRateData ?? [];

            if (samples.length === 0) {
                return {
                    id: w.id,
                    name: w.name,
                    start: w.start,
                    duration_min: Math.round((w.duration ?? 0) / 60 * 10) / 10,
                    avg_hr: w.avgHeartRate?.qty ?? null,
                    max_hr_recorded: w.maxHeartRate?.qty ?? null,
                    zones: null,
                    zones_pct: null,
                    method: 'karvonen_hrr',
                    hr_reserve_used: reserve,
                    note: 'No heartRateData available',
                };
            }

            const workoutEndMs = parseHAEDate(w.end).getTime();
            const zoneSec = calcWorkoutZoneSec(samples, workoutEndMs, rhr, reserve);

            const totalSec = Object.values(zoneSec).reduce((a, b) => a + b, 0);
            const toMin = (s: number): number => Math.round(s / 60 * 10) / 10;
            const toPct = (s: number): number => totalSec > 0 ? Math.round(s / totalSec * 1000) / 10 : 0;

            return {
                id: w.id,
                name: w.name,
                start: w.start,
                duration_min: Math.round((w.duration ?? 0) / 60 * 10) / 10,
                avg_hr: w.avgHeartRate?.qty ?? null,
                max_hr_recorded: w.maxHeartRate?.qty ?? null,
                zones: {
                    z1_min: toMin(zoneSec.z1),
                    z2_min: toMin(zoneSec.z2),
                    z3_min: toMin(zoneSec.z3),
                    z4_min: toMin(zoneSec.z4),
                    z5_min: toMin(zoneSec.z5),
                    below_rhr_min: toMin(zoneSec.below_rhr),
                },
                zones_pct: {
                    z1_pct: toPct(zoneSec.z1),
                    z2_pct: toPct(zoneSec.z2),
                    z3_pct: toPct(zoneSec.z3),
                    z4_pct: toPct(zoneSec.z4),
                    z5_pct: toPct(zoneSec.z5),
                    below_rhr_pct: toPct(zoneSec.below_rhr),
                },
                method: 'karvonen_hrr',
                hr_reserve_used: reserve,
            };
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    max_hr,
                    rhr,
                    hr_reserve: reserve,
                    workout_count: results.length,
                    workouts: results,
                }, null, 2),
            }],
        };
    },
);

// TRIMP (Training Impulse) — zone-weighted training load
server.registerTool(
    'get_workout_trimp',
    {
        description: `Calculates the TRIMP (Training Impulse) score for each workout in the given date range.

WHAT IS TRIMP:
  TRIMP is a training load metric that accounts for both workout duration and intensity.
  Higher zones contribute exponentially more to the score than lower zones, reflecting
  the greater physiological stress of high-intensity work.

FORMULA (zone-weighted variant):
  TRIMP = Σ (zone_minutes × weight × hrr_pct)

  Zone weights and representative HRR %:
    Z1 (Recovery):   weight = 1.0, hrr_pct = 0.55
    Z2 (Aerobic):    weight = 2.0, hrr_pct = 0.65
    Z3 (Aerobic+):   weight = 3.0, hrr_pct = 0.75
    Z4 (Threshold):  weight = 4.5, hrr_pct = 0.85
    Z5 (VO2 Max):    weight = 6.0, hrr_pct = 0.95

  Zone boundaries use Karvonen/HRR:
    pct = (hr_sample_avg - rhr) / (max_hr - rhr)
  Time below RHR (pct < 0) is excluded from the TRIMP calculation.

REQUIRED INPUTS:
  - max_hr : maximum heart rate in bpm (use 220 - age as estimate).
  - rhr    : resting heart rate in bpm (use get_resting_heart_rate for accuracy).

OUTPUT:
  - Per workout: id, name, start, duration_min, trimp, zones_min (breakdown for audit)
  - Summary: total_trimp, workout_count, avg_trimp_per_workout
  - Workouts with no heartRateData get trimp = null.

INTERPRETATION:
  ~50–100   : easy/recovery session
  ~100–200  : moderate aerobic workout
  ~200–400  : hard training session
  > 400     : very high load (long race, intense interval block)
  Chronic Training Load (CTL) is the 42-day rolling average of daily TRIMP.
  Acute Training Load (ATL) is the 7-day rolling average.`,
        inputSchema: {
            start: z
                .string()
                .optional()
                .describe('Start of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to 365 days ago if omitted.'),
            end: z
                .string()
                .optional()
                .describe('End of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to today if omitted.'),
            workout_id: z
                .string()
                .optional()
                .describe('Filter to a single workout by its UUID (from get_workouts or get_workout_heart_rate_zones). When provided, start/end can be omitted.'),
            max_hr: z
                .number()
                .describe('Maximum heart rate in bpm (e.g. 185). Use 220 - age as estimate if unknown.'),
            rhr: z
                .number()
                .describe('Resting heart rate in bpm. Call get_resting_heart_rate first for best accuracy.'),
        },
    },
    async ({ start, end, workout_id, max_hr, rhr }) => {
        const now = new Date();
        const resolvedEnd = end ?? `${now.toISOString().slice(0, 10)} 23:59:59 +0000`;
        const resolvedStart = start ?? `${new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +0000`;
        const res = await callTCPRaw('workouts', {
            start: resolvedStart,
            end: resolvedEnd,
            includeMetadata: true,
            includeRoutes: false,
            metadataAggregation: 'seconds',
        });

        const allWorkouts: any[] = res.result?.data?.workouts ?? [];
        const workouts = workout_id ? allWorkouts.filter((w: any) => w.id === workout_id) : allWorkouts;
        const reserve = max_hr - rhr;

        const results = workouts.map((w: any) => {
            const samples: Array<{ Avg: number; date: string }> = w.heartRateData ?? [];

            if (samples.length === 0) {
                return {
                    id: w.id,
                    name: w.name,
                    start: w.start,
                    duration_min: Math.round((w.duration ?? 0) / 60 * 10) / 10,
                    trimp: null,
                    zones_min: null,
                    note: 'No heartRateData available',
                };
            }

            const workoutEndMs = parseHAEDate(w.end).getTime();
            const zoneSec = calcWorkoutZoneSec(samples, workoutEndMs, rhr, reserve);

            const toMin = (s: number): number => Math.round(s / 60 * 10) / 10;
            const zonesMin = {
                z1_min: toMin(zoneSec.z1),
                z2_min: toMin(zoneSec.z2),
                z3_min: toMin(zoneSec.z3),
                z4_min: toMin(zoneSec.z4),
                z5_min: toMin(zoneSec.z5),
            };

            const trimp = parseFloat(
                (Object.entries(TRIMP_ZONE_PARAMS) as Array<[keyof typeof TRIMP_ZONE_PARAMS, { weight: number; hrr_pct: number }]>)
                    .reduce((sum, [zone, p]) => sum + (zonesMin[`${zone}_min` as keyof typeof zonesMin] ?? 0) * p.weight * p.hrr_pct, 0)
                    .toFixed(1),
            );

            return {
                id: w.id,
                name: w.name,
                start: w.start,
                duration_min: Math.round((w.duration ?? 0) / 60 * 10) / 10,
                trimp,
                zones_min: zonesMin,
            };
        });

        const valid = results.filter((r) => r.trimp !== null);
        const totalTrimp = parseFloat(valid.reduce((s, r) => s + (r.trimp as number), 0).toFixed(1));

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    max_hr,
                    rhr,
                    hr_reserve: reserve,
                    summary: {
                        workout_count: results.length,
                        total_trimp: totalTrimp,
                        avg_trimp_per_workout: valid.length > 0
                            ? parseFloat((totalTrimp / valid.length).toFixed(1))
                            : null,
                    },
                    workouts: results,
                }, null, 2),
            }],
        };
    },
);

async function healthCheck(
    host: string,
    port: number,
    timeout: number = 5000,
): Promise<boolean> {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let hasResponded = false;

        client.setTimeout(timeout);

        client.connect(port, host, () => {
            if (!hasResponded) {
                hasResponded = true;
                client.end();
                resolve(true);
            }
        });

        client.on('error', () => {
            if (!hasResponded) {
                hasResponded = true;
                resolve(false);
            }
        });

        client.on('timeout', () => {
            if (!hasResponded) {
                hasResponded = true;
                client.destroy();
                resolve(false);
            }
        });
    });
}

async function main() {
    console.error(`Performing health check to ${HAE_HOST}:${HAE_PORT}...`);
    const isHealthy = await healthCheck(HAE_HOST, HAE_PORT);

    if (!isHealthy) {
        console.error(
            `Health check warning: Cannot connect to ${HAE_HOST}:${HAE_PORT}. Server will start anyway - ensure Health Auto Export iOS app is running with TCP server enabled.`,
        );
    } else {
        console.error(
            `Health check passed: Successfully connected to ${HAE_HOST}:${HAE_PORT}`,
        );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Health Auto Export MCP Server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});

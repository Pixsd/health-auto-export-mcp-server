import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { parseHAEDate } from '../utils/date.js';
import { percentile } from '../utils/math.js';
import { selectSleepIntervals } from '../formulas/sleep.js';
import type { SleepInterval } from '../formulas/sleep.js';
import { upsertRhrDay, getRhrRange } from '../db/rhrStore.js';

type RhrDayResult = {
    date: string;
    rhr_bpm: number;
    samples_count: number;
    deep_sleep_minutes: number;
    method: string;
};

function buildRhrResponse(
    validResults: RhrDayResult[],
): { content: Array<{ type: 'text'; text: string }> } {
    const summary = {
        days_with_data: validResults.length,
        avg_rhr_bpm:
            validResults.length > 0
                ? Math.round(
                    (validResults.reduce((s, r) => s + r.rhr_bpm, 0) / validResults.length) * 10,
                ) / 10
                : null,
        min_rhr_bpm:
            validResults.length > 0 ? Math.min(...validResults.map((r) => r.rhr_bpm)) : null,
        max_rhr_bpm:
            validResults.length > 0 ? Math.max(...validResults.map((r) => r.rhr_bpm)) : null,
    };
    return {
        content: [{ type: 'text', text: JSON.stringify({ summary, daily: validResults }, null, 2) }],
    };
}

export function registerRestingHrTool(server: McpServer): void {
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
            const today = new Date().toISOString().slice(0, 10);
            const startDay = start.slice(0, 10);
            const endDay = end.slice(0, 10);

            // Fast path: if the entire range is historical and already in DB, skip HAE.
            if (endDay < today) {
                const cached = await getRhrRange(startDay, endDay);
                if (cached.length > 0) {
                    const validResults = cached.map((d) => ({
                        date: d.date,
                        rhr_bpm: d.rhr_bpm,
                        samples_count: d.samples_count,
                        deep_sleep_minutes: d.deep_sleep_minutes,
                        method: d.method,
                    }));
                    return buildRhrResponse(validResults);
                }
            }

            // Fetch raw HR samples and sleep analysis in parallel.
            // IMPORTANT: HAE groups sleep stages by the session's *start night*, so a session
            // that begins at 23:00 on day D and ends at 07:00 on day D+1 is only returned when
            // querying day D, NOT day D+1. We therefore extend the sleep query 1 day backward
            // so that early-morning stages (00:00–08:00) of the previous night are included.
            const sleepStart = new Date(parseHAEDate(start).getTime() - 86_400_000);
            const sleepStartStr =
                sleepStart.toISOString().replace('T', ' ').slice(0, 19) + ' +0000';

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

            const hrMetric = ((hrRes as any).result?.data?.metrics as any[] ?? [])
                .find((m: any) => m.name === 'heart_rate');
            const sleepMetric = ((sleepRes as any).result?.data?.metrics as any[] ?? [])
                .find((m: any) => m.name === 'sleep_analysis');

            const hrSamples: Array<{ date: string; Avg: number }> = hrMetric?.data ?? [];
            const sleepIntervals: SleepInterval[] = sleepMetric?.data ?? [];

            // Keep only deep sleep intervals (locale-aware). Falls back to all non-awake sleep.
            const { selected: usedDeep, method: sleepMethod } =
                selectSleepIntervals(sleepIntervals);

            const deepIntervals = usedDeep.map((s) => ({
                dayKey: s.startDate.slice(0, 10),
                startMs: parseHAEDate(s.startDate).getTime(),
                endMs: parseHAEDate(s.endDate).getTime(),
                durationMin: Math.round(
                    (parseHAEDate(s.endDate).getTime() -
                        parseHAEDate(s.startDate).getTime()) /
                    60_000,
                ),
            }));

            // Map HR samples into deep-sleep windows, grouped by day.
            const dayData = new Map<string, { hrValues: number[]; deepMinutes: number }>();

            for (const interval of deepIntervals) {
                if (!dayData.has(interval.dayKey)) {
                    dayData.set(interval.dayKey, { hrValues: [], deepMinutes: 0 });
                }
                const entry = dayData.get(interval.dayKey)!;
                entry.deepMinutes += interval.durationMin;

                for (const sample of hrSamples) {
                    const t = parseHAEDate(sample.date).getTime();
                    if (
                        t >= interval.startMs &&
                        t <= interval.endMs &&
                        typeof sample.Avg === 'number'
                    ) {
                        entry.hrValues.push(sample.Avg);
                    }
                }
            }

            // Compute 5th percentile per day.
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

            const validResults = results.filter((r) => r.samples_count > 0);

            // Persist to MongoDB: insert-only for past days, upsert for today.
            await Promise.all(
                validResults.map((r) =>
                    upsertRhrDay(
                        {
                            _id: r.date,
                            date: r.date,
                            rhr_bpm: r.rhr_bpm,
                            samples_count: r.samples_count,
                            deep_sleep_minutes: r.deep_sleep_minutes,
                            method: r.method,
                            computed_at: new Date(),
                        },
                        r.date >= today,
                    ),
                ),
            );

            return buildRhrResponse(validResults);
        },
    );
}

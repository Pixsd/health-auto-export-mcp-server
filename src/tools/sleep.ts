import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { getSleepNight, saveSleepNight } from '../db/sleepStore.js';
import type { SleepNightDoc, SleepStageEntry, SleepHrStats } from '../db/types.js';

// ---------------------------------------------------------------------------
// Stage label → canonical name
// ---------------------------------------------------------------------------
const STAGE_MAP: Record<string, string> = {
    // Italian
    'Nucleo': 'Core', 'Profondo': 'Deep', 'REM': 'REM', 'Sveglio': 'Awake',
    'A letto': 'InBed',
    // English (HealthKit enum style)
    'AsleepCore': 'Core', 'AsleepDeep': 'Deep', 'AsleepREM': 'REM',
    'Awake': 'Awake', 'InBed': 'InBed', 'In Bed': 'InBed',
    // French
    'Profond': 'Deep', 'Éveillé': 'Awake', 'Eveillé': 'Awake', 'Au lit': 'InBed',
    // German
    'Tief': 'Deep', 'Wach': 'Awake', 'Im Bett': 'InBed',
    // Spanish / Portuguese
    'Profundo': 'Deep', 'Despierto': 'Awake', 'Desperto': 'Awake',
};

function canonicalStage(label: string): string {
    return STAGE_MAP[label] ?? label;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse HAE timestamp "2026-05-21 06:30:42 +0200" → Date */
function parseTs(s: string): Date {
    // Converts "YYYY-MM-DD HH:MM:SS ±HHMM" → "YYYY-MM-DDTHH:MM:SS±HH:MM"
    return new Date(
        s.replace(
            /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/,
            '$1T$2$3$4:$5',
        ),
    );
}

/** Extract "HH:MM" from HAE timestamp string (already in local time) */
function hhmm(s: string): string {
    return s.slice(11, 16);
}

/** Round to 1 decimal */
function r1(v: number): number {
    return Math.round(v * 10) / 10;
}

/** YYYY-MM-DD of tomorrow given today's date string */
function nextDay(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

/** Yesterday's date (local YYYY-MM-DD, good enough for daily use) */
function yesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Build SleepNightDoc from raw HAE intervals
// ---------------------------------------------------------------------------

type RawInterval = { startDate: string; endDate: string; value: string };

function buildDoc(date: string, raw: RawInterval[]): SleepNightDoc {
    // Normalise and sort
    const intervals = raw
        .map((r) => ({
            startDate: r.startDate,
            endDate: r.endDate,
            stage: canonicalStage(r.value),
            ms: parseTs(r.endDate).getTime() - parseTs(r.startDate).getTime(),
        }))
        .filter((r) => r.ms > 0)
        .sort((a, b) => parseTs(a.startDate).getTime() - parseTs(b.startDate).getTime());

    if (intervals.length === 0) {
        throw new Error(`No sleep intervals found for ${date}`);
    }

    const timeline: SleepStageEntry[] = intervals.map((r) => ({
        start: hhmm(r.startDate),
        end: hhmm(r.endDate),
        stage: r.stage,
        duration_min: r1(r.ms / 60_000),
    }));

    // Totals
    let deep_ms = 0, rem_ms = 0, core_ms = 0, awake_ms = 0;
    for (const r of intervals) {
        if (r.stage === 'Deep')  deep_ms  += r.ms;
        else if (r.stage === 'REM')   rem_ms   += r.ms;
        else if (r.stage === 'Core')  core_ms  += r.ms;
        else if (r.stage === 'Awake') awake_ms += r.ms;
        // InBed counted in time_in_bed but not in sleep totals
    }

    const first = intervals[0]!;
    const last  = intervals[intervals.length - 1]!;
    const time_in_bed_ms = parseTs(last.endDate).getTime() - parseTs(first.startDate).getTime();
    const total_sleep_ms = deep_ms + rem_ms + core_ms;

    return {
        _id: date,
        date,
        sleep_start: hhmm(first.startDate),
        sleep_end:   hhmm(last.endDate),
        time_in_bed_min:  r1(time_in_bed_ms  / 60_000),
        total_sleep_min:  r1(total_sleep_ms  / 60_000),
        deep_min:  r1(deep_ms  / 60_000),
        rem_min:   r1(rem_ms   / 60_000),
        core_min:  r1(core_ms  / 60_000),
        awake_min: r1(awake_ms / 60_000),
        efficiency_pct: time_in_bed_ms > 0
            ? r1(total_sleep_ms / time_in_bed_ms * 100)
            : 0,
        timeline,
        hr: null,
        fetched_at: new Date(),
    };
}

// ---------------------------------------------------------------------------
// HR stats computation
// ---------------------------------------------------------------------------

type HrSample = { date: string; qty?: number; Avg?: number; Min?: number; Max?: number };

interface ExtraVitals {
    rrSamples: HrSample[];
    spo2Samples: HrSample[];
    hrvSamples: HrSample[];
}

function simpleStats(vals: number[]): { avg: number; min: number; max: number } | null {
    if (vals.length === 0) return null;
    const avg = r1(vals.reduce((a, b) => a + b, 0) / vals.length);
    return { avg, min: r1(Math.min(...vals)), max: r1(Math.max(...vals)) };
}

function computeHrStats(
    hrSamples: HrSample[],
    timeline: SleepStageEntry[],
    sleepStart: string,
    sleepEnd: string,
    baseDate: string,
    extra: ExtraVitals,
    tz: string,
): SleepHrStats {
    // Parse sample timestamps — HAE returns "YYYY-MM-DD HH:MM:SS ±HHMM" in date field
    type ParsedSample = { ts: Date; bpm: number };
    const parsed: ParsedSample[] = hrSamples
        .map((s) => ({ ts: parseTs(s.date), bpm: s.qty ?? s.Avg ?? 0 }))
        .filter((s) => !isNaN(s.ts.getTime()) && s.bpm > 20 && s.bpm < 220);

    // Filter to sleep window only
    // The fetch window starts at 20:00 on baseDate — if sleepStart is before noon
    // it crossed midnight and belongs to nextDay(baseDate).
    const startDateStr = sleepStart < '12:00' ? nextDay(baseDate) : baseDate;
    const nightStart = parseTs(`${startDateStr} ${sleepStart}:00 ${tz}`);
    const endDateStr = sleepEnd < sleepStart ? nextDay(startDateStr) : startDateStr;
    const nightEnd   = parseTs(`${endDateStr} ${sleepEnd}:00 ${tz}`);

    const nightSamples = parsed.filter(
        (s) => s.ts >= nightStart && s.ts <= nightEnd,
    );

    // Helper: filter any sample list to the sleep window and return values
    function nightVals(samples: HrSample[]): number[] {
        return samples
            .map((s) => ({ ts: parseTs(s.date), v: s.qty ?? s.Avg ?? 0 }))
            .filter((s) => !isNaN(s.ts.getTime()) && s.ts >= nightStart && s.ts <= nightEnd)
            .map((s) => s.v);
    }

    // Respiratory rate
    const rrVals  = nightVals(extra.rrSamples).filter((v) => v > 4 && v < 40);
    const rrStats = simpleStats(rrVals);

    // SpO2
    const spo2Vals  = nightVals(extra.spo2Samples).filter((v) => v > 50 && v <= 100);
    const spo2Stats = simpleStats(spo2Vals);

    // HRV (take median of available samples for the night)
    const hrvVals = nightVals(extra.hrvSamples).filter((v) => v > 0 && v < 300);
    const hrv_rmssd_ms = hrvVals.length > 0
        ? r1(hrvVals.reduce((a, b) => a + b, 0) / hrvVals.length)
        : null;

    if (nightSamples.length === 0) {
        return {
            avg_bpm: 0, min_bpm: 0, max_bpm: 0,
            per_stage: { deep_avg_bpm: null, rem_avg_bpm: null, core_avg_bpm: null, awake_avg_bpm: null },
            respiratory_rate_avg_rpm: rrStats?.avg ?? null,
            respiratory_rate_min_rpm: rrStats?.min ?? null,
            respiratory_rate_max_rpm: rrStats?.max ?? null,
            spo2_avg_pct: spo2Stats?.avg ?? null,
            spo2_min_pct: spo2Stats?.min ?? null,
            hrv_rmssd_ms,
        };
    }

    const bpms = nightSamples.map((s) => s.bpm);
    const avg  = r1(bpms.reduce((a, b) => a + b, 0) / bpms.length);
    const min  = r1(Math.min(...bpms));
    const max  = r1(Math.max(...bpms));

    // Per-stage average: for each stage collect samples whose ts falls within any interval of that stage
    const stageBuckets: Record<string, number[]> = { Deep: [], REM: [], Core: [], Awake: [] };

    for (const entry of timeline) {
        const bucket = stageBuckets[entry.stage];
        if (!bucket) continue;
        // Reconstruct absolute start/end — HH:MM strings, cross-midnight aware
        const eStartDate = entry.start < sleepStart ? nextDay(startDateStr) : startDateStr;
        const eEndDate   = entry.end   < sleepStart ? nextDay(startDateStr) : startDateStr;
        const eStart = parseTs(`${eStartDate} ${entry.start}:00 ${tz}`);
        const eEnd   = parseTs(`${eEndDate}   ${entry.end}:00 ${tz}`);
        
        for (const s of parsed) {
            if (s.ts >= eStart && s.ts <= eEnd) bucket.push(s.bpm);
        }
    }

    function stageAvg(stage: string): number | null {
        const b = stageBuckets[stage];
        if (!b || b.length === 0) return null;
        return r1(b.reduce((a, v) => a + v, 0) / b.length);
    }

    return {
        avg_bpm: avg,
        min_bpm: min,
        max_bpm: max,
        per_stage: {
            deep_avg_bpm:  stageAvg('Deep'),
            rem_avg_bpm:   stageAvg('REM'),
            core_avg_bpm:  stageAvg('Core'),
            awake_avg_bpm: stageAvg('Awake'),
        },
        respiratory_rate_avg_rpm: rrStats?.avg ?? null,
        respiratory_rate_min_rpm: rrStats?.min ?? null,
        respiratory_rate_max_rpm: rrStats?.max ?? null,
        spo2_avg_pct: spo2Stats?.avg ?? null,
        spo2_min_pct: spo2Stats?.min ?? null,
        hrv_rmssd_ms,
    };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerSleepTool(server: McpServer): void {
    server.registerTool(
        'get_sleep_night',
        {
            description:
                'Get a structured summary of a single night of sleep (phases, totals, efficiency). ' +
                'Results are cached in MongoDB — re-fetches only if not yet cached. ' +
                'The "date" parameter is the evening the night started (e.g. "2026-05-20" = night of 20→21 May). ' +
                'Defaults to last night.',
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe('Evening date of the night (YYYY-MM-DD). Default: last night.'),
                tz_offset: z
                    .string()
                    .optional()
                    .describe('Timezone offset for the HAE request, e.g. "+0200". Default: "+0200".'),
                force_refresh: z
                    .boolean()
                    .optional()
                    .describe('Ignore cache and re-fetch from Apple Health. Default: false.'),
                include_heart_rate: z
                    .boolean()
                    .optional()
                    .describe('Include heart rate stats (avg/min/max + per sleep stage). Default: false.'),

            },
        },
        async ({ date, tz_offset, force_refresh, include_heart_rate }) => {
            const night      = date ?? yesterday();
            const tz         = tz_offset ?? '+0200';
            const withHr     = include_heart_rate ?? false;

            // Cache lookup (skip if force_refresh)
            if (!force_refresh) {
                const cached = await getSleepNight(night);
                if (cached) {
                    // If HR was requested but not in cache, fall through to re-fetch
                    if (!withHr || cached.hr !== null) {
                        const { fetched_at, ...rest } = cached;
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({ ...rest, cached: true, fetched_at }, null, 2),
                            }],
                        };
                    }
                }
            }

            // Fetch from HAE: window = evening 20:00 → next day 12:00
            const morning = nextDay(night);
            const start   = `${night} 20:00:00 ${tz}`;
            const end     = `${morning} 12:00:00 ${tz}`;

            type MetricsResponse = {
                result?: { data?: { metrics?: Array<{ name: string; data: (RawInterval & { qty?: number })[] }> } };
            };

            // Fetch sleep_analysis (hours) and vitals (minutes) in two separate parallel calls
            // to avoid HAE silently dropping metrics when interval mixes don't work
            const fetchSleep = callTCPRaw('health_metrics', {
                start, end,
                metrics: 'sleep_analysis',
                interval: 'hours',
                aggregate: false,
            });
            const fetchVitals = withHr
                ? callTCPRaw('health_metrics', {
                    start, end,
                    metrics: 'heart_rate,respiratory_rate,oxygen_saturation,heart_rate_variability',
                    interval: 'minutes',
                    aggregate: false,
                })
                : Promise.resolve(null);

            const [rawSleep, rawVitals] = await Promise.all([fetchSleep, fetchVitals]);

            const sleepMetrics = (rawSleep as MetricsResponse).result?.data?.metrics ?? [];
            const vitalsMetrics = rawVitals ? (rawVitals as MetricsResponse).result?.data?.metrics ?? [] : [];

            const sleepData  = sleepMetrics.find((m) => m.name === 'sleep_analysis')?.data ?? [];
            const hrData     = vitalsMetrics.find((m) => m.name === 'heart_rate')?.data ?? [];
            const rrData     = vitalsMetrics.find((m) => m.name === 'respiratory_rate')?.data ?? [];
            const spo2Data   = vitalsMetrics.find((m) => m.name === 'oxygen_saturation')?.data ?? [];
            const hrvData    = vitalsMetrics.find((m) => m.name === 'heart_rate_variability')?.data ?? [];

            if (sleepData.length === 0) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: `No sleep data found for night of ${night}` }),
                    }],
                };
            }

            const doc = buildDoc(night, sleepData);

            // Compute HR + vitals stats if requested
            if (withHr && hrData.length > 0) {
                doc.hr = computeHrStats(
                    hrData as unknown as HrSample[],
                    doc.timeline,
                    doc.sleep_start,
                    doc.sleep_end,
                    night,
                    {
                        rrSamples:  rrData   as unknown as HrSample[],
                        spo2Samples: spo2Data as unknown as HrSample[],
                        hrvSamples:  hrvData  as unknown as HrSample[],
                    },
                    tz,
                );
            }

            // Cache only completed nights (night date < today)
            const today = new Date().toISOString().slice(0, 10);
            if (night < today) {
                await saveSleepNight(doc).catch(() => { /* non-fatal */ });
            }

            const { fetched_at, ...rest } = doc;
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({ ...rest, cached: false, fetched_at }, null, 2),
                }],
            };
        },
    );
}

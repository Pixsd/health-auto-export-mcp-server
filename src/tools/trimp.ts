import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import {
    getProcessedWorkouts,
    saveProcessedWorkout,
    batchResolveHrParams,
    computeWorkoutDoc,
} from '../db/workoutStore.js';
import type { WorkoutProcessedDoc } from '../db/types.js';

export function registerTrimpTool(server: McpServer): void {
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

HR PARAMETERS (rhr / max_hr):
  These are now OPTIONAL. When omitted, the tool automatically resolves the
  most appropriate historical values from the database:
  - rhr    : closest RHR entry on or before the workout date (within 30 days).
  - max_hr : closest max-HR snapshot on or before the workout date (within 365 days).
  If no DB value is available, provide a fallback here.

OUTPUT:
  - Per workout: id, name, start, duration_min, trimp, zones_min (breakdown for audit)
  - Summary: total_trimp, workout_count, avg_trimp_per_workout
  - rhr_used, max_hr_used, rhr_source, max_hr_source (actual values used)
  - cached: true if the result was served from the database
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
                    .describe(
                        'Start of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to 365 days ago if omitted.',
                    ),
                end: z
                    .string()
                    .optional()
                    .describe(
                        'End of date range. Format: "YYYY-MM-DD HH:mm:ss ±HHMM". Defaults to today if omitted.',
                    ),
                workout_id: z
                    .string()
                    .optional()
                    .describe(
                        'Filter to a single workout by its UUID (from get_workouts or get_workout_heart_rate_zones). When provided, start/end can be omitted.',
                    ),
                workout_date: z
                    .string()
                    .optional()
                    .describe(
                        'Date of the workout in YYYY-MM-DD format. Use together with workout_id to avoid fetching 365 days of data — narrows the TCP request to a single day and avoids timeouts.',
                    ),
                max_hr: z
                    .number()
                    .optional()
                    .describe(
                        'Fallback maximum heart rate in bpm. Used only if no DB snapshot exists for the workout date.',
                    ),
                rhr: z
                    .number()
                    .optional()
                    .describe(
                        'Fallback resting heart rate in bpm. Used only if no DB entry exists for the workout date.',
                    ),
            },
        },
        async ({ start, end, workout_id, workout_date, max_hr, rhr }) => {
            const now = new Date();
            const today = now.toISOString().slice(0, 10);
            const resolvedEnd = end ?? (workout_date ? `${workout_date} 23:59:59 +0000` : `${today} 23:59:59 +0000`);
            const resolvedStart =
                start ?? (workout_date
                    ? `${workout_date} 00:00:00 +0000`
                    : `${new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +0000`);

            const res = await callTCPRaw('workouts', {
                start: resolvedStart,
                end: resolvedEnd,
                includeMetadata: true,
                includeRoutes: false,
                metadataAggregation: 'seconds',
            });

            const allWorkouts: any[] = (res as any).result?.data?.workouts ?? [];
            const workouts = workout_id
                ? allWorkouts.filter((w: any) => w.id === workout_id)
                : allWorkouts;

            // ── Batch-fetch cached results for past workouts ───────────────────────────
            const pastIds = workouts
                .filter((w: any) => (w.start as string).slice(0, 10) < today)
                .map((w: any) => w.id as string);
            const cachedMap = await getProcessedWorkouts(pastIds);

            // ── Resolve HR params for uncached workouts (batch) ───────────────────────
            const toProcess = workouts.filter((w: any) => !cachedMap.has(w.id as string));
            const hrParamsMap = await batchResolveHrParams(
                toProcess.map((w: any) => (w.start as string).slice(0, 10)),
                rhr,
                max_hr,
            );

            // ── Compute and persist ───────────────────────────────────────────────────
            const computedMap = new Map<string, WorkoutProcessedDoc>();
            await Promise.all(
                toProcess.map(async (w: any) => {
                    const workoutDate = (w.start as string).slice(0, 10);
                    const hrParams = hrParamsMap.get(workoutDate);
                    if (!hrParams) return;
                    const doc = computeWorkoutDoc(w, hrParams);
                    computedMap.set(w.id as string, doc);
                    const isToday = workoutDate >= today;
                    await saveProcessedWorkout(doc, isToday);
                }),
            );

            // ── Build response ────────────────────────────────────────────────────────
            const results = workouts.map((w: any) => {
                const id = w.id as string;
                const doc = cachedMap.get(id) ?? computedMap.get(id);

                if (!doc) {
                    return {
                        id,
                        name: w.name as string,
                        start: w.start as string,
                        duration_min: Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
                        trimp: null,
                        zones_min: null,
                        note: 'Cannot compute: no HR parameters available. Call get_resting_heart_rate and estimate_max_hr first.',
                    };
                }

                return {
                    id: doc._id,
                    name: doc.name,
                    start: doc.start,
                    duration_min: doc.duration_min,
                    trimp: doc.trimp,
                    zones_min: doc.zones_min,
                    rhr_used: doc.rhr_used,
                    max_hr_used: doc.max_hr_used,
                    hr_reserve_used: doc.hr_reserve_used,
                    rhr_source: doc.rhr_source,
                    max_hr_source: doc.max_hr_source,
                    cached: cachedMap.has(id),
                };
            });

            const valid = results.filter((r) => r.trimp !== null);
            const totalTrimp = parseFloat(
                valid.reduce((s, r) => s + (r.trimp as number), 0).toFixed(1),
            );

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                summary: {
                                    workout_count: results.length,
                                    total_trimp: totalTrimp,
                                    avg_trimp_per_workout:
                                        valid.length > 0
                                            ? parseFloat((totalTrimp / valid.length).toFixed(1))
                                            : null,
                                },
                                workouts: results,
                            },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );
}


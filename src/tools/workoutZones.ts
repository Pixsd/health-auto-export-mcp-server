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

export function registerWorkoutZonesTool(server: McpServer): void {
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

HR PARAMETERS (rhr / max_hr):
  These are now OPTIONAL. When omitted, the tool automatically resolves the
  most appropriate historical values from the database:
  - rhr    : closest RHR entry on or before the workout date (within 30 days).
  - max_hr : closest max-HR snapshot on or before the workout date (within 365 days).
  If no DB value is available, provide a fallback here.
  Call get_resting_heart_rate and estimate_max_hr to populate the database first.

OUTPUT per workout:
  - id, name, start, duration_min
  - avg_hr, max_hr_recorded
  - zones     : { z1_min, z2_min, z3_min, z4_min, z5_min, below_rhr_min }
  - zones_pct : same values as % of total tracked time
  - rhr_used, max_hr_used, hr_reserve_used (actual values used for computation)
  - rhr_source, max_hr_source (e.g. "db:2026-05-01" or "provided")
  - cached    : true if the result was served from the database

NOTE: Workouts with no heartRateData (Apple Watch not worn) are included with zones = null.
NOTE: Historical workouts are cached in MongoDB and served instantly on repeated calls.`,
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
                        'Filter to a single workout by its UUID (from get_workouts or get_workout_trimp). When provided, start/end can be omitted.',
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

            // ── Batch-fetch cached results for past workouts ───────────────────
            const pastIds = workouts
                .filter((w: any) => (w.start as string).slice(0, 10) < today)
                .map((w: any) => w.id as string);
            const cachedMap = await getProcessedWorkouts(pastIds);

            // ── Resolve HR params for uncached workouts (batch) ───────────────
            const toProcess = workouts.filter((w: any) => !cachedMap.has(w.id as string));
            const hrParamsMap = await batchResolveHrParams(
                toProcess.map((w: any) => (w.start as string).slice(0, 10)),
                rhr,
                max_hr,
            );

            // ── Compute and persist ───────────────────────────────────────────
            const computedMap = new Map<string, WorkoutProcessedDoc>();
            await Promise.all(
                toProcess.map(async (w: any) => {
                    const workoutDate = (w.start as string).slice(0, 10);
                    const hrParams = hrParamsMap.get(workoutDate);
                    if (!hrParams) return; // no HR data → skip (included in output with note)
                    const doc = computeWorkoutDoc(w, hrParams);
                    computedMap.set(w.id as string, doc);
                    const isToday = workoutDate >= today;
                    await saveProcessedWorkout(doc, isToday);
                }),
            );

            // ── Build response ────────────────────────────────────────────────
            const results = workouts.map((w: any) => {
                const id = w.id as string;
                const doc = cachedMap.get(id) ?? computedMap.get(id);

                if (!doc) {
                    return {
                        id,
                        name: w.name as string,
                        start: w.start as string,
                        duration_min:
                            Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
                        zones: null,
                        zones_pct: null,
                        note: 'Cannot compute: no HR parameters available. Call get_resting_heart_rate and estimate_max_hr first.',
                    };
                }

                return {
                    id: doc._id,
                    name: doc.name,
                    start: doc.start,
                    duration_min: doc.duration_min,
                    avg_hr: doc.avg_hr,
                    max_hr_recorded: doc.max_hr_recorded,
                    zones: doc.zones,
                    zones_pct: doc.zones_pct,
                    rhr_used: doc.rhr_used,
                    max_hr_used: doc.max_hr_used,
                    hr_reserve_used: doc.hr_reserve_used,
                    rhr_source: doc.rhr_source,
                    max_hr_source: doc.max_hr_source,
                    cached: cachedMap.has(id),
                };
            });

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            { workout_count: results.length, workouts: results },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );
}

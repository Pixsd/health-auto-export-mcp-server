import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { parseHAEDate } from '../utils/date.js';
import { calcWorkoutZoneSec } from '../formulas/workout.js';

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
                max_hr: z
                    .number()
                    .describe(
                        'Maximum heart rate in bpm (e.g. 185). Use 220 - age as estimate if unknown.',
                    ),
                rhr: z
                    .number()
                    .describe(
                        'Resting heart rate in bpm. Call get_resting_heart_rate first for best accuracy.',
                    ),
            },
        },
        async ({ start, end, workout_id, max_hr, rhr }) => {
            const now = new Date();
            const resolvedEnd =
                end ?? `${now.toISOString().slice(0, 10)} 23:59:59 +0000`;
            const resolvedStart =
                start ??
                `${new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10)} 00:00:00 +0000`;

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
            const reserve = max_hr - rhr;

            const results = workouts.map((w: any) => {
                const samples: Array<{ Avg: number; date: string }> =
                    w.heartRateData ?? [];

                if (samples.length === 0) {
                    return {
                        id: w.id,
                        name: w.name,
                        start: w.start,
                        duration_min: Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
                        avg_hr: w.avgHeartRate?.qty ?? null,
                        max_hr_recorded: w.maxHeartRate?.qty ?? null,
                        zones: null,
                        zones_pct: null,
                        method: 'karvonen_hrr',
                        hr_reserve_used: reserve,
                        note: 'No heartRateData available',
                    };
                }

                const workoutEndMs = parseHAEDate(w.end as string).getTime();
                const zoneSec = calcWorkoutZoneSec(samples, workoutEndMs, rhr, reserve);

                const totalSec = Object.values(zoneSec).reduce((a, b) => a + b, 0);
                const toMin = (s: number): number => Math.round(s / 60 * 10) / 10;
                const toPct = (s: number): number =>
                    totalSec > 0 ? Math.round((s / totalSec) * 1000) / 10 : 0;

                return {
                    id: w.id,
                    name: w.name,
                    start: w.start,
                    duration_min: Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
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
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
                                max_hr,
                                rhr,
                                hr_reserve: reserve,
                                workout_count: results.length,
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

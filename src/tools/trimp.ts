import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { parseHAEDate } from '../utils/date.js';
import { TRIMP_ZONE_PARAMS, calcWorkoutZoneSec } from '../formulas/workout.js';

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
                        trimp: null,
                        zones_min: null,
                        note: 'No heartRateData available',
                    };
                }

                const workoutEndMs = parseHAEDate(w.end as string).getTime();
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
                    (
                        Object.entries(TRIMP_ZONE_PARAMS) as Array<
                            [keyof typeof TRIMP_ZONE_PARAMS, { weight: number; hrr_pct: number }]
                        >
                    )
                        .reduce(
                            (sum, [zone, p]) =>
                                sum +
                                (zonesMin[`${zone}_min` as keyof typeof zonesMin] ?? 0) *
                                    p.weight *
                                    p.hrr_pct,
                            0,
                        )
                        .toFixed(1),
                );

                return {
                    id: w.id,
                    name: w.name,
                    start: w.start,
                    duration_min: Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
                    trimp,
                    zones_min: zonesMin,
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
                                max_hr,
                                rhr,
                                hr_reserve: reserve,
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

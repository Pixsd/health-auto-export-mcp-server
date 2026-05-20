import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callTCPRaw } from '../tcp/client.js';
import { percentile } from '../utils/math.js';

export function registerMaxHrTool(server: McpServer): void {
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
                    .describe(
                        'Days of workout history to analyse. Default 90 (3 months — clinical standard for "recent HRmax": covers a full training block and captures at least one near-maximal effort for most athletes, while keeping response times fast).',
                    ),
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
                // Minute-level aggregation keeps response small; we only need heartRate.max.qty.
                metadataAggregation: 'minutes',
            });

            const allWorkouts: any[] = (res as any).result?.data?.workouts ?? [];

            type WorkoutPeak = {
                date: string;
                name: string;
                id: string;
                peak_bpm: number;
                duration_min: number;
            };

            // Use the pre-aggregated heartRate.max.qty — no need to iterate heartRateData samples.
            const workoutPeaks: WorkoutPeak[] = allWorkouts
                .map((w: any) => ({
                    date: (w.start as string).slice(0, 10),
                    name: (w.name as string) ?? 'Unknown',
                    id: w.id as string,
                    peak_bpm: (w.heartRate?.max?.qty as number) ?? NaN,
                    duration_min: Math.round((w.duration as number) / 60),
                }))
                .filter((w) => isFinite(w.peak_bpm) && w.peak_bpm > 0)
                .sort((a, b) => b.peak_bpm - a.peak_bpm);

            const tanaka = Math.round(208 - 0.7 * age);
            const fox = 220 - age;

            if (workoutPeaks.length === 0) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    recommended_max_hr_bpm: tanaka,
                                    recommended_source: 'no_data',
                                    measured: null,
                                    formulas: { tanaka_2001: tanaka, fox_1971: fox },
                                    lookback_days,
                                    note: 'No workouts with HR data found. Using Tanaka formula.',
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            }

            const peakObserved = workoutPeaks[0]!.peak_bpm;
            const sortedAsc = [...workoutPeaks.map((w) => w.peak_bpm)].sort((a, b) => a - b);
            const p95 = Math.round(percentile(sortedAsc, 0.95));

            const useMeasured = p95 >= tanaka - 5;

            return {
                content: [
                    {
                        type: 'text' as const,
                        text: JSON.stringify(
                            {
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

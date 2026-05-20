import { parseHAEDate } from '../utils/date.js';

/**
 * Zone weights and representative HRR % used for the TRIMP (Training Impulse) formula.
 *
 * TRIMP = Σ (zone_minutes × weight × hrr_pct)
 *
 * Zone boundaries use Karvonen/HRR:
 *   pct = (hr_sample_avg - rhr) / (max_hr - rhr)
 *
 *   Z1 Recovery  : pct < 0.60
 *   Z2 Aerobic   : 0.60 ≤ pct < 0.70
 *   Z3 Aerobic+  : 0.70 ≤ pct < 0.80
 *   Z4 Threshold : 0.80 ≤ pct < 0.90
 *   Z5 VO2 Max   : pct ≥ 0.90
 */
export const TRIMP_ZONE_PARAMS = {
    z1: { weight: 1.0, hrr_pct: 0.55 },
    z2: { weight: 2.0, hrr_pct: 0.65 },
    z3: { weight: 3.0, hrr_pct: 0.75 },
    z4: { weight: 4.5, hrr_pct: 0.85 },
    z5: { weight: 6.0, hrr_pct: 0.95 },
} as const;

/**
 * Computes seconds spent in each HR zone for a workout using the Karvonen/HRR method.
 *
 * Time is derived from the actual gap between consecutive HR samples (not sample count),
 * so zone durations are accurate even with irregular sampling intervals.
 * Samples where pct < 0 (HR below RHR) are counted in `below_rhr`.
 */
export function calcWorkoutZoneSec(
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

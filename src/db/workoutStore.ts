import { getDb } from './client.js';
import { getRhrForDate } from './rhrStore.js';
import { getMaxHrForDate } from './maxHrStore.js';
import { calcWorkoutZoneSec, TRIMP_ZONE_PARAMS } from '../formulas/workout.js';
import { parseHAEDate } from '../utils/date.js';
import type { WorkoutProcessedDoc, ZonesData, ZonesPctData } from './types.js';

const COL = 'workout_processed';

export async function getProcessedWorkout(workoutId: string): Promise<WorkoutProcessedDoc | null> {
    return (await getDb()).collection<WorkoutProcessedDoc>(COL).findOne({ _id: workoutId });
}

/**
 * Batch-loads processed workouts for a list of IDs.
 * Returns a Map<workoutId, doc>.
 */
export async function getProcessedWorkouts(
    workoutIds: string[],
): Promise<Map<string, WorkoutProcessedDoc>> {
    if (workoutIds.length === 0) return new Map();
    const docs = await (await getDb())
        .collection<WorkoutProcessedDoc>(COL)
        .find({ _id: { $in: workoutIds } })
        .toArray();
    return new Map(docs.map((d) => [d._id, d]));
}

/**
 * Saves a processed workout.
 * - Past workouts: insert-only (immutable once written).
 * - Today's workouts: not cached (data may be incomplete).
 */
export async function saveProcessedWorkout(
    doc: WorkoutProcessedDoc,
    isToday: boolean,
): Promise<void> {
    if (isToday) return; // Do not cache in-progress workout data
    const col = (await getDb()).collection<WorkoutProcessedDoc>(COL);
    await col.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
}

// ── HR parameter resolver ─────────────────────────────────────────────────────

export interface ResolvedHrParams {
    rhr: number;
    max_hr: number;
    rhr_source: string;    // "db:YYYY-MM-DD" | "provided"
    max_hr_source: string; // "db:YYYY-MM-DD" | "provided"
}

/**
 * Resolves the RHR and maxHR to use for a workout on the given date.
 *
 * Strategy:
 *   1. Look up the most recent RHR entry ≤ workout_date in the DB.
 *   2. Look up the most recent max-HR snapshot ≤ workout_date in the DB.
 *   3. Fall back to `fallbackRhr` / `fallbackMaxHr` when DB has no entry.
 *   4. Return null if either value cannot be resolved.
 *
 * This ensures historical workouts are always computed with the HR parameters
 * that were valid at that time — not today's values.
 */
export async function resolveHrParams(
    workoutDate: string,
    fallbackRhr?: number,
    fallbackMaxHr?: number,
): Promise<ResolvedHrParams | null> {
    const [rhrDoc, maxHrDoc] = await Promise.all([
        getRhrForDate(workoutDate),
        getMaxHrForDate(workoutDate),
    ]);

    const rhr = rhrDoc?.rhr_bpm ?? fallbackRhr;
    const max_hr = maxHrDoc?.recommended_max_hr_bpm ?? fallbackMaxHr;

    if (rhr === undefined || max_hr === undefined) return null;

    return {
        rhr,
        max_hr,
        rhr_source: rhrDoc ? `db:${rhrDoc.date}` : 'provided',
        max_hr_source: maxHrDoc ? `db:${maxHrDoc.end_date}` : 'provided',
    };
}

/**
 * Batch-resolves HR params for a set of workout dates. Returns a Map<date, params>.
 * Dates for which neither DB data nor fallbacks are available are omitted.
 */
export async function batchResolveHrParams(
    workoutDates: string[],
    fallbackRhr?: number,
    fallbackMaxHr?: number,
): Promise<Map<string, ResolvedHrParams>> {
    const uniqueDates = [...new Set(workoutDates)];
    const results = await Promise.all(
        uniqueDates.map(async (date) => {
            const params = await resolveHrParams(date, fallbackRhr, fallbackMaxHr);
            return [date, params] as const;
        }),
    );
    const map = new Map<string, ResolvedHrParams>();
    for (const [date, params] of results) {
        if (params !== null) map.set(date, params);
    }
    return map;
}

// ── Workout computation ───────────────────────────────────────────────────────

/**
 * Computes HR zones and TRIMP for a raw HAE workout using the given HR parameters.
 * Returns a complete WorkoutProcessedDoc ready to be stored in MongoDB.
 *
 * Both zones and TRIMP are always computed together so either tool can serve
 * from the same cached document.
 */
export function computeWorkoutDoc(
    w: any,
    hrParams: ResolvedHrParams,
): WorkoutProcessedDoc {
    const workoutDate = (w.start as string).slice(0, 10);
    const samples: Array<{ Avg: number; date: string }> = w.heartRateData ?? [];
    const reserve = hrParams.max_hr - hrParams.rhr;

    const base = {
        _id: w.id as string,
        workout_date: workoutDate,
        name: w.name as string,
        start: w.start as string,
        duration_min: Math.round(((w.duration as number) ?? 0) / 60 * 10) / 10,
        avg_hr: (w.avgHeartRate?.qty as number | undefined) ?? null,
        max_hr_recorded: (w.maxHeartRate?.qty as number | undefined) ?? null,
        rhr_used: hrParams.rhr,
        max_hr_used: hrParams.max_hr,
        hr_reserve_used: reserve,
        rhr_source: hrParams.rhr_source,
        max_hr_source: hrParams.max_hr_source,
        computed_at: new Date(),
    };

    if (samples.length === 0) {
        return { ...base, zones: null, zones_pct: null, trimp: null, zones_min: null };
    }

    const workoutEndMs = parseHAEDate(w.end as string).getTime();
    const zoneSec = calcWorkoutZoneSec(samples, workoutEndMs, hrParams.rhr, reserve);
    const totalSec = Object.values(zoneSec).reduce((a, b) => a + b, 0);
    const toMin = (s: number): number => Math.round(s / 60 * 10) / 10;
    const toPct = (s: number): number =>
        totalSec > 0 ? Math.round((s / totalSec) * 1000) / 10 : 0;

    const zonesMin: Omit<ZonesData, 'below_rhr_min'> = {
        z1_min: toMin(zoneSec.z1),
        z2_min: toMin(zoneSec.z2),
        z3_min: toMin(zoneSec.z3),
        z4_min: toMin(zoneSec.z4),
        z5_min: toMin(zoneSec.z5),
    };

    const zones: ZonesData = { ...zonesMin, below_rhr_min: toMin(zoneSec.below_rhr) };

    const zones_pct: ZonesPctData = {
        z1_pct: toPct(zoneSec.z1),
        z2_pct: toPct(zoneSec.z2),
        z3_pct: toPct(zoneSec.z3),
        z4_pct: toPct(zoneSec.z4),
        z5_pct: toPct(zoneSec.z5),
        below_rhr_pct: toPct(zoneSec.below_rhr),
    };

    const trimp = parseFloat(
        (
            Object.entries(TRIMP_ZONE_PARAMS) as Array<
                [keyof typeof TRIMP_ZONE_PARAMS, { weight: number; hrr_pct: number }]
            >
        )
            .reduce(
                (sum, [zone, p]) =>
                    sum + (zonesMin[`${zone}_min` as keyof typeof zonesMin] ?? 0) * p.weight * p.hrr_pct,
                0,
            )
            .toFixed(1),
    );

    return { ...base, zones, zones_pct, trimp, zones_min: zonesMin };
}

// ── rhr_daily ─────────────────────────────────────────────────────────────────
// One document per calendar day. Immutable for past days; updatable for today.
export interface RhrDailyDoc {
    _id: string;              // "YYYY-MM-DD"
    date: string;             // "YYYY-MM-DD"
    rhr_bpm: number;
    samples_count: number;
    deep_sleep_minutes: number;
    method: string;           // "deep_sleep_p5" | "all_sleep_p5"
    computed_at: Date;
}

// ── max_hr_snapshots ──────────────────────────────────────────────────────────
// One document per date the estimate was computed (= end of the lookback window).
// Immutable for past dates; updatable for today.
export interface MaxHrSnapshotDoc {
    _id: string;              // "YYYY-MM-DD" (= end_date)
    end_date: string;         // "YYYY-MM-DD"
    lookback_days: number;
    age: number;
    recommended_max_hr_bpm: number;
    recommended_source: string;
    measured: {
        peak_hr_observed_bpm: number;
        peak_hr_p95_bpm: number;
        workouts_analyzed: number;
        top_5_workouts: Array<{
            date: string;
            name: string;
            id: string;
            peak_bpm: number;
            duration_min: number;
        }>;
    } | null;
    formulas: {
        tanaka_2001: number;
        fox_1971: number;
    };
    computed_at: Date;
}

// ── workout_processed ─────────────────────────────────────────────────────────
// One document per workout UUID. Contains both HR zone and TRIMP results so
// both tools can serve from the same cache. Immutable for past workout dates.
export interface ZonesData {
    z1_min: number;
    z2_min: number;
    z3_min: number;
    z4_min: number;
    z5_min: number;
    below_rhr_min: number;
}

export interface ZonesPctData {
    z1_pct: number;
    z2_pct: number;
    z3_pct: number;
    z4_pct: number;
    z5_pct: number;
    below_rhr_pct: number;
}

export interface WorkoutProcessedDoc {
    _id: string;              // workout UUID
    workout_date: string;     // "YYYY-MM-DD"
    name: string;
    start: string;
    duration_min: number;
    avg_hr: number | null;
    max_hr_recorded: number | null;
    // HR parameters used for computation — stored for auditability
    rhr_used: number;
    max_hr_used: number;
    hr_reserve_used: number;
    rhr_source: string;       // e.g. "db:2026-05-10" or "provided"
    max_hr_source: string;    // e.g. "db:2026-05-19" or "provided"
    // Zone data (null = no heartRateData in the workout)
    zones: ZonesData | null;
    zones_pct: ZonesPctData | null;
    // TRIMP data
    trimp: number | null;
    zones_min: Omit<ZonesData, 'below_rhr_min'> | null;
    computed_at: Date;
}

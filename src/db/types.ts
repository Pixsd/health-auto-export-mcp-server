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

// ── sleep_nights ──────────────────────────────────────────────────────────────
// One document per night. _id = "YYYY-MM-DD" of the evening the night started
// (e.g. "2026-05-20" covers the night 20→21 May). Immutable for past nights.
export interface SleepStageEntry {
    start: string;        // "HH:MM" local time
    end: string;          // "HH:MM" local time
    stage: string;        // canonical: Core | Deep | REM | Awake | InBed
    duration_min: number;
}

export interface SleepHrStats {
    // Heart rate
    avg_bpm: number;
    min_bpm: number;
    max_bpm: number;
    per_stage: {
        deep_avg_bpm: number | null;
        rem_avg_bpm: number | null;
        core_avg_bpm: number | null;
        awake_avg_bpm: number | null;
    };
    // Respiratory rate (breaths/min)
    respiratory_rate_avg_rpm: number | null;
    respiratory_rate_min_rpm: number | null;
    respiratory_rate_max_rpm: number | null;
    // Blood oxygen
    spo2_avg_pct: number | null;
    spo2_min_pct: number | null;
    // HRV RMSSD for this specific night (ms)
    hrv_rmssd_ms: number | null;
}

export interface SleepNightDoc {
    _id: string;               // "YYYY-MM-DD" = evening date
    date: string;              // "YYYY-MM-DD"
    sleep_start: string;       // "HH:MM" local time of first non-awake interval
    sleep_end: string;         // "HH:MM" local time of last interval
    time_in_bed_min: number;   // from first to last interval
    total_sleep_min: number;   // Core + Deep + REM
    deep_min: number;
    rem_min: number;
    core_min: number;
    awake_min: number;
    efficiency_pct: number;    // total_sleep / time_in_bed * 100
    timeline: SleepStageEntry[];
    hr: SleepHrStats | null;
    fetched_at: Date;
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

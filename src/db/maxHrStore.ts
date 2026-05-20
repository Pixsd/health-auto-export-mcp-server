import { getDb } from './client.js';
import type { MaxHrSnapshotDoc } from './types.js';

const COL = 'max_hr_snapshots';

/**
 * Saves a max-HR snapshot computed for a given end_date.
 * - Past end dates (isToday = false): insert-only (immutable once written).
 * - Today: always overwrite (new workouts may have been added).
 */
export async function upsertMaxHrSnapshot(
    doc: MaxHrSnapshotDoc,
    isToday: boolean,
): Promise<void> {
    const col = (await getDb()).collection<MaxHrSnapshotDoc>(COL);
    if (isToday) {
        await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    } else {
        await col.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
    }
}

/**
 * Finds the most recent max-HR snapshot with end_date ≤ `date`, looking back
 * up to 365 days. If none found (bootstrap scenario: first snapshot was computed
 * today but workouts predate it), falls back to the closest available snapshot
 * overall — max HR changes ~1 bpm/year so a recent-future snapshot is valid.
 */
export async function getMaxHrForDate(date: string): Promise<MaxHrSnapshotDoc | null> {
    const col = (await getDb()).collection<MaxHrSnapshotDoc>(COL);
    const cutoff = new Date(date);
    cutoff.setDate(cutoff.getDate() - 365);

    // Primary: snapshot that existed on or before the workout date.
    const prior = await col.findOne(
        { end_date: { $gte: cutoff.toISOString().slice(0, 10), $lte: date } },
        { sort: { end_date: -1 } },
    );
    if (prior) return prior;

    // Fallback: most recent snapshot overall (handles bootstrap / first-run).
    return col.findOne({}, { sort: { end_date: -1 } });
}

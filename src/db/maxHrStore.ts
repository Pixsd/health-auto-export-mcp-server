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
 * up to 365 days. Returns null if none found.
 *
 * Max HR changes slowly, so a snapshot from up to a year ago is still useful.
 */
export async function getMaxHrForDate(date: string): Promise<MaxHrSnapshotDoc | null> {
    const col = (await getDb()).collection<MaxHrSnapshotDoc>(COL);
    const cutoff = new Date(date);
    cutoff.setDate(cutoff.getDate() - 365);
    return col.findOne(
        { end_date: { $gte: cutoff.toISOString().slice(0, 10), $lte: date } },
        { sort: { end_date: -1 } },
    );
}

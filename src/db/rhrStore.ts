import { getDb } from './client.js';
import type { RhrDailyDoc } from './types.js';

const COL = 'rhr_daily';

/**
 * Saves a daily RHR value.
 * - Past days (isToday = false): insert-only (immutable once written).
 * - Today: always overwrite (data may still be accumulating).
 */
export async function upsertRhrDay(doc: RhrDailyDoc, isToday: boolean): Promise<void> {
    const col = (await getDb()).collection<RhrDailyDoc>(COL);
    if (isToday) {
        await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    } else {
        await col.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
    }
}

/**
 * Finds the most recent RHR reading on or before `date`, looking back up to 30 days.
 * Returns null if none found.
 */
export async function getRhrForDate(date: string): Promise<RhrDailyDoc | null> {
    const col = (await getDb()).collection<RhrDailyDoc>(COL);
    const cutoff = new Date(date);
    cutoff.setDate(cutoff.getDate() - 30);
    return col.findOne(
        { date: { $gte: cutoff.toISOString().slice(0, 10), $lte: date } },
        { sort: { date: -1 } },
    );
}

/**
 * Returns all RHR entries in [startDate, endDate] sorted ascending.
 */
export async function getRhrRange(startDate: string, endDate: string): Promise<RhrDailyDoc[]> {
    const col = (await getDb()).collection<RhrDailyDoc>(COL);
    return col.find({ date: { $gte: startDate, $lte: endDate } }).sort({ date: 1 }).toArray();
}

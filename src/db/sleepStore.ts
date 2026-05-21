import { getDb } from './client.js';
import type { SleepNightDoc } from './types.js';

const COLLECTION = 'sleep_nights';

export async function getSleepNight(date: string): Promise<SleepNightDoc | null> {
    const db = await getDb();
    return db.collection<SleepNightDoc>(COLLECTION).findOne({ _id: date }) ?? null;
}

export async function saveSleepNight(doc: SleepNightDoc): Promise<void> {
    const db = await getDb();
    await db.collection<SleepNightDoc>(COLLECTION).replaceOne(
        { _id: doc._id },
        doc,
        { upsert: true },
    );
}

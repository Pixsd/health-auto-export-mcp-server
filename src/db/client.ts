import { MongoClient, type Db } from 'mongodb';
import { MONGODB_URI } from '../config.js';

let _client: MongoClient | null = null;
let _db: Db | null = null;
let _connecting: Promise<Db> | null = null;

export async function getDb(): Promise<Db> {
    if (_db) return _db;
    if (_connecting) return _connecting;
    _connecting = (async () => {
        _client = new MongoClient(MONGODB_URI);
        await _client.connect();
        _db = _client.db();
        return _db;
    })();
    return _connecting;
}

export async function closeDb(): Promise<void> {
    if (_client) {
        await _client.close();
        _client = null;
        _db = null;
        _connecting = null;
    }
}

/** Creates all necessary indexes. Call once at server startup. */
export async function initDb(): Promise<void> {
    const db = await getDb();
    await Promise.all([
        db.collection('rhr_daily').createIndex({ date: 1 }),
        db.collection('max_hr_snapshots').createIndex({ end_date: -1 }),
        db.collection('workout_processed').createIndex({ workout_date: 1 }),
    ]);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const MAX_LOGS = 100;

/**
 * Dual-mode store:
 * - Uses local JSON files by default (zero setup for local / VPS hosting).
 * - Automatically switches to MongoDB if MONGO_URI is configured (ideal for free Render/HF hosting).
 */
export class ReminderStore {
  constructor() {
    this.mongoClient = null;
    this.db = null;
    this.useMongo = false;
  }

  async init(mongoUri) {
    if (mongoUri && mongoUri.trim().length > 0) {
      try {
        const { MongoClient } = await import('mongodb');
        this.mongoClient = new MongoClient(mongoUri.trim());
        await this.mongoClient.connect();
        this.db = this.mongoClient.db();
        this.useMongo = true;
        console.log('[Store] Connected to MongoDB for persistent schedules & logs.');
        return;
      } catch (err) {
        console.warn('[Store] MongoDB connection failed, falling back to local JSON storage:', err.message);
      }
    }

    await fs.mkdir(DATA_DIR, { recursive: true });
    await this._ensureJsonFile(SCHEDULES_FILE, []);
    await this._ensureJsonFile(LOGS_FILE, []);
    console.log(`[Store] Using local JSON storage in ${DATA_DIR}`);
  }

  getMongoDb() {
    return this.useMongo ? this.db : null;
  }

  async close() {
    if (this.mongoClient) {
      await this.mongoClient.close();
    }
  }

  async _ensureJsonFile(filePath, defaultValue) {
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
    }
  }

  async _readJson(filePath, fallback = []) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async _writeJson(filePath, data) {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
  }

  async getAllSchedules() {
    if (this.useMongo) {
      const docs = await this.db.collection('schedules').find({}).toArray();
      return docs.map(({ _id, ...rest }) => rest);
    }
    return this._readJson(SCHEDULES_FILE, []);
  }

  async upsertSchedule(schedule) {
    const now = new Date().toISOString();
    const record = {
      ...schedule,
      updatedAt: now,
      createdAt: schedule.createdAt || now,
    };

    if (this.useMongo) {
      await this.db.collection('schedules').updateOne(
        { id: record.id },
        { $set: record },
        { upsert: true }
      );
      return record;
    }

    const schedules = await this._readJson(SCHEDULES_FILE, []);
    const idx = schedules.findIndex((item) => item.id === record.id);
    if (idx >= 0) {
      schedules[idx] = { ...schedules[idx], ...record };
    } else {
      schedules.push(record);
    }
    await this._writeJson(SCHEDULES_FILE, schedules);
    return record;
  }

  async deleteSchedule(id) {
    if (this.useMongo) {
      const result = await this.db.collection('schedules').deleteOne({ id });
      return result.deletedCount > 0;
    }

    const schedules = await this._readJson(SCHEDULES_FILE, []);
    const filtered = schedules.filter((item) => item.id !== id);
    if (filtered.length === schedules.length) return false;
    await this._writeJson(SCHEDULES_FILE, filtered);
    return true;
  }

  async addLog(entry) {
    const log = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    if (this.useMongo) {
      await this.db.collection('delivery_logs').insertOne(log);
      return log;
    }

    const logs = await this._readJson(LOGS_FILE, []);
    logs.unshift(log);
    if (logs.length > MAX_LOGS) {
      logs.length = MAX_LOGS;
    }
    await this._writeJson(LOGS_FILE, logs);
    return log;
  }

  async getLogs(limit = 30) {
    if (this.useMongo) {
      const docs = await this.db
        .collection('delivery_logs')
        .find({})
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
      return docs.map(({ _id, ...rest }) => rest);
    }

    const logs = await this._readJson(LOGS_FILE, []);
    return logs.slice(0, limit);
  }
}


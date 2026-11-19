import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { ReminderStore } from './store.js';
import { WhatsAppService } from './whatsapp.js';
import { ReminderScheduler } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_SECRET = (process.env.API_SECRET || '').trim();
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'UTC';
const MONGO_URI = process.env.MONGO_URI || '';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Optional API key middleware (only enforced if API_SECRET is set in .env)
function requireAuth(req, res, next) {
  if (!API_SECRET) return next();
  const provided = req.headers['x-api-key'] || req.query.apiKey;
  if (provided !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: invalid x-api-key' });
  }
  return next();
}

const store = new ReminderStore();
const whatsapp = new WhatsAppService(store);
const scheduler = new ReminderScheduler(store, whatsapp, {
  defaultTimezone: DEFAULT_TIMEZONE,
});

// Built-in pairing & monitoring dashboard
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Health endpoint for Render / Hugging Face / cron-job.org keep-alive pings
app.get('/health', (_req, res) => {
  const wa = whatsapp.getStatus();
  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    whatsappStatus: wa.status,
    whatsappConnected: wa.connected,
  });
});

// WhatsApp connection status & QR data URL
app.get('/api/whatsapp/status', requireAuth, (_req, res) => {
  res.json(whatsapp.getStatus());
});

// Disconnect current WhatsApp session and regenerate QR
app.post('/api/whatsapp/logout', requireAuth, async (_req, res) => {
  await whatsapp.logout();
  res.json({ ok: true, message: 'Logged out; new QR code will be generated shortly.' });
});

// Request an 8-digit pairing code so mobile users can link WhatsApp from one phone
app.post('/api/whatsapp/pair-code', requireAuth, async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) {
    return res.status(400).json({ error: 'phoneNumber is required.' });
  }
  try {
    const result = await whatsapp.requestPairingCode(phoneNumber);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Immediate one-off WhatsApp send (used for testing & instant triggers)
app.post('/api/whatsapp/send-now', requireAuth, async (req, res) => {
  const { phoneNumber, message, title } = req.body || {};
  if (!phoneNumber || !message) {
    return res.status(400).json({ error: 'phoneNumber and message are required.' });
  }

  try {
    const result = await whatsapp.sendMessage(phoneNumber, message);
    await store.addLog({
      title: title || 'Manual / Instant Send',
      phoneNumber,
      status: 'sent',
      messageId: result.messageId,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    await store.addLog({
      title: title || 'Manual / Instant Send',
      phoneNumber,
      status: 'failed',
      error: err.message,
    });
    return res.status(400).json({ error: err.message });
  }
});

// List all synced WhatsApp schedules
app.get('/api/schedules', requireAuth, async (_req, res) => {
  const schedules = await store.getAllSchedules();
  res.json({ schedules });
});

// Create or update a schedule from the Flutter app
app.post('/api/schedules', requireAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.id || !body.title || !body.time) {
    return res.status(400).json({ error: 'id, title, and time (HH:mm) are required.' });
  }

  const normalized = {
    id: String(body.id),
    title: String(body.title).trim(),
    note: String(body.note || '').trim(),
    category: String(body.category || 'General').trim(),
    time: String(body.time).trim(), // "HH:mm"
    date: body.date ? String(body.date).trim() : null, // "YYYY-MM-DD" for one-time
    daysOfWeek: Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number) : [],
    timezone: String(body.timezone || DEFAULT_TIMEZONE),
    phoneNumber: String(body.phoneNumber || '').trim(),
    customMessage: String(body.customMessage || '').trim(),
    whatsappEnabled: Boolean(body.whatsappEnabled),
    enabled: body.enabled !== false,
  };

  const saved = await store.upsertSchedule(normalized);
  res.status(201).json({ ok: true, schedule: saved });
});

// Delete a schedule when removed or WhatsApp option disabled
app.delete('/api/schedules/:id', requireAuth, async (req, res) => {
  const removed = await store.deleteSchedule(req.params.id);
  res.json({ ok: true, removed });
});

// Delivery logs
app.get('/api/logs', requireAuth, async (_req, res) => {
  const logs = await store.getLogs(30);
  res.json({ logs });
});

async function bootstrap() {
  await store.init(MONGO_URI);
  scheduler.start();

  whatsapp.start().catch((err) => {
    console.error('[WhatsApp] Initial startup error:', err.message);
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 WhatsApp Reminder Backend running on http://localhost:${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser to scan the WhatsApp QR code.\n`);
  });

  const shutdown = async () => {
    console.log('\nShutting down gracefully...');
    scheduler.stop();
    await store.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});


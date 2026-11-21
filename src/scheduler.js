const WEEKDAY_MAP = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Extracts local calendar date, HH:mm time, and ISO weekday (1=Mon .. 7=Sun)
 * for any IANA timezone using Node's built-in Intl API.
 */
export function getLocalTimeParts(date = new Date(), timeZone = 'UTC') {
  let validTimeZone = timeZone || 'UTC';
  try {
    Intl.DateTimeFormat('en-US', { timeZone: validTimeZone }).format(date);
  } catch {
    validTimeZone = 'UTC';
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const timeStr = `${hour}:${parts.minute}`;
  const weekday = WEEKDAY_MAP[parts.weekday] || 1;

  return {
    timeZone: validTimeZone,
    dateStr,
    timeStr,
    weekday,
    triggerKey: `${dateStr}T${timeStr}`,
  };
}

/**
 * Determines whether a schedule should dispatch a WhatsApp message at `now`.
 */
export function shouldTriggerSchedule(schedule, now = new Date(), fallbackTimeZone = 'Asia/Karachi') {
  if (!schedule || !schedule.enabled || !schedule.whatsappEnabled) {
    return { due: false };
  }
  if (!schedule.phoneNumber || !schedule.time) {
    return { due: false };
  }

  // Force local Pakistan timezone if user timezone is missing or invalid UTC
  const effectiveTz = (schedule.timezone && schedule.timezone !== 'UTC')
    ? schedule.timezone
    : (fallbackTimeZone || 'Asia/Karachi');

  const local = getLocalTimeParts(now, effectiveTz);

  // Prevent duplicate delivery within the exact same minute key
  if (schedule.lastTriggeredKey === local.triggerKey) {
    return { due: false };
  }

  // Check minute difference between current clock and scheduled time
  const [curH, curM] = local.timeStr.split(':').map(Number);
  const [schH, schM] = schedule.time.split(':').map(Number);
  const diffMinutes = (curH * 60 + curM) - (schH * 60 + schM);

  // Allow trigger if it is the exact minute or within 3 minutes of wake
  if (diffMinutes < 0 || diffMinutes > 3) {
    return { due: false };
  }

  // Prevent sending multiple times for the same routine on the same date
  if (schedule.lastTriggeredDate === local.dateStr && schedule.lastTriggeredTime === schedule.time) {
    return { due: false };
  }

  const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
  if (days.length > 0) {
    // Recurring weekly timetable item (1=Mon ... 7=Sun)
    if (!days.includes(local.weekday)) {
      return { due: false };
    }
    return { due: true, triggerKey: local.triggerKey, dateStr: local.dateStr, isOneTime: false };
  }

  // One-time scheduled activity
  if (schedule.date && schedule.date === local.dateStr) {
    return { due: true, triggerKey: local.triggerKey, dateStr: local.dateStr, isOneTime: true };
  }

  return { due: false };
}

export function buildReminderMessage(schedule) {
  if (schedule.customMessage && schedule.customMessage.trim().length > 0) {
    return schedule.customMessage.trim();
  }

  const lines = [`⏰ *Reminder: ${schedule.title || 'Scheduled Activity'}*`];
  if (schedule.note && schedule.note.trim().length > 0) {
    lines.push(`📝 ${schedule.note.trim()}`);
  }
  lines.push(`🕒 Scheduled Time: ${schedule.time}`);
  if (schedule.category && schedule.category.trim().length > 0) {
    lines.push(`📂 Category: ${schedule.category.trim()}`);
  }
  return lines.join('\n');
}

export class ReminderScheduler {
  constructor(store, whatsappService, options = {}) {
    this.store = store;
    this.whatsapp = whatsappService;
    this.defaultTimezone = options.defaultTimezone || 'UTC';
    this.intervalMs = options.intervalMs || 15000; // Check every 15 seconds for exact-minute precision
    this.timer = null;
    this.isChecking = false;
  }

  start() {
    if (this.timer) return;
    console.log(`[Scheduler] Started (polling every ${this.intervalMs / 1000}s, default TZ: ${this.defaultTimezone})`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[Scheduler] Tick error:', err.message);
      });
    }, this.intervalMs);

    // Run an immediate check shortly after boot
    setTimeout(() => {
      this.tick().catch((err) => console.error('[Scheduler] Initial tick error:', err.message));
    }, 3000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(now = new Date()) {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const schedules = await this.store.getAllSchedules();

      for (const schedule of schedules) {
        const decision = shouldTriggerSchedule(schedule, now, this.defaultTimezone);
        if (!decision.due) continue;

        const messageText = buildReminderMessage(schedule);
        try {
          const result = await this.whatsapp.sendMessage(schedule.phoneNumber, messageText);
          console.log(`[Scheduler] Sent WhatsApp reminder "${schedule.title}" to ${schedule.phoneNumber}`);

          await this.store.upsertSchedule({
            ...schedule,
            lastTriggeredKey: decision.triggerKey,
            lastTriggeredDate: decision.dateStr,
            lastTriggeredTime: schedule.time,
            lastSentAt: result.sentAt,
            lastStatus: 'sent',
            enabled: decision.isOneTime ? false : schedule.enabled,
          });

          await this.store.addLog({
            scheduleId: schedule.id,
            title: schedule.title,
            phoneNumber: schedule.phoneNumber,
            status: 'sent',
            messageId: result.messageId,
          });
        } catch (err) {
          console.error(`[Scheduler] Failed to send "${schedule.title}":`, err.message);
          await this.store.upsertSchedule({
            ...schedule,
            lastTriggeredKey: decision.triggerKey,
            lastStatus: `failed: ${err.message}`,
          });
          await this.store.addLog({
            scheduleId: schedule.id,
            title: schedule.title,
            phoneNumber: schedule.phoneNumber,
            status: 'failed',
            error: err.message,
          });
        }
      }
    } finally {
      this.isChecking = false;
    }
  }
}


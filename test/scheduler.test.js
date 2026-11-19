import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReminderMessage,
  getLocalTimeParts,
  shouldTriggerSchedule,
} from '../src/scheduler.js';
import { formatPhoneToJid } from '../src/whatsapp.js';

test('formatPhoneToJid cleans symbols and formats JID', () => {
  assert.equal(formatPhoneToJid('+92 300-1234567'), '923001234567@s.whatsapp.net');
  assert.throws(() => formatPhoneToJid('123'));
});

test('getLocalTimeParts resolves timezone accurately', () => {
  // 2026-11-18T03:00:00Z is 08:00 AM in Asia/Karachi (UTC+5), Wednesday (weekday 3)
  const sample = new Date('2026-11-18T03:00:00Z');
  const parts = getLocalTimeParts(sample, 'Asia/Karachi');
  assert.equal(parts.dateStr, '2026-11-18');
  assert.equal(parts.timeStr, '08:00');
  assert.equal(parts.weekday, 3);
  assert.equal(parts.triggerKey, '2026-11-18T08:00');
});

test('shouldTriggerSchedule fires for matching weekly timetable day and prevents duplicates', () => {
  const now = new Date('2026-11-18T03:00:10Z'); // Wed 08:00 in Asia/Karachi
  const schedule = {
    id: 'gym-1',
    title: 'Morning Gym',
    time: '08:00',
    daysOfWeek: [1, 3, 5], // Mon, Wed, Fri
    timezone: 'Asia/Karachi',
    phoneNumber: '923001234567',
    whatsappEnabled: true,
    enabled: true,
  };

  const first = shouldTriggerSchedule(schedule, now);
  assert.equal(first.due, true);
  assert.equal(first.isOneTime, false);
  assert.equal(first.triggerKey, '2026-11-18T08:00');

  // Same minute after marking lastTriggeredKey should not fire again
  const duplicate = shouldTriggerSchedule(
    { ...schedule, lastTriggeredKey: first.triggerKey },
    new Date('2026-11-18T03:00:45Z')
  );
  assert.equal(duplicate.due, false);
});

test('shouldTriggerSchedule fires for one-time schedule on exact date and time', () => {
  const now = new Date('2026-11-20T09:30:00Z'); // UTC 09:30
  const schedule = {
    id: 'dentist-1',
    title: 'Dentist Appointment',
    date: '2026-11-20',
    time: '09:30',
    daysOfWeek: [],
    timezone: 'UTC',
    phoneNumber: '15551234567',
    whatsappEnabled: true,
    enabled: true,
  };

  const result = shouldTriggerSchedule(schedule, now);
  assert.equal(result.due, true);
  assert.equal(result.isOneTime, true);
});

test('buildReminderMessage uses customMessage if set, else builds structured reminder', () => {
  const custom = buildReminderMessage({ title: 'Study', time: '18:00', customMessage: 'Time to code!' });
  assert.equal(custom, 'Time to code!');

  const generated = buildReminderMessage({
    title: 'Math Class',
    note: 'Room 204',
    time: '10:00',
    category: 'Study',
  });
  assert.match(generated, /Math Class/);
  assert.match(generated, /Room 204/);
  assert.match(generated, /10:00/);
});


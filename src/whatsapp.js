import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { useMongoAuthState } from './mongoAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, '../auth_info_baileys');

/**
 * Strips formatting from a phone number and converts it to a WhatsApp JID.
 * Example: "+92 300-1234567" -> "923001234567@s.whatsapp.net"
 */
export function formatPhoneToJid(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Invalid phone number. Include country code without leading 0 (e.g., 923001234567).');
  }
  return `${digits}@s.whatsapp.net`;
}

export class WhatsAppService {
  constructor(store) {
    this.store = store;
    this.sock = null;
    this.status = 'initializing'; // initializing | waiting_qr | connected | reconnecting | disconnected
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.connectedUser = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.clearAuthFn = null;
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'connected',
      user: this.connectedUser,
      hasQr: Boolean(this.qrDataUrl),
      qrDataUrl: this.qrDataUrl,
      lastError: this.lastError,
    };
  }

  async start() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.status = 'initializing';
    this.lastError = null;

    let state;
    let saveCreds;

    const mongoDb = this.store?.getMongoDb?.();
    if (mongoDb) {
      const mongoAuth = await useMongoAuthState(mongoDb);
      state = mongoAuth.state;
      saveCreds = mongoAuth.saveCreds;
      this.clearAuthFn = mongoAuth.clearAll;
    } else {
      await fs.mkdir(AUTH_DIR, { recursive: true });
      const fileAuth = await useMultiFileAuthState(AUTH_DIR);
      state = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
      this.clearAuthFn = async () => {
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
      };
    }

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    const logger = pino({ level: 'silent' });

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.status = 'waiting_qr';
        this.qrRaw = qr;
        this.connectedUser = null;
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        } catch (err) {
          console.error('[WhatsApp] Failed to encode QR image:', err.message);
        }

        console.log('\n[WhatsApp] Scan this QR code in WhatsApp -> Linked Devices -> Link a Device:');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('[WhatsApp] Or open the web dashboard in your browser to scan the QR image.\n');
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.qrRaw = null;
        this.qrDataUrl = null;
        this.lastError = null;
        this.connectedUser = {
          id: this.sock.user?.id || null,
          name: this.sock.user?.name || 'Linked WhatsApp Account',
        };
        console.log(`[WhatsApp] Connected successfully as ${this.connectedUser.id}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        this.connectedUser = null;
        this.lastError = lastDisconnect?.error?.message || `Disconnected (code ${statusCode ?? 'unknown'})`;

        if (isLoggedOut) {
          console.log('[WhatsApp] Session logged out. Clearing saved credentials and generating a fresh QR...');
          this.status = 'disconnected';
          if (this.clearAuthFn) {
            await this.clearAuthFn();
          }
          this.scheduleReconnect(2000);
        } else {
          console.log(`[WhatsApp] Connection closed (${this.lastError}). Reconnecting in 5s...`);
          this.status = 'reconnecting';
          this.scheduleReconnect(5000);
        }
      }
    });
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.start().catch((err) => {
        console.error('[WhatsApp] Reconnect failed:', err.message);
        this.lastError = err.message;
        this.scheduleReconnect(10000);
      });
    }, delayMs);
  }

  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch {
      // Ignore logout errors if already closed
    }
    if (this.clearAuthFn) {
      await this.clearAuthFn();
    }
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.connectedUser = null;
    this.status = 'disconnected';
    this.scheduleReconnect(1500);
  }

  async requestPairingCode(phoneNumber) {
    if (this.status === 'connected') {
      throw new Error('WhatsApp is already connected.');
    }

    const digits = String(phoneNumber || '').replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      throw new Error(
        'Enter a valid WhatsApp number with country code (e.g. 923001234567).'
      );
    }

    if (!this.sock) {
      await this.start();
      // Give the socket a brief moment to initialize before requesting code
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    if (!this.sock) {
      throw new Error('WhatsApp service is still starting. Try again in a moment.');
    }

    const rawCode = await this.sock.requestPairingCode(digits);
    const formatted =
      rawCode && rawCode.length === 8
        ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
        : rawCode;

    return {
      code: formatted,
      rawCode,
      phoneNumber: digits,
    };
  }

  async sendMessage(phoneNumber, message) {
    if (this.status !== 'connected' || !this.sock) {
      throw new Error('WhatsApp is not connected yet. Scan the QR code on the server dashboard first.');
    }

    const jid = formatPhoneToJid(phoneNumber);
    const trimmedMessage = String(message || '').trim();
    if (!trimmedMessage) {
      throw new Error('Message text cannot be empty.');
    }

    const result = await this.sock.sendMessage(jid, { text: trimmedMessage });
    return {
      jid,
      messageId: result?.key?.id || null,
      sentAt: new Date().toISOString(),
    };
  }
}


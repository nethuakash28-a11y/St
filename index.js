const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const baileys = require('chama-bailez-pro');
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} = baileys;

process.env.FFMPEG_PATH = ffmpegPath;

const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const COLLECTION_DIR = process.env.COLLECTION_DIR || './collection';
fs.mkdirSync(COLLECTION_DIR, { recursive: true });

let sock = null;
let connected = false;
const sessions = new Map(); // user jid -> { name, stickers }

// ---------------- BOT ----------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (_) {}

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true;
      console.log('✅ WhatsApp connected');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed, code:', code);
      if (code === DisconnectReason.loggedOut) {
        // session eka delete karala aluth ekak pair karanna denna
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      setTimeout(startBot, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const t = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).trim();

    // 1) Channel link
    const m = t.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/);
    if (m) {
      await sock.sendMessage(from, { text: '🔍 Scanning channel...' });
      try {
        const meta = await sock.newsletterMetadata('invite', m[1]);
        const msgs = await sock.newsletterFetchMessages(meta.id, 100);
        const stickers = (msgs || []).filter((x) => x.message?.stickerMessage);

        if (!stickers.length) {
          return sock.sendMessage(from, { text: '❌ Stickers hambune naha.' });
        }

        sessions.set(from, { name: meta.name, stickers });
        return sock.sendMessage(from, {
          text: `✅ *${meta.name}* channel eke stickers ${stickers.length} k hambuna.\n\nReply karanna:\n1. Start\n2. Exit`,
        });
      } catch (e) {
        console.error(e);
        return sock.sendMessage(from, {
          text: '❌ Channel eka scan karanna bari una.',
        });
      }
    }

    // 2) Menu reply
    const session = sessions.get(from);
    if (session && (t === '1' || t === '2')) {
      if (t === '2') {
        sessions.delete(from);
        return sock.sendMessage(from, { text: '👋 Exit.' });
      }

      await sock.sendMessage(from, { text: '⏳ Collection ekata add wenawa...' });
      const dir = path.join(
        COLLECTION_DIR,
        session.name.replace(/[^\w]/g, '_')
      );
      fs.mkdirSync(dir, { recursive: true });

      let ok = 0;
      for (const [i, s] of session.stickers.entries()) {
        try {
          const buf = await downloadMediaMessage(s, 'buffer', {});
          fs.writeFileSync(path.join(dir, `${i + 1}.webp`), buf);
          ok++;
          await new Promise((r) => setTimeout(r, 500));
        } catch (e) {
          console.error('skip', i, e.message);
        }
      }

      sessions.delete(from);
      return sock.sendMessage(from, {
        text: `🎉 Stickers ${ok}/${session.stickers.length} collection ekata add una.`,
      });
    }
  });
}

// ---------------- WEB ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => res.json({ connected }));

app.post('/api/pair', async (req, res) => {
  try {
    if (connected) return res.json({ error: 'Already connected' });
    if (!sock) return res.json({ error: 'Bot not ready, try again' });

    const number = String(req.body.number || '').replace(/\D/g, '');
    if (number.length < 8) {
      return res.json({ error: 'Invalid number (country code ekath ekka denna, e.g. 94771234567)' });
    }

    await new Promise((r) => setTimeout(r, 1500));
    const code = await sock.requestPairingCode(number);
    const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
    res.json({ code: pretty });
  } catch (e) {
    console.error(e);
    res.json({ error: 'Pairing code eka hadanna bari una: ' + e.message });
  }
});

app.listen(PORT, () => console.log('Web running on port', PORT));
startBot();

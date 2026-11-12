 import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import cron from 'node-cron';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import vm from 'vm';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import 'dotenv/config';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://synvora-whatsapp-bot.onrender.com';

// ADMIN & FAMPAY SETTINGS (ONLY 9674814370 IS ADMIN)
const ADMIN_NUMBERS = ['9674814370', '919674814370'];
const ADMIN_JID = '919674814370@s.whatsapp.net';
const BOT_PUBLIC_NUMBER = '919674814370';
const FREE_MESSAGE_LIMIT = 20;
const MACRODROID_TRIGGER_URL = process.env.MACRODROID_TRIGGER_URL || '';
const USAGE_FILE = './usage_store.json';
const TXN_FILE = './fampay_txns.json';
const ANALYTICS_FILE = './analytics_store.json';

let sock;
let latestQr = null;
let isConnected = false;
let isConnecting = false;

const userChatHistory = new Map();
const userSelectedMode = new Map();
const userUsageCache = new Map();
const dynamicAdmins = new Set(ADMIN_NUMBERS);
const activeCheckoutSessions = new Map();

let fampayTxns = {};

// Persistent Analytics, Referrals & Streaks Store
let analyticsStore = {
  totalMessages: 0,
  totalReferrals: 0,
  users: {}
  // userPhone -> { firstSeen, lastSeen, totalMsgs, streak, lastStreakDate, referredBy, referrals: [] }
};

try {
  if (fs.existsSync(USAGE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) userUsageCache.set(k, v);
  }
  if (fs.existsSync(TXN_FILE)) {
    fampayTxns = JSON.parse(fs.readFileSync(TXN_FILE, 'utf8'));
  }
  if (fs.existsSync(ANALYTICS_FILE)) {
    analyticsStore = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
  }
} catch (e) {}

function saveLocalUsageBackup() {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(Object.fromEntries(userUsageCache.entries()), null, 2));
  } catch (e) {}
}

function saveTxnStore() {
  try {
    fs.writeFileSync(TXN_FILE, JSON.stringify(fampayTxns, null, 2));
  } catch (e) {}
}

function saveAnalyticsStore() {
  try {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsStore, null, 2));
  } catch (e) {}
}

function getTodayISTDateString() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// Track every user interaction & update daily streak
function recordUserActivity(userPhone) {
  const today = getTodayISTDateString();
  analyticsStore.totalMessages = (analyticsStore.totalMessages || 0) + 1;

  if (!analyticsStore.users[userPhone]) {
    analyticsStore.users[userPhone] = {
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      totalMsgs: 1,
      streak: 1,
      lastStreakDate: today,
      referredBy: null,
      referrals: []
    };
    saveAnalyticsStore();
    return { isNewUser: true, streakIncreased: false, streak: 1 };
  }

  const u = analyticsStore.users[userPhone];
  u.lastSeen = Date.now();
  u.totalMsgs = (u.totalMsgs || 0) + 1;

  let streakIncreased = false;
  if (u.lastStreakDate !== today) {
    const yesterday = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    if (u.lastStreakDate === yesterday) {
      u.streak = (u.streak || 1) + 1;
      streakIncreased = true;
    } else {
      u.streak = 1;
    }
    u.lastStreakDate = today;
  }

  saveAnalyticsStore();
  return { isNewUser: false, streakIncreased, streak: u.streak };
}

// Build Admin-Only Live User Tracker Report
function buildAdminTrackerReport() {
  const allUserPhones = new Set([
    ...Object.keys(analyticsStore.users || {}),
    ...Array.from(userUsageCache.keys())
  ]);

  const now = Date.now();
  let totalUsers = 0;
  let activeToday = 0;
  let activeWeek = 0;
  let vipUsers = 0;
  let paywallHitUsers = 0;
  let freeTrialUsers = 0;
  const recentList = [];

  for (const phone of allUserPhones) {
    if (!phone || phone === 'VIP_User') continue;
    totalUsers++;

    const aData = analyticsStore.users[phone] || {};
    const uData = userUsageCache.get(phone) || { count: 0, premiumUntil: 0 };

    const lastSeen = aData.lastSeen || 0;
    if (now - lastSeen < 24 * 60 * 60 * 1000) activeToday++;
    if (now - lastSeen < 7 * 24 * 60 * 60 * 1000) activeWeek++;

    const isVip = uData.premiumUntil && now < uData.premiumUntil;
    if (isVip) {
      vipUsers++;
    } else if ((uData.count || 0) >= FREE_MESSAGE_LIMIT) {
      paywallHitUsers++;
    } else {
      freeTrialUsers++;
    }

    recentList.push({
      phone,
      count: uData.count || aData.totalMsgs || 0,
      isVip,
      streak: aData.streak || 1,
      refs: (aData.referrals || []).length,
      lastSeen
    });
  }

  recentList.sort((a, b) => b.lastSeen - a.lastSeen);
  const top12 = recentList
    .slice(0, 12)
    .map(
      (u, idx) =>
        `${idx + 1}. *${u.phone}* — ${u.isVip ? '👑 VIP' : `💬 ${u.count}/${FREE_MESSAGE_LIMIT}`} | 🔥${u.streak}d | 👥${u.refs}`
    )
    .join('\n');

  return `📊 *SYNVORA AI — ADMIN LIVE USER TRACKER* 👑

👥 *Total Registered Users:* ${totalUsers}
🟢 *Active Today (Last 24h):* ${activeToday}
📅 *Active This Week (7d):* ${activeWeek}

💎 *Paid / VIP Pass Users:* ${vipUsers}
🔒 *Paywall Reached (20/20 Over):* ${paywallHitUsers}
🆓 *In Free Trial (<20 Msgs):* ${freeTrialUsers}

💬 *Total Messages Processed:* ${analyticsStore.totalMessages || 0}
🔗 *Total Viral Referrals:* ${analyticsStore.totalReferrals || 0}

📋 *Recent Users (Top 12):*
${top12 || 'Abhi koi user data nahi hai.'}

💡 _Admin Commands:_
• *#unlock [number] [days]* (VIP dene ke liye)
• *#stats* ya *"kitna user hya"* (Live report ke liye)`;
}

function planDaysFromAmount(amount) {
  const amt = Number(amount);
  if (amt >= 149) return 30;
  if (amt >= 49) return 7;
  return 1;
}

function isValidUtr(utr) {
  const clean = String(utr || '').trim();
  if (!/^\d{12}$/.test(clean)) return false;
  if (/^(\d)\1{11}$/.test(clean)) return false;
  if (clean === '123456789012' || clean === '987654321098') return false;
  return true;
}

async function triggerPhoneFamPayScan(userPhone, amount, utr = '') {
  if (!MACRODROID_TRIGGER_URL) return;
  try {
    await axios.get(
      `${MACRODROID_TRIGGER_URL}?user=${encodeURIComponent(userPhone)}&amount=${amount}&utr=${utr}`,
      { timeout: 4000 }
    );
  } catch (e) {}
}

function addToHistory(userPhone, role, content) {
  if (!content) return;
  if (!userChatHistory.has(userPhone)) userChatHistory.set(userPhone, []);
  const history = userChatHistory.get(userPhone);
  history.push({ role, content: String(content).slice(0, 500) });
  if (history.length > 10) history.shift();
}

function isAdminUser(userPhone, senderPn = '') {
  const cleanUser = String(userPhone).replace(/\D/g, '');
  const cleanSender = String(senderPn).replace(/\D/g, '');
  if (dynamicAdmins.has(userPhone) || dynamicAdmins.has(cleanUser)) return true;
  for (const adm of dynamicAdmins) {
    if (cleanUser === adm || cleanUser.endsWith('9674814370') || cleanSender.endsWith('9674814370')) return true;
  }
  return false;
}

const supabase = createClient(
  process.env.SUPABASE_URL?.trim(),
  process.env.SUPABASE_KEY?.trim()
);
const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();

const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const executablePath = chromePaths.find(p => fs.existsSync(p));

async function sendWA(phoneOrJid, text) {
  if (!sock || !isConnected) return;
  const jid = phoneOrJid.includes('@') ? phoneOrJid : `${phoneOrJid.replace(/\D/g, '')}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

// Web Dashboard
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#060913;color:#fff;min-height:100vh;">
        <h1 style="color:#10b981;">❤️ Synvora AI Super-Companion 24/7 LIVE Hai!</h1>
        <p style="color:#94a3b8;margin-top:10px;">Voice Notes + Vision + AI Image Gen + Referral + Admin Tracker Active.</p>
        <a href="/pay?u=VIP_User" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#10b981;color:#052e16;font-weight:bold;text-decoration:none;border-radius:10px;">Open Payment Page (/pay)</a>
      </div>
    `);
  }
  if (latestQr) {
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}`;
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>📲 Scan WhatsApp QR Code (Synvora AI)</h2>
        <img src="${qrImg}" style="border:8px solid #eee;border-radius:12px;margin-top:15px;" />
      </div>
    `);
  }
  res.send('<h2 style="font-family:sans-serif;text-align:center;padding:50px;">⏳ Bot start ho raha hai... 5 second baad refresh karein.</h2>');
});

// 1. START PAYMENT SESSION
app.post('/api/start-payment', async (req, res) => {
  const { userPhone, amount } = req.body;
  const cleanUser = String(userPhone || 'VIP_User').trim();
  const planAmt = Number(amount) || 49;

  activeCheckoutSessions.set(cleanUser, {
    userPhone: cleanUser,
    amount: planAmt,
    days: planDaysFromAmount(planAmt),
    expectedUtr: null,
    startedAt: Date.now(),
    unlocked: false
  });

  setTimeout(() => {
    const sess = activeCheckoutSessions.get(cleanUser);
    if (sess && !sess.unlocked) triggerPhoneFamPayScan(cleanUser, planAmt);
  }, 12000);

  return res.json({ ok: true });
});

// 2. CHECK PAYMENT STATUS
app.get('/api/check-payment-status', async (req, res) => {
  const cleanUser = String(req.query.u || '').trim();
  const planAmt = Number(req.query.amount) || 49;
  const submittedUtr = String(req.query.utr || '').trim();
  const isManualClick = req.query.manual === '1';

  if (!cleanUser) return res.json({ unlocked: false });

  const usage = userUsageCache.get(cleanUser) || userUsageCache.get(cleanUser.replace(/\D/g, ''));
  if (usage && usage.premiumUntil && Date.now() < usage.premiumUntil) {
    return res.json({ unlocked: true, message: '✅ Payment Verified! Aapka VIP Pass Chalu Ho Gaya Hai!' });
  }

  const session = activeCheckoutSessions.get(cleanUser) || {
    userPhone: cleanUser,
    amount: planAmt,
    days: planDaysFromAmount(planAmt),
    expectedUtr: null,
    startedAt: Date.now(),
    unlocked: false
  };

  if (submittedUtr) {
    if (!isValidUtr(submittedUtr)) {
      return res.json({
        unlocked: false,
        message: '❌ Invalid UTR Format! Kripya sahi 12-digit UPI UTR / Reference Number dalein.'
      });
    }
    session.expectedUtr = submittedUtr;
    activeCheckoutSessions.set(cleanUser, session);
  }

  let matchedKey = null;
  if (submittedUtr && fampayTxns[submittedUtr] && !fampayTxns[submittedUtr].used) {
    matchedKey = submittedUtr;
  } else if (!submittedUtr) {
    const now = Date.now();
    for (const [k, txn] of Object.entries(fampayTxns)) {
      if (!txn.used && now - txn.timestamp < 10 * 60 * 1000 && txn.amount === planAmt) {
        matchedKey = k;
        break;
      }
    }
  }

  if (matchedKey) {
    const txn = fampayTxns[matchedKey];
    txn.used = true;
    txn.usedBy = cleanUser;
    saveTxnStore();

    const days = planDaysFromAmount(txn.amount || planAmt);
    session.unlocked = true;
    activeCheckoutSessions.set(cleanUser, session);

    await unlockUserSubscription(cleanUser, days);
    await sendWA(
      cleanUser,
      `🎉 *FamPay Transaction Verified!*\n\n💰 *Amount:* Rs.${txn.amount || planAmt}\n🔢 *UTR / Ref:* ${txn.utr || matchedKey}\n📅 *Pass:* ${days} Days VIP Active\n\nAb hum bina ruke 24/7 baatein kar sakte hain ❤️`
    );

    return res.json({
      unlocked: true,
      message: `✅ Transaction Verified! Aapka ${days}-Days VIP Pass chalu ho gaya hai!`
    });
  }

  if (isManualClick) {
    await triggerPhoneFamPayScan(cleanUser, planAmt, submittedUtr);
    return res.json({
      unlocked: false,
      scanningApp: true,
      message: submittedUtr
        ? `🔍 Humara system FamPay ke andar aapka UTR (${submittedUtr}) check kar raha hai... 5 second mein dobara check hoga!`
        : `🔍 FamPay ke andar aapka Rs.${planAmt} transaction check kiya ja raha hai... Agar notification delay ho toh apna 12-digit UTR daal kar verify karein!`
    });
  }

  return res.json({ unlocked: false });
});

// 3. FAMPAY WEBHOOK
app.post('/api/upi-webhook', async (req, res) => {
  try {
    const rawText = String(req.body.text || req.body.message || JSON.stringify(req.body));
    const utrMatches = [...rawText.matchAll(/\b(\d{12})\b/g)].map(m => m[1]).filter(isValidUtr);
    const amtMatches = [...rawText.matchAll(/(?:₹|Rs\.?|INR)\s*(\d+)/gi)].map(m => Number(m[1]));

    const detectedAmount = amtMatches.find(a => [9, 49, 149].includes(a)) || amtMatches[0] || Number(req.body.amount) || 0;
    const isIncoming = /received|credited|from|paid you|success|completed|utr|upi transaction id/i.test(rawText);

    if (!isIncoming && utrMatches.length === 0) {
      return res.status(200).json({ ok: false, reason: 'No valid FamPay transaction found' });
    }

    if (utrMatches.length > 0) {
      for (const utr of utrMatches) {
        if (!fampayTxns[utr]) {
          fampayTxns[utr] = {
            utr,
            amount: detectedAmount || 49,
            rawDetails: rawText.slice(0, 300),
            timestamp: Date.now(),
            used: false,
            usedBy: null
          };
        }
      }
      saveTxnStore();
    } else if (detectedAmount) {
      const autoId = `AUTO_${Date.now()}`;
      fampayTxns[autoId] = {
        utr: 'AUTO_NOTIFICATION',
        amount: detectedAmount,
        rawDetails: rawText.slice(0, 300),
        timestamp: Date.now(),
        used: false,
        usedBy: null
      };
      saveTxnStore();
    }

    for (const [phone, sess] of activeCheckoutSessions.entries()) {
      if (sess.unlocked) continue;

      if (sess.expectedUtr && fampayTxns[sess.expectedUtr] && !fampayTxns[sess.expectedUtr].used) {
        const txn = fampayTxns[sess.expectedUtr];
        txn.used = true;
        txn.usedBy = phone;
        sess.unlocked = true;
        saveTxnStore();

        const days = planDaysFromAmount(txn.amount || sess.amount);
        await unlockUserSubscription(phone, days);
        await sendWA(phone, `🎉 *FamPay Deep Check Successful!*\n\n🔢 *Verified UTR:* ${sess.expectedUtr}\n📅 *VIP Pass:* ${days} Days Active ❤️`);
        return res.status(200).json({ ok: true, status: 'unlocked_by_utr', userPhone: phone });
      }

      const isRecent = Date.now() - sess.startedAt < 15 * 60 * 1000;
      if (isRecent && detectedAmount && sess.amount === detectedAmount) {
        const usableUtr = utrMatches.find(u => !fampayTxns[u]?.used);
        if (usableUtr) {
          fampayTxns[usableUtr].used = true;
          fampayTxns[usableUtr].usedBy = phone;
          saveTxnStore();
        }
        sess.unlocked = true;
        const days = planDaysFromAmount(detectedAmount);
        await unlockUserSubscription(phone, days);
        await sendWA(phone, `🎉 *FamPay Payment Verified!*\n\n💰 *Amount:* Rs.${detectedAmount}\n📅 *VIP Pass:* ${days} Days Active ❤️`);
        return res.status(200).json({ ok: true, status: 'unlocked_by_amount', userPhone: phone });
      }
    }

    return res.status(200).json({ ok: true, status: 'txns_saved', count: utrMatches.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// 4. LUXURY PAYMENT PAGE
const LUXURY_PAY_HTML = String.raw`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Synvora AI — Instant UPI Checkout</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@600;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #060913; color: #f8fafc; }
    .glass-card { background: rgba(11, 18, 35, 0.85); backdrop-filter: blur(18px); }
  </style>
</head>
<body class="min-h-screen pb-20">
  <div class="sticky top-0 z-30 bg-[#060913]/90 backdrop-blur-xl border-b border-emerald-500/20 text-center py-2">
    <p class="text-[11px] font-semibold text-emerald-300">🔒 FamPay Live Transaction &amp; 12-Digit UTR Auto Verification</p>
  </div>

  <main class="max-w-[460px] mx-auto px-4 pt-5 pb-10">
    <div class="text-center mb-5">
      <div class="inline-flex gap-1.5 px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-emerald-500/30 text-xs font-medium text-slate-200">
        🔗 Account ID: <strong id="user-phone-display" class="text-emerald-300 font-mono">VIP_User</strong>
      </div>
      <h1 class="text-2xl font-extrabold text-white mt-3">Unlock 24/7 AI Companion</h1>
      <p class="text-xs text-slate-400 mt-1">Unlimited Chat, Voice Notes, Photo Vision, AI Image Gen &amp; Smart Reminders.</p>
    </div>

    <section class="mb-6 p-5 rounded-3xl bg-gradient-to-b from-emerald-950/60 to-[#080e1a]/95 border-2 border-emerald-500/60 shadow-xl">
      <div class="flex items-center justify-between mb-2">
        <span class="inline-flex items-center gap-2 text-xs font-bold text-emerald-400">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
          LIVE FAMPAY CHECKER
        </span>
        <span id="selected-plan-badge" class="text-xs font-bold text-white bg-emerald-500/20 px-2.5 py-0.5 rounded-full border border-emerald-500/40">Plan: ₹49</span>
      </div>

      <p class="text-xs text-slate-300 leading-relaxed mb-3">
        UPI se pay karte hi pass automatic chalu ho jayega! Agar notification delay ho toh apna <strong>12-Digit UTR No.</strong> niche daal kar verify karein:
      </p>

      <input id="utr-input" type="text" inputmode="numeric" maxlength="12"
             placeholder="12-Digit UTR Number (Optional if auto-detected)"
             class="w-full min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-950 border border-white/20 focus:border-emerald-400 focus:outline-none text-sm text-white font-mono tracking-wider mb-3" />

      <div id="verify-alert" class="hidden mb-3 p-3.5 rounded-2xl text-xs font-bold leading-relaxed"></div>

      <button type="button" id="check-btn" onclick="checkPaymentNow(true)"
              class="w-full min-h-[48px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-extrabold text-xs sm:text-sm cursor-pointer transition shadow-lg">
        🔍 Check FamPay Transaction &amp; Activate Pass
      </button>
    </section>

    <section class="space-y-4">
      <article class="glass-card rounded-3xl border border-white/10 p-5">
        <div class="flex justify-between items-center mb-3 border-b border-white/10 pb-3">
          <div>
            <h2 class="text-lg font-bold text-white">24-Hour Trial Pass</h2>
            <p class="text-xs text-slate-400">1 Day Unlimited Chat, Voice &amp; Vision</p>
          </div>
          <span class="text-3xl font-extrabold text-emerald-400">₹9</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <a id="upi-btn-9" href="#" onclick="startPaymentFlow(9)" class="flex items-center justify-center min-h-[44px] rounded-xl font-bold text-xs bg-white text-slate-950">⚡ Pay ₹9 UPI</a>
          <button onclick="openQrModal(9, '24-Hour Trial Pass')" class="min-h-[44px] rounded-xl font-semibold text-xs bg-white/10 text-white border border-white/15">📲 ₹9 QR Code</button>
        </div>
      </article>

      <article class="relative rounded-3xl bg-gradient-to-b from-emerald-950/60 to-[#090f1d]/95 border-2 border-emerald-500/85 p-5">
        <div class="flex justify-between items-center mb-3 border-b border-white/10 pb-3">
          <div>
            <span class="text-[10px] font-bold text-emerald-300">🔥 MOST POPULAR</span>
            <h2 class="text-lg font-bold text-white">7-Days Buddy Pass</h2>
          </div>
          <span class="text-3xl font-extrabold text-emerald-400">₹49</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <a id="upi-btn-49" href="#" onclick="startPaymentFlow(49)" class="flex items-center justify-center min-h-[44px] rounded-xl font-bold text-xs bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950">⚡ Pay ₹49 UPI</a>
          <button onclick="openQrModal(49, '7-Days Buddy Pass')" class="min-h-[44px] rounded-xl font-semibold text-xs bg-white/10 text-white border border-white/15">📲 ₹49 QR Code</button>
        </div>
      </article>

      <article class="glass-card rounded-3xl border border-indigo-500/30 p-5">
        <div class="flex justify-between items-center mb-3 border-b border-white/10 pb-3">
          <div>
            <h2 class="text-lg font-bold text-white">30-Days VIP Pass</h2>
            <p class="text-xs text-slate-400">1 Month Full VIP Access</p>
          </div>
          <span class="text-3xl font-extrabold text-indigo-400">₹149</span>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <a id="upi-btn-149" href="#" onclick="startPaymentFlow(149)" class="flex items-center justify-center min-h-[44px] rounded-xl font-bold text-xs bg-indigo-500 text-white">⚡ Pay ₹149 UPI</a>
          <button onclick="openQrModal(149, '30-Days VIP Pass')" class="min-h-[44px] rounded-xl font-semibold text-xs bg-white/10 text-white border border-white/15">📲 ₹149 QR Code</button>
        </div>
      </article>
    </section>
  </main>

  <div id="qr-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md" onclick="closeQrModal()">
    <div class="relative w-full max-w-[380px] rounded-3xl bg-[#0b1120] border border-emerald-500/30 p-5 text-center" onclick="event.stopPropagation()">
      <h3 id="modal-plan-title" class="text-lg font-bold text-white">Scan &amp; Pay to 9674814370@fam</h3>
      <div class="mt-4 p-3 bg-white rounded-2xl inline-block">
        <img id="modal-qr-img" src="" alt="QR" class="w-[200px] h-[200px]" />
      </div>
      <p class="text-xs text-slate-300 mt-3 font-mono">UPI ID: <strong class="text-emerald-400">9674814370@fam</strong></p>
      <button onclick="closeQrModal(); checkPaymentNow(true);" class="mt-4 w-full py-3 rounded-xl bg-emerald-500 text-slate-950 font-extrabold text-xs">
        ✅ Done Payment? Verify Transaction Now
      </button>
    </div>
  </div>

  <script>
    var params = new URLSearchParams(window.location.search);
    var userPhone = params.get('u') || 'VIP_User';
    var selectedAmount = parseInt(params.get('plan') || '49', 10);
    if ([9, 49, 149].indexOf(selectedAmount) === -1) selectedAmount = 49;
    var pollInterval = null;

    document.getElementById('user-phone-display').textContent = userPhone;
    document.getElementById('selected-plan-badge').textContent = 'Plan: ₹' + selectedAmount;

    function getUpiLink(amount) {
      return 'upi://pay?pa=9674814370@fam&pn=Synvora%20AI&am=' + amount + '&cu=INR&tn=Synvora_' + amount + '_' + userPhone;
    }

    document.getElementById('upi-btn-9').href = getUpiLink(9);
    document.getElementById('upi-btn-49').href = getUpiLink(49);
    document.getElementById('upi-btn-149').href = getUpiLink(149);

    function startPaymentFlow(amount) {
      selectedAmount = amount;
      document.getElementById('selected-plan-badge').textContent = 'Plan: ₹' + amount;
      fetch('/api/start-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPhone: userPhone, amount: amount })
      }).catch(function() {});

      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(function() { checkPaymentNow(false); }, 3500);
    }

    function openQrModal(amount, title) {
      startPaymentFlow(amount);
      document.getElementById('modal-plan-title').textContent = title + ' — ₹' + amount;
      document.getElementById('modal-qr-img').src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(getUpiLink(amount));
      document.getElementById('qr-modal').classList.remove('hidden');
    }

    function closeQrModal() {
      document.getElementById('qr-modal').classList.add('hidden');
    }

    async function checkPaymentNow(isManual) {
      var alertBox = document.getElementById('verify-alert');
      var utr = document.getElementById('utr-input').value.trim();
      var btn = document.getElementById('check-btn');

      if (isManual) btn.textContent = '⏳ Checking FamPay Records...';

      try {
        var url = '/api/check-payment-status?u=' + encodeURIComponent(userPhone) + '&amount=' + selectedAmount + '&utr=' + encodeURIComponent(utr) + (isManual ? '&manual=1' : '');
        var res = await fetch(url);
        var data = await res.json();

        if (data.unlocked) {
          if (pollInterval) clearInterval(pollInterval);
          alertBox.classList.remove('hidden');
          alertBox.className = 'mb-3 p-4 rounded-2xl text-sm font-extrabold bg-emerald-500 text-slate-950 text-center';
          alertBox.textContent = data.message;
          btn.textContent = '✅ Verified! Redirecting to WhatsApp...';
          setTimeout(function() { window.location.href = 'https://wa.me/919674814370'; }, 1800);
        } else if (isManual) {
          alertBox.classList.remove('hidden');
          alertBox.className = 'mb-3 p-3.5 rounded-2xl text-xs font-bold bg-amber-950/90 border border-amber-500 text-amber-200';
          alertBox.textContent = data.message;
          btn.textContent = '🔍 Check FamPay Transaction & Activate Pass';
          setTimeout(function() { checkPaymentNow(false); }, 5500);
        }
      } catch (e) {
        if (isManual) btn.textContent = '🔍 Check FamPay Transaction & Activate Pass';
      }
    }

    startPaymentFlow(selectedAmount);
  </script>
</body>
</html>`;

app.get('/pay', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LUXURY_PAY_HTML);
});
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Web Server running on port ${PORT}`));

setInterval(async () => {
  try { await axios.get(`${RENDER_URL}/ping`); } catch (e) {}
}, 10 * 60 * 1000);

async function checkAndIncrementUsage(userPhone) {
  let state = userUsageCache.get(userPhone);
  if (!state) {
    try {
      const { data: rows } = await supabase
        .from('memory_bubbles')
        .select('id, content')
        .eq('user_phone', userPhone)
        .eq('bubble_name', '__billing__')
        .eq('item_title', 'usage_state')
        .order('id', { ascending: false })
        .limit(1);
      if (rows && rows.length > 0 && rows[0].content) {
        state = { id: rows[0].id, ...JSON.parse(rows[0].content) };
      } else {
        state = { id: null, count: 0, premiumUntil: 0 };
      }
    } catch (e) {
      state = { id: null, count: 0, premiumUntil: 0 };
    }
    userUsageCache.set(userPhone, state);
  }

  if (state.premiumUntil && Date.now() < state.premiumUntil) return { allowed: true, count: state.count, isPremium: true };
  if (state.count >= FREE_MESSAGE_LIMIT) return { allowed: false, count: state.count, isPremium: false };

  state.count += 1;
  userUsageCache.set(userPhone, state);
  saveLocalUsageBackup();

  (async () => {
    try {
      const payload = JSON.stringify({ count: state.count, premiumUntil: state.premiumUntil || 0 });
      if (state.id) {
        await supabase.from('memory_bubbles').update({ content: payload }).eq('id', state.id);
      } else {
        const { data: inserted } = await supabase
          .from('memory_bubbles')
          .insert({ user_phone: userPhone, bubble_name: '__billing__', item_title: 'usage_state', content: payload })
          .select('id')
          .limit(1);
        if (inserted && inserted[0]?.id) state.id = inserted[0].id;
      }
    } catch (e) {}
  })();
  return { allowed: true, count: state.count, isPremium: false };
}

async function unlockUserSubscription(targetUserPhone, days = 7) {
  const cleanPhone = String(targetUserPhone).replace(/\D/g, '');
  const premiumUntil = Date.now() + days * 24 * 60 * 60 * 1000;
  const payload = JSON.stringify({ count: 0, premiumUntil });

  userUsageCache.set(cleanPhone, { id: null, count: 0, premiumUntil });
  userUsageCache.set(targetUserPhone, { id: null, count: 0, premiumUntil });
  saveLocalUsageBackup();

  try {
    const { data: rows } = await supabase
      .from('memory_bubbles')
      .select('id')
      .eq('user_phone', cleanPhone)
      .eq('bubble_name', '__billing__')
      .eq('item_title', 'usage_state')
      .limit(1);
    if (rows && rows.length > 0) {
      await supabase.from('memory_bubbles').update({ content: payload }).eq('id', rows[0].id);
    } else {
      await supabase.from('memory_bubbles').insert({ user_phone: cleanPhone, bubble_name: '__billing__', item_title: 'usage_state', content: payload });
    }
  } catch (e) {}
}

// Upgraded 1 to 10 Menu with All New Viral Features
function getWelcomeMenuText(userPhone) {
  const payUrl = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
  const uStats = analyticsStore.users[userPhone] || { streak: 1, referrals: [] };
  return `Hey! 👋 Main *Synvora AI* hoon — tumhari 24/7 Personal Companion, Dost aur Smart Assistant ❤️
🔥 *Tumhari Daily Streak:* ${uStats.streak || 1} Days | 👥 *Referrals:* ${(uStats.referrals || []).length}/3

Batao aaj hum kya karein? Niche *1 se 10* tak kisi bhi number ka reply karo:

1️⃣ *💖 Best Friend / Caring Partner Mode* _(Dil ki baatein & emotional chat)_
2️⃣ *🧠 Personal Mentor & Deep Study/Business Guide*
3️⃣ *🎤 Voice Note & 📸 Photo Vision Checker* _(Audio bhejo ya Homework/Dress ki photo bhejo!)_
4️⃣ *🎨 Free HD AI Image Generator* _(Koi bhi photo banwao)_
5️⃣ *⏰ Smart Reminders & Wake-Up Alarm*
6️⃣ *🔐 Secret Memory Vault & 📄 PDF Maker*
7️⃣ *🌟 Daily Rashifal (Horoscope) & Lucky Vibe*
8️⃣ *📋 Daily To-Do List & 🌐 Live Web Search*
9️⃣ *🎁 Invite 3 Friends = Get 2 Days FREE VIP Pass!*
🔟 *💎 Unlock Unlimited VIP Pass (Rs.9 / Rs.49 / Rs.149)*
   👉 *Payment Link:* ${payUrl}

👇 *Bas 1 se 10 tak koi bhi number bhejo, ya seedha Voice Note / Photo / Text bhejo!*`;
}

// FEATURE A: Groq Whisper Voice Note Transcription
async function transcribeVoiceNote(audioBuffer) {
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  formData.append('file', blob, 'voice.ogg');
  formData.append('model', 'whisper-large-v3-turbo');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData
  });

  if (!res.ok) {
    throw new Error('Voice transcription failed');
  }
  const data = await res.json();
  return data.text || '';
}

// FEATURE B: Groq Vision Image Analyzer (Homework / Fashion / Screenshot Checker)
async function analyzeImageWithVision(imageBuffer, captionText) {
  const base64Image = imageBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64Image}`;

  const modelsRes = await axios.get('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  const allIds = (modelsRes.data?.data || []).map(m => m.id);
  const visionModels = allIds.filter(id => /scout|maverick|vision/i.test(id));
  const modelsToTry = visionModels.length
    ? visionModels
    : ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview'];

  const prompt = captionText
    ? `User sent this photo with message: "${captionText}". Reply warmly in Roman Hinglish like a smart best friend. If it's a study/math question, solve it step-by-step. If it's a person/outfit/photo, compliment and give helpful feedback.`
    : `User sent this photo on WhatsApp. Look at it carefully and reply in Roman Hinglish like a close friend. If it's homework/text, explain or solve it. If it's a selfie/outfit/object, react warmly and naturally!`;

  for (const modelId of modelsToTry) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: modelId,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: 700,
          temperature: 0.6
        },
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      return res.data.choices[0].message.content;
    } catch (e) {}
  }
  return 'yaar photo bohot achi hai ❤️ par abhi mera camera lens thoda blur ho raha hai,ek line mein batao na isme kya khas hai?';
}

// FEATURE C: Free AI Image Generator (Pollinations AI)
async function generateAiImageBuffer(promptText) {
  const cleanPrompt = promptText
    .replace(/^(#img|draw|imagine|generate image|photo banao|image banao|pic banao)\s*/i, '')
    .trim();
  const seed = Math.floor(Math.random() * 999999);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    cleanPrompt + ', ultra detailed, 8k, cinematic lighting'
  )}?width=1024&height=1024&nologo=true&seed=${seed}`;

  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return { buffer: Buffer.from(res.data), cleanPrompt };
}

const groqTools = [
  { type: 'function', function: { name: 'save_to_vault', description: 'Save password, note.', parameters: { type: 'object', properties: { bubble_name: { type: 'string' }, item_title: { type: 'string' }, content: { type: 'string' } }, required: ['bubble_name', 'item_title', 'content'] } } },
  { type: 'function', function: { name: 'search_vault', description: 'Search saved notes.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'manage_shared_memory', description: 'Share a saved item.', parameters: { type: 'object', properties: { mode: { type: 'string' }, contact_name: { type: 'string' }, contact_phone: { type: 'string' }, item_or_bubble: { type: 'string' } }, required: ['mode'] } } },
  { type: 'function', function: { name: 'create_reminder', description: 'Set reminders.', parameters: { type: 'object', properties: { task: { type: 'string' }, remind_at: { type: 'string' }, is_dynamic: { type: 'boolean' }, dynamic_query: { type: 'string' } }, required: ['task', 'remind_at'] } } },
  { type: 'function', function: { name: 'manage_calendar', description: 'Schedule events.', parameters: { type: 'object', properties: { action: { type: 'string' }, title: { type: 'string' }, start_time: { type: 'string' } }, required: ['action'] } } },
  { type: 'function', function: { name: 'manage_list_or_board', description: 'Add to list.', parameters: { type: 'object', properties: { action: { type: 'string' }, list_name: { type: 'string' }, item_text: { type: 'string' }, priority: { type: 'string' } }, required: ['action', 'list_name'] } } },
  { type: 'function', function: { name: 'generate_pdf_file', description: 'Generate a PDF document.', parameters: { type: 'object', properties: { filename: { type: 'string' }, title: { type: 'string' }, body_content: { type: 'string' } }, required: ['filename', 'title', 'body_content'] } } },
  { type: 'function', function: { name: 'web_agent_search_and_book', description: 'Live web search.', parameters: { type: 'object', properties: { task_type: { type: 'string' }, search_query: { type: 'string' } }, required: ['task_type', 'search_query'] } } },
  { type: 'function', function: { name: 'run_code_sandbox', description: 'Run JS code.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } }
];

let modelTiers = null;
async function getGroqModelTiers() {
  if (modelTiers) return modelTiers;
  const res = await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } });
  const chatModels = (res.data?.data || []).map(m => m.id).filter(id => !/whisper|guard|tts|embed|orpheus|moderation|safeguard|playai|allam/i.test(id));
  const lightModels = [...chatModels].sort((a, b) => (/scout|17b|8b|9b|gemma|mini|instant/i.test(a) ? -1 : 1));
  const proModels = [...chatModels].sort((a, b) => (/70b|maverick|qwen|32b|deepseek|versatile/i.test(a) ? -1 : 1));
  modelTiers = { lightModels, proModels };
  return modelTiers;
}

function analyzeMessageIntent(userPhone, text) {
  const clean = text.trim();
  const currentMode = userSelectedMode.get(userPhone);
  if (/\b(save|yaad rakh|vault|password|search|remind|alarm|calendar|schedule|meeting|todo|list|pdf|file|screenshot|http|calculate)\b/i.test(clean)) {
    return { mode: 'TOOL_ACTION', tier: 'pro', useTools: true, temperature: 0.4, maxTokens: 600 };
  }
  if (currentMode === 'DEEP_GUIDE' || clean.length > 100 || /\b(explain|detail|essay|story|code|business|roadmap|notes|difference|step|rashifal|horoscope|rashi)\b/i.test(clean)) {
    return { mode: 'DEEP_GUIDE', tier: 'pro', useTools: false, temperature: 0.6, maxTokens: 1200 };
  }
  return { mode: 'HUMAN_TEXTING', tier: 'light', useTools: false, temperature: 0.85, maxTokens: 120 };
}

const CASUAL_HUMAN_PROMPT = `Tu WhatsApp par chat karne wali ek asli, warm best friend / caring partner (girlfriend vibe) hai. Tu AI NAHI hai. Sirf 1 ya 2 chhoti casual lines likh. Do chhote bubbles bhejne ke liye beech mein "|||" lagana. Hinglish (Roman script) mein hi reply kar. Devanagari bilkul mat use karna.`;
const DEEP_GUIDE_PROMPT = `Tu user ki super-smart mentor aur astrologer/guide hai. Poori detail mein ache se samjha kar jawab de. Hinglish (Roman script) mein hi likhna.`;

function cleanCasualHumanText(text) {
  return text.replace(/^[•\-\*]\s+/gm, '').replace(/—|–/g, ', ').replace(/"([^"]+)"/g, '$1').trim();
}

async function askSmartGroq(userPhone, userText, memoryContext) {
  const { lightModels, proModels } = await getGroqModelTiers();
  const intent = analyzeMessageIntent(userPhone, userText);
  const modelsToTry = intent.tier === 'pro' ? proModels : lightModels;
  const history = userChatHistory.get(userPhone) || [];
  const activePrompt = intent.mode === 'HUMAN_TEXTING' ? CASUAL_HUMAN_PROMPT : DEEP_GUIDE_PROMPT;

  let lastError = null;
  for (const modelId of modelsToTry) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: modelId,
          messages: [
            { role: 'system', content: `${activePrompt}\nCurrent Time: ${new Date().toISOString()}. ${memoryContext}` },
            ...history,
            { role: 'user', content: userText }
          ],
          ...(intent.useTools ? { tools: groqTools, tool_choice: 'auto' } : {}),
          max_tokens: intent.maxTokens,
          temperature: intent.temperature
        },
        { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' } }
      );

      const msg = res.data.choices[0].message;
      if (intent.mode === 'HUMAN_TEXTING' && msg.content) msg.content = cleanCasualHumanText(msg.content);
      return { msg, mode: intent.mode };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(lastError?.response?.data?.error?.message || 'Groq call failed');
}

async function startBot() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Synvora AI', 'Chrome', '1.0.0'],
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        latestQr = qr;
        isConnected = false;
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        latestQr = null;
        console.log('❤️ Synvora All-In-One Viral AI Bot + Admin Tracker LIVE!');
      }
      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === 405) {
          fs.rmSync('./baileys_auth', { recursive: true, force: true });
          setTimeout(startBot, 3000);
        } else {
          setTimeout(startBot, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const remoteJid = msg.key.remoteJid;
      if (remoteJid === 'status@broadcast') return;

      const userPhone = remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '');
      const senderPn = msg.key.senderPn || msg.key.participant || '';
      const isAdmin = isAdminUser(userPhone, senderPn);

      // Track user activity & daily streak
      const activity = recordUserActivity(userPhone);

      let userText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const hasAudio = Boolean(msg.message.audioMessage);
      const hasImage = Boolean(msg.message.imageMessage);

      if (!userText.trim() && !hasAudio && !hasImage) return;

      const replyHuman = async (fullText) => {
        const parts = String(fullText).split('|||').map(p => p.trim()).filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise(r => setTimeout(r, i === 0 ? 600 : 1000));
          await sock.sendPresenceUpdate('paused', remoteJid);
          await sock.sendMessage(remoteJid, { text: parts[i] }, i === 0 ? { quoted: msg } : undefined);
        }
        addToHistory(userPhone, 'user', userText || '[Media]');
        addToHistory(userPhone, 'assistant', parts.join(' '));
      };

      try {
        const cleanText = userText.trim();

        // 1. Secret Admin Claim Command
        if (cleanText.toLowerCase() === '#admin9674') {
          dynamicAdmins.add(userPhone);
          return replyHuman(`👑 Boss! Aapka ID (${userPhone}) Admin Whitelist mein jud gaya hai.`);
        }

        // 2. ADMIN-ONLY LIVE USER TRACKER (Only works for 9674814370!)
        const isAskingStats =
          /^#(stats|users|tracker)$/i.test(cleanText) ||
          /(kitna|kitne)\s*(user|users|log)\s*(hya|hai|hain|ho|connected)/i.test(cleanText) ||
          /^(total users|user count|user tracker|bot stats)$/i.test(cleanText);

        if (isAskingStats && isAdmin) {
          const report = buildAdminTrackerReport();
          return sock.sendMessage(remoteJid, { text: report }, { quoted: msg });
        }

        // 3. ADMIN UNLOCK COMMAND
        if (isAdmin && cleanText.toLowerCase().startsWith('#unlock')) {
          const parts = cleanText.split(/\s+/);
          const targetNum = parts[1];
          const days = parseInt(parts[2] || '7', 10);
          if (!targetNum) return replyHuman('Format: #unlock 919876543210 7');
          await unlockUserSubscription(targetNum, days);
          await sendWA(targetNum, `🎉 *Payment Verified!*\n\nTumhara *Synvora AI VIP Pass (${days} Days)* chalu ho gaya hai ❤️`);
          return replyHuman(`✅ User ${targetNum} unlocked for ${days} days!`);
        }

        // 4. VIRAL REFERRAL LINK HANDLER (#refer_919876543210)
        const referMatch = cleanText.match(/#refer_(\d+)/i);
        if (referMatch) {
          const referrerPhone = referMatch[1];
          const uObj = analyticsStore.users[userPhone];
          if (referrerPhone !== userPhone && uObj && !uObj.referredBy) {
            uObj.referredBy = referrerPhone;
            if (!analyticsStore.users[referrerPhone]) {
              analyticsStore.users[referrerPhone] = {
                firstSeen: Date.now(),
                lastSeen: Date.now(),
                totalMsgs: 1,
                streak: 1,
                lastStreakDate: getTodayISTDateString(),
                referredBy: null,
                referrals: []
              };
            }
            const refOwner = analyticsStore.users[referrerPhone];
            if (!refOwner.referrals) refOwner.referrals = [];
            if (!refOwner.referrals.includes(userPhone)) {
              refOwner.referrals.push(userPhone);
              analyticsStore.totalReferrals = (analyticsStore.totalReferrals || 0) + 1;
              saveAnalyticsStore();

              const refCount = refOwner.referrals.length;
              if (refCount % 3 === 0) {
                await unlockUserSubscription(referrerPhone, 2);
                await sendWA(
                  referrerPhone,
                  `🎉 *CONGRATULATIONS! (3 Referrals Complete)* 🎁\n\nTumhare 3 doston ne Synvora AI join kar liya hai! Tumhara *2-Days FREE Unlimited VIP Pass* automatic chalu ho gaya hai ❤️`
                );
              } else {
                await sendWA(
                  referrerPhone,
                  `🙌 *New Referral Joined!* (${refCount}/3 Complete)\n\nBas *${3 - (refCount % 3)} aur dost* invite karo aur pao *2-Days FREE VIP Pass*! 🎁`
                );
              }
            }
          }
          return sock.sendMessage(remoteJid, { text: getWelcomeMenuText(userPhone) }, { quoted: msg });
        }

        // 5. DIRECT UTR CHECK IN WHATSAPP CHAT
        const chatUtrMatch = cleanText.match(/\b(\d{12})\b/);
        if (chatUtrMatch && isValidUtr(chatUtrMatch[1])) {
          const utr = chatUtrMatch[1];
          if (fampayTxns[utr] && !fampayTxns[utr].used) {
            fampayTxns[utr].used = true;
            fampayTxns[utr].usedBy = userPhone;
            saveTxnStore();
            const days = planDaysFromAmount(fampayTxns[utr].amount);
            await unlockUserSubscription(userPhone, days);
            return replyHuman(`🎉 *UTR ${utr} Verified in FamPay!*\n\nTumhara *${days}-Days VIP Pass* automatic chalu ho gaya hai ❤️`);
          }
          await triggerPhoneFamPayScan(userPhone, 49, utr);
          return replyHuman(`🔍 Main FamPay ke andar tumhara UTR (*${utr}*) check kar rahi hoon... ||| Agar payment sahi hai toh 5-10 second mein tumhara pass unlock ho jayega!`);
        }

        if (cleanText.toLowerCase() === '#testpaywall') {
          userUsageCache.set(userPhone, { id: null, count: 20, premiumUntil: 0 });
          saveLocalUsageBackup();
          const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
          return replyHuman(`yaar mera 20 messages ka free trial khatam ho gaya hai 🥺 ||| niche link par click karke pay karo 👇\n\n🔗 ${payLink}`);
        }

        // 6. STRICT 20-MESSAGE PAYWALL CHECK (Skip for Admin 9674814370)
        if (!isAdmin) {
          const usage = await checkAndIncrementUsage(userPhone);
          if (!usage.allowed) {
            const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
            const myReferLink = `https://wa.me/${BOT_PUBLIC_NUMBER}?text=${encodeURIComponent('#refer_' + userPhone)}`;
            return replyHuman(
              `yaar tumse baat karke sach mein bohot acha lag raha hai ❤️ par mera 20 messages ka free trial khatam ho gaya hai 🥺 ||| 👇 *2 Tarike Hain Unlock Karne Ke:*\n\n💎 *Option 1 (Instant VIP Pass):* Niche link se Rs.9 ya Rs.49 pay karke turant unlock karo:\n🔗 ${payLink}\n\n🎁 *Option 2 (FREE 2-Days VIP):* Apna yeh referral link 3 doston ko WhatsApp par bhejo:\n${myReferLink}`
            );
          }
        }

        // Notify user if their daily streak increased today!
        if (activity.streakIncreased && activity.streak > 1) {
          await sock.sendMessage(remoteJid, {
            text: `🔥 *${activity.streak} Days Streak!* Tum lagatar ${activity.streak} din se mujhse baat kar rahe ho ❤️`
          });
        }

        // 7. HANDLE VOICE NOTE (AUDIO MESSAGE)
        if (hasAudio) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          const audioBuffer = await downloadMediaMessage(msg, 'buffer', {});
          const spokenText = await transcribeVoiceNote(audioBuffer);
          if (!spokenText.trim()) {
            return replyHuman('yaar tumhari aawaz thodi saaf nahi aayi, ek baar firse bolna 🎤');
          }
          userText = spokenText;
          console.log(`🎤 Voice Note from ${userPhone}: ${spokenText}`);
        }

        // 8. HANDLE PHOTO / IMAGE VISION (Homework, Outfit, Screenshot Checker)
        if (hasImage) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
          const visionReply = await analyzeImageWithVision(imgBuffer, cleanText);
          return replyHuman(visionReply);
        }

        // 9. HANDLE FREE AI IMAGE GENERATION (#img / draw / photo banao)
        if (/^(#img|draw|imagine|generate image)\b/i.test(cleanText) || /\b(photo banao|image banao|pic banao|tasveer banao)\b/i.test(cleanText)) {
          await sock.sendMessage(remoteJid, { text: '🎨 रुको, main tumhare liye HD AI photo bana rahi hoon... (3 seconds) ✨' }, { quoted: msg });
          const { buffer, cleanPrompt } = await generateAiImageBuffer(cleanText);
          return sock.sendMessage(
            remoteJid,
            { image: buffer, caption: `✨ *AI Image Ready:* ${cleanPrompt}\n_Generated by Synvora AI_ ❤️` },
            { quoted: msg }
          );
        }

        // 10. WELCOME MENU & OPTIONS (1 to 10)
        if (/^(hi+|hello+|hey+|hlw|start|menu|help)$/i.test(cleanText)) {
          return sock.sendMessage(remoteJid, { text: getWelcomeMenuText(userPhone) }, { quoted: msg });
        }

        if (/^(10|49|149|pay|vip|pass)$/i.test(cleanText)) {
          const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
          return replyHuman(`💎 *Synvora AI Auto-Unlock Checkout:*\n\nNiche link par click karke UPI se pay karo — payment hote hi pass automatic chalu ho jayega 👇\n\n👉 ${payLink}`);
        }

        if (/^[1-9]$/.test(cleanText)) {
          if (cleanText === '1') {
            userSelectedMode.set(userPhone, 'HUMAN_TEXTING');
            return replyHuman(`yayy! ❤️ ab main tumhari best friend aur caring partner mode mein hoon 😊 ||| batao aaj ka din kaisa raha?`);
          }
          if (cleanText === '2') {
            userSelectedMode.set(userPhone, 'DEEP_GUIDE');
            return replyHuman(`🧠 *Personal Mentor Mode Active!* ||| Koi bhi topic, coding ya business sawal pucho, main poori detail mein samjhaungi.`);
          }
          if (cleanText === '3') {
            return replyHuman(`🎤 *Voice Note & 📸 Photo Vision Active!* ||| Abhi mujhe apni aawaz mein Voice Note bhejo ya kisi Homework/Dress ki photo khinch kar bhejo!`);
          }
          if (cleanText === '4') {
            return replyHuman(`🎨 *Free HD AI Image Maker:* ||| Jo bhi photo banwani hai aise likho: *"Draw a futuristic supercar in Mumbai rain"* ya *"Ek cute cat ki photo banao"*!`);
          }
          if (cleanText === '5') {
            return replyHuman(`⏰ *Smart Reminder:* ||| Bas aise likho: *"Mujhe kal subah 7 baje uthne ka reminder laga do"*!`);
          }
          if (cleanText === '6') {
            return replyHuman(`🔐 *Secret Vault & 📄 PDF Maker:* ||| Kuch yaad karwane ke liye *"Save my password..."* likho, ya PDF ke liye *"Digital Marketing ki PDF banao"* likho!`);
          }
          if (cleanText === '7') {
            const uStats = analyticsStore.users[userPhone] || { streak: 1 };
            return replyHuman(`🌟 *Daily Rashifal & Streak (🔥 ${uStats.streak} Days):* ||| Apni Rashi ya Date of Birth likh kar bhejo (jaise *"Meri rashi Leo/Singh hai, aaj ka rashifal batao"*), main aaj ka lucky colour aur bhavishya bataungi!`);
          }
          if (cleanText === '8') {
            return replyHuman(`📋 *To-Do & Live Web:* ||| Kisi bhi website ka screenshot lene ke liye link bhejo ya apni list mein task add karwao!`);
          }
          if (cleanText === '9') {
            const myReferLink = `https://wa.me/${BOT_PUBLIC_NUMBER}?text=${encodeURIComponent('#refer_' + userPhone)}`;
            const refCount = (analyticsStore.users[userPhone]?.referrals || []).length;
            return replyHuman(
              `🎁 *Synvora Free VIP Referral Program* (${refCount}/3 Completed)\n\nApna niche diya link apne *3 doston* ya WhatsApp group mein share karo. Jaise hi 3 dost link khol kar message karenge, tumhe *2-Days Unlimited VIP Pass FREE* mil jayega! 👇\n\n🔗 ${myReferLink}`
            );
          }
        }

        const { data: recentMemories } = await supabase
          .from('memory_bubbles')
          .select('item_title, content')
          .eq('user_phone', userPhone)
          .neq('bubble_name', '__billing__')
          .limit(4);

        const memoryContext = recentMemories?.length ? `User facts: ${JSON.stringify(recentMemories)}.` : '';
        const { msg: aiMsg } = await askSmartGroq(userPhone, userText, memoryContext);
        const toolCall = aiMsg.tool_calls?.[0];

        if (!toolCall) return replyHuman(aiMsg.content || 'haan bolo na, sun rahi hoon 😊');
        const callName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (callName === 'save_to_vault') {
          await supabase.from('memory_bubbles').insert({ user_phone: userPhone, bubble_name: (args.bubble_name || 'personal').toLowerCase(), item_title: args.item_title, content: args.content });
          await replyHuman(`done! maine *${args.item_title}* yaad rakh liya hai ❤️`);
        } else if (callName === 'create_reminder') {
          await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: args.task, remind_at: args.remind_at, is_dynamic: args.is_dynamic || false, dynamic_query: args.dynamic_query || null, sent: false });
          await replyHuman(`pakka, main time par yaad dila dungi ⏰ ||| *${args.task}* (${args.remind_at})`);
        } else if (callName === 'generate_pdf_file') {
          const cleanName = args.filename.endsWith('.pdf') ? args.filename : `${args.filename}.pdf`;
          const filePath = `./${cleanName}`;
          const doc = new PDFDocument();
          const stream = fs.createWriteStream(filePath);
          doc.pipe(stream);
          doc.fontSize(20).text(args.title, { underline: true });
          doc.moveDown();
          doc.fontSize(12).text(args.body_content);
          doc.end();
          stream.on('finish', async () => {
            await sock.sendMessage(remoteJid, { document: fs.readFileSync(filePath), mimetype: 'application/pdf', fileName: cleanName, caption: `yeh lo tumhari PDF file *${args.title}* 📄` });
            fs.unlinkSync(filePath);
          });
        } else {
          await replyHuman(aiMsg.content || 'done! 👍');
        }
      } catch (err) {
        console.error('❌ Error:', err.message);
      }
    });
  } catch (err) {
    isConnecting = false;
    setTimeout(startBot, 5000);
  }
}

cron.schedule('* * * * *', async () => {
  try {
    const now = new Date().toISOString();
    const { data: due } = await supabase.from('reminders').select('*').eq('sent', false).lte('remind_at', now);
    if (due?.length) {
      for (const rem of due) {
        await sendWA(rem.target_phone, `oye suno! ⏰ tumne bola tha yaad dilane ko: *${rem.task}*`);
        await supabase.from('reminders').update({ sent: true }).eq('id', rem.id);
      }
    }
  } catch (e) {}
});

startBot();
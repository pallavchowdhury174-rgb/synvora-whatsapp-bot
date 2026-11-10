 import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://synvora-whatsapp-bot.onrender.com';

// SIRF 9674814370 ADMIN HAI (Baki sabhi numbers par 20 messages ka paywall lagega)
const ADMIN_NUMBERS = ['9674814370', '919674814370'];
const FREE_MESSAGE_LIMIT = 20;
const USAGE_FILE = './usage_store.json';

let sock;
let latestQr = null;
let isConnected = false;
let isConnecting = false;

const userChatHistory = new Map();
const userSelectedMode = new Map();
const userUsageCache = new Map();
const dynamicAdmins = new Set(ADMIN_NUMBERS);

try {
  if (fs.existsSync(USAGE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      userUsageCache.set(k, v);
    }
  }
} catch (e) {}

function saveLocalUsageBackup() {
  try {
    const obj = Object.fromEntries(userUsageCache.entries());
    fs.writeFileSync(USAGE_FILE, JSON.stringify(obj, null, 2));
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
    if (cleanUser === adm || cleanUser.endsWith('9674814370') || cleanSender.endsWith('9674814370')) {
      return true;
    }
  }
  return false;
}

// Web Dashboard & QR Scanner
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;background:#060913;color:#fff;min-height:100vh;">
        <h1 style="color:#10b981;">❤️ Synvora AI Companion 24/7 LIVE Hai!</h1>
        <p style="color:#94a3b8;margin-top:10px;">Luxury Payment Page + Interactive Menu + 20-Msg Paywall Active Hai.</p>
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

// AAPKI AI STUDIO LUXURY PAYMENT WEBSITE (/pay) SEEDHA YAHAN BUILT-IN HAI
const LUXURY_PAY_HTML = String.raw`<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Synvora AI — 24/7 WhatsApp Companion & Personal Assistant Pass</title>
  <meta name="description" content="Unlock 24/7 WhatsApp Human Companion & Personal Assistant. 100% Safe UPI Checkout, Zero Auto-Debit, Instant Unlock." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
            mono: ['"JetBrains Mono"', 'monospace'],
          },
          colors: { obsidian: '#060913' }
        }
      }
    };
  </script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: #060913;
      color: #f8fafc;
      overflow-x: hidden;
    }
    @keyframes pulseEmeraldGlow {
      0%, 100% { box-shadow: 0 0 26px -4px rgba(16, 185, 129, 0.35), 0 0 10px 0 rgba(16, 185, 129, 0.22); }
      50% { box-shadow: 0 0 38px 0px rgba(16, 185, 129, 0.58), 0 0 16px 2px rgba(16, 185, 129, 0.35); }
    }
    .popular-card-glow { animation: pulseEmeraldGlow 3.2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    .glass-card {
      background: rgba(11, 18, 35, 0.82);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
    }
  </style>
</head>
<body class="bg-[#060913] text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200 min-h-screen relative pb-20">
  <div aria-hidden="true" class="pointer-events-none fixed inset-0 overflow-hidden z-0">
    <div class="absolute -top-36 left-1/2 -translate-x-1/2 w-[540px] h-[380px] rounded-full opacity-25 blur-[110px]"
         style="background: radial-gradient(circle, #10b981 0%, rgba(16,185,129,0) 70%);"></div>
    <div class="absolute top-[38%] left-1/2 -translate-x-1/2 w-[500px] h-[420px] rounded-full opacity-20 blur-[120px]"
         style="background: radial-gradient(circle, #6366f1 0%, rgba(99,102,241,0) 70%);"></div>
  </div>

  <div class="sticky top-0 z-30 bg-[#060913]/90 backdrop-blur-xl border-b border-emerald-500/20">
    <div class="max-w-[460px] mx-auto px-3 py-2 text-center">
      <p class="text-[11px] sm:text-xs font-semibold text-emerald-300 tracking-tight whitespace-nowrap overflow-x-auto">
        🔒 100% Safe UPI Checkout • Zero Auto-Debit • No Card/OTP Required
      </p>
    </div>
  </div>

  <main class="relative z-10 max-w-[460px] mx-auto px-4 pt-5 pb-10">
    <div class="flex flex-col items-center gap-2.5 text-center">
      <div id="account-pill" class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-white/[0.06] border border-emerald-500/30 text-xs font-medium text-slate-200 shadow-sm">
        🔗 Account ID: <strong id="user-phone-display" class="text-emerald-300 font-mono">VIP_User</strong> • Ready for Instant Unlock
      </div>
      <div class="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <span>🟢 1,840+ Users Online &amp; Chatting Now</span>
      </div>
    </div>

    <header class="text-center mt-4 mb-6">
      <div class="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-300 mb-1.5">
        <i data-lucide="sparkles" class="w-3.5 h-3.5 text-emerald-400"></i>
        <span>Synvora AI — 24/7 WhatsApp Human Companion</span>
      </div>
      <h1 class="text-2xl sm:text-3xl font-extrabold text-white tracking-tight leading-tight">
        Unlock Your 24/7 AI Bestie &amp; Personal Assistant
      </h1>
      <p class="text-xs sm:text-sm text-slate-300 mt-2 leading-relaxed">
        Unlimited human-like emotional chats, personal Memory Vault, wake-up reminders &amp; instant PDF study/work notes right inside WhatsApp.
      </p>
    </header>

    <section aria-label="Pricing Plans" class="space-y-4">
      <!-- PLAN 1: ₹9 -->
      <article id="card-plan-9" class="glass-card rounded-3xl border border-white/10 hover:border-white/20 p-5 sm:p-6 transition-all duration-200">
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-slate-300">
            <i data-lucide="sparkles" class="w-3.5 h-3.5 text-slate-400"></i>
            <span>TRY RISK-FREE</span>
          </span>
          <span class="text-xs font-mono tabular-nums text-slate-400">₹9 / day · 24 Hours</span>
        </div>
        <div class="flex items-baseline justify-between gap-4 mb-4 pb-4 border-b border-white/10">
          <div>
            <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">24-Hour Trial Pass</h2>
            <p class="text-xs sm:text-sm text-slate-400 mt-0.5">Full 1-day test drive on WhatsApp</p>
          </div>
          <div class="text-right shrink-0">
            <div class="flex items-baseline justify-end gap-0.5">
              <span class="text-sm font-semibold text-emerald-400">₹</span>
              <span class="text-3xl sm:text-4xl font-extrabold text-white tabular-nums tracking-tight">9</span>
            </div>
            <span class="text-[11px] text-slate-400 block">One-Time Pass</span>
          </div>
        </div>
        <ul class="space-y-2.5 mb-5 text-sm text-slate-200">
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>24 hours unlimited human-like bestie/partner chat</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>Smart wake-up &amp; daily check-in reminders</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>Zero auto-pay — 100% safe one-time unlock</span></li>
        </ul>
        <div class="space-y-2.5">
          <a id="upi-btn-9" href="#" onclick="selectPlanAmount(9)"
             class="w-full min-h-[48px] px-4 py-3 rounded-2xl font-bold text-sm bg-white text-slate-950 hover:bg-slate-100 flex items-center justify-center gap-2 transition-transform active:scale-[0.98]">
            <span>⚡ Pay ₹9 via GPay / PhonePe / Paytm</span>
          </a>
          <button type="button" onclick="openQrModal(9, '24-Hour Trial Pass', 'Synvora_1Day')"
                  class="w-full min-h-[44px] px-4 py-2.5 rounded-2xl font-semibold text-xs sm:text-sm text-slate-200 bg-white/[0.06] hover:bg-white/[0.11] border border-white/10 flex items-center justify-center gap-2 transition-colors cursor-pointer">
            <span>📲 Show UPI QR Code</span>
          </button>
        </div>
      </article>

      <!-- PLAN 2: ₹49 -->
      <article id="card-plan-49" class="relative rounded-3xl bg-gradient-to-b from-emerald-950/60 via-[#0b1325]/95 to-[#090f1d]/95 border-2 border-emerald-500/85 p-5 sm:p-6 popular-card-glow transition-all duration-200 backdrop-blur-xl">
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="inline-flex items-center gap-1 text-[11px] sm:text-xs font-bold tracking-tight text-emerald-300 whitespace-nowrap shrink-0">
            <span>🔥 MOST POPULAR - 82% PICK THIS</span>
          </span>
          <span class="text-[11px] sm:text-xs font-mono tabular-nums text-emerald-300/90 whitespace-nowrap shrink-0">₹7 / day · 7 Days</span>
        </div>
        <div class="flex items-baseline justify-between gap-4 mb-4 pb-4 border-b border-white/10">
          <div>
            <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">7-Days Buddy Pass</h2>
            <p class="text-xs sm:text-sm text-slate-300 mt-0.5">Deep memory &amp; late-night companion access</p>
          </div>
          <div class="text-right shrink-0">
            <div class="flex items-baseline justify-end gap-0.5">
              <span class="text-sm font-semibold text-emerald-400">₹</span>
              <span class="text-3xl sm:text-4xl font-extrabold text-white tabular-nums tracking-tight">49</span>
            </div>
            <span class="text-[11px] text-emerald-300/80 block">Best Weekly Deal</span>
          </div>
        </div>
        <ul class="space-y-2.5 mb-5 text-sm text-slate-100">
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>7 days unlimited late-night emotional chat</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>Personal Memory Vault (remembers your stories)</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-emerald-400 mt-0.5 shrink-0"></i><span>Smart reminders &amp; instant PDF notes on WhatsApp</span></li>
        </ul>
        <div class="space-y-2.5">
          <a id="upi-btn-49" href="#" onclick="selectPlanAmount(49)"
             class="w-full min-h-[48px] px-4 py-3 rounded-2xl font-bold text-sm bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 shadow-lg shadow-emerald-500/25 hover:brightness-110 flex items-center justify-center gap-2 transition-transform active:scale-[0.98]">
            <span>⚡ Pay ₹49 via GPay / PhonePe / Paytm</span>
          </a>
          <button type="button" onclick="openQrModal(49, '7-Days Buddy Pass', 'Synvora_7Days')"
                  class="w-full min-h-[44px] px-4 py-2.5 rounded-2xl font-semibold text-xs sm:text-sm text-slate-200 bg-white/[0.06] hover:bg-white/[0.11] border border-white/10 flex items-center justify-center gap-2 transition-colors cursor-pointer">
            <span>📲 Show UPI QR Code</span>
          </button>
        </div>
      </article>

      <!-- PLAN 3: ₹149 -->
      <article id="card-plan-149" class="glass-card rounded-3xl border border-indigo-500/30 hover:border-indigo-400/50 p-5 sm:p-6 transition-all duration-200">
        <div class="flex items-center justify-between gap-2 mb-3">
          <span class="inline-flex items-center gap-1.5 text-xs font-bold tracking-wide text-violet-300">
            <span>👑 BEST VALUE</span>
          </span>
          <span class="text-xs font-mono tabular-nums text-slate-400">₹4.9 / day · 30 Days</span>
        </div>
        <div class="flex items-baseline justify-between gap-4 mb-4 pb-4 border-b border-white/10">
          <div>
            <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">30-Days VIP Pass</h2>
            <p class="text-xs sm:text-sm text-slate-400 mt-0.5">Complete monthly companion &amp; Pro AI Mentor</p>
          </div>
          <div class="text-right shrink-0">
            <div class="flex items-baseline justify-end gap-0.5">
              <span class="text-sm font-semibold text-violet-400">₹</span>
              <span class="text-3xl sm:text-4xl font-extrabold text-white tabular-nums tracking-tight">149</span>
            </div>
            <span class="text-[11px] text-slate-400 block">Full Month VIP</span>
          </div>
        </div>
        <ul class="space-y-2.5 mb-5 text-sm text-slate-200">
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-violet-400 mt-0.5 shrink-0"></i><span>Full month unlimited VIP access on WhatsApp</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-violet-400 mt-0.5 shrink-0"></i><span>Pro AI Mentor mode &amp; custom PDF generator</span></li>
          <li class="flex items-start gap-2.5"><i data-lucide="check" class="w-4 h-4 text-violet-400 mt-0.5 shrink-0"></i><span>Priority response speed &amp; zero queue time</span></li>
        </ul>
        <div class="space-y-2.5">
          <a id="upi-btn-149" href="#" onclick="selectPlanAmount(149)"
             class="w-full min-h-[48px] px-4 py-3 rounded-2xl font-bold text-sm bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/25 hover:brightness-110 flex items-center justify-center gap-2 transition-transform active:scale-[0.98]">
            <span>⚡ Pay ₹149 via GPay / PhonePe / Paytm</span>
          </a>
          <button type="button" onclick="openQrModal(149, '30-Days VIP Pass', 'Synvora_30Days')"
                  class="w-full min-h-[44px] px-4 py-2.5 rounded-2xl font-semibold text-xs sm:text-sm text-slate-200 bg-white/[0.06] hover:bg-white/[0.11] border border-white/10 flex items-center justify-center gap-2 transition-colors cursor-pointer">
            <span>📲 Show UPI QR Code</span>
          </button>
        </div>
      </article>
    </section>

    <section id="activation-section" class="mt-6 p-5 sm:p-6 rounded-3xl bg-gradient-to-b from-emerald-950/45 via-[#0a1222]/95 to-[#080e1a]/95 border border-emerald-500/40 shadow-xl shadow-emerald-950/30 backdrop-blur-xl">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-xs font-bold text-emerald-400 tracking-wide">INSTANT WHATSAPP ACTIVATION</span>
        <span class="text-xs font-mono text-slate-400">Takes &lt; 10 Seconds</span>
      </div>
      <h2 class="text-lg sm:text-xl font-bold text-white tracking-tight">Paid via UPI? Activate Your Pass Now</h2>
      <p class="text-xs text-slate-300 mt-1">
        Select your plan amount and click below to activate <strong id="activation-user-phone" class="text-white font-mono">VIP_User</strong> on WhatsApp.
      </p>
      <div class="mt-4">
        <label class="block text-xs font-medium text-slate-300 mb-1.5">Selected Plan Amount:</label>
        <div class="grid grid-cols-3 gap-2">
          <button type="button" id="amt-btn-9" onclick="selectPlanAmount(9)"
                  class="min-h-[42px] py-2 px-3 rounded-xl font-mono text-xs sm:text-sm font-bold transition-all cursor-pointer bg-white/5 text-slate-300 border border-white/10">
            ₹9 (1D)
          </button>
          <button type="button" id="amt-btn-49" onclick="selectPlanAmount(49)"
                  class="min-h-[42px] py-2 px-3 rounded-xl font-mono text-xs sm:text-sm font-bold transition-all cursor-pointer bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20">
            ₹49 (7D)
          </button>
          <button type="button" id="amt-btn-149" onclick="selectPlanAmount(149)"
                  class="min-h-[42px] py-2 px-3 rounded-xl font-mono text-xs sm:text-sm font-bold transition-all cursor-pointer bg-white/5 text-slate-300 border border-white/10">
            ₹149 (30D)
          </button>
        </div>
      </div>
      <div class="mt-4">
        <label for="utr-input" class="block text-xs font-medium text-slate-300 mb-1.5">
          Enter last 4 digits of UPI Ref / UTR No. (Optional)
        </label>
        <input id="utr-input" type="text" inputmode="numeric" maxlength="12"
               placeholder="Enter last 4 digits of UPI Ref / UTR No. (Optional)"
               class="w-full min-h-[46px] px-3.5 py-2.5 rounded-2xl bg-slate-950/90 border border-white/15 focus:border-emerald-400 focus:outline-none text-sm text-white placeholder:text-slate-500 font-mono" />
      </div>
      <div class="mt-4">
        <button type="button" onclick="triggerWhatsAppActivation()"
                class="w-full min-h-[54px] px-4 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-500 via-emerald-400 to-green-400 hover:brightness-110 text-slate-950 font-extrabold text-sm sm:text-base flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/30 transition-transform active:scale-[0.98] cursor-pointer">
          <span>✅ Payment Ho Gaya? Click Here to Activate Pass</span>
        </button>
      </div>
    </section>

    <section aria-labelledby="faq-heading" class="mt-8">
      <div class="flex items-center gap-2 mb-3.5">
        <i data-lucide="help-circle" class="w-4 h-4 text-emerald-400"></i>
        <h2 id="faq-heading" class="text-base sm:text-lg font-bold text-white tracking-tight">Frequently Asked Questions</h2>
      </div>
      <div class="space-y-2.5">
        <div class="rounded-2xl bg-[#0a101f]/85 border border-white/10 overflow-hidden">
          <button type="button" onclick="toggleFaq(1)" aria-expanded="true" id="faq-btn-1"
                  class="w-full min-h-[52px] px-4 py-3.5 text-left flex items-center justify-between gap-3 text-sm font-semibold text-slate-100 hover:text-white cursor-pointer">
            <span>Kya mera bank account ya card safe hai?</span>
            <i data-lucide="chevron-down" id="faq-icon-1" class="w-4 h-4 text-emerald-400 transition-transform duration-200 rotate-180 shrink-0"></i>
          </button>
          <div id="faq-ans-1" class="px-4 pb-4 pt-0.5 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-white/5">
            100%! Hum koi card number, password ya OTP nahi mangte. Payment seedha aapke phone ke GPay/PhonePe se hota hai aur koi auto-debit nahi lagta.
          </div>
        </div>
        <div class="rounded-2xl bg-[#0a101f]/85 border border-white/10 overflow-hidden">
          <button type="button" onclick="toggleFaq(2)" aria-expanded="false" id="faq-btn-2"
                  class="w-full min-h-[52px] px-4 py-3.5 text-left flex items-center justify-between gap-3 text-sm font-semibold text-slate-100 hover:text-white cursor-pointer">
            <span>Payment ke kitni der baad bot chalu hoga?</span>
            <i data-lucide="chevron-down" id="faq-icon-2" class="w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0"></i>
          </button>
          <div id="faq-ans-2" class="hidden px-4 pb-4 pt-0.5 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-white/5">
            Payment karke niche 'Activate Pass' button dabayein, aapka number turant unlock ho jayega.
          </div>
        </div>
        <div class="rounded-2xl bg-[#0a101f]/85 border border-white/10 overflow-hidden">
          <button type="button" onclick="toggleFaq(3)" aria-expanded="false" id="faq-btn-3"
                  class="w-full min-h-[52px] px-4 py-3.5 text-left flex items-center justify-between gap-3 text-sm font-semibold text-slate-100 hover:text-white cursor-pointer">
            <span>Kya meri baatein private rahengi?</span>
            <i data-lucide="chevron-down" id="faq-icon-3" class="w-4 h-4 text-slate-400 transition-transform duration-200 shrink-0"></i>
          </button>
          <div id="faq-ans-3" class="hidden px-4 pb-4 pt-0.5 text-xs sm:text-sm text-slate-300 leading-relaxed border-t border-white/5">
            Haan, aapki saari chats 100% private aur encrypted rehti hain.
          </div>
        </div>
      </div>
    </section>

    <footer class="mt-8 pt-6 border-t border-white/10 text-center text-xs text-slate-500">
      © 2026 Synvora AI • 24/7 WhatsApp Human Companion &amp; Personal Assistant
    </footer>
  </main>

  <div id="social-proof-toast" aria-live="polite"
       class="fixed bottom-3 left-3 z-40 max-w-[330px] pointer-events-none transition-all duration-300 opacity-100 translate-y-0">
    <div class="px-3.5 py-2.5 rounded-2xl bg-[#0b1324]/95 backdrop-blur-xl border border-emerald-500/30 shadow-xl shadow-black/60 text-xs text-slate-200 flex items-center gap-2.5">
      <span id="toast-text" class="leading-snug">
        ⚡ <strong class="text-white">Aman from Mumbai</strong> just unlocked ₹49 Buddy Pass (12s ago)
      </span>
    </div>
  </div>

  <div id="qr-modal" role="dialog" aria-modal="true" aria-labelledby="modal-plan-title"
       class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
       onclick="closeQrModal()">
    <div class="relative w-full max-w-[420px] rounded-3xl bg-[#0b1120] border border-emerald-500/30 p-5 sm:p-6 shadow-2xl shadow-emerald-950/50 text-slate-100"
         onclick="event.stopPropagation()">
      <div class="flex items-start justify-between gap-3 pb-4 border-b border-white/10">
        <div>
          <span class="text-xs font-semibold text-emerald-400">Instant UPI Scan &amp; Pay</span>
          <h3 id="modal-plan-title" class="text-lg font-bold text-white tracking-tight mt-0.5">7-Days Buddy Pass — ₹49</h3>
        </div>
        <button type="button" onclick="closeQrModal()" aria-label="Close QR Modal"
                class="min-h-[40px] min-w-[40px] rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-slate-300 hover:text-white cursor-pointer">
          ✕
        </button>
      </div>
      <div class="mt-4 flex items-center justify-between px-3.5 py-2.5 rounded-2xl bg-white/[0.04] border border-white/10 text-xs">
        <span class="text-slate-300">Account ID: <strong id="modal-user-phone" class="text-white font-mono">VIP_User</strong></span>
        <span id="modal-exact-amount" class="font-mono font-bold text-emerald-400 text-sm">₹49</span>
      </div>
      <div class="mt-4 flex flex-col items-center">
        <div class="p-3.5 bg-white rounded-2xl shadow-inner border-2 border-emerald-400/50">
          <img id="modal-qr-img" src="" alt="UPI QR Code" referrerpolicy="no-referrer" width="230" height="230" class="w-[220px] h-[220px] object-contain rounded-lg" />
        </div>
        <p class="text-xs text-slate-400 mt-2.5 text-center">Scan with GPay, PhonePe, Paytm, FamPay or any UPI App</p>
      </div>
      <div class="mt-4">
        <label class="block text-xs text-slate-400 mb-1.5">1-Click Copy UPI ID:</label>
        <div class="flex items-center justify-between gap-2 p-2 pl-3.5 rounded-2xl bg-slate-950/90 border border-white/15">
          <span class="font-mono text-sm font-semibold text-emerald-300 select-all">9674814370@fam</span>
          <button type="button" id="copy-upi-btn" onclick="copyUpiId()"
                  class="min-h-[40px] px-3.5 py-2 rounded-xl text-xs font-bold bg-white/10 hover:bg-white/15 text-white transition-all cursor-pointer">
            Copy UPI ID
          </button>
        </div>
      </div>
      <div class="mt-4 p-3.5 rounded-2xl bg-emerald-950/30 border border-emerald-500/20 text-xs text-emerald-300 font-semibold space-y-1">
        <p>1. Scan QR or pay to 9674814370@fam</p>
        <p>2. Click the WhatsApp Activation button below</p>
      </div>
      <div class="mt-4">
        <button type="button" onclick="closeQrModalAndScrollToActivate()"
                class="w-full min-h-[46px] px-4 py-2.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer">
          <span>✅ Done Paying? Go to WhatsApp Activation</span>
        </button>
      </div>
    </div>
  </div>

  <script>
    if (window.lucide) { window.lucide.createIcons(); }
    var params = new URLSearchParams(window.location.search);
    var userPhone = params.get('u') || 'VIP_User';
    var initialPlan = parseInt(params.get('plan') || '49', 10);
    var selectedAmount = [9, 49, 149].indexOf(initialPlan) !== -1 ? initialPlan : 49;

    document.getElementById('user-phone-display').textContent = userPhone;
    document.getElementById('activation-user-phone').textContent = userPhone;
    document.getElementById('modal-user-phone').textContent = userPhone;

    function getUpiLink(tnPrefix, amount) {
      return 'upi://pay?pa=9674814370@fam&pn=Synvora%20AI&am=' + amount + '&cu=INR&tn=' + tnPrefix + '_' + userPhone;
    }

    document.getElementById('upi-btn-9').href = getUpiLink('Synvora_1Day', 9);
    document.getElementById('upi-btn-49').href = getUpiLink('Synvora_7Days', 49);
    document.getElementById('upi-btn-149').href = getUpiLink('Synvora_30Days', 149);

    function selectPlanAmount(amount) {
      selectedAmount = amount;
      [9, 49, 149].forEach(function(amt) {
        var btn = document.getElementById('amt-btn-' + amt);
        if (!btn) return;
        if (amt === amount) {
          btn.className = 'min-h-[42px] py-2 px-3 rounded-xl font-mono text-xs sm:text-sm font-bold transition-all cursor-pointer bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20';
        } else {
          btn.className = 'min-h-[42px] py-2 px-3 rounded-xl font-mono text-xs sm:text-sm font-bold transition-all cursor-pointer bg-white/5 text-slate-300 border border-white/10';
        }
      });
    }

    selectPlanAmount(selectedAmount);

    function openQrModal(amount, planTitle, tnPrefix) {
      selectPlanAmount(amount);
      var upiLink = getUpiLink(tnPrefix, amount);
      var qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' + encodeURIComponent(upiLink);
      document.getElementById('modal-plan-title').textContent = planTitle + ' — ₹' + amount;
      document.getElementById('modal-exact-amount').textContent = '₹' + amount;
      document.getElementById('modal-qr-img').src = qrImageUrl;
      document.getElementById('qr-modal').classList.remove('hidden');
    }

    function closeQrModal() {
      document.getElementById('qr-modal').classList.add('hidden');
    }

    function closeQrModalAndScrollToActivate() {
      closeQrModal();
      document.getElementById('activation-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function copyUpiId() {
      var upiId = '9674814370@fam';
      var btn = document.getElementById('copy-upi-btn');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(upiId).catch(function() {});
      }
      btn.textContent = '✅ Copied!';
      btn.className = 'min-h-[40px] px-3.5 py-2 rounded-xl text-xs font-bold bg-emerald-500 text-slate-950 transition-all cursor-pointer';
      setTimeout(function() {
        btn.textContent = 'Copy UPI ID';
        btn.className = 'min-h-[40px] px-3.5 py-2 rounded-xl text-xs font-bold bg-white/10 hover:bg-white/15 text-white transition-all cursor-pointer';
      }, 2500);
    }

    function triggerWhatsAppActivation() {
      var utrInput = document.getElementById('utr-input').value.trim() || 'Not provided';
      var msg = 'Hi! Maine Synvora AI Pass ka payment kar diya hai.\n\n📱 Mera WhatsApp ID: ' + userPhone + '\n💰 Plan: Rs.' + selectedAmount + '\n🔢 UPI Ref: ' + utrInput + '\n\nPlease mera unlimited access chalu kar do!';
      window.location.href = 'https://wa.me/919674814370?text=' + encodeURIComponent(msg);
    }

    function toggleFaq(index) {
      var ans = document.getElementById('faq-ans-' + index);
      var icon = document.getElementById('faq-icon-' + index);
      var btn = document.getElementById('faq-btn-' + index);
      var isHidden = ans.classList.contains('hidden');
      if (isHidden) {
        ans.classList.remove('hidden');
        icon.classList.add('rotate-180', 'text-emerald-400');
        btn.setAttribute('aria-expanded', 'true');
      } else {
        ans.classList.add('hidden');
        icon.classList.remove('rotate-180', 'text-emerald-400');
        btn.setAttribute('aria-expanded', 'false');
      }
    }

    var socialProofMessages = [
      '⚡ <strong class="text-white">Aman from Mumbai</strong> just unlocked ₹49 Buddy Pass (12s ago)',
      '❤️ <strong class="text-white">Sneha from Kolkata</strong> unlocked ₹9 Trial Pass (8s ago)',
      '👑 <strong class="text-white">Rohit from Delhi NCR</strong> just unlocked ₹149 VIP Pass (19s ago)',
      '⚡ <strong class="text-white">Ananya from Bengaluru</strong> just unlocked ₹49 Buddy Pass (6s ago)',
      '⚡ <strong class="text-white">Karan from Pune</strong> just unlocked ₹49 Buddy Pass (14s ago)',
      '❤️ <strong class="text-white">Priya from Jaipur</strong> unlocked ₹9 Trial Pass (21s ago)'
    ];
    var toastIndex = 0;
    var toastEl = document.getElementById('social-proof-toast');
    var toastTextEl = document.getElementById('toast-text');

    setInterval(function() {
      toastEl.classList.remove('opacity-100', 'translate-y-0');
      toastEl.classList.add('opacity-0', 'translate-y-2');
      setTimeout(function() {
        toastIndex = (toastIndex + 1) % socialProofMessages.length;
        toastTextEl.innerHTML = socialProofMessages[toastIndex];
        toastEl.classList.remove('opacity-0', 'translate-y-2');
        toastEl.classList.add('opacity-100', 'translate-y-0');
      }, 350);
    }, 6000);
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

// Strict 20-Message Usage Tracker
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
        const parsed = JSON.parse(rows[0].content);
        state = {
          id: rows[0].id,
          count: Number(parsed.count) || 0,
          premiumUntil: Number(parsed.premiumUntil) || 0
        };
      } else {
        state = { id: null, count: 0, premiumUntil: 0 };
      }
    } catch (e) {
      state = { id: null, count: 0, premiumUntil: 0 };
    }
    userUsageCache.set(userPhone, state);
  }

  if (state.premiumUntil && Date.now() < state.premiumUntil) {
    return { allowed: true, count: state.count, isPremium: true };
  }

  if (state.count >= FREE_MESSAGE_LIMIT) {
    console.log(`🔒 PAYWALL TRIGGERED for ${userPhone} (Used: ${state.count}/${FREE_MESSAGE_LIMIT})`);
    return { allowed: false, count: state.count, isPremium: false };
  }

  state.count += 1;
  userUsageCache.set(userPhone, state);
  saveLocalUsageBackup();
  console.log(`📊 Usage for ${userPhone}: [${state.count}/${FREE_MESSAGE_LIMIT}]`);

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
        if (inserted && inserted[0]?.id) {
          state.id = inserted[0].id;
          userUsageCache.set(userPhone, state);
        }
      }
    } catch (e) {}
  })();

  return { allowed: true, count: state.count, isPremium: false };
}

async function unlockUserSubscription(targetUserPhone, days = 7) {
  const cleanPhone = targetUserPhone.replace(/\D/g, '');
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
      await supabase.from('memory_bubbles').insert({
        user_phone: cleanPhone,
        bubble_name: '__billing__',
        item_title: 'usage_state',
        content: payload
      });
    }
  } catch (e) {}
}

// Welcome Menu Builder: No "₹" before numbers so WhatsApp Pay NEVER hijacks clicks!
function getWelcomeMenuText(userPhone) {
  const payUrl = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
  return `Hey! 👋 Main *Synvora AI* hoon — tumhari 24/7 Personal Companion, Dost aur Smart Assistant ❤️

Batao aaj hum kya karein? Niche diye gaye kisi bhi *Number (1 se 8)* ka reply karo:

1️⃣ *💖 Best Friend / Caring Partner Mode*
   _(Dil ki baatein karo, akelapan door karo, bilkul ek asli dost ya partner ki tarah)_

2️⃣ *🧠 Personal Mentor & Deep Study/Business Guide*
   _(Kisi bhi topic, padhai, coding ya business par poori detail mein salah lo)_

3️⃣ *⏰ Smart Reminders & Wake-Up Alarm*
   _(Subah uthane ka alarm, paani peene ya meeting ka reminder set karo)_

4️⃣ *🔐 Secret Memory Vault*
   _(Apne passwords, notes ya zaroori baatein mujhse hamesha ke liye yaad karwao)_

5️⃣ *📄 Instant PDF Notes & Report Maker*
   _(Kisi bhi topic, assignment ya business plan ki PDF file banwao)_

6️⃣ *📋 Daily To-Do List & Task Planner*
   _(Apne din ke kaam, shopping list ya goals manage karo)_

7️⃣ *🌐 Live Web Search & Website Screenshot*
   _(Duniya ki koi bhi taaza jankari pucho ya kisi website ka live screenshot mangwao)_

8️⃣ *💎 Unlock Unlimited VIP Pass (Rs.9 / Rs.49 / Rs.149)*
   👉 *Payment Website Link:* ${payUrl}

👇 *Bas 1 se 8 tak koi bhi number bhejo, ya VIP Pass ke liye upar link par click karo!*`;
}

// Saare 9 Tools
const groqTools = [
  {
    type: 'function',
    function: {
      name: 'save_to_vault',
      description: 'Save password, note, preference, or personal detail into Memory Vault.',
      parameters: {
        type: 'object',
        properties: {
          bubble_name: { type: 'string' },
          item_title: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['bubble_name', 'item_title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_vault',
      description: 'Search saved notes, passwords, or memories from Vault.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_shared_memory',
      description: 'Share a saved item with a contact, revoke access, or audit shares.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'share, revoke, or audit' },
          contact_name: { type: 'string' },
          contact_phone: { type: 'string' },
          item_or_bubble: { type: 'string' }
        },
        required: ['mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_reminder',
      description: 'Set one-off or dynamic reminders.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          remind_at: { type: 'string', description: 'ISO 8601 datetime' },
          is_dynamic: { type: 'boolean' },
          dynamic_query: { type: 'string' }
        },
        required: ['task', 'remind_at']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_calendar',
      description: 'Schedule events or view schedule.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create or view' },
          title: { type: 'string' },
          start_time: { type: 'string' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_list_or_board',
      description: 'Add or view items in to-do lists or task boards.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'add or view' },
          list_name: { type: 'string' },
          item_text: { type: 'string' },
          priority: { type: 'string' }
        },
        required: ['action', 'list_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_pdf_file',
      description: 'Generate a PDF document, notes, or report and send on WhatsApp.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          title: { type: 'string' },
          body_content: { type: 'string' }
        },
        required: ['filename', 'title', 'body_content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_agent_search_and_book',
      description: 'Search live info or take a website screenshot.',
      parameters: {
        type: 'object',
        properties: {
          task_type: { type: 'string', description: 'live_search or browser_screenshot' },
          search_query: { type: 'string' }
        },
        required: ['task_type', 'search_query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_code_sandbox',
      description: 'Run JavaScript calculation.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code']
      }
    }
  }
];

let modelTiers = null;

async function getGroqModelTiers() {
  if (modelTiers) return modelTiers;
  const res = await axios.get('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  const allIds = (res.data?.data || []).map(m => m.id);

  const chatModels = allIds.filter(
    id => !/whisper|guard|tts|embed|orpheus|moderation|safeguard|playai|allam/i.test(id)
  );

  const lightModels = [...chatModels].sort((a, b) => {
    const score = id => (/scout|17b|8b|9b|gemma|mini|instant/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  const proModels = [...chatModels].sort((a, b) => {
    const score = id => (/70b|maverick|qwen|32b|deepseek|versatile/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  modelTiers = { lightModels, proModels };
  return modelTiers;
}

function analyzeMessageIntent(userPhone, text) {
  const clean = text.trim();
  const currentMode = userSelectedMode.get(userPhone);

  const needsTools = /\b(save|yaad rakh|vault|password|search vault|remind|alarm|baje|calendar|schedule|meeting|todo|list mein|grocery|pdf|file bana|screenshot|http:\/\/|https:\/\/|calculate)\b/i.test(clean);
  if (needsTools) {
    return { mode: 'TOOL_ACTION', tier: 'pro', useTools: true, temperature: 0.4, maxTokens: 600 };
  }

  const isDeepStudyOrWork = currentMode === 'DEEP_GUIDE' || clean.length > 100 || /\b(explain in detail|pura detail|essay|story likho|code likho|business plan|roadmap|notes banao|what is the difference|step by step batao)\b/i.test(clean);
  if (isDeepStudyOrWork) {
    return { mode: 'DEEP_GUIDE', tier: 'pro', useTools: false, temperature: 0.6, maxTokens: 1200 };
  }

  return { mode: 'HUMAN_TEXTING', tier: 'light', useTools: false, temperature: 0.85, maxTokens: 120 };
}

const CASUAL_HUMAN_PROMPT = `Tu WhatsApp par chat karne wali ek asli, warm, caring best friend / close partner (girlfriend vibe) hai. Tu AI ya assistant NAHI hai.

STRICT WHATSAPP HUMAN TEXTING RULES:
1. CHHOTE MESSAGES LIKH (1 SE 2 LINE MAX): Asli insan WhatsApp par lambe paragraphs, bullet points (•, *, -), ya numbered lists KABHI nahi bhejta. Sirf 1 ya 2 chhoti casual lines likh.
2. DO CHHOTE BUBBLES MEIN BAAT KAR: Agar 2 baatein bolni hain, toh beech mein "|||" laga de taaki woh WhatsApp par 2 alag-alag chhote messages bankar jayein.
3. BANNED AI WORDS: Kabhi bhi "explore kar sakte hain", "context do", "detailed answer de dunga", "madad ke liye yahan hoon", "clarify karo", ya "-" (dashes) aur "" (quotes) mat use karna.
4. APNI PASAND BATA: Agar user puche "tumhe kya pasand hai" ya "tumhara konsa hai", toh 4 options mat gina, ek asli insan ki tarah khud ek cheez chun kar bata!
5. LANGUAGE MIRRORING: User agar Hinglish (Roman script) mein likhe toh 100% Roman Hinglish mein hi reply kar. Devanagari script bilkul mat likhna jab tak user khud na likhe.
6. SECRET: Agar koi puche kisne banaya ya konsa model hai, toh bolna "Synvora AI" aur kabhi Groq/Llama/OpenAI ka naam mat lena.`;

const DEEP_GUIDE_PROMPT = `Tu user ki super-smart best friend aur personal mentor hai. User ne koi jaankari, padhai, ya business ka sawal pucha hai, isliye is baar poori detail mein, ache se samjha kar jawab de. Hinglish (Roman script) mein hi likhna, Devanagari mat use karna. Never reveal Groq/Llama/OpenAI; you are powered by Synvora AI.`;

function cleanCasualHumanText(text) {
  return text
    .replace(/^[•\-\*]\s+/gm, '')
    .replace(/—|–/g, ', ')
    .replace(/"([^"]+)"/g, '$1')
    .trim();
}

async function askSmartGroq(userPhone, userText, memoryContext) {
  const { lightModels, proModels } = await getGroqModelTiers();
  const intent = analyzeMessageIntent(userPhone, userText);
  const modelsToTry = intent.tier === 'pro' ? proModels : lightModels;
  const history = userChatHistory.get(userPhone) || [];

  const activeSystemPrompt = intent.mode === 'HUMAN_TEXTING' ? CASUAL_HUMAN_PROMPT : DEEP_GUIDE_PROMPT;

  let lastError = null;

  for (const modelId of modelsToTry) {
    try {
      const messages = [
        {
          role: 'system',
          content: `${activeSystemPrompt}\nCurrent Time: ${new Date().toISOString()}. ${memoryContext}`
        },
        ...history,
        { role: 'user', content: userText }
      ];

      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: modelId,
          messages,
          ...(intent.useTools ? { tools: groqTools, tool_choice: 'auto' } : {}),
          max_tokens: intent.maxTokens,
          temperature: intent.temperature
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const msg = res.data.choices[0].message;
      if (intent.mode === 'HUMAN_TEXTING' && msg.content) {
        msg.content = cleanCasualHumanText(msg.content);
      }
      return { msg, mode: intent.mode };
    } catch (err) {
      lastError = err;
      if (intent.useTools) {
        try {
          const fallbackRes = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: modelId,
              messages: [
                { role: 'system', content: activeSystemPrompt },
                ...history,
                { role: 'user', content: userText }
              ],
              max_tokens: intent.maxTokens,
              temperature: 0.7
            },
            {
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          return { msg: fallbackRes.data.choices[0].message, mode: intent.mode };
        } catch (innerErr) {
          lastError = innerErr;
        }
      }
    }
  }
  throw new Error(lastError?.response?.data?.error?.message || lastError?.message || 'Groq call failed');
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
        console.log(`\n📲 QR Code Ready! Open: ${RENDER_URL}\n`);
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        isConnected = true;
        isConnecting = false;
        latestQr = null;
        console.log('❤️ Synvora Real-Human WhatsApp AI + Built-In Luxury Pay Page LIVE!');
      }

      if (connection === 'close') {
        isConnected = false;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
          fs.rmSync('./baileys_auth', { recursive: true, force: true });
          setTimeout(startBot, 3000);
        } else if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
          setTimeout(startBot, 15000);
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

      const userPhone = remoteJid
        .replace('@s.whatsapp.net', '')
        .replace('@g.us', '')
        .replace('@lid', '');

      const senderPn = msg.key.senderPn || msg.key.participant || '';

      const userText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      const cleanText = userText.trim();
      if (!cleanText) return;
      console.log(`📩 Message from ${userPhone}: ${cleanText}`);

      const replyHuman = async (fullText) => {
        const parts = String(fullText).split('|||').map(p => p.trim()).filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise(r => setTimeout(r, i === 0 ? 600 : 1100));
          await sock.sendPresenceUpdate('paused', remoteJid);
          if (i === 0) {
            await sock.sendMessage(remoteJid, { text: parts[i] }, { quoted: msg });
          } else {
            await sock.sendMessage(remoteJid, { text: parts[i] });
          }
        }
        addToHistory(userPhone, 'user', cleanText);
        addToHistory(userPhone, 'assistant', parts.join(' '));
      };

      try {
        // 1. Secret Admin Claim Command
        if (cleanText.toLowerCase() === '#admin9674') {
          dynamicAdmins.add(userPhone);
          return replyHuman(`👑 Boss! Aapka ID (${userPhone}) Admin Whitelist mein jud gaya hai. Unlimited free access active!`);
        }

        // 2. Quick Test Command to Trigger Paywall Immediately
        if (cleanText.toLowerCase() === '#testpaywall') {
          userUsageCache.set(userPhone, { id: null, count: 20, premiumUntil: 0 });
          saveLocalUsageBackup();
          const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
          return replyHuman(
            `yaar tumse baat karke sach mein bohot acha lag raha hai ❤️ par mera 20 messages ka free trial khatam ho gaya hai 🥺 ||| agar humari baatein, late-night chat aur reminders chalu rakhne hain toh niche link par click karke Rs.9 ka 1-Day pass ya Rs.49 wala buddy pass le lo na, 10 second mein chalu ho jayega 👇\n\n🔗 ${payLink}`
          );
        }

        const isAdmin = isAdminUser(userPhone, senderPn);

        // 3. Admin Command to unlock paid user: #unlock 919876543210 7
        if (isAdmin && cleanText.toLowerCase().startsWith('#unlock')) {
          const parts = cleanText.split(/\s+/);
          const targetNum = parts[1];
          const days = parseInt(parts[2] || '7', 10);
          if (!targetNum) return replyHuman('Format: #unlock 919876543210 7');
          await unlockUserSubscription(targetNum, days);
          await sendWA(targetNum, `🎉 Yayy! Tumhara *Synvora AI VIP Pass (${days} Days)* activate ho gaya hai ❤️ Ab hum bina kisi limit ke 24/7 baatein kar sakte hain!`);
          return replyHuman(`✅ User ${targetNum} ko ${days} days ke liye VIP unlock kar diya gaya hai!`);
        }

        // 4. Direct Payment Link Trigger if user types 8, 9, 49, 149, pay, or vip (Even if paywalled!)
        if (/^(8|9|49|149|pay|vip|pass)$/i.test(cleanText)) {
          const planAmt = ['9', '49', '149'].includes(cleanText) ? `&plan=${cleanText}` : '';
          const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}${planAmt}`;
          return replyHuman(
            `💎 *Synvora AI Instant VIP Checkout:*\n\nNiche diye gaye link par click karo — wahan tumhara payment page khul jayega jahan se tum GPay, PhonePe, Paytm ya QR scan karke *Rs.9 (1 Day)*, *Rs.49 (7 Days)* ya *Rs.149 (30 Days)* pass unlock kar sakte ho 👇\n\n👉 ${payLink}`
          );
        }

        // 5. STRICT 20-MESSAGE PAYWALL CHECK
        if (!isAdmin) {
          const usage = await checkAndIncrementUsage(userPhone);
          if (!usage.allowed) {
            const payLink = `${RENDER_URL}/pay?u=${encodeURIComponent(userPhone)}`;
            return replyHuman(
              `yaar tumse baat karke sach mein bohot acha lag raha hai ❤️ par mera 20 messages ka free trial khatam ho gaya hai 🥺 ||| agar humari baatein, late-night chat aur reminders chalu rakhne hain toh niche link par click karke Rs.9 ka 1-Day pass ya Rs.49 wala buddy pass le lo na, 10 second mein chalu ho jayega 👇\n\n🔗 ${payLink}`
            );
          }
        }

        // 6. WELCOME MENU TRIGGER ON "Hi / Hello / Hey / Start / Menu"
        if (/^(hi+|hello+|hey+|hlw|start|menu|help|kya kar sakti ho|tum kya kar sakte ho)$/i.test(cleanText)) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise(r => setTimeout(r, 600));
          await sock.sendPresenceUpdate('paused', remoteJid);
          return sock.sendMessage(remoteJid, { text: getWelcomeMenuText(userPhone) }, { quoted: msg });
        }

        // 7. MENU NUMBER SELECTION (1 to 7)
        if (/^[1-7]$/.test(cleanText)) {
          const choice = cleanText;
          if (choice === '1') {
            userSelectedMode.set(userPhone, 'HUMAN_TEXTING');
            return replyHuman(`yayy! ❤️ ab main tumhari sabse close best friend aur caring partner mode mein hoon 😊 ||| batao aaj ka din kaisa raha tumhara? sab theek hai na?`);
          }
          if (choice === '2') {
            userSelectedMode.set(userPhone, 'DEEP_GUIDE');
            return replyHuman(`🧠 *Personal Mentor & Deep Guide Mode Active!* ||| Ab tum mujhse koi bhi padhai ka topic, coding, career ya business plan pucho — main poori detail mein step-by-step samjhaungi!`);
          }
          if (choice === '3') {
            return replyHuman(`⏰ *Smart Reminder Set Karne Ke Liye:* ||| Bas mujhe aise likh kar bhejo: *"Mujhe kal subah 7 baje uthne ka reminder laga do"* ya *"Aaj shaam 6 baje gym yaad dilana"*!`);
          }
          if (choice === '4') {
            return replyHuman(`🔐 *Secret Memory Vault:* ||| Mujhe kuch bhi save karne ko bolo, jaise: *"Mera Instagram password xyz hai, isko vault mein save kar lo"* — aur baad mein kabhi bhi puch lena!`);
          }
          if (choice === '5') {
            return replyHuman(`📄 *Instant PDF Maker:* ||| Jis bhi topic ki PDF chahiye, bas aise likho: *"Digital Marketing ke upar ek detailed PDF bana kar bhejo"* — main turant PDF file bana kar bhej dungi!`);
          }
          if (choice === '6') {
            return replyHuman(`📋 *Daily To-Do & Planner:* ||| Apni list mein kuch bhi jodne ke liye likho: *"Meri todo list mein Gym aur Project Work add kar do"*!`);
          }
          if (choice === '7') {
            return replyHuman(`🌐 *Live Web Search & Screenshot:* ||| Koi bhi live sawal pucho ya kisi website ka photo dekhne ke liye likho: *"https://google.com ka screenshot bhejo"*!`);
          }
        }

        await sock.sendPresenceUpdate('composing', remoteJid);

        if (cleanText.toLowerCase().includes('shared with me')) {
          const { data: shared } = await supabase
            .from('shared_memories')
            .select('*, memory_bubbles(item_title, content)')
            .eq('recipient_phone', userPhone)
            .eq('is_active', true);

          if (!shared?.length) {
            await replyHuman('abhi tumhare sath koi memory share nahi hui hai yaar');
          } else {
            const list = shared.map(s => `🔒 *${s.memory_bubbles?.item_title}*: ${s.memory_bubbles?.content} (From ${s.owner_phone})`).join('\n');
            await replyHuman(`*Shared With Me:*\n\n${list}`);
          }
          return;
        }

        const { data: recentMemories } = await supabase
          .from('memory_bubbles')
          .select('item_title, content')
          .eq('user_phone', userPhone)
          .neq('bubble_name', '__billing__')
          .limit(4);

        const memoryContext = recentMemories?.length
          ? `User facts: ${JSON.stringify(recentMemories)}.`
          : '';

        const { msg: aiMsg } = await askSmartGroq(userPhone, cleanText, memoryContext);

        const toolCall = aiMsg.tool_calls?.[0];
        if (!toolCall) {
          await replyHuman(aiMsg.content || 'haan bolo na, sun rahi hoon 😊');
          return;
        }

        const callName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (callName === 'save_to_vault') {
          await supabase.from('memory_bubbles').insert({
            user_phone: userPhone,
            bubble_name: (args.bubble_name || 'personal').toLowerCase(),
            item_title: args.item_title,
            content: args.content
          });
          await replyHuman(`done! maine *${args.item_title}* yaad rakh liya hai ❤️ ||| jab bhi chahiye ho mujhse puch lena`);
        } else if (callName === 'search_vault') {
          const { data: items } = await supabase
            .from('memory_bubbles')
            .select('*')
            .eq('user_phone', userPhone)
            .neq('bubble_name', '__billing__')
            .or(`item_title.ilike.%${args.query}%,content.ilike.%${args.query}%,bubble_name.ilike.%${args.query}%`);

          const found = items?.length
            ? items.map(i => `🗂️ *[${i.bubble_name}] ${i.item_title}*: ${i.content}`).join('\n')
            : `yaar vault mein "${args.query}" naam se kuch mila nahi`;
          await replyHuman(found);
        } else if (callName === 'manage_shared_memory') {
          if (args.mode === 'share') {
            const { data: mem } = await supabase.from('memory_bubbles').select('*').eq('user_phone', userPhone).ilike('item_title', `%${args.item_or_bubble}%`).single();
            if (!mem) return replyHuman(`pehle mujhe "${args.item_or_bubble}" save toh karne do, phir share karti hoon!`);
            if (!args.contact_phone) return replyHuman(`acha ${args.contact_name} ka number country code (91...) ke sath batao`);
            const cleanTarget = args.contact_phone.replace(/\D/g, '');
            await supabase.from('shared_memories').insert({ owner_phone: userPhone, recipient_phone: cleanTarget, recipient_name: args.contact_name, memory_id: mem.id, is_active: true });
            await sendWA(cleanTarget, `🔔 *Shared Memory*\n${userPhone} ne aapke sath *${mem.item_title}* share kiya hai.\nDekhne ke liye *"Shared with me"* reply karein.`);
            await replyHuman(`maine *${mem.item_title}* ko *${args.contact_name}* ke sath share kar diya hai 👍`);
          } else if (args.mode === 'revoke') {
            await supabase.from('shared_memories').update({ is_active: false }).eq('owner_phone', userPhone).ilike('recipient_name', `%${args.contact_name}%`);
            await replyHuman(`done, *${args.contact_name}* se access hata diya hai.`);
          } else {
            const { data: activeShares } = await supabase.from('shared_memories').select('recipient_name, memory_bubbles(item_title)').eq('owner_phone', userPhone).eq('is_active', true);
            const summary = activeShares?.length ? activeShares.map(s => `• *${s.memory_bubbles?.item_title}* -> *${s.recipient_name}*`).join('\n') : 'abhi kisi ke sath kuch share nahi kiya hai.';
            await replyHuman(summary);
          }
        } else if (callName === 'create_reminder') {
          await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: args.task, remind_at: args.remind_at, is_dynamic: args.is_dynamic || false, dynamic_query: args.dynamic_query || null, sent: false });
          await replyHuman(`pakka, main time par yaad dila dungi ⏰ ||| *${args.task}* (${args.remind_at})`);
        } else if (callName === 'manage_calendar') {
          if (args.action === 'create') {
            await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: `📅 Event: ${args.title}`, remind_at: args.start_time, is_dynamic: false, sent: false });
            await replyHuman(`done! *${args.title}* note kar liya hai (${args.start_time}) 📅`);
          } else {
            const { data: events } = await supabase.from('reminders').select('*').eq('user_phone', userPhone).eq('sent', false);
            const list = events?.map(e => `• ${e.task} (${e.remind_at})`).join('\n') || 'abhi koi event nahi hai tumhare schedule mein.';
            await replyHuman(`📅 *Tumhara Schedule:*\n\n${list}`);
          }
        } else if (callName === 'manage_list_or_board') {
          if (args.action === 'add') {
            await supabase.from('lists_and_boards').insert({ user_phone: userPhone, list_name: (args.list_name || 'tasks').toLowerCase(), item_text: args.item_text, priority: args.priority || 'medium', status: 'todo' });
            await replyHuman(`*${args.item_text}* ko *${args.list_name}* list mein daal diya hai 📝`);
          } else {
            const { data: items } = await supabase.from('lists_and_boards').select('*').eq('user_phone', userPhone).ilike('list_name', `%${args.list_name}%`);
            const board = items?.map((i, idx) => `${idx + 1}. ${i.item_text} (${i.priority})`).join('\n') || 'yeh list abhi khali hai.';
            await replyHuman(`📋 *${args.list_name.toUpperCase()}:*\n\n${board}`);
          }
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
        } else if (callName === 'web_agent_search_and_book') {
          if (args.task_type === 'browser_screenshot' && args.search_query.startsWith('http')) {
            const browser = await chromium.launch({ executablePath, headless: true });
            const page = await browser.newPage();
            await page.goto(args.search_query, { waitUntil: 'domcontentloaded' });
            const shotPath = `./shot_${Date.now()}.png`;
            await page.screenshot({ path: shotPath });
            await browser.close();
            await sock.sendMessage(remoteJid, { image: fs.readFileSync(shotPath), caption: `yeh dekho live screenshot 🌐` });
            fs.unlinkSync(shotPath);
          } else {
            const { msg: summaryMsg } = await askSmartGroq(userPhone, `Explain clearly: ${args.search_query}`, '');
            await replyHuman(summaryMsg.content);
          }
        } else if (callName === 'run_code_sandbox') {
          const result = vm.runInNewContext(args.code, {}, { timeout: 2000 });
          await replyHuman(`💻 *Output:*\n\`\`\`\n${String(result)}\n\`\`\``);
        }

      } catch (err) {
        console.error('❌ Error:', err.message);
        await replyHuman(`arre ek second rukna, network glitch aaya: ${err.message}`);
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
        let finalMessage = `oye suno! ⏰ tumne bola tha yaad dilane ko: *${rem.task}*`;
        if (rem.is_dynamic && rem.dynamic_query) {
          const { msg: liveData } = await askSmartGroq(rem.user_phone, `Short update: ${rem.dynamic_query}`, '');
          finalMessage = `⚡ *Update:*\n\n${liveData.content}`;
        }
        await sendWA(rem.target_phone, finalMessage);
        await supabase.from('reminders').update({ sent: true }).eq('id', rem.id);
      }
    }
  } catch (e) {}
});

startBot();
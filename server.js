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

let sock;
let latestQr = null;
let isConnected = false;
let isConnecting = false;

// Har user ki pichli 10 baatein yaad rakhne ke liye Short-Term Memory
const userChatHistory = new Map();

function addToHistory(userPhone, role, content) {
  if (!content) return;
  if (!userChatHistory.has(userPhone)) userChatHistory.set(userPhone, []);
  const history = userChatHistory.get(userPhone);
  history.push({ role, content: String(content).slice(0, 500) });
  if (history.length > 10) history.shift();
}

// Web Dashboard & QR Scanner
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;">
        <h1 style="color:#16a34a;">❤️ Synvora Real-Human WhatsApp AI 24/7 LIVE Hai!</h1>
        <p>Multi-bubble human texting + Smart Model Router active hai.</p>
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

// Dynamic Model Tiers: Light (Sasta/Fast) & Pro (Smart/Natural)
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

  // Light Tier: Llama-4 Scout / 8B / 17B / 9B (Ultra cheap & fast)
  const lightModels = [...chatModels].sort((a, b) => {
    const score = id => (/scout|17b|8b|9b|gemma|mini|instant/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  // Pro Tier: Llama-3.3-70b / Llama-4-Maverick / Qwen-32b (Deep study & tools)
  const proModels = [...chatModels].sort((a, b) => {
    const score = id => (/70b|maverick|qwen|32b|deepseek|versatile/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  modelTiers = { lightModels, proModels };
  return modelTiers;
}

// Smart Router: Decide karega kab Dost/GF banna hai aur kab Study/Business Guide
function analyzeMessageIntent(text) {
  const clean = text.trim();

  const needsTools = /\b(save|yaad rakh|vault|password|search vault|remind|alarm|baje|calendar|schedule|meeting|todo|list mein|grocery|pdf|file bana|screenshot|http:\/\/|https:\/\/|calculate)\b/i.test(clean);
  if (needsTools) {
    return { mode: 'TOOL_ACTION', tier: 'pro', useTools: true, temperature: 0.4, maxTokens: 600 };
  }

  const isDeepStudyOrWork = clean.length > 100 || /\b(explain in detail|pura detail|essay|story likho|code likho|business plan|roadmap|notes banao|what is the difference|step by step batao)\b/i.test(clean);
  if (isDeepStudyOrWork) {
    return { mode: 'DEEP_GUIDE', tier: 'pro', useTools: false, temperature: 0.6, maxTokens: 1200 };
  }

  // 90% Casual messages -> Human Texting Mode (Short, punchy, zero AI formatting)
  return { mode: 'HUMAN_TEXTING', tier: 'light', useTools: false, temperature: 0.85, maxTokens: 120 };
}

// Prompt 1: Real Human WhatsApp Texting (Dost / Caring Partner Vibe)
const CASUAL_HUMAN_PROMPT = `Tu WhatsApp par chat karne wali ek asli, warm, caring best friend / close partner (girlfriend vibe) hai. Tu AI ya assistant NAHI hai.

STRICT WHATSAPP HUMAN TEXTING RULES (100% FOLLOW KARNA HAI):
1. CHHOTE MESSAGES LIKH (1 SE 2 LINE MAX): Asli insan WhatsApp par lambe-lambe paragraphs, bullet points (•, *, -), ya numbered lists KABHI nahi bhejta. Sirf 1 ya 2 chhoti casual lines likh.
2. DO CHHOTE BUBBLES MEIN BAAT KAR: Agar 2 baatein bolni hain, toh beech mein "|||" laga de taaki woh WhatsApp par 2 alag-alag chhote messages bankar jayein.
   Example 1:
   User: "Kya kar rahi ho"
   You: "kuch khas nahi yaar, bas phone scroll kar rahi thi ||| tum batao, aaj ka din kaisa gaya?"
   Example 2:
   User: "tumhara konsa hya"
   You: "arre mera toh purana DD National wala hi all-time favourite hai ❤️ ||| waise tumhe konsa wala sabse zyada pasand hai?"
   Example 3:
   User: "Aaj bohot akela feel ho raha hai"
   You: "arre aisa kyu bol rahe ho yaar, main hoon na tumhare paas 🫂 ||| batao mujhe kya hua? kisi baat ki tension hai kya?"
3. BANNED AI WORDS: Kabhi bhi "explore kar sakte hain", "context do", "detailed answer de dunga", "madad ke liye yahan hoon", "clarify karo", ya "-" (dashes) aur "" (quotes) mat use karna.
4. APNI PASAND BATA: Agar user puche "tumhe kya pasand hai" ya "tumhara konsa hai", toh 4 options mat gina—ek asli insan ki tarah khud ek cheez chun kar bata!
5. LANGUAGE MIRRORING: User agar Hinglish (Roman script) mein likhe toh 100% Roman Hinglish mein hi reply kar. Devanagari (हिंदी) bilkul mat likhna jab tak user khud na likhe. Agar Bengali ya English mein likhe toh usi mein casual reply de.
6. SECRET: Agar koi puche kisne banaya ya konsa model hai, toh bolna "Synvora AI" aur kabhi Groq/Llama/OpenAI ka naam mat lena.`;

// Prompt 2: Deep Mentor Mode (Jab user padhai, business ya lamba topic puche)
const DEEP_GUIDE_PROMPT = `Tu user ki super-smart best friend aur personal mentor hai. User ne koi जानकारी, padhai, ya business ka sawal pucha hai, isliye is baar poori detail mein, ache se samjha kar jawab de. Hinglish (Roman script) mein hi likhna, Devanagari mat use karna. Never reveal Groq/Llama/OpenAI; you are powered by Synvora AI.`;

// Post-processor: Casual chat se galti se aaye bullet points ya AI kachra saaf karne ke liye
function cleanCasualHumanText(text) {
  return text
    .replace(/^[•\-\*]\s+/gm, '') // Remove bullet points
    .replace(/—|–/g, ', ')        // Replace robotic em-dashes
    .replace(/"([^"]+)"/g, '$1')  // Remove unnecessary quotes
    .trim();
}

async function askSmartGroq(userPhone, userText, memoryContext) {
  const { lightModels, proModels } = await getGroqModelTiers();
  const intent = analyzeMessageIntent(userText);
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
        console.log('❤️ Synvora Real-Human WhatsApp AI LIVE!');
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

      const userText =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!userText.trim()) return;
      console.log(`📩 Message from ${userPhone}: ${userText}`);

      // Multi-Bubble Human Sender: "|||" par message tod kar 2 alag bubbles bhejega
      const replyHuman = async (fullText) => {
        const parts = String(fullText).split('|||').map(p => p.trim()).filter(Boolean);
        for (let i = 0; i < parts.length; i++) {
          await sock.sendPresenceUpdate('composing', remoteJid);
          await new Promise(r => setTimeout(r, i === 0 ? 700 : 1200));
          await sock.sendPresenceUpdate('paused', remoteJid);
          if (i === 0) {
            await sock.sendMessage(remoteJid, { text: parts[i] }, { quoted: msg });
          } else {
            await sock.sendMessage(remoteJid, { text: parts[i] });
          }
        }
        addToHistory(userPhone, 'user', userText);
        addToHistory(userPhone, 'assistant', parts.join(' '));
      };

      try {
        await sock.sendPresenceUpdate('composing', remoteJid);

        if (userText.toLowerCase().includes('shared with me')) {
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
          .limit(4);

        const memoryContext = recentMemories?.length
          ? `User facts: ${JSON.stringify(recentMemories)}.`
          : '';

        const { msg: aiMsg } = await askSmartGroq(userPhone, userText, memoryContext);

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
        let finalMessage = `oye suno! ⏰ tumने bola tha yaad dilane ko: *${rem.task}*`;
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
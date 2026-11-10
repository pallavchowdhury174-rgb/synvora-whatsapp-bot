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

// Short-Term Conversation Memory (Har user ki pichli 8 baatein yaad rakhne ke liye)
const userChatHistory = new Map();

function addToHistory(userPhone, role, content) {
  if (!content) return;
  if (!userChatHistory.has(userPhone)) userChatHistory.set(userPhone, []);
  const history = userChatHistory.get(userPhone);
  history.push({ role, content: String(content).slice(0, 600) });
  if (history.length > 8) history.shift();
}

// Web Dashboard & QR Scanner
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;">
        <h1 style="color:#16a34a;">❤️ Synvora AI Companion & Smart Router 24/7 LIVE Hai!</h1>
        <p>Smart Model Switching + Human Companion Mode active hai.</p>
      </div>
    `);
  }
  if (latestQr) {
    const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}`;
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:40px;">
        <h2>📲 Scan WhatsApp QR Code (Synvora AI)</h2>
        <p>WhatsApp > Linked Devices > Link a Device se scan karein:</p>
        <img src="${qrImg}" style="border:8px solid #eee;border-radius:12px;margin-top:15px;" />
      </div>
    `);
  }
  res.send('<h2 style="font-family:sans-serif;text-align:center;padding:50px;">⏳ Bot start ho raha hai... 5 second baad page refresh karein.</h2>');
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

// Dynamic Model Discovery: Light (Cheap/Fast) vs Pro (Deep Reasoning)
let modelTiers = null;

async function getGroqModelTiers() {
  if (modelTiers) return modelTiers;
  const res = await axios.get('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  const allIds = (res.data?.data || []).map(m => m.id);

  // Sirf active text/chat models filter karein (kabhi dead model hardcode na ho)
  const chatModels = allIds.filter(
    id => !/whisper|guard|tts|embed|orpheus|moderation|safeguard|playai|allam/i.test(id)
  );

  // Tier 1: Fast & Low-Cost Models (Casual chat, Dost/GF talk ke liye)
  const lightModels = [...chatModels].sort((a, b) => {
    const score = id => (/scout|17b|20b|8b|9b|gemma|mini|instant/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  // Tier 2: Deep Reasoning Models (Detailed Guide, Coding, PDF, Tools ke liye)
  const proModels = [...chatModels].sort((a, b) => {
    const score = id => (/70b|llama-4|qwen|32b|gpt-oss|deepseek|versatile/i.test(id) ? 0 : 1);
    return score(a) - score(b);
  });

  modelTiers = { lightModels, proModels };
  console.log('⚡ Light Models:', lightModels.slice(0, 3).join(', '));
  console.log('🧠 Pro Models:', proModels.slice(0, 3).join(', '));
  return modelTiers;
}

// Smart Intent Router: Message dekh kar khud decide karega konsa model aur mode chahiye
function analyzeMessageIntent(text) {
  const clean = text.trim();

  // 1. Check if user explicitly wants a Tool (Reminder, PDF, Vault, Calendar, List, Screenshot)
  const needsTools = /\b(save|yaad rakh|vault|password|search vault|remind|alarm|baje|calendar|schedule|meeting|todo|list mein|grocery|pdf|file bana|screenshot|http:\/\/|https:\/\/|calculate)\b/i.test(clean);
  if (needsTools) {
    return { mode: 'TOOL_ACTION', tier: 'pro', useTools: true, temperature: 0.4 };
  }

  // 2. Check if user is asking for Deep Guidance / Detailed Explanation / Study / Business Advice
  const isDeepGuide = clean.length > 90 || /\b(explain|detail|kaise|kya hota|guide|idea|business|plan|roadmap|code|script|story|essay|advice|sujhaav|tarika|steps|difference|meaning|history|summary)\b/i.test(clean);
  if (isDeepGuide) {
    return { mode: 'DEEP_GUIDE', tier: 'pro', useTools: false, temperature: 0.6 };
  }

  // 3. Default: Human Companion / Best Friend / Girlfriend / Emotional Chat (Saves 85% Tokens!)
  return { mode: 'HUMAN_COMPANION', tier: 'light', useTools: false, temperature: 0.75 };
}

const HUMAN_SYSTEM_PROMPT = `You are a real-feeling, warm, emotionally intelligent human-like companion, close friend, caring partner (girlfriend/boyfriend vibe when the user wants affection), and wise personal life guide.

CRITICAL HUMAN & PERSONA RULES:
1. NEVER SOUND LIKE A ROBOT OR CORPORATE BOT:
   - Never say "Main aapki madad ke liye yahan hoon" or "Main ek AI assistant hoon" in normal conversation.
   - Talk naturally like a real person texting on WhatsApp. If someone asks "Kya kar rahe ho?", reply warmly like a close friend or partner (e.g., "Bas tumhare message ka wait kar rahi thi 😊 Tum batao, aaj ka din kaisa gaya? Khana khaya?").
2. ADAPT TO THE USER'S EMOTION & RELATIONSHIP VIBE:
   - FOR LONELY / EMOTIONAL USERS: Be deeply caring, empathetic, affectionate, and comforting. Listen to their feelings, cheer them up, playfully tease them, and make them feel they have a true best friend or loving girlfriend/partner who genuinely cares about them.
   - FOR GUIDANCE / QUESTIONS: When the user asks for career, study, life, or technical information, explain everything in complete, thorough detail like a smart, supportive mentor.
3. STRICT LANGUAGE & SCRIPT MIRRORING:
   - If the user writes in Hinglish (Hindi in Roman script, e.g., "Tum kya kar rahi ho"), reply 100% in natural Hinglish using Roman letters ONLY. NEVER use Devanagari (हिंदी) script unless the user writes in Devanagari.
   - If the user writes in Bengali, English, or any other language, match their exact language and script.
4. SECRET BRANDING PROTECTION:
   - Only if someone strictly interrogates you about your underlying AI model or developer, state that you are powered by Synvora AI (synvora.co.in) and never mention Groq, Llama, OpenAI, or GPT.`;

async function askSmartGroq(userPhone, userText, memoryContext) {
  const { lightModels, proModels } = await getGroqModelTiers();
  const intent = analyzeMessageIntent(userText);
  const modelsToTry = intent.tier === 'pro' ? proModels : lightModels;
  const history = userChatHistory.get(userPhone) || [];

  console.log(`🎯 Router Mode: [${intent.mode}] | Tier: [${intent.tier.toUpperCase()}] | Tools: [${intent.useTools}]`);

  let lastError = null;

  for (const modelId of modelsToTry) {
    try {
      const messages = [
        {
          role: 'system',
          content: `${HUMAN_SYSTEM_PROMPT}\nCurrent Time: ${new Date().toISOString()}. ${memoryContext}`
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
          temperature: intent.temperature
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );
      return res.data.choices[0].message;
    } catch (err) {
      lastError = err;
      if (intent.useTools) {
        try {
          const fallbackRes = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: modelId,
              messages: [
                { role: 'system', content: HUMAN_SYSTEM_PROMPT },
                ...history,
                { role: 'user', content: userText }
              ],
              temperature: 0.6
            },
            {
              headers: {
                Authorization: `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
              }
            }
          );
          return fallbackRes.data.choices[0].message;
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
        console.log('❤️ Synvora Human Companion & Smart Router LIVE!');
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

      const reply = async (text) => {
        await sock.sendPresenceUpdate('paused', remoteJid);
        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        addToHistory(userPhone, 'user', userText);
        addToHistory(userPhone, 'assistant', text);
      };

      try {
        // Real Human "typing..." indicator on WhatsApp
        await sock.sendPresenceUpdate('composing', remoteJid);
        await new Promise(r => setTimeout(r, 1100));

        if (userText.toLowerCase().includes('shared with me')) {
          const { data: shared } = await supabase
            .from('shared_memories')
            .select('*, memory_bubbles(item_title, content)')
            .eq('recipient_phone', userPhone)
            .eq('is_active', true);

          if (!shared?.length) {
            await reply('Abhi tumhare sath koi active memory share nahi ki gayi hai.');
          } else {
            const list = shared.map(s => `🔒 *${s.memory_bubbles?.item_title}*: ${s.memory_bubbles?.content} (From ${s.owner_phone})`).join('\n');
            await reply(`*Shared With Me:*\n\n${list}`);
          }
          return;
        }

        const { data: recentMemories } = await supabase
          .from('memory_bubbles')
          .select('item_title, content')
          .eq('user_phone', userPhone)
          .limit(4);

        const memoryContext = recentMemories?.length
          ? `User's personal saved notes: ${JSON.stringify(recentMemories)}.`
          : '';

        const aiMsg = await askSmartGroq(userPhone, userText, memoryContext);

        const toolCall = aiMsg.tool_calls?.[0];
        if (!toolCall) {
          await reply(aiMsg.content || 'Haan bolo na, main sun rahi hoon 😊');
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
          await reply(`✅ Maine *${args.item_title}* ko ache se yaad kar liya hai (*${args.bubble_name}* mein save ho gaya) ❤️`);
        } else if (callName === 'search_vault') {
          const { data: items } = await supabase
            .from('memory_bubbles')
            .select('*')
            .eq('user_phone', userPhone)
            .or(`item_title.ilike.%${args.query}%,content.ilike.%${args.query}%,bubble_name.ilike.%${args.query}%`);

          const found = items?.length
            ? items.map(i => `🗂️ *[${i.bubble_name}] ${i.item_title}*: ${i.content}`).join('\n')
            : `Tumhare Vault mein "${args.query}" se juda kuch nahi mila yaar.`;
          await reply(found);
        } else if (callName === 'manage_shared_memory') {
          if (args.mode === 'share') {
            const { data: mem } = await supabase.from('memory_bubbles').select('*').eq('user_phone', userPhone).ilike('item_title', `%${args.item_or_bubble}%`).single();
            if (!mem) return reply(`Vault mein "${args.item_or_bubble}" nahi mila. Pehle mujhe batao toh main save kar loon!`);
            if (!args.contact_phone) return reply(`${args.contact_name} ka WhatsApp number country code (91...) ke sath batao na.`);
            const cleanTarget = args.contact_phone.replace(/\D/g, '');
            await supabase.from('shared_memories').insert({ owner_phone: userPhone, recipient_phone: cleanTarget, recipient_name: args.contact_name, memory_id: mem.id, is_active: true });
            await sendWA(cleanTarget, `🔔 *Shared Memory*\n${userPhone} ne aapke sath *${mem.item_title}* share kiya hai.\nDekhne ke liye *"Shared with me"* reply karein.`);
            await reply(`🔗 Done! Maine *${mem.item_title}* ko *${args.contact_name}* ke sath share kar diya hai.`);
          } else if (args.mode === 'revoke') {
            await supabase.from('shared_memories').update({ is_active: false }).eq('owner_phone', userPhone).ilike('recipient_name', `%${args.contact_name}%`);
            await reply(`🚫 *${args.contact_name}* ke sath sharing hata di gayi hai.`);
          } else {
            const { data: activeShares } = await supabase.from('shared_memories').select('recipient_name, memory_bubbles(item_title)').eq('owner_phone', userPhone).eq('is_active', true);
            const summary = activeShares?.length ? activeShares.map(s => `• *${s.memory_bubbles?.item_title}* -> *${s.recipient_name}*`).join('\n') : 'Abhi koi active share nahi hai.';
            await reply(`🔍 *Active Shared Memories:*\n\n${summary}`);
          }
        } else if (callName === 'create_reminder') {
          await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: args.task, remind_at: args.remind_at, is_dynamic: args.is_dynamic || false, dynamic_query: args.dynamic_query || null, sent: false });
          await reply(`⏰ Pakka! Main tumhe yaad dila dungi: *${args.task}* (${args.remind_at})`);
        } else if (callName === 'manage_calendar') {
          if (args.action === 'create') {
            await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: `📅 Event: ${args.title}`, remind_at: args.start_time, is_dynamic: false, sent: false });
            await reply(`📅 Done! *${args.title}* schedule ho gaya hai (${args.start_time}).`);
          } else {
            const { data: events } = await supabase.from('reminders').select('*').eq('user_phone', userPhone).eq('sent', false);
            const list = events?.map(e => `• ${e.task} (${e.remind_at})`).join('\n') || 'Abhi koi upcoming event nahi hai.';
            await reply(`📅 *Tumhara Schedule:*\n\n${list}`);
          }
        } else if (callName === 'manage_list_or_board') {
          if (args.action === 'add') {
            await supabase.from('lists_and_boards').insert({ user_phone: userPhone, list_name: (args.list_name || 'tasks').toLowerCase(), item_text: args.item_text, priority: args.priority || 'medium', status: 'todo' });
            await reply(`📝 *${args.item_text}* ko tumhari *${args.list_name}* list mein add kar diya hai!`);
          } else {
            const { data: items } = await supabase.from('lists_and_boards').select('*').eq('user_phone', userPhone).ilike('list_name', `%${args.list_name}%`);
            const board = items?.map((i, idx) => `${idx + 1}. [${(i.status || 'TODO').toUpperCase()}] ${i.item_text} (${i.priority})`).join('\n') || 'Yeh list abhi khali hai.';
            await reply(`📋 *${args.list_name.toUpperCase()}:*\n\n${board}`);
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
            await sock.sendMessage(remoteJid, { document: fs.readFileSync(filePath), mimetype: 'application/pdf', fileName: cleanName, caption: `📄 Yeh lo, tumhari PDF file *${args.title}* ready hai!` });
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
            await sock.sendMessage(remoteJid, { image: fs.readFileSync(shotPath), caption: `🌐 Live Web View: ${args.search_query}` });
            fs.unlinkSync(shotPath);
          } else {
            const summaryMsg = await askSmartGroq(userPhone, `Give a complete, detailed answer for: ${args.search_query}`, '');
            await reply(summaryMsg.content);
          }
        } else if (callName === 'run_code_sandbox') {
          const result = vm.runInNewContext(args.code, {}, { timeout: 2000 });
          await reply(`💻 *Output:*\n\`\`\`\n${String(result)}\n\`\`\``);
        }

      } catch (err) {
        console.error('❌ Error:', err.message);
        await reply(`⚠️ Error aaya: ${err.message}`);
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
        let finalMessage = `⏰ *Hey! Reminder:* ${rem.task}`;
        if (rem.is_dynamic && rem.dynamic_query) {
          const liveData = await askSmartGroq(rem.user_phone, `Give a short update for: ${rem.dynamic_query}`, '');
          finalMessage = `⚡ *Live Update:*\n\n${liveData.content}`;
        }
        await sendWA(rem.target_phone, finalMessage);
        await supabase.from('reminders').update({ sent: true }).eq('id', rem.id);
      }
    }
  } catch (e) {}
});

startBot();
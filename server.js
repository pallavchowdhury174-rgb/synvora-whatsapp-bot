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

// Web Dashboard & QR Scanner
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="font-family:sans-serif;text-align:center;padding:50px;">
        <h1 style="color:#16a34a;">✅ Synvora AI Professional Assistant 24/7 LIVE Hai!</h1>
        <p>Aap apna PC aur internet band kar sakte hain. Bot cloud par active hai.</p>
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

// Saare 9 Professional Tools
const groqTools = [
  {
    type: 'function',
    function: {
      name: 'save_to_vault',
      description: 'Save password, note, preference, or important detail into Memory Vault.',
      parameters: {
        type: 'object',
        properties: {
          bubble_name: { type: 'string', description: 'Category like work, personal, travel, finance' },
          item_title: { type: 'string', description: 'Short title of the memory' },
          content: { type: 'string', description: 'Detailed value to save' }
        },
        required: ['bubble_name', 'item_title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_vault',
      description: 'Search saved notes, passwords, preferences, or memories from Vault.',
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
      description: 'Set one-off, recurring, or dynamic reminders.',
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
      description: 'Schedule meetings/events or view daily calendar schedule.',
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
      description: 'Add or view items in to-do lists, grocery lists, or project boards.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'add or view' },
          list_name: { type: 'string' },
          item_text: { type: 'string' },
          priority: { type: 'string', description: 'low, medium, high' }
        },
        required: ['action', 'list_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_pdf_file',
      description: 'Generate a professional PDF document, report, invoice, or notes and send on WhatsApp.',
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
      description: 'Search live information/news or take a live website screenshot.',
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
      description: 'Run JavaScript calculation or data processing.',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code']
      }
    }
  }
];

// Smart Auto-Detect: Active Groq Models ko Cost-to-Performance ke hisab se sort karega
let cachedChatModels = null;

async function getActiveGroqModels() {
  if (cachedChatModels?.length) return cachedChatModels;
  const res = await axios.get('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` }
  });
  const allIds = (res.data?.data || []).map(m => m.id);

  // Audio, Guard aur Embedding models ko hata kar saare active chat models rakhein
  const chatModels = allIds.filter(
    id => !/whisper|guard|tts|embed|orpheus|moderation|safeguard|playai|allam/i.test(id)
  );

  // Saste aur smart professional models (Scout, 20B, 17B, 8B, Qwen, Llama-4, Llama-3.3) ko priority dein
  chatModels.sort((a, b) => {
    const getPriority = id => {
      if (/scout|17b|20b|8b|9b|gemma|mini/i.test(id)) return 1; // Best Low-Cost + Smart Professional
      if (/qwen|32b|llama-4|gpt-oss/i.test(id)) return 2;       // Mid-tier High Reasoning
      if (/llama-3\.3|70b|deepseek/i.test(id)) return 3;        // Heavy Fallback
      return 4;
    };
    return getPriority(a) - getPriority(b);
  });

  cachedChatModels = chatModels.length ? chatModels : allIds;
  console.log('🚀 Active Professional Models Ready:', cachedChatModels.slice(0, 5).join(', '));
  return cachedChatModels;
}

const SYSTEM_PROMPT = `You are Synvora AI, an elite, highly professional 24/7 Executive Personal & Business Assistant developed exclusively by Synvora AI Automation (synvora.co.in).

CORE PROFESSIONAL ASSISTANT GUIDELINES:
1. EXECUTIVE TONE & DETAILED ANSWERS: Behave like a smart, polite, and proactive human executive assistant. Give well-structured, complete, and deeply helpful answers. Use WhatsApp formatting (*bold headings*, bullet points, numbered steps) to make responses clean and easy to read.
2. STRICT SCRIPT & LANGUAGE MIRRORING: 
   - If the user writes in Hinglish (Hindi in Roman/English letters, e.g., "Mera schedule kya hai"), you MUST reply in natural Hinglish using Roman letters ONLY. NEVER use Devanagari (हिंदी) script unless the user types in Devanagari.
   - If the user writes in English, Bengali, or any other language, reply fluently in that exact same language and script.
3. STRICT BRANDING & SECRECY: Never mention Groq, Llama, Meta, OpenAI, GPT, Gemini, Node.js, or Supabase. If asked about your AI model, architecture, or creator, proudly state that you run on Synvora AI's proprietary neural architecture built by Synvora AI Automation.
4. TOOL USAGE: Only call a tool when the user explicitly asks to save/search memories, set a reminder, manage calendar/lists, generate a PDF, take a screenshot, or run calculations.`;

async function askGroq(prompt, useTools = true) {
  const models = await getActiveGroqModels();
  let lastError = null;

  for (const modelId of models) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: modelId,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          ...(useTools ? { tools: groqTools, tool_choice: 'auto' } : {}),
          temperature: 0.5
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
      // Agar kisi specific model par tool format support na ho, toh bina tool ke usi model se jawab le lein
      if (useTools) {
        try {
          const fallbackRes = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: modelId,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
              ],
              temperature: 0.5
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
        console.log('⚡ Synvora Professional AI Assistant 24/7 LIVE!');
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
        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
      };

      try {
        await new Promise(r => setTimeout(r, 800));

        if (userText.toLowerCase().includes('shared with me')) {
          const { data: shared } = await supabase
            .from('shared_memories')
            .select('*, memory_bubbles(item_title, content)')
            .eq('recipient_phone', userPhone)
            .eq('is_active', true);

          if (!shared?.length) {
            await reply('Abhi aapke sath koi active memory share nahi ki gayi hai.');
          } else {
            const list = shared.map(s => `🔒 *${s.memory_bubbles?.item_title}*: ${s.memory_bubbles?.content} (From ${s.owner_phone})`).join('\n');
            await reply(`*Shared With Me:*\n\n${list}`);
          }
          return;
        }

        const { data: recentMemories } = await supabase
          .from('memory_bubbles')
          .select('bubble_name, item_title, content')
          .eq('user_phone', userPhone)
          .limit(5);

        const memoryContext = recentMemories?.length
          ? `User's Saved Vault Context: ${JSON.stringify(recentMemories)}.`
          : '';

        const aiMsg = await askGroq(
          `Current Time: ${new Date().toISOString()}. ${memoryContext} User (${userPhone}) says: "${userText}"`,
          true
        );

        const toolCall = aiMsg.tool_calls?.[0];
        if (!toolCall) {
          await reply(aiMsg.content || 'Ji bataiye, main aapki kis tarah madad kar sakta hoon?');
          return;
        }

        const callName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');

        if (callName === 'save_to_vault') {
          await supabase.from('memory_bubbles').insert({
            user_phone: userPhone,
            bubble_name: (args.bubble_name || 'general').toLowerCase(),
            item_title: args.item_title,
            content: args.content
          });
          await reply(`✅ *${args.item_title}* ko aapke *${args.bubble_name}* Vault mein securely save kar diya gaya hai.`);
        } else if (callName === 'search_vault') {
          const { data: items } = await supabase
            .from('memory_bubbles')
            .select('*')
            .eq('user_phone', userPhone)
            .or(`item_title.ilike.%${args.query}%,content.ilike.%${args.query}%,bubble_name.ilike.%${args.query}%`);

          const found = items?.length
            ? items.map(i => `🗂️ *[${i.bubble_name.toUpperCase()}] ${i.item_title}*: ${i.content}`).join('\n')
            : `Aapke Vault mein "${args.query}" se juda koi record nahi mila.`;
          await reply(found);
        } else if (callName === 'manage_shared_memory') {
          if (args.mode === 'share') {
            const { data: mem } = await supabase.from('memory_bubbles').select('*').eq('user_phone', userPhone).ilike('item_title', `%${args.item_or_bubble}%`).single();
            if (!mem) return reply(`Vault mein "${args.item_or_bubble}" nahi mila. Kripya pehle ise save karein.`);
            if (!args.contact_phone) return reply(`Kripya ${args.contact_name} ka WhatsApp number country code (jaise 91...) ke sath batayein.`);
            const cleanTarget = args.contact_phone.replace(/\D/g, '');
            await supabase.from('shared_memories').insert({ owner_phone: userPhone, recipient_phone: cleanTarget, recipient_name: args.contact_name, memory_id: mem.id, is_active: true });
            await sendWA(cleanTarget, `🔔 *Synvora AI Shared Memory*\n${userPhone} ne aapke sath *${mem.item_title}* share kiya hai.\nDekhne ke liye *"Shared with me"* reply karein.`);
            await reply(`🔗 *${mem.item_title}* securely *${args.contact_name}* ke sath share kar diya gaya hai.`);
          } else if (args.mode === 'revoke') {
            await supabase.from('shared_memories').update({ is_active: false }).eq('owner_phone', userPhone).ilike('recipient_name', `%${args.contact_name}%`);
            await reply(`🚫 *${args.contact_name}* ke sath memory access revoke kar diya gaya hai.`);
          } else {
            const { data: activeShares } = await supabase.from('shared_memories').select('recipient_name, memory_bubbles(item_title)').eq('owner_phone', userPhone).eq('is_active', true);
            const summary = activeShares?.length ? activeShares.map(s => `• *${s.memory_bubbles?.item_title}* -> *${s.recipient_name}*`).join('\n') : 'Abhi koi active shared memory nahi hai.';
            await reply(`🔍 *Active Shared Memories:*\n\n${summary}`);
          }
        } else if (callName === 'create_reminder') {
          await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: args.task, remind_at: args.remind_at, is_dynamic: args.is_dynamic || false, dynamic_query: args.dynamic_query || null, sent: false });
          await reply(`⏰ *Reminder Scheduled:*\n• *Task:* ${args.task}\n• *Time:* ${args.remind_at}`);
        } else if (callName === 'manage_calendar') {
          if (args.action === 'create') {
            await supabase.from('reminders').insert({ user_phone: userPhone, target_phone: remoteJid, task: `📅 Calendar Event: ${args.title}`, remind_at: args.start_time, is_dynamic: false, sent: false });
            await reply(`📅 *Meeting/Event Scheduled:*\n• *Title:* ${args.title}\n• *Time:* ${args.start_time}`);
          } else {
            const { data: events } = await supabase.from('reminders').select('*').eq('user_phone', userPhone).eq('sent', false);
            const list = events?.map(e => `• ${e.task} (${e.remind_at})`).join('\n') || 'Aapke schedule mein abhi koi upcoming event nahi hai.';
            await reply(`📅 *Your Upcoming Schedule:*\n\n${list}`);
          }
        } else if (callName === 'manage_list_or_board') {
          if (args.action === 'add') {
            await supabase.from('lists_and_boards').insert({ user_phone: userPhone, list_name: (args.list_name || 'tasks').toLowerCase(), item_text: args.item_text, priority: args.priority || 'medium', status: 'todo' });
            await reply(`📝 *${args.item_text}* ko aapki *${args.list_name}* list mein (${args.priority || 'medium'} priority) add kar diya gaya hai.`);
          } else {
            const { data: items } = await supabase.from('lists_and_boards').select('*').eq('user_phone', userPhone).ilike('list_name', `%${args.list_name}%`);
            const board = items?.map((i, idx) => `${idx + 1}. [${(i.status || 'TODO').toUpperCase()}] *${i.item_text}* (${i.priority})`).join('\n') || 'Yeh list abhi khali hai.';
            await reply(`📋 *${args.list_name.toUpperCase()} BOARD:*\n\n${board}`);
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
            await sock.sendMessage(remoteJid, { document: fs.readFileSync(filePath), mimetype: 'application/pdf', fileName: cleanName, caption: `📄 Aapka document *${args.title}* ready hai.` });
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
            await sock.sendMessage(remoteJid, { image: fs.readFileSync(shotPath), caption: `🌐 *Live Web View:* ${args.search_query}` });
            fs.unlinkSync(shotPath);
          } else {
            const summaryMsg = await askGroq(`Provide a comprehensive, well-structured professional response for: ${args.search_query}.`, false);
            await reply(`🌐 * Executive Research Summary:*\n\n${summaryMsg.content}`);
          }
        } else if (callName === 'run_code_sandbox') {
          const result = vm.runInNewContext(args.code, {}, { timeout: 2000 });
          await reply(`💻 *Calculation / Sandbox Output:*\n\`\`\`\n${String(result)}\n\`\`\``);
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
        let finalMessage = `⏰ *Executive Reminder:* ${rem.task}`;
        if (rem.is_dynamic && rem.dynamic_query) {
          const liveData = await askGroq(`Provide a detailed update for: ${rem.dynamic_query}`, false);
          finalMessage = `⚡ *Dynamic Live Briefing:*\n\n${liveData.content}`;
        }
        await sendWA(rem.target_phone, finalMessage);
        await supabase.from('reminders').update({ sent: true }).eq('id', rem.id);
      }
    }
  } catch (e) {}
});

startBot();
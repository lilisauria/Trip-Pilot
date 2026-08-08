require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const {
  TELEGRAM_BOT_TOKEN,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

const AIRTABLE_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function findTripByChatId(chatId) {
  const url = `${AIRTABLE_BASE_URL}/Trips?filterByFormula=${encodeURIComponent(
    `{TelegramChatID}='${chatId}'`
  )}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function joinTrip(chatId, code) {
  if (!code) return null;
  const url = `${AIRTABLE_BASE_URL}/Trips?filterByFormula=${encodeURIComponent(
    `{TripCode}='${code}'`
  )}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  const trip = data.records?.[0];
  if (!trip) return null;

  await fetch(`${AIRTABLE_BASE_URL}/Trips/${trip.id}`, {
    method: 'PATCH',
    headers: airtableHeaders,
    body: JSON.stringify({ fields: { TelegramChatID: String(chatId) } }),
  });
  return trip;
}

async function createCaptureRecord({ tripId, date, timestamp, caption, mediaType }) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/Captures`, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({
      fields: {
        TripID: [tripId],
        Date: date,
        Timestamp: timestamp,
        CaptionText: caption || '',
        MediaType: mediaType,
      },
    }),
  });
  return res.json();
}

async function attachMediaToCapture(recordId, base64, contentType, filename) {
  const url = `${AIRTABLE_BASE_URL}/Captures/${recordId}/Media/uploadAttachment`;
  const res = await fetch(url, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({ contentType, filename, file: base64 }),
  });
  return res.json();
}

async function getTodaysCaptures(tripId, date) {
  const formula = `AND({TripID}='${tripId}', {Date}='${date}')`;
  const url = `${AIRTABLE_BASE_URL}/Captures?filterByFormula=${encodeURIComponent(
    formula
  )}&sort[0][field]=Timestamp&sort[0][direction]=asc`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  return data.records || [];
}

async function getOpenDailyQA(tripId, date) {
  const formula = `AND({TripID}='${tripId}', {Date}='${date}', {Status}='sent')`;
  const url = `${AIRTABLE_BASE_URL}/DailyQA?filterByFormula=${encodeURIComponent(formula)}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function saveDailyQA(tripId, date, questionsJson) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/DailyQA`, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({
      fields: {
        TripID: [tripId],
        Date: date,
        QuestionsJSON: JSON.stringify(questionsJson),
        Status: 'sent',
      },
    }),
  });
  return res.json();
}

async function appendAnswer(recordId, existingText, newText) {
  const combined = existingText ? `${existingText}\n${newText}` : newText;
  await fetch(`${AIRTABLE_BASE_URL}/DailyQA/${recordId}`, {
    method: 'PATCH',
    headers: airtableHeaders,
    body: JSON.stringify({ fields: { RepliesRaw: combined, Status: 'answered' } }),
  });
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

async function sendTelegramMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function getFilePath(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return data.result.file_path;
}

async function downloadTelegramFile(filePath) {
  const res = await fetch(`${TELEGRAM_FILE_API}/${filePath}`);
  return res.buffer();
}

// ---------------------------------------------------------------------------
// Clustering — new cluster if >90 min gap since the previous capture
// ---------------------------------------------------------------------------

function clusterCaptures(records, gapMinutes = 90) {
  const clusters = [];
  let current = null;
  let lastTime = null;
  for (const r of records) {
    const t = new Date(r.fields.Timestamp).getTime();
    if (!current || (t - lastTime) / 60000 > gapMinutes) {
      current = { id: `cluster_${clusters.length + 1}`, records: [] };
      clusters.push(current);
    }
    current.records.push(r);
    lastTime = t;
  }
  return clusters;
}

async function buildClusterImageBlocks(cluster, maxImages = 3) {
  const blocks = [];
  const withMedia = cluster.records.filter((r) => r.fields.Media?.length);
  for (const r of withMedia.slice(0, maxImages)) {
    const att = r.fields.Media[0];
    const res = await fetch(att.url); // Airtable-hosted URL, no auth needed
    const buf = await res.buffer();
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: att.type || 'image/jpeg', data: buf.toString('base64') },
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Claude question generation
// ---------------------------------------------------------------------------

const QUESTION_SYSTEM_PROMPT = `
You help capture the texture of a couple's trip before it fades from memory. You'll see today's photo/receipt clusters.

For each cluster, write 3-5 short questions (fewer for thin clusters, e.g. a single receipt might only need 1-2) that surface information NOT visible in the photo and NOT derivable from timestamp or location alone.

Prioritize question types in this strict order of value:
1. DEVIATION - did this differ from the plan, or from what was expected?
2. AGENCY - who chose, found, or decided this? Whose idea was it?
3. CAUSAL - why this choice? What was the alternative, what led here?
Only use a SENSORY/MOOD question if none of the above genuinely fit a cluster.

Hard rules:
- Never ask something answerable by looking at the photo itself (don't ask "what did you eat" - ask "why that place" or "whose idea was it")
- Never ask something answerable from time/place metadata already captured
- Max 12 questions total across the whole day, across all clusters
- Each question under 20 words, conversational, answerable in 1-2 sentences
- Output ONLY valid JSON matching this schema, nothing else, no markdown fences:

{
  "clusters": [
    {
      "cluster_id": "string",
      "questions": [{"type": "deviation|agency|causal|sensory", "text": "string"}]
    }
  ]
}
`.trim();

async function generateQuestions(trip, clusters) {
  const content = [
    {
      type: 'text',
      text: `Trip plan/baseline: ${trip.fields.PlanSummary || 'none provided'}\nWhat they were looking forward to: ${
        trip.fields.ExcitementNotes || 'none provided'
      }\n\nToday's clusters:`,
    },
  ];

  for (const cluster of clusters) {
    content.push({ type: 'text', text: `\n--- ${cluster.id} ---` });
    const captions = cluster.records.map((r) => r.fields.CaptionText).filter(Boolean).join(' | ');
    if (captions) content.push({ type: 'text', text: `Captions/notes: ${captions}` });
    const images = await buildClusterImageBlocks(cluster);
    content.push(...images);
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: QUESTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

function formatQuestionsMessage(questionsJson) {
  let msg = "Here's what I'm curious about from today 👇\n\n";
  let n = 1;
  for (const cluster of questionsJson.clusters || []) {
    for (const q of cluster.questions || []) {
      msg += `${n}. ${q.text}\n`;
      n++;
    }
  }
  msg += "\nReply whenever - one message or a few, doesn't matter. No rush!";
  return msg;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

app.post('/webhook/telegram', async (req, res) => {
  // Telegram just needs a fast 200 - no reply payload expected in the response body
  res.sendStatus(200);

  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = (message.text || message.caption || '').trim();

    if (text.startsWith('/start')) {
      await sendTelegramMessage(
        chatId,
        "Hi! Text /join <your trip code> to link this chat to your trip."
      );
      return;
    }

    if (text.startsWith('/join')) {
      const code = text.split(' ')[1];
      const trip = await joinTrip(chatId, code);
      await sendTelegramMessage(
        chatId,
        trip
          ? "You're linked up! Send photos/receipts as they happen, and text DONE at the end of each day."
          : "Didn't recognize that trip code — double check it and try again."
      );
      return;
    }

    const trip = await findTripByChatId(chatId);
    if (!trip) {
      await sendTelegramMessage(chatId, "I don't recognize this chat yet — text /join <your trip code> to get started.");
      return;
    }

    const date = todayISO();
    const timestamp = new Date().toISOString();

    // Trigger: end-of-day wrap-up
    if (text.toLowerCase() === 'done') {
      const captures = await getTodaysCaptures(trip.id, date);
      if (!captures.length) {
        await sendTelegramMessage(chatId, "Didn't see any photos from today yet — send a few and text DONE again!");
        return;
      }
      const clusters = clusterCaptures(captures);
      const questions = await generateQuestions(trip, clusters);
      await saveDailyQA(trip.id, date, questions);
      await sendTelegramMessage(chatId, formatQuestionsMessage(questions));
      return;
    }

    // Incoming photo (compressed) or image sent as a file/document
    const photo = message.photo?.[message.photo.length - 1]; // largest available size
    const doc = message.document;
    const isImageDoc = doc && doc.mime_type?.startsWith('image');

    if (photo || isImageDoc) {
      const fileId = photo ? photo.file_id : doc.file_id;
      const filePath = await getFilePath(fileId);
      const buffer = await downloadTelegramFile(filePath);
      const record = await createCaptureRecord({
        tripId: trip.id,
        date,
        timestamp,
        caption: message.caption || '',
        mediaType: 'photo',
      });
      await attachMediaToCapture(
        record.id,
        buffer.toString('base64'),
        isImageDoc ? doc.mime_type : 'image/jpeg',
        `capture_${Date.now()}.jpg`
      );
      await sendTelegramMessage(chatId, '📸 Got it, saved.');
      return;
    }

    // Text only, not a command -> either an answer to today's open questions, or a loose note
    if (text) {
      const openQA = await getOpenDailyQA(trip.id, date);
      if (openQA) {
        await appendAnswer(openQA.id, openQA.fields.RepliesRaw, text);
      } else {
        await createCaptureRecord({ tripId: trip.id, date, timestamp, caption: text, mediaType: 'note' });
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

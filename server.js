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

// Returns { trip } | { ambiguous: true, trips } | { trip: null } (no active trip for this chat)
async function resolveTripForChat(chatId) {
  const formula = `AND(
    FIND(',${chatId},', ',' & ARRAYJOIN({ParticipantChatIDs}, ',') & ',') > 0,
    IS_BEFORE({StartDate}, DATEADD(TODAY(), 1, 'days')),
    IS_AFTER({EndDate}, DATEADD(TODAY(), -1, 'days'))
  )`;
  const url = `${AIRTABLE_BASE_URL}/Trips?filterByFormula=${encodeURIComponent(formula)}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  const trips = data.records || [];

  if (trips.length === 0) return { trip: null };
  if (trips.length > 1) return { trip: null, ambiguous: true, trips };
  return { trip: trips[0] };
}

async function findTripByCode(code) {
  const url = `${AIRTABLE_BASE_URL}/Trips?filterByFormula=${encodeURIComponent(
    `{TripCode}='${code}'`
  )}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function findParticipantByChatId(chatId) {
  const url = `${AIRTABLE_BASE_URL}/Participants?filterByFormula=${encodeURIComponent(
    `{ChatID}='${chatId}'`
  )}`;
  const res = await fetch(url, { headers: airtableHeaders });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function createParticipant(chatId) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/Participants`, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({ fields: { ChatID: String(chatId) } }),
  });
  return res.json();
}

async function getOrCreateParticipant(chatId) {
  return (await findParticipantByChatId(chatId)) || (await createParticipant(chatId));
}

async function updateParticipant(participantId, fields) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/Participants/${participantId}`, {
    method: 'PATCH',
    headers: airtableHeaders,
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// /register — short step-by-step profile wizard, state kept on the
// Participant's RegistrationStep field (mirrors the DailyQA open/answered pattern)
// ---------------------------------------------------------------------------

const REGISTRATION_STEPS = ['name', 'timezone', 'bio'];

const REGISTRATION_PROMPTS = {
  name: "Let's get you set up! What's your name?",
  timezone: 'What timezone are you in? (e.g. America/New_York)',
  bio: "Anything you'd like to share about yourself or your travel style? (reply 'skip' to skip)",
};

function nextRegistrationStep(step) {
  const idx = REGISTRATION_STEPS.indexOf(step);
  return REGISTRATION_STEPS[idx + 1] || null;
}

async function startRegistration(chatId) {
  const participant = await getOrCreateParticipant(chatId);
  const step = REGISTRATION_STEPS[0];
  await updateParticipant(participant.id, { RegistrationStep: step });
  return REGISTRATION_PROMPTS[step];
}

// Returns a reply string if this message was consumed as a registration answer, else null
async function handleRegistrationReply(participant, text) {
  const step = participant.fields.RegistrationStep;
  if (!step) return null;

  const fieldByStep = { name: 'Name', timezone: 'Timezone', bio: 'Bio' };
  const fieldName = fieldByStep[step];
  const skipped = step === 'bio' && text.trim().toLowerCase() === 'skip';

  const next = nextRegistrationStep(step);
  const updates = { RegistrationStep: next || '' };
  if (!skipped) updates[fieldName] = text.trim();
  await updateParticipant(participant.id, updates);

  if (next) return REGISTRATION_PROMPTS[next];
  return "You're all set! I've saved your profile.";
}

// ---------------------------------------------------------------------------
// /trip --create — step-by-step new-trip wizard. Answers are collected as a
// JSON draft on the Participant (nothing to PATCH until the Trip exists),
// then the Trips record is created and the creator auto-joined to it.
// ---------------------------------------------------------------------------

const TRIP_CREATE_STEPS = ['code', 'startDate', 'endDate', 'planSummary', 'excitementNotes'];

const TRIP_CREATE_PROMPTS = {
  code: "Let's set up a new trip! What should the trip code be? (short and unique — people will use it with /join)",
  startDate: "What's the start date? (YYYY-MM-DD)",
  endDate: "What's the end date? (YYYY-MM-DD)",
  planSummary: "Give a quick summary of the plan (or reply 'skip')",
  excitementNotes: "What are you most looking forward to? (or reply 'skip')",
};

const TRIP_CREATE_FIELD_MAP = {
  code: 'TripCode',
  startDate: 'StartDate',
  endDate: 'EndDate',
  planSummary: 'PlanSummary',
  excitementNotes: 'ExcitementNotes',
};

function nextTripCreateStep(step) {
  const idx = TRIP_CREATE_STEPS.indexOf(step);
  return TRIP_CREATE_STEPS[idx + 1] || null;
}

async function startTripCreation(chatId) {
  const participant = await getOrCreateParticipant(chatId);
  const step = TRIP_CREATE_STEPS[0];
  await updateParticipant(participant.id, { TripCreationStep: step, TripCreationDraft: '{}' });
  return TRIP_CREATE_PROMPTS[step];
}

// Returns a reply string if this message was consumed as a trip-creation answer, else null
async function handleTripCreationReply(participant, text) {
  const step = participant.fields.TripCreationStep;
  if (!step) return null;

  const trimmed = text.trim();
  const skippable = step === 'planSummary' || step === 'excitementNotes';
  const skipped = skippable && trimmed.toLowerCase() === 'skip';

  if (step === 'code' && !skipped) {
    const existing = await findTripByCode(trimmed);
    if (existing) return `"${trimmed}" is already taken — try a different trip code.`;
  }
  if ((step === 'startDate' || step === 'endDate') && !skipped && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `That doesn't look like YYYY-MM-DD — try again. ${TRIP_CREATE_PROMPTS[step]}`;
  }

  const draft = JSON.parse(participant.fields.TripCreationDraft || '{}');
  if (!skipped) draft[TRIP_CREATE_FIELD_MAP[step]] = trimmed;

  const next = nextTripCreateStep(step);
  if (next) {
    await updateParticipant(participant.id, { TripCreationStep: next, TripCreationDraft: JSON.stringify(draft) });
    return TRIP_CREATE_PROMPTS[next];
  }

  const tripRes = await fetch(`${AIRTABLE_BASE_URL}/Trips`, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({ fields: draft }),
  });
  const trip = await tripRes.json();

  const existingTripIds = (participant.fields.Trips || []).map((t) => (typeof t === 'string' ? t : t.id));
  await updateParticipant(participant.id, {
    TripCreationStep: '',
    TripCreationDraft: '',
    Trips: [...existingTripIds, trip.id],
  });

  return `Trip "${draft.TripCode}" is set up and you're linked to it! Share the code "${draft.TripCode}" so others can /join.`;
}

async function joinTrip(chatId, code) {
  if (!code) return null;
  const trip = await findTripByCode(code);
  if (!trip) return null;

  const participant = await getOrCreateParticipant(chatId);
  const existingTripIds = (participant.fields.Trips || []).map((t) => (typeof t === 'string' ? t : t.id));
  if (!existingTripIds.includes(trip.id)) {
    await fetch(`${AIRTABLE_BASE_URL}/Participants/${participant.id}`, {
      method: 'PATCH',
      headers: airtableHeaders,
      body: JSON.stringify({ fields: { Trips: [...existingTripIds, trip.id] } }),
    });
  }
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

// Returns { ok: true, data } on success, { ok: false, error } if the upload
// itself failed (bad host, bad auth, Airtable-side error, etc.) — callers
// must check `ok` rather than assume the attachment landed.
async function attachMediaToCapture(recordId, base64, contentType, filename) {
  // Attachment uploads are served from a different host than record CRUD.
  const url = `https://content.airtable.com/v0/${AIRTABLE_BASE_ID}/${recordId}/Media/uploadAttachment`;
  const res = await fetch(url, {
    method: 'POST',
    headers: airtableHeaders,
    body: JSON.stringify({ contentType, filename, file: base64 }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    return { ok: false, error: data.error || `HTTP ${res.status}` };
  }
  return { ok: true, data };
}

async function updateCaptureCaption(recordId, caption) {
  await fetch(`${AIRTABLE_BASE_URL}/Captures/${recordId}`, {
    method: 'PATCH',
    headers: airtableHeaders,
    body: JSON.stringify({ fields: { CaptionText: caption } }),
  });
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
// Pending caption tracking — if a photo arrives with no caption, the next
// plain-text message from that chat (within PENDING_CAPTION_WINDOW_MS) is
// treated as its location/description instead of a standalone note.
// In-memory only (matches this app's no-persistence-beyond-Airtable design)
// — lost on restart, and a second captionless photo before the reply lands
// simply replaces the pending target (the first stays uncaptioned).
// ---------------------------------------------------------------------------

const PENDING_CAPTION_WINDOW_MS = 10 * 60 * 1000;
const pendingCaptionByChat = new Map();

function setPendingCaption(chatId, recordId) {
  pendingCaptionByChat.set(chatId, { recordId, expiresAt: Date.now() + PENDING_CAPTION_WINDOW_MS });
}

function takePendingCaption(chatId) {
  const pending = pendingCaptionByChat.get(chatId);
  if (!pending) return null;
  pendingCaptionByChat.delete(chatId);
  if (Date.now() > pending.expiresAt) return null;
  return pending.recordId;
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

    if (text.startsWith('/register')) {
      const prompt = await startRegistration(chatId);
      await sendTelegramMessage(chatId, prompt);
      return;
    }

    if (text.startsWith('/trip') && text.includes('--create')) {
      const prompt = await startTripCreation(chatId);
      await sendTelegramMessage(chatId, prompt);
      return;
    }

    // Mid-wizard reply (plain text, not a command) takes priority over trip logic
    if (text && !text.startsWith('/')) {
      const participant = await findParticipantByChatId(chatId);
      if (participant?.fields.RegistrationStep) {
        const reply = await handleRegistrationReply(participant, text);
        await sendTelegramMessage(chatId, reply);
        return;
      }
      if (participant?.fields.TripCreationStep) {
        const reply = await handleTripCreationReply(participant, text);
        await sendTelegramMessage(chatId, reply);
        return;
      }
    }

    const resolved = await resolveTripForChat(chatId);
    if (resolved.ambiguous) {
      const codes = resolved.trips.map((t) => t.fields.TripCode).join(', ');
      await sendTelegramMessage(
        chatId,
        `This chat is linked to more than one active trip right now (${codes}) — I can't tell which one this is for. Let me know which trip before sending more.`
      );
      return;
    }
    const trip = resolved.trip;
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
      const attachResult = await attachMediaToCapture(
        record.id,
        buffer.toString('base64'),
        isImageDoc ? doc.mime_type : 'image/jpeg',
        `capture_${Date.now()}.jpg`
      );
      if (!attachResult.ok) {
        console.error('Media attach failed:', JSON.stringify(attachResult.error));
        await sendTelegramMessage(
          chatId,
          "⚠️ I saved your note but the photo itself failed to upload — can you resend it? (If this keeps happening, let the trip organizer know.)"
        );
        return;
      }
      if (message.caption) {
        await sendTelegramMessage(chatId, '📸 Got it, saved.');
      } else {
        setPendingCaption(chatId, record.id);
        await sendTelegramMessage(chatId, "📸 Got it! Where was this / what was it? (or just keep going, no rush)");
      }
      return;
    }

    // Text only, not a command -> answer to today's open questions, the location/description
    // for a just-sent uncaptioned photo, or a loose note, in that priority order
    if (text) {
      const openQA = await getOpenDailyQA(trip.id, date);
      if (openQA) {
        await appendAnswer(openQA.id, openQA.fields.RepliesRaw, text);
        return;
      }
      const pendingRecordId = takePendingCaption(chatId);
      if (pendingRecordId) {
        await updateCaptureCaption(pendingRecordId, text);
        await sendTelegramMessage(chatId, `📍 Tagged: ${text}`);
        return;
      }
      await createCaptureRecord({ tripId: trip.id, date, timestamp, caption: text, mediaType: 'note' });
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

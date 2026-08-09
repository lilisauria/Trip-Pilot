# Trip Pilot — Telegram trip journaling bot

Trip Pilot turns a Telegram chat into a lightweight, low-friction trip diary.
People traveling together send photos, receipts, and notes to the bot as
they happen — no app to install, no manual journaling in the moment. At the
end of each day, the bot reviews what came in, clusters it into "moments,"
and asks Claude to generate a short set of targeted questions that surface
the details a photo alone can't capture (why you picked that restaurant,
whose idea a detour was, how something differed from the plan). Replies to
those questions get appended to that day's record. The result, over the
course of a trip, is a structured, dated log of captures plus the texture
and reasoning behind them — raw material for a trip recap, without anyone
having to sit down and write one.

## Purpose

The core problem this solves: in-the-moment trip photos capture *what*
happened but not *why* it mattered — and by the time anyone sits down to
write about the trip, that context is gone. Trip Pilot captures the
context immediately, passively, through a channel people already have open
constantly (Telegram), and does the effortful part (asking good questions,
at the right time, about the right things) automatically.

It is intentionally minimal: there's no dashboard, no separate app, and no
onboarding beyond a couple of chat commands. All persistent data lives in
Airtable, which also functions as the review/export surface.

## How it works — end to end

1. **A trip gets created.** Either pre-populated directly in Airtable, or
   created from inside Telegram with `/trip --create` (see below).
2. **People join a trip.** Anyone texts `/join <trip code>` to the bot.
   This links their Telegram chat to that trip. A chat can be linked to
   multiple trips, and a trip can have multiple participant chats — see
   [Data model](#data-model).
3. **Captures happen passively.** Throughout the trip, participants send
   photos, receipt images (as a file for full quality), or short text notes
   directly to the bot, whenever. Each is saved as a `Captures` row in
   Airtable, tagged with a timestamp; the bot just acknowledges with
   "📸 Got it, saved."
4. **End of day, someone texts `DONE`.** The bot pulls every capture from
   that trip for the current date, groups them into clusters (a new cluster
   starts whenever there's a >90 minute gap since the last capture — a
   proxy for "a new activity/location"), and sends the clusters (images +
   captions) to Claude along with the trip's baseline plan and
   pre-trip excitement notes. Claude returns 1–5 short, specific questions
   per cluster, prioritized in this order: did this deviate from the plan,
   who chose/decided it, why this choice over the alternative — falling
   back to a mood/sensory question only if none of those fit. The bot
   sends the question list back to the chat.
5. **People answer whenever.** Any plain-text reply to an open question set
   gets appended (as raw, unparsed text — no per-question mapping yet) to
   that day's `DailyQA` record, and the record is marked `answered`.

## Commands

| Command | What it does |
|---|---|
| `/start` | Greets the user and points them at `/join`. |
| `/join <trip code>` | Links this chat to the trip with that code (creates a `Participants` record for this chat if one doesn't exist yet, and adds the trip to it). Replies with confirmation or "code not recognized." |
| `/register` | Starts a short step-by-step profile wizard for this chat: name → timezone → bio (bio is skippable by replying `skip`). Answers are saved to that chat's `Participants` record. Re-running `/register` restarts the wizard and overwrites previous answers. |
| `/trip --create` | Starts a step-by-step wizard to create a brand-new trip from inside Telegram: trip code (must be unique) → start date → end date → plan summary (skippable) → excitement notes (skippable). On completion, creates the `Trips` record and automatically links the creating chat to it — no separate `/join` needed afterward. |
| *(photo / image file)* | Saves the image as a `Captures` row tagged to today's date, attached via Airtable's upload endpoint. Photos sent as a normal Telegram "photo" are compressed by Telegram itself; send as a **file/document** to preserve full quality (useful for receipts). |
| *(plain text)* | If there's an open (unanswered) question set for today, the text is appended as an answer. Otherwise, it's saved as a standalone note-type `Captures` row. |
| `DONE` (any case) | Triggers the end-of-day flow: pulls today's captures, clusters them, generates questions via Claude, saves and sends them. If no captures exist yet for today, the bot says so instead of proceeding. |
| `GET /health` | Not a Telegram command — an HTTP endpoint (`/health`) that returns `ok`, used for uptime checks. |

A message that arrives mid-`/register` or mid-`/trip --create` (i.e., the
chat has an in-progress wizard step recorded) is always interpreted as an
answer to that wizard, regardless of trip state — it takes priority over
everything else except other slash commands.

## Data model (Airtable)

The base has four tables. Trip ↔ chat membership is a genuine many-to-many
relationship via a join table (`Participants`), **not** a field directly on
`Trips` — a single chat can be linked to multiple trips, and a single trip
can have multiple participant chats.

### `Trips`
One row per trip.

| Field | Type | Notes |
|---|---|---|
| `TripCode` | Single line text | Unique code people `/join` with. |
| `PlanSummary` | Long text | Baseline plan, fed to Claude as context. |
| `ExcitementNotes` | Long text | What participants said they were looking forward to; also fed to Claude. |
| `StartDate` / `EndDate` | Date | Define the trip's active window. |
| `Captures` | Link to `Captures` | Auto-populated reverse link. |
| `DailyQA` | Link to `DailyQA` | Auto-populated reverse link. |
| `Participants` | Link to `Participants` | Auto-created reverse link from `Participants.Trips`. |
| `ParticipantChatIDs` | Lookup (`Participants.ChatID`, via the `Participants` link) | Rollup of every linked chat's ID — this is what chat-resolution queries against. |
| `Active` | Checkbox | Currently unused/reserved for future use. |

**Chat → trip resolution**: a chat's current trip for capture/DONE
purposes is resolved by finding the `Trips` record where
`ParticipantChatIDs` contains that chat's ID **and** today's date falls
within `StartDate`–`EndDate`. If that matches more than one trip at once,
the bot explicitly tells the chat it's ambiguous and refuses to log a
capture or DailyQA write until resolved, rather than guessing.

### `Participants`
One row per (chat), holding profile data and trip membership.

| Field | Type | Notes |
|---|---|---|
| `ChatID` | Single line text | The Telegram chat ID; effectively the participant's identity. |
| `Name` | Single line text | Set via `/register`. |
| `Timezone` | Single line text | Set via `/register`; free text, not currently used in any date logic. |
| `Bio` | Long text | Set via `/register`; not yet fed into question generation. |
| `Trips` | Link to `Trips` | The many-to-many join — every trip this chat has joined. |
| `RegistrationStep` | Single line text | Internal wizard state for `/register` (`name`/`timezone`/`bio`, blank when not registering). |
| `TripCreationStep` | Single line text | Internal wizard state for `/trip --create` (`code`/`startDate`/`endDate`/`planSummary`/`excitementNotes`, blank when not creating a trip). |
| `TripCreationDraft` | Long text | JSON blob holding in-progress trip-creation answers until the `Trips` record is actually created. |

### `Captures`
One row per incoming photo/receipt/note.

| Field | Type | Notes |
|---|---|---|
| `TripID` | Link to `Trips` | |
| `Date` | Single line text | `YYYY-MM-DD`, used for daily filtering. |
| `Timestamp` | Single line text | ISO timestamp, used for clustering. |
| `Media` | Attachment | Populated via Airtable's `uploadAttachment` endpoint (photos/files only). |
| `CaptionText` | Long text | Telegram caption or note text, if any. |
| `MediaType` | Single select | `photo`, `note`. |

### `DailyQA`
One row per trip per day, created when `DONE` is texted.

| Field | Type | Notes |
|---|---|---|
| `TripID` | Link to `Trips` | |
| `Date` | Single line text | `YYYY-MM-DD` |
| `QuestionsJSON` | Long text | Raw JSON returned by Claude. |
| `RepliesRaw` | Long text | Free-text replies appended as they arrive (not mapped to individual questions). |
| `Status` | Single select | `sent`, `answered`. |

## Architecture

- **`server.js`** — the entire application: a single Express server exposing
  one webhook (`POST /webhook/telegram`) and one health check
  (`GET /health`). No database of its own — Airtable is the only
  persistence layer, accessed directly via its REST API (no SDK).
- **Telegram Bot API** — inbound messages arrive via webhook; outbound
  replies and file downloads go through `api.telegram.org`.
- **Airtable** — system of record for trips, participants, captures, and
  daily Q&A. Also doubles as the human-facing review UI (no separate admin
  panel exists).
- **Claude (Anthropic API)** — generates the daily question sets from
  clustered captures (images + captions) and trip context. Model:
  `claude-sonnet-5`.

No queue, no background workers, no retry logic — every webhook call does
its work synchronously (fire-and-forget after the initial `200` ack to
Telegram) and errors are simply logged.

## Setup

### 1. Create the bot (~2 min)
1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, give it a name and a username (must end in `bot`).
3. BotFather returns a token like `123456789:AA...` — this is
   `TELEGRAM_BOT_TOKEN`.

### 2. Airtable
Create a base with the four tables described above (or use the Metadata
API — see `airtable-schema.md` for the original single-participant schema
this evolved from; the many-to-many `Participants` table described here is
the current source of truth). Get a Personal Access Token from
[airtable.com/create/tokens](https://airtable.com/create/tokens) scoped to
this base with at least `data.records:read`, `data.records:write`,
`schema.bases:read`, and `schema.bases:write` (the write/schema scopes are
only needed if you're managing schema changes via the API rather than the
UI).

### 3. Anthropic API key
A standard server-side key from console.anthropic.com.

### 4. Environment variables
```
TELEGRAM_BOT_TOKEN=
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
ANTHROPIC_API_KEY=
PORT=3000
```

### 5. Install & run
```bash
npm install
npm start
```
Any always-on Node host works (Render, Railway, Fly.io).

### 6. Point Telegram at your webhook
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-deployed-url>/webhook/telegram"
```
Expect `{"ok":true,"result":true,...}` back.

### 7. Create a trip and test
Text your bot `/trip --create` and follow the prompts (or pre-create a
`Trips` row in Airtable directly). Then `/join <code>`, send a couple of
test photos, text `DONE`, and confirm the question list comes back and the
data landed correctly in Airtable.

## Known limitations

- **Answer alignment is manual-ish** — replies to a day's questions are
  appended as one raw text blob, not mapped to individual questions.
- **No retry/dedup logic** on the Claude call or any Airtable write — a
  failed request is just logged and dropped.
- **Clustering is naive** — pure time-gap (90 minutes), no location signal.
- **`Timezone` and `Bio` are captured but not yet used** — day boundaries
  are computed from server time (`todayISO()`), not per-participant
  timezone, and `Bio` isn't fed into question generation yet.
- **A photo sent with a caption while a `/register` or `/trip --create`
  wizard is in progress** has its caption consumed as a wizard answer —
  the photo itself is not processed in that case.
- **The `Active` field on `Trips`** exists but isn't used by any current
  logic — reserved for future use.
- **No auth beyond the trip code** — anyone who knows a trip code can
  `/join` it.

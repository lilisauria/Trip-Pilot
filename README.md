# Trip Pilot — Telegram capture + question generation

Same pilot as the WhatsApp version, on Telegram instead. Simpler to stand up:
no sandbox, no join-code expiry, no approval process — a bot is live the
moment you create it.

## How it works

1. You create a Telegram bot (via @BotFather) and pre-create a `Trips` row
   with a `TripCode`.
2. Your friends text `/join <code>` to the bot once — this links their
   Telegram chat to that Trip row.
3. Photos/receipts sent any time → downloaded and saved to `Captures`, bot
   replies "📸 Got it, saved." No AI call yet.
4. Texting **DONE** → pulls today's captures, clusters by time gap, sends to
   Claude with the trip baseline, saves + sends back the questions.
5. Replies after that get appended as raw text against that day's `DailyQA`
   record.

## Setup

### 1. Create the bot (~2 min)
1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, give it a name and a username (must end in `bot`, e.g.
   `bretagne_trip_bot`).
3. BotFather gives you a token like `123456789:AA...` — this is
   `TELEGRAM_BOT_TOKEN`.

### 2. Airtable
Follow `airtable-schema.md`. Add the `Trips` row with a `TripCode` **before**
your friends leave, so `/join` has something to match against.

### 3. Anthropic API key
Standard server-side key from console.anthropic.com.

### 4. Deploy
```bash
cd trip-pilot-telegram
cp .env.example .env   # fill in real values
npm install
npm start
```
Any always-on Node host works (Render, Railway, Fly.io).

### 5. Point Telegram at your webhook
Once deployed, register the webhook with one call (no dashboard step, unlike
Twilio):
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-deployed-url>/webhook/telegram"
```
You should get back `{"ok":true,"result":true,...}`.

### 6. Have them join
Tell your friends: open Telegram, search for your bot's username, hit Start,
then send `/join bretagne2026` (or whatever code you set). They should get a
confirmation back immediately.

### 7. Test before they leave
Send yourself (via the bot) a couple of test photos, text `done`, confirm
the question list comes back. Check the Airtable base to confirm the photo
and questions landed correctly.

## Differences from the WhatsApp/Twilio version

- **Identification**: chat ID + `/join` code instead of phone number lookup
  — Telegram doesn't expose a phone number by default.
- **No session/sandbox expiry** to manage.
- **Photo quality**: Telegram compresses images sent as a normal "photo."
  If receipt legibility matters, tell them to send receipts as a **file**
  (attach → file, not photo) — the bot already handles both.
- **Free, no approval process** — nothing to wait on before going live.

## Known limits (same as the WhatsApp version)

- Answer alignment is manual-ish — one raw text blob per day, not mapped to
  individual questions.
- No retry/dedup logic on the Claude call or Airtable writes.
- Clustering is naive (pure time-gap, no location signal).

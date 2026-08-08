# Airtable base: `TripPilot`

Same three-table structure as the WhatsApp version, with one change: `Trips`
is keyed by a join code + Telegram chat ID instead of a phone number.

## Trips
One row per trip/couple. Create this row **before** the trip starts.

| Field | Type | Notes |
|---|---|---|
| TripCode | Single line text | A word your friends will text to link up, e.g. `bretagne2026` |
| TelegramChatID | Single line text | Leave blank — filled in automatically when they text `/join <code>` |
| PlanSummary | Long text | Baseline plan from the pre-trip Frame step |
| ExcitementNotes | Long text | What they said they were looking forward to |
| StartDate | Date | |
| EndDate | Date | |

## Captures
One row per incoming photo/receipt/note. Identical to the WhatsApp version.

| Field | Type | Notes |
|---|---|---|
| TripID | Link to Trips | |
| Date | Single line text | `YYYY-MM-DD`, used for daily filtering |
| Timestamp | Single line text | ISO timestamp, used for clustering |
| Media | Attachment | Populated via Airtable's uploadAttachment endpoint |
| CaptionText | Long text | Telegram caption text, if any |
| MediaType | Single select | `photo`, `note` |

## DailyQA
One row per trip per day, created when "done" is texted. Identical to the WhatsApp version.

| Field | Type | Notes |
|---|---|---|
| TripID | Link to Trips | |
| Date | Single line text | `YYYY-MM-DD` |
| QuestionsJSON | Long text | Raw JSON returned by Claude |
| RepliesRaw | Long text | Free-text replies appended as they arrive |
| Status | Single select | `sent`, `answered` |

## Notes
- Get your Airtable Personal Access Token from airtable.com/create/tokens
  with `data.records:read` and `data.records:write` scopes on this base.
- `AIRTABLE_BASE_ID` is the `appXXXXXXXX` string from the base's API docs.

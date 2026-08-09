require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const { AIRTABLE_API_KEY, AIRTABLE_BASE_ID } = process.env;

const AIRTABLE_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  'Content-Type': 'application/json',
};

async function fetchAllRecords(table) {
  let records = [];
  let offset;
  do {
    const url = `${AIRTABLE_BASE_URL}/${table}${offset ? `?offset=${offset}` : ''}`;
    const res = await fetch(url, { headers: airtableHeaders });
    const data = await res.json();
    if (data.error) throw new Error(`Airtable error fetching ${table}: ${JSON.stringify(data.error)}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function findTripByCode(code) {
  const trips = await fetchAllRecords('Trips');
  return trips.find((t) => t.fields.TripCode === code) || null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function timeLabel(isoTimestamp) {
  const d = new Date(isoTimestamp);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function downloadAttachment(att, destPath) {
  const res = await fetch(att.url);
  const buf = await res.buffer();
  fs.writeFileSync(destPath, buf);
}

function extFromType(type) {
  if (!type) return 'jpg';
  const map = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };
  return map[type] || 'jpg';
}

async function exportTrip(tripCode) {
  const trip = await findTripByCode(tripCode);
  if (!trip) {
    console.error(`No trip found with code "${tripCode}"`);
    process.exit(1);
  }

  const [allCaptures, allDailyQA] = await Promise.all([
    fetchAllRecords('Captures'),
    fetchAllRecords('DailyQA'),
  ]);

  const captures = allCaptures
    .filter((r) => (r.fields.TripID || []).includes(trip.id))
    .sort((a, b) => new Date(a.fields.Timestamp) - new Date(b.fields.Timestamp));

  const dailyQAByDate = {};
  for (const r of allDailyQA) {
    if ((r.fields.TripID || []).includes(trip.id)) {
      dailyQAByDate[r.fields.Date] = r.fields;
    }
  }

  const outDir = path.join(__dirname, 'exports', tripCode);
  const imagesDir = path.join(outDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const byDate = {};
  for (const c of captures) {
    const date = c.fields.Date || 'unknown-date';
    (byDate[date] = byDate[date] || []).push(c);
  }
  const dates = Object.keys(byDate).sort();

  let md = `# ${trip.fields.TripCode}\n\n`;
  md += `${trip.fields.StartDate || '?'} — ${trip.fields.EndDate || '?'}\n\n`;
  if (trip.fields.PlanSummary) md += `**Plan:** ${trip.fields.PlanSummary}\n\n`;
  if (trip.fields.ExcitementNotes) md += `**Looking forward to:** ${trip.fields.ExcitementNotes}\n\n`;
  md += `---\n\n`;

  const jsonOut = { trip: trip.fields, days: [] };

  for (const date of dates) {
    md += `## ${date}\n\n`;
    const dayJson = { date, items: [], qa: null };

    for (const c of byDate[date]) {
      const f = c.fields;
      const time = f.Timestamp ? timeLabel(f.Timestamp) : '??:??';
      const item = { time, type: f.MediaType, caption: f.CaptionText || '', image: null };

      if (f.Media?.length) {
        const att = f.Media[0];
        const ext = extFromType(att.type);
        const filename = `${date}_${time.replace(':', '')}_${c.id}.${ext}`;
        await downloadAttachment(att, path.join(imagesDir, filename));
        item.image = `images/${filename}`;
        md += `**${time}** — ![](images/${filename})\n`;
        md += f.CaptionText ? `Location/note: ${f.CaptionText}\n\n` : `_(no location noted)_\n\n`;
      } else {
        md += `**${time}** — ${f.CaptionText || '_(empty note)_'}\n\n`;
      }
      dayJson.items.push(item);
    }

    const qa = dailyQAByDate[date];
    if (qa) {
      md += `**Day wrap-up Q&A:**\n\n`;
      let questions = [];
      try {
        const parsed = JSON.parse(qa.QuestionsJSON || '{}');
        for (const cluster of parsed.clusters || []) {
          for (const q of cluster.questions || []) questions.push(q.text);
        }
      } catch (e) {
        // ignore malformed QuestionsJSON
      }
      questions.forEach((q, i) => (md += `${i + 1}. ${q}\n`));
      md += `\nReplies (raw, not mapped to individual questions):\n> ${(qa.RepliesRaw || '').split('\n').join('\n> ')}\n\n`;
      dayJson.qa = { questions, repliesRaw: qa.RepliesRaw || '' };
    }

    md += `---\n\n`;
    jsonOut.days.push(dayJson);
  }

  fs.writeFileSync(path.join(outDir, 'manuscript.md'), md);
  fs.writeFileSync(path.join(outDir, 'manuscript.json'), JSON.stringify(jsonOut, null, 2));

  console.log(`Exported ${captures.length} captures across ${dates.length} days.`);
  console.log(`-> ${path.join(outDir, 'manuscript.md')}`);
  console.log(`-> ${path.join(outDir, 'manuscript.json')}`);
  console.log(`-> ${imagesDir}/ (${captures.filter((c) => c.fields.Media?.length).length} images)`);
}

const tripCode = process.argv[2];
if (!tripCode) {
  console.error('Usage: node export-trip.js <tripCode>');
  process.exit(1);
}

exportTrip(tripCode).catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

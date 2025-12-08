// parsePowerOn.js
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const TZ = '+02:00'; // Europe/Kyiv

function parseUkDate(dateStr) {
  const [dd, mm, yyyy] = dateStr.split('.');
  return { year: Number(yyyy), month: Number(mm), day: Number(dd) };
}

function makeIso({ year, month, day }, timeStr) {
  let [hhStr, mmStr] = timeStr.split(':');
  let hh = Number(hhStr);
  const mm = Number(mmStr);

  if (hh === 24) {
    hh = 0;
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + 1);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:00${TZ}`;
}

function parseScheduleFromHtml(html) {
  const $ = cheerio.load(html);

  const ps = $('.power-off__text p')
    .toArray()
    .map((p) => $(p).text().trim());

  if (ps.length < 3) throw new Error('Не знайшов достатньо <p>');

  const dateMatch = ps[0].match(/на\s+(\d{2}\.\d{2}\.\d{4})/);
  if (!dateMatch) throw new Error('Не вдалося розпізнати дату графіка');

  const scheduleDate = parseUkDate(dateMatch[1]);

  const updatedMatch =
    ps[1].match(/станом на\s+(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})/);
  let updatedIso = null;
  if (updatedMatch) {
    const [, timeStr, updatedDateStr] = updatedMatch;
    updatedIso = makeIso(parseUkDate(updatedDateStr), timeStr);
  }

  const groups = {};

  for (let i = 2; i < ps.length; i++) {
    const line = ps[i];
    if (!line.startsWith('Група')) continue;

    const m = line.match(
      /^Група\s+(\d\.\d)\.\s+Електроенергії немає\s+(.+)\.$/,
    );

    if (!m) continue;

    const [, groupId, intervalsPart] = m;

    const intervalStrings = intervalsPart.split(',').map((s) => s.trim());

    const intervals = [];
    for (const s of intervalStrings) {
      const mm = s.match(/з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/);
      if (!mm) continue;
      const [, startTime, endTime] = mm;
      intervals.push({
        start: makeIso(scheduleDate, startTime),
        end: makeIso(scheduleDate, endTime),
      });
    }

    groups[groupId] = intervals;
  }

  const yy = scheduleDate.year;
  const mm = String(scheduleDate.month).padStart(2, '0');
  const dd = String(scheduleDate.day).padStart(2, '0');

  return {
    date: `${yy}-${mm}-${dd}`,
    updated_at: updatedIso,
    groups,
  };
}

function isoToIcalDateTime(isoString) {
  // Convert "2025-12-08T00:00:00+02:00" to "20251208T000000"
  // Remove dashes, colons, and timezone offset
  return isoString.replace(/[-:]/g, '').replace(/\+.*$/, '').replace(/Z$/, '');
}

function generateIcalForGroup(groupId, intervals, scheduleDate) {
  const lines = [];
  
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//LOE Power Off//Group ' + groupId + '//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  
  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i];
    const dtstart = isoToIcalDateTime(interval.start);
    const dtend = isoToIcalDateTime(interval.end);
    const uid = `${scheduleDate}-${groupId}-${i}@loe-poweroff`;
    
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTART:${dtstart}`);
    lines.push(`DTEND:${dtend}`);
    lines.push(`SUMMARY:Відключення електроенергії (Група ${groupId})`);
    lines.push(`DESCRIPTION:Група ${groupId}. Електроенергії немає з ${interval.start.substring(11, 16)} до ${interval.end.substring(11, 16)}`);
    lines.push(`DTSTAMP:${isoToIcalDateTime(new Date().toISOString())}`);
    lines.push('END:VEVENT');
  }
  
  lines.push('END:VCALENDAR');
  
  return lines.join('\r\n') + '\r\n';
}

async function saveIcalCalendars(data) {
  const calDir = path.join(process.cwd(), 'docs', 'cal');
  
  // Create cal directory if it doesn't exist
  try {
    await fs.mkdir(calDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  
  // Generate iCal file for each group
  for (const [groupId, intervals] of Object.entries(data.groups)) {
    const icalContent = generateIcalForGroup(groupId, intervals, data.date);
    const fileName = `${groupId}.ics`;
    const filePath = path.join(calDir, fileName);
    
    await fs.writeFile(filePath, icalContent, 'utf-8');
    console.log(`Saved iCal calendar: ${fileName}`);
  }
}

async function saveData(data) {
  const dataDir = path.join(process.cwd(), 'docs', 'data');
  
  // Create data directory if it doesn't exist
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  const latestPath = path.join(dataDir, 'latest.json');
  
  // Check if latest.json exists and compare updated_at
  let shouldSaveLatest = true;
  try {
    const existingContent = await fs.readFile(latestPath, 'utf-8');
    const existingData = JSON.parse(existingContent);
    
    if (existingData.updated_at === data.updated_at) {
      shouldSaveLatest = false;
      console.log('Skipping latest.json write: updated_at unchanged');
    }
  } catch (error) {
    // File doesn't exist or is invalid, proceed with saving
    if (error.code !== 'ENOENT') {
      console.warn('Error reading latest.json:', error.message);
    }
  }

  // Save to latest.json if updated_at changed
  if (shouldSaveLatest) {
    await fs.writeFile(latestPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('Saved to latest.json');
  }

  // Always save to date-specific file
  const datePath = path.join(dataDir, `${data.date}.json`);
  await fs.writeFile(datePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Saved to ${data.date}.json`);
  
  // Generate iCal calendars for all groups
  await saveIcalCalendars(data);
  
  // Generate HTML index page
  await generateIndexPage(data);
}

function formatTime(isoString) {
  // Extract time from ISO string like "2025-12-08T00:00:00+02:00"
  const match = isoString.match(/T(\d{2}):(\d{2})/);
  if (!match) return isoString;
  return match[1] + ':' + match[2];
}

async function generateIndexPage(data) {
  const docsDir = path.join(process.cwd(), 'docs');
  
  // Create docs directory if it doesn't exist
  try {
    await fs.mkdir(docsDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  
  const groups = Object.keys(data.groups).sort();
  
  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LOE Power Off - Графіки відключення електроенергії</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.4;
      color: #333;
      background: #f5f5f5;
      padding: 0.75rem;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
      background: white;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.1);
      padding: 1rem 1.25rem;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 0.75rem;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    h1 {
      color: #2c3e50;
      font-size: 1.5rem;
      font-weight: 600;
    }
    .schedule-info {
      color: #7f8c8d;
      font-size: 0.85rem;
    }
    .schedule-info strong { color: #2c3e50; }
    .description {
      background: #e8f4f8;
      padding: 0.75rem;
      border-radius: 4px;
      margin-bottom: 0.75rem;
      font-size: 0.85rem;
      color: #2c3e50;
      line-height: 1.5;
    }
    .data-link {
      margin-bottom: 0.75rem;
      text-align: center;
    }
    .data-link .link {
      display: inline-block;
    }
    .groups {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .group-card {
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 0.6rem 0.75rem;
      background: #fafafa;
      display: flex;
      flex-direction: column;
    }
    .group-card.has-current {
      border-color: #e74c3c;
      background: #fff5f5;
    }
    .group-card.has-current .group-title {
      color: #e74c3c;
    }
    .group-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: #2c3e50;
      margin-bottom: 0.5rem;
    }
    .intervals {
      font-size: 0.75rem;
      color: #555;
      margin-bottom: 0.5rem;
      line-height: 1.5;
      flex-grow: 1;
    }
    .interval-item {
      margin-bottom: 0.25rem;
    }
    .interval-item.past {
      color: #999;
      opacity: 0.6;
    }
    .interval-item.current {
      font-weight: bold;
      color: #2c3e50;
    }
    .group-links {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      margin-top: auto;
    }
    .group-links .link {
      width: 100%;
    }
    .link {
      display: inline-block;
      padding: 0.35rem 0.6rem;
      background: #3498db;
      color: white;
      text-decoration: none;
      border-radius: 3px;
      font-size: 0.8rem;
      transition: background 0.15s;
      text-align: center;
    }
    .link:hover { background: #2980b9; }
    .link.ics { background: #27ae60; }
    .link.ics:hover { background: #229954; }
    .link.data { background: #9b59b6; }
    .link.data:hover { background: #8e44ad; }
    footer {
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid #ddd;
      text-align: center;
      color: #7f8c8d;
      font-size: 0.8rem;
    }
    footer a {
      color: #3498db;
      text-decoration: none;
    }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>LOE Power Off</h1>
      <div class="schedule-info">
        <strong>Дата:</strong> ${data.date}${data.updated_at ? ` | <strong>Оновлено:</strong> ${new Date(data.updated_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
      </div>
    </header>
    <div class="description">
      <strong>Як користуватися:</strong> Перегляньте графік відключень для вашої групи нижче. Натисніть на посилання "ICS", щоб додати календар відключень до вашого календарного додатку (Google Calendar, Apple Calendar, Outlook тощо). Також можна завантажити всі дані у форматі JSON для програмного використання.
    </div>
    <div class="data-link">
      <a href="data/latest.json" class="link data">📊 Завантажити всі дані (JSON)</a>
    </div>
    <div class="groups">
${groups.map(groupId => {
  const intervals = data.groups[groupId];
  const intervalsHtml = intervals.length > 0 
    ? `<div class="intervals">${intervals.map(interval => 
        `<div class="interval-item">${formatTime(interval.start)} — ${formatTime(interval.end)}</div>`
      ).join('')}</div>`
    : '';
  return `      <div class="group-card">
        <div class="group-title">Група ${groupId}</div>
        ${intervalsHtml}
        <div class="group-links">
          <a href="cal/${groupId}.ics" class="link ics">📅 ICS</a>
        </div>
      </div>`;
}).join('\n')}
    </div>
    <footer>
      <a href="https://github.com/osuhol/loe-poweroff" target="_blank" rel="noopener noreferrer">GitHub</a>
    </footer>
  </div>
  <script>
    (function() {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      
      function parseTime(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return new Date(today.getTime() + hours * 60 * 60 * 1000 + minutes * 60 * 1000);
      }
      
      function parseInterval(intervalText) {
        // Split on em dash, en dash, or hyphen
        const parts = intervalText.split(/[—–-]/).map(s => s.trim());
        if (parts.length !== 2) return null;
        
        const [startStr, endStr] = parts;
        // Validate format HH:MM
        if (!/^\d{2}:\d{2}$/.test(startStr) || !/^\d{2}:\d{2}$/.test(endStr)) return null;
        
        const startTime = parseTime(startStr);
        let endTime = parseTime(endStr);
        
        if (endTime <= startTime) {
          endTime = new Date(endTime.getTime() + 24 * 60 * 60 * 1000);
        }
        
        return { start: startTime, end: endTime };
      }
      
      function updateIntervals() {
        const now = new Date();
        const currentTime = now.getTime();
        const intervalItems = document.querySelectorAll('.interval-item');
        const groupCards = document.querySelectorAll('.group-card');
        
        // Reset group cards
        groupCards.forEach(card => {
          card.classList.remove('has-current');
        });
        
        intervalItems.forEach(item => {
          const interval = parseInterval(item.textContent);
          if (!interval) return;
          
          const startTime = interval.start.getTime();
          const endTime = interval.end.getTime();
          
          item.classList.remove('past', 'current');
          
          if (currentTime < startTime) {
            // Future period - no special styling
          } else if (currentTime >= startTime && currentTime < endTime) {
            // Current period
            item.classList.add('current');
            // Mark parent group card as having current interval
            const groupCard = item.closest('.group-card');
            if (groupCard) {
              groupCard.classList.add('has-current');
            }
          } else {
            // Past period
            item.classList.add('past');
          }
        });
      }
      
      updateIntervals();
      
      // Update every minute
      setInterval(updateIntervals, 60000);
    })();
  </script>
</body>
</html>`;
  
  const indexPath = path.join(docsDir, 'index.html');
  await fs.writeFile(indexPath, html, 'utf-8');
  console.log('Generated index.html');
  
  // Create .nojekyll file to disable Jekyll processing on GitHub Pages
  const nojekyllPath = path.join(docsDir, '.nojekyll');
  await fs.writeFile(nojekyllPath, '', 'utf-8');
  console.log('Created .nojekyll file');
}

/* ---------------------------------------------------
   MAIN: тягнемо HTML напряму з Інтернету
--------------------------------------------------- */
async function main() {
    const URL = 'https://poweron.loe.lviv.ua/';
  
    const browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    const page = await browser.newPage();

    await page.goto(URL, {
        waitUntil: "networkidle0"
    });

    const html = await page.content(); // тут вже є всі <p>
    const data = parseScheduleFromHtml(html);

    console.log(data);
    
    await saveData(data);
    
    await browser.close();
  }
  
  main(); // ← ESM-спосіб запуску
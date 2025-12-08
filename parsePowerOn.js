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
  const calDir = path.join(process.cwd(), 'cal');
  
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
  const dataDir = path.join(process.cwd(), 'data');
  
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
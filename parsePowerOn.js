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
  console.log('[PARSE] Starting HTML parsing...');
  console.log(`[PARSE] HTML length: ${html.length} characters`);
  
  const $ = cheerio.load(html);

  const ps = $('.power-off__text p')
    .toArray()
    .map((p) => $(p).text().trim());

  console.log(`[PARSE] Found ${ps.length} paragraph elements`);
  if (ps.length > 0) {
    console.log('[PARSE] First few paragraphs:', ps.slice(0, 5).map((p, i) => `[${i}] ${p.substring(0, 100)}`));
  }

  if (ps.length < 3) {
    console.error('[PARSE] ERROR: Not enough <p> elements found');
    throw new Error('Не знайшов достатньо <p>');
  }

  // Find all date sections
  const dateSections = [];
  let currentSection = null;
  let lastDateIndex = -1;

  console.log('[PARSE] Searching for date sections...');
  
  for (let i = 0; i < ps.length; i++) {
    const line = ps[i];
    
    // Check if this is a date header: "Графік погодинних відключень на DD.MM.YYYY" or just "на DD.MM.YYYY"
    const dateMatch = line.match(/(?:Графік погодинних відключень\s+)?на\s+(\d{2}\.\d{2}\.\d{4})/);
    if (dateMatch) {
      console.log(`[PARSE] Found date header at line ${i}: "${line}"`);
      
      // Save previous section if exists
      if (currentSection) {
        const groupCount = Object.keys(currentSection.groups).length;
        console.log(`[PARSE] Saving previous section with ${groupCount} groups`);
        dateSections.push(currentSection);
      }
      
      // Start new section
      const scheduleDate = parseUkDate(dateMatch[1]);
      console.log(`[PARSE] Starting new section for date: ${scheduleDate.year}-${scheduleDate.month}-${scheduleDate.day}`);
      currentSection = {
        date: scheduleDate,
        groups: {},
        updatedIso: null,
      };
      lastDateIndex = i;
      continue;
    }
    
    // Check if this is an update time line (appears after date header)
    if (currentSection && i === lastDateIndex + 1) {
      const updatedMatch = line.match(/станом на\s+(\d{2}:\d{2})\s+(\d{2}\.\d{2}\.\d{4})/);
      if (updatedMatch) {
        const [, timeStr, updatedDateStr] = updatedMatch;
        currentSection.updatedIso = makeIso(parseUkDate(updatedDateStr), timeStr);
        console.log(`[PARSE] Found update time: ${currentSection.updatedIso}`);
        continue;
      } else {
        console.log(`[PARSE] Line ${i} (expected update time) didn't match pattern: "${line}"`);
      }
    }
    
    // Parse group lines
    if (currentSection && line.startsWith('Група')) {
      const m = line.match(
        /^Група\s+(\d\.\d)\.\s+Електроенергії немає\s+(.+)\.$/,
      );

      if (m) {
        const [, groupId, intervalsPart] = m;
        console.log(`[PARSE] Found group ${groupId} at line ${i}: "${line}"`);
        console.log(`[PARSE] Intervals part: "${intervalsPart}"`);
        
        const intervalStrings = intervalsPart.split(',').map((s) => s.trim());
        console.log(`[PARSE] Split into ${intervalStrings.length} interval string(s):`, intervalStrings);

        const intervals = [];
        for (const s of intervalStrings) {
          const mm = s.match(/з\s+(\d{2}:\d{2})\s+до\s+(\d{2}:\d{2})/);
          if (!mm) {
            console.warn(`[PARSE] WARNING: Could not parse interval string "${s}" for group ${groupId}`);
            continue;
          }
          const [, startTime, endTime] = mm;
          const interval = {
            start: makeIso(currentSection.date, startTime),
            end: makeIso(currentSection.date, endTime),
          };
          console.log(`[PARSE] Parsed interval: ${startTime} -> ${endTime} (ISO: ${interval.start} to ${interval.end})`);
          intervals.push(interval);
        }

        if (intervals.length === 0) {
          console.error(`[PARSE] ERROR: No valid intervals found for group ${groupId} from line: "${line}"`);
        } else {
          console.log(`[PARSE] Successfully parsed ${intervals.length} interval(s) for group ${groupId}`);
        }
        
        currentSection.groups[groupId] = intervals;
      } else {
        console.warn(`[PARSE] WARNING: Line ${i} starts with "Група" but doesn't match expected pattern: "${line}"`);
      }
    }
  }

  // Don't forget the last section
  if (currentSection) {
    const groupCount = Object.keys(currentSection.groups).length;
    console.log(`[PARSE] Saving last section with ${groupCount} groups`);
    dateSections.push(currentSection);
  }

  if (dateSections.length === 0) {
    console.error('[PARSE] ERROR: No date sections found');
    throw new Error('Не знайшов жодного розділу з датою');
  }

  console.log(`[PARSE] Found ${dateSections.length} date section(s)`);
  
  // Convert sections to the expected format
  const result = dateSections.map((section) => {
    const yy = section.date.year;
    const mm = String(section.date.month).padStart(2, '0');
    const dd = String(section.date.day).padStart(2, '0');
    const dateStr = `${yy}-${mm}-${dd}`;
    
    const groupIds = Object.keys(section.groups).sort();
    const totalIntervals = Object.values(section.groups).reduce((sum, intervals) => sum + intervals.length, 0);
    
    console.log(`[PARSE] Section ${dateStr}: ${groupIds.length} groups, ${totalIntervals} total intervals`);
    console.log(`[PARSE] Groups found: ${groupIds.join(', ')}`);
    console.log(`[PARSE] Updated at: ${section.updatedIso || 'NOT SET'}`);
    
    // Log each group's intervals
    for (const [groupId, intervals] of Object.entries(section.groups)) {
      console.log(`[PARSE]   Group ${groupId}: ${intervals.length} interval(s)`);
      intervals.forEach((interval, idx) => {
        console.log(`[PARSE]     [${idx}] ${interval.start.substring(11, 16)} - ${interval.end.substring(11, 16)}`);
      });
    }

    return {
      date: dateStr,
      updated_at: section.updatedIso || null,
      groups: section.groups,
    };
  });
  
  console.log('[PARSE] Parsing complete');
  return result;
}

function getTodayDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDateTodayOrFuture(dateStr) {
  const today = getTodayDate();
  return dateStr >= today;
}

function isoToIcalDateTime(isoString) {
  // Convert "2025-12-08T00:00:00+02:00" to "20251208T000000"
  // Remove dashes, colons, and timezone offset
  return isoString.replace(/[-:]/g, '').replace(/\+.*$/, '').replace(/Z$/, '');
}

function generateVTimezone() {
  // Generate VTIMEZONE for Europe/Kyiv (UTC+2, no DST changes in recent years)
  // Note: Ukraine abolished DST in 2021, so it's permanently UTC+2
  const currentYear = new Date().getFullYear();
  
  return [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Kyiv',
    'BEGIN:STANDARD',
    `DTSTART:${currentYear}0101T000000`,
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0200',
    'TZNAME:EET',
    'END:STANDARD',
    'END:VTIMEZONE'
  ].join('\r\n');
}

function parseExistingIcal(icalContent) {
  const events = {};
  const lines = icalContent.split(/\r?\n/);
  let currentEvent = null;
  
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      currentEvent = {};
    } else if (line.startsWith('END:VEVENT')) {
      if (currentEvent && currentEvent.uid) {
        events[currentEvent.uid] = {
          sequence: currentEvent.sequence || 0,
          dtstart: currentEvent.dtstart,
          dtend: currentEvent.dtend,
          dtstamp: currentEvent.dtstamp,
        };
      }
      currentEvent = null;
    } else if (currentEvent) {
      if (line.startsWith('UID:')) {
        currentEvent.uid = line.substring(4);
      } else if (line.startsWith('SEQUENCE:')) {
        currentEvent.sequence = parseInt(line.substring(9), 10) || 0;
      } else if (line.startsWith('DTSTART')) {
        // Handle both DTSTART: and DTSTART;TZID=Europe/Kyiv: formats
        const match = line.match(/^DTSTART(?:;TZID=[^:]+)?:(.+)$/);
        if (match) {
          currentEvent.dtstart = match[1];
        }
      } else if (line.startsWith('DTEND')) {
        // Handle both DTEND: and DTEND;TZID=Europe/Kyiv: formats
        const match = line.match(/^DTEND(?:;TZID=[^:]+)?:(.+)$/);
        if (match) {
          currentEvent.dtend = match[1];
        }
      } else if (line.startsWith('DTSTAMP:')) {
        currentEvent.dtstamp = line.substring(8);
      }
    }
  }
  
  return events;
}

function generateIcalForGroup(groupId, allIntervalsByDate, existingEvents = {}) {
  const lines = [];
  
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//LOE Power Off//Group ' + groupId + '//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(generateVTimezone());
  
  // Process all dates, sorted chronologically
  const sortedDates = Object.keys(allIntervalsByDate).sort();
  
  for (const scheduleDate of sortedDates) {
    const intervals = allIntervalsByDate[scheduleDate];
    
    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const dtstart = isoToIcalDateTime(interval.start);
      const dtend = isoToIcalDateTime(interval.end);
      const uid = `${scheduleDate}-${groupId}-${i}@loe-poweroff`;
      
      // Determine sequence number and whether event changed
      let sequence = 0;
      let eventChanged = false;
      const existingEvent = existingEvents[uid];
      if (existingEvent) {
        // Event exists - check if it changed
        // Compare with TZID format for existing events
        const existingDtstart = existingEvent.dtstart.replace(/^.*TZID=Europe\/Kyiv:/, '').replace(/^DTSTART:/, '');
        const existingDtend = existingEvent.dtend.replace(/^.*TZID=Europe\/Kyiv:/, '').replace(/^DTEND:/, '');
        if (existingDtstart !== dtstart || existingDtend !== dtend) {
          // Event changed - increment sequence
          sequence = existingEvent.sequence + 1;
          eventChanged = true;
        } else {
          // Event unchanged - keep same sequence
          sequence = existingEvent.sequence;
          eventChanged = false;
        }
      } else {
        // New event - start at 0
        sequence = 0;
        eventChanged = true;
      }
      
      // Use existing DTSTAMP if event unchanged, otherwise generate new one
      const dtstamp = eventChanged || !existingEvent?.dtstamp
        ? isoToIcalDateTime(new Date().toISOString())
        : existingEvent.dtstamp;
      
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`SEQUENCE:${sequence}`);
      lines.push(`DTSTART;TZID=Europe/Kyiv:${dtstart}`);
      lines.push(`DTEND;TZID=Europe/Kyiv:${dtend}`);
      lines.push(`SUMMARY:Відключення електроенергії (Група ${groupId})`);
      lines.push(`DESCRIPTION:Група ${groupId}. Електроенергії немає з ${interval.start.substring(11, 16)} до ${interval.end.substring(11, 16)}`);
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push('END:VEVENT');
    }
  }
  
  lines.push('END:VCALENDAR');
  
  return lines.join('\r\n') + '\r\n';
}

async function loadAllDateFiles() {
  const dataDir = path.join(process.cwd(), 'docs', 'data');
  const today = getTodayDate();
  const allData = {};
  
  try {
    const files = await fs.readdir(dataDir);
    const dateFiles = files.filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.json$/));
    
    for (const file of dateFiles) {
      const dateStr = file.replace('.json', '');
      // Only load today and future dates
      if (dateStr >= today) {
        try {
          const content = await fs.readFile(path.join(dataDir, file), 'utf-8');
          const data = JSON.parse(content);
          allData[dateStr] = data;
        } catch (error) {
          console.warn(`Warning: Could not read date file ${file}:`, error.message);
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Warning: Could not read data directory:`, error.message);
    }
  }
  
  return allData;
}

async function saveIcalCalendars(allDataByDate) {
  console.log('[ICAL] Starting iCal calendar generation...');
  const calDir = path.join(process.cwd(), 'docs', 'cal');
  
  // Create cal directory if it doesn't exist
  try {
    await fs.mkdir(calDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[ICAL] ERROR: Could not create cal directory:`, error.message);
      throw error;
    }
  }
  
  // Collect all groups and their intervals by date (include all dates for cumulative calendars)
  const groupsByDate = {};
  const allGroupIds = new Set();
  
  console.log(`[ICAL] Processing ${Object.keys(allDataByDate).length} date(s)`);
  for (const [dateStr, data] of Object.entries(allDataByDate)) {
    console.log(`[ICAL] Processing date ${dateStr}: ${Object.keys(data.groups).length} groups`);
    for (const [groupId, intervals] of Object.entries(data.groups)) {
      allGroupIds.add(groupId);
      if (!groupsByDate[groupId]) {
        groupsByDate[groupId] = {};
      }
      groupsByDate[groupId][dateStr] = intervals;
      console.log(`[ICAL]   Group ${groupId}: ${intervals.length} interval(s)`);
    }
  }
  
  console.log(`[ICAL] Found ${allGroupIds.size} unique group(s): ${Array.from(allGroupIds).sort().join(', ')}`);
  
  // Generate iCal file for each group
  for (const groupId of allGroupIds) {
    const fileName = `${groupId}.ics`;
    const filePath = path.join(calDir, fileName);
    
    // Read existing ICS file to get current sequence numbers
    let existingEvents = {};
    try {
      const existingContent = await fs.readFile(filePath, 'utf-8');
      existingEvents = parseExistingIcal(existingContent);
      console.log(`[ICAL] Loaded existing ${fileName}: ${Object.keys(existingEvents).length} event(s)`);
    } catch (error) {
      // File doesn't exist or can't be read - start fresh
      if (error.code !== 'ENOENT') {
        console.warn(`[ICAL] WARNING: Could not read existing ICS file ${fileName}:`, error.message);
      } else {
        console.log(`[ICAL] ${fileName} doesn't exist, will create new file`);
      }
    }
    
    const dateCount = Object.keys(groupsByDate[groupId]).length;
    const totalIntervals = Object.values(groupsByDate[groupId]).reduce((sum, intervals) => sum + intervals.length, 0);
    console.log(`[ICAL] Generating ${fileName} with ${dateCount} date(s) and ${totalIntervals} total interval(s)`);
    
    const icalContent = generateIcalForGroup(groupId, groupsByDate[groupId], existingEvents);
    
    await fs.writeFile(filePath, icalContent, 'utf-8');
    console.log(`[ICAL] Saved iCal calendar: ${fileName}`);
  }
  
  console.log('[ICAL] iCal calendar generation complete');
}

function getNextDayOrToday(allDataByDate) {
  const today = getTodayDate();
  const sortedDates = Object.keys(allDataByDate).filter(d => d >= today).sort();
  
  if (sortedDates.length === 0) {
    return null;
  }
  
  // Find next day (first date after today), or use today if no next day
  const todayIndex = sortedDates.indexOf(today);
  if (todayIndex >= 0 && todayIndex < sortedDates.length - 1) {
    // Next day exists
    return allDataByDate[sortedDates[todayIndex + 1]];
  } else {
    // No next day, use today (or first available date)
    return allDataByDate[sortedDates[0]];
  }
}

async function saveData(data) {
  console.log(`[SAVE] Processing data for date: ${data.date}`);
  console.log(`[SAVE] Updated at: ${data.updated_at || 'NOT SET'}`);
  console.log(`[SAVE] Groups: ${Object.keys(data.groups).length}`);
  
  const dataDir = path.join(process.cwd(), 'docs', 'data');
  
  // Create data directory if it doesn't exist
  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[SAVE] ERROR: Could not create data directory:`, error.message);
      throw error;
    }
  }

  const latestPath = path.join(dataDir, 'latest.json');
  
  // Check if latest.json exists and compare updated_at for this specific date
  let shouldSkip = false;
  try {
    const existingContent = await fs.readFile(latestPath, 'utf-8');
    const existingData = JSON.parse(existingContent);
    console.log(`[SAVE] Found existing latest.json with date: ${existingData.date}`);
    
    // Check if this date's data already exists and hasn't changed
    const datePath = path.join(dataDir, `${data.date}.json`);
    try {
      const dateContent = await fs.readFile(datePath, 'utf-8');
      const dateData = JSON.parse(dateContent);
      console.log(`[SAVE] Found existing ${data.date}.json`);
      console.log(`[SAVE] Existing updated_at: ${dateData.updated_at}`);
      console.log(`[SAVE] New updated_at: ${data.updated_at}`);
      
      if (dateData.updated_at === data.updated_at) {
        console.log(`[SAVE] Skipping ${data.date}.json: updated_at unchanged`);
        shouldSkip = true;
      } else {
        console.log(`[SAVE] updated_at changed, will update ${data.date}.json`);
        
        // Compare groups to detect changes
        const existingGroups = Object.keys(dateData.groups).sort();
        const newGroups = Object.keys(data.groups).sort();
        if (JSON.stringify(existingGroups) !== JSON.stringify(newGroups)) {
          console.log(`[SAVE] WARNING: Group list changed!`);
          console.log(`[SAVE]   Existing: ${existingGroups.join(', ')}`);
          console.log(`[SAVE]   New: ${newGroups.join(', ')}`);
        }
      }
    } catch (error) {
      // Date file doesn't exist, proceed
      if (error.code !== 'ENOENT') {
        console.warn(`[SAVE] WARNING: Could not read date file:`, error.message);
      } else {
        console.log(`[SAVE] ${data.date}.json doesn't exist, will create it`);
      }
    }
  } catch (error) {
    // File doesn't exist or is invalid, proceed with saving
    if (error.code !== 'ENOENT') {
      console.warn(`[SAVE] WARNING: Error reading latest.json:`, error.message);
    } else {
      console.log(`[SAVE] latest.json doesn't exist, will create it`);
    }
  }

  // Only save date-specific file if date is today or future
  if (isDateTodayOrFuture(data.date)) {
    if (!shouldSkip) {
      const datePath = path.join(dataDir, `${data.date}.json`);
      await fs.writeFile(datePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[SAVE] Saved to ${data.date}.json`);
      console.log(`[SAVE] Data summary: ${Object.keys(data.groups).length} groups, updated_at: ${data.updated_at}`);
    } else {
      console.log(`[SAVE] Skipped ${data.date}.json (no changes)`);
    }
  } else {
    console.log(`[SAVE] Skipping ${data.date}.json: date is in the past`);
    if (shouldSkip) {
      return;
    }
  }

  // Load all date files (today + future) to determine which day to use for latest.json
  const allDataByDate = await loadAllDateFiles();
  
  // Add/update the current data
  if (isDateTodayOrFuture(data.date)) {
    allDataByDate[data.date] = data;
  }
  
  // Get next day or today for latest.json and HTML
  const selectedData = getNextDayOrToday(allDataByDate);
  
  if (selectedData) {
    await fs.writeFile(latestPath, JSON.stringify(selectedData, null, 2), 'utf-8');
    console.log(`[SAVE] Saved to latest.json (${selectedData.date})`);
    console.log(`[SAVE] latest.json contains ${Object.keys(selectedData.groups).length} groups`);
    
    // Generate iCal calendars for all groups (include all dates for cumulative calendars)
    await saveIcalCalendars(allDataByDate);
    
    // Generate HTML index page for selected day (next day or today)
    await generateIndexPage(selectedData);
  } else {
    console.log('[SAVE] WARNING: No current or future dates available');
  }
}

// formatTime is now handled in client-side JavaScript (docs/app.js)

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
  
  // Ensure static files exist (they should be committed to git)
  // This function now just ensures the directory structure is correct
  // The actual HTML/CSS/JS files are static and loaded by the browser
  
  // Create .nojekyll file to disable Jekyll processing on GitHub Pages
  const nojekyllPath = path.join(docsDir, '.nojekyll');
  await fs.writeFile(nojekyllPath, '', 'utf-8');
  console.log('Ensured .nojekyll file exists');
}

/* ---------------------------------------------------
   MAIN: тягнемо HTML напряму з Інтернету
--------------------------------------------------- */
async function main() {
    const URL = 'https://poweron.loe.lviv.ua/';
    console.log('[MAIN] Starting parser...');
    console.log(`[MAIN] Fetching from URL: ${URL}`);
  
    let browser;
    try {
      browser = await puppeteer.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
      console.log('[MAIN] Browser launched successfully');
      
      const page = await browser.newPage();
      console.log('[MAIN] Navigating to page...');

      await page.goto(URL, {
          waitUntil: "networkidle0"
      });
      console.log('[MAIN] Page loaded, extracting HTML...');

      const html = await page.content(); // тут вже є всі <p>
      console.log(`[MAIN] Retrieved HTML: ${html.length} characters`);
      
      // Check if we got meaningful content
      if (html.length < 1000) {
        console.error('[MAIN] ERROR: HTML content seems too short, possible fetch issue');
      }
      
      // Check for expected content
      if (!html.includes('power-off__text')) {
        console.warn('[MAIN] WARNING: HTML does not contain expected "power-off__text" class');
      }
      
      const dataArray = parseScheduleFromHtml(html);
      console.log(`[MAIN] Parsed ${dataArray.length} date section(s)`);
      
      if (dataArray.length === 0) {
        console.error('[MAIN] ERROR: No data parsed from HTML');
        throw new Error('No data parsed from HTML');
      }
      
      // Save each day separately
      for (const data of dataArray) {
        console.log(`[MAIN] Processing date: ${data.date}`);
        await saveData(data);
      }
      
      console.log('[MAIN] All data processed successfully');
      
    } catch (error) {
      console.error('[MAIN] ERROR during execution:', error.message);
      console.error('[MAIN] Stack trace:', error.stack);
      throw error;
    } finally {
      if (browser) {
        await browser.close();
        console.log('[MAIN] Browser closed');
      }
    }
  }
  
  main(); // ← ESM-спосіб запуску
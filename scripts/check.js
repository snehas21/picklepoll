const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BOOKING_URL =
  'https://anc.ca.apm.activecommunities.com/richmondhill/activity/search' +
  '?onlineSiteId=0&activity_select_param=2&open_spots=1&min_age=40' +
  '&activity_keyword=pickleball&max_age=50&viewMode=list';

const STATUS_FILE = path.join(__dirname, '..', 'status.json');

function slotKey(slot) {
  return `${slot.date}|${slot.time}`;
}

function isWeekend(dateStr) {
  if (!dateStr) return false;
  const day = new Date(dateStr).getDay();
  return day === 0 || day === 6; // Sunday or Saturday
}

async function sendNotification(title, message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) {
    console.log('NTFY_TOPIC not set — skipping notification.');
    return;
  }
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'high',
      Tags: 'sports,white_check_mark',
    },
    body: message,
  });
  if (res.ok) {
    console.log('Notification sent via ntfy.sh');
  } else {
    console.error(`ntfy.sh failed: ${res.status} ${await res.text()}`);
  }
}

async function check() {
  console.log('Launching browser…');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    console.log('Navigating to booking page…');
    await page.goto(BOOKING_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // Extra wait for SPA to finish rendering activity cards
    console.log('Waiting 5s for SPA to render…');
    await page.waitForTimeout(5000);

    // Grab each activity card that has an "Enroll Now" button
    const cards = await page.evaluate(() => {
      const enrollButtons = [...document.querySelectorAll('button, a')]
        .filter(el => /enroll\s*now/i.test(el.textContent.trim()));

      return enrollButtons.map(btn => {
        // Walk up the DOM to find a meaningful card container
        let node = btn.parentElement;
        for (let i = 0; i < 12; i++) {
          if (!node) break;
          // A card has enough text to contain a title + details
          if ((node.innerText || '').replace(/\s+/g, ' ').trim().length > 80) break;
          node = node.parentElement;
        }
        const text = node ? (node.innerText || '').replace(/\s+/g, ' ').trim() : '';
        return { text };
      });
    });

    console.log(`Found ${cards.length} "Enroll Now" button(s)`);

    const qualified = [];
    const skipped = [];

    for (const card of cards) {
      const { text } = card;
      const isWomen  = /\bwomen'?s?\b/i.test(text);
      const isLesson = /\blessons?\b/i.test(text);

      console.log(`  Card: "${text.slice(0, 80)}" | women=${isWomen} lesson=${isLesson}`);

      if (isWomen) {
        skipped.push({ title: text.slice(0, 100), reason: "Women's" });
      } else if (isLesson) {
        skipped.push({ title: text.slice(0, 100), reason: 'Lessons' });
      } else if (!/pickleball\s*-\s*adult\s*\(drop\s*in\)/i.test(text)) {
        skipped.push({ title: text.slice(0, 100), reason: 'Not Drop In' });
      } else {
        qualified.push(parseCard(text));
      }
    }

    // Load previously notified slot keys to avoid duplicate SMS
    let prevNotifiedSlots = [];
    try {
      const prev = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
      prevNotifiedSlots = prev.notifiedSlots || [];
    } catch (_) {}

    const weekendSlots = qualified.filter(s => isWeekend(s.date));
    const newWeekendSlots = weekendSlots.filter(s => !prevNotifiedSlots.includes(slotKey(s)));

    if (newWeekendSlots.length > 0) {
      console.log(`Found ${newWeekendSlots.length} new weekend slot(s) — sending notification…`);
      const lines = newWeekendSlots.map(
        s => `• ${s.date} ${s.time} (${s.openings} spot${s.openings === 1 ? '' : 's'})`
      );
      const msg =
        lines.join('\n') + '\n' +
        'Book: https://anc.ca.apm.activecommunities.com/richmondhill/activity/search?activity_keyword=pickleball';
      await sendNotification('Pickleball weekend opening!', msg);
    } else {
      console.log('No new weekend slots to notify about.');
    }

    // Persist all weekend slot keys we've ever notified about
    const notifiedSlots = [
      ...new Set([...prevNotifiedSlots, ...weekendSlots.map(slotKey)]),
    ];

    const status = {
      checkedAt: new Date().toISOString(),
      available: qualified.length > 0,
      total: cards.length,
      qualified,
      skipped,
      notifiedSlots,
      error: null,
    };

    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
    console.log(`Done. ${qualified.length} qualified (${weekendSlots.length} weekend), ${skipped.length} skipped.`);
    process.exit(0);

  } catch (err) {
    console.error('Check failed:', err.message);
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      checkedAt: new Date().toISOString(),
      available: false,
      total: 0,
      qualified: [],
      skipped: [],
      notifiedSlots: [],
      error: err.message,
    }, null, 2));
    process.exit(1);
  } finally {
    await browser.close();
  }
}

function parseCard(text) {
  // Card text looks like:
  // "Pickleball - Adult (Drop In) #143429 / 18 yrs + / Openings 5 Oak Ridges CC April 7, 2026 Tue 8:30 AM - 10:00 AM Enroll Now"
  const lines = text.split(/\s{2,}|\n/).map(l => l.trim()).filter(Boolean);
  const title = lines[0] || text.slice(0, 60);

  const openingsMatch = text.match(/openings?\s+(\d+)/i);
  const openings = openingsMatch ? parseInt(openingsMatch[1]) : null;

  const dateMatch = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/i);
  const date = dateMatch ? dateMatch[0] : null;

  const timeMatch = text.match(/\d{1,2}:\d{2}\s*(am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(am|pm)/i);
  const time = timeMatch ? timeMatch[0] : null;

  return { title, openings, date, time, raw: text.slice(0, 300) };
}

check();

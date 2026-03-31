const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BOOKING_URL =
  'https://anc.ca.apm.activecommunities.com/richmondhill/activity/search' +
  '?onlineSiteId=0&activity_select_param=2&open_spots=1&min_age=40' +
  '&activity_keyword=pickleball&max_age=50&viewMode=list';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/check', async (req, res) => {
  try {
    const response = await fetch(BOOKING_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    if (!response.ok) {
      return res.json({
        available: false,
        error: `Site returned HTTP ${response.status}`,
      });
    }

    const html = await response.text();
    const available = /enroll\s+now/i.test(html);

    res.json({ available, bookingUrl: BOOKING_URL });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Picklepoll server running at http://localhost:${PORT}`);
});

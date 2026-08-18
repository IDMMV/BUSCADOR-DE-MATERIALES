const { chromium } = require('playwright');

(async () => {
  const url = process.env.PREVIEW_URL;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!url) throw new Error('PREVIEW_URL is not configured.');
  if (!bypassSecret) throw new Error('VERCEL_AUTOMATION_BYPASS_SECRET is not configured.');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    extraHTTPHeaders: {
      'x-vercel-protection-bypass': bypassSecret,
      'x-vercel-set-bypass-cookie': 'true'
    }
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const apiFailures = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      apiFailures.push(`${response.status()} ${response.url()}`);
    }
  });

  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const title = await page.title();
    const bodyText = (await page.locator('body').innerText()).trim();
    const search = page.locator('.search').first();
    const searchInput = search.locator('input').first();
    const searchButtons = search.locator('button');

    if (!title.toLowerCase().includes('buscador de materiales')) {
      throw new Error(`Unexpected page title: ${title}`);
    }
    if (bodyText.length < 100) {
      throw new Error('Page body contains too little visible content.');
    }
    if (!(await searchInput.isVisible())) {
      throw new Error('Main search input is not visible.');
    }
    if ((await searchButtons.count()) < 1) {
      throw new Error('Main search controls were not found.');
    }

    await searchInput.fill('MATERIAL');
    if (await searchInput.inputValue() !== 'MATERIAL') {
      throw new Error('Search input did not accept text.');
    }

    console.log('Executing real search...');
    const searchButton = searchButtons.first();
    await searchButton.click();
    await page.waitForTimeout(1500);

    const resultCards = page.locator('.results .card');
    const resultCount = await resultCards.count();
    if (resultCount < 1) {
      throw new Error('Real search returned no material results for "MATERIAL".');
    }

    const firstResultText = (await resultCards.first().innerText()).trim();
    if (firstResultText.length < 20) {
      throw new Error('Search returned a result card with insufficient visible information.');
    }

    console.log(`Real search: PASS (${resultCount} result card(s))`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);

    const mobileOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    );
    if (mobileOverflow) {
      throw new Error('Mobile layout has horizontal overflow.');
    }

    if (consoleErrors.length || pageErrors.length || apiFailures.length) {
      console.log('Browser QA diagnostics:');
      console.log(JSON.stringify({ consoleErrors, pageErrors, apiFailures }, null, 2));
    }

    if (pageErrors.length) {
      throw new Error(`Browser page errors detected: ${pageErrors.join(' | ')}`);
    }
    if (apiFailures.length) {
      throw new Error(`API failures detected: ${apiFailures.join(' | ')}`);
    }

    console.log('HUGO BROWSER QA: PASS');
    console.log(`Title: ${title}`);
    console.log('Desktop search control: PASS');
    console.log('Search input interaction: PASS');
    console.log('Real search and result validation: PASS');
    console.log('Mobile viewport overflow: PASS');
    console.log('Page errors: 0');
    console.log('API failures: 0');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`HUGO BROWSER QA: FAIL - ${error.message}`);
  process.exit(1);
});

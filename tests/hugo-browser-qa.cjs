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
  const failedResponses = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('response', response => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      apiFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', request => {
    failedResponses.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'request failed'}`);
  });

  const diagnostics = async () => {
    const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
    const cards = await page.locator('.results .card').count().catch(() => 0);
    const statusText = await page.locator('#status, .status').allInnerTexts().catch(() => []);
    return {
      cards,
      bodyTail: bodyText.slice(-1000),
      statusText,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      apiFailures: [...apiFailures],
      failedResponses: [...failedResponses]
    };
  };

  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await page.title();
    const bodyText = (await page.locator('body').innerText()).trim();
    const search = page.locator('.search').first();
    const searchInput = search.locator('input').first();
    const searchButton = search.locator('button:not(.mic)').first();
    const resultCards = page.locator('.results .card');

    if (!title.toLowerCase().includes('buscador de materiales')) {
      throw new Error(`Unexpected page title: ${title}`);
    }
    if (bodyText.length < 100) {
      throw new Error('Page body contains too little visible content.');
    }
    if (!(await searchInput.isVisible())) {
      throw new Error('Main search input is not visible.');
    }
    if (!(await searchButton.isVisible())) {
      throw new Error('Main search button is not visible.');
    }

    console.log('Waiting for the real material data source to populate...');

    // The application loads the material catalog asynchronously. Do not assume
    // that DOMContentLoaded means the catalog is already available.
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('.results .card').length > 0,
        { timeout: 20000 }
      );
    } catch (_) {
      const d = await diagnostics();
      throw new Error(
        `Material catalog did not populate within 20s. ` +
        `cards=${d.cards}; apiFailures=${d.apiFailures.join(' | ') || 'none'}; ` +
        `pageErrors=${d.pageErrors.join(' | ') || 'none'}; ` +
        `status=${d.statusText.join(' | ') || 'none'}; ` +
        `bodyTail=${d.bodyTail.replace(/\s+/g, ' ').slice(-500)}`
      );
    }

    // Give the UI one additional rendering turn after the first card appears.
    await page.waitForTimeout(500);

    const initialResultCount = await resultCards.count();
    if (initialResultCount < 1) {
      throw new Error('Material cards disappeared after the catalog load completed.');
    }

    const firstCard = resultCards.first();
    const codeLocator = firstCard.locator('.code').first();
    let searchTerm = '';
    if (await codeLocator.count()) {
      searchTerm = (await codeLocator.innerText()).trim();
    }
    if (!searchTerm) {
      searchTerm = (await firstCard.innerText()).trim().split(/\s+/)[0];
    }
    if (!searchTerm) {
      throw new Error('Could not derive a valid search term from the first loaded material.');
    }

    console.log(`Loaded material cards: ${initialResultCount}`);
    console.log(`Using real search term from loaded data: ${searchTerm}`);

    await searchInput.fill(searchTerm);
    if (await searchInput.inputValue() !== searchTerm) {
      throw new Error('Search input did not accept the test value.');
    }

    console.log('Executing real search...');
    await searchButton.click();

    // Search rendering can also be asynchronous; wait for the known material
    // code to remain present instead of relying on a fixed 1.5s delay.
    await page.waitForFunction(
      term => Array.from(document.querySelectorAll('.results .card'))
        .some(card => card.textContent?.toLowerCase().includes(String(term).toLowerCase())),
      searchTerm,
      { timeout: 10000 }
    );

    const filteredResultCount = await resultCards.count();
    if (filteredResultCount < 1) {
      throw new Error(`Real search returned no results for known material "${searchTerm}".`);
    }

    const firstResultText = (await resultCards.first().innerText()).trim();
    if (firstResultText.length < 20) {
      throw new Error('Search returned a result card with insufficient visible information.');
    }

    console.log(`Real search: PASS (${filteredResultCount} result card(s))`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);

    const mobileOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
    );
    if (mobileOverflow) {
      throw new Error('Mobile layout has horizontal overflow.');
    }

    if (pageErrors.length) {
      throw new Error(`Browser page errors detected: ${pageErrors.join(' | ')}`);
    }
    if (apiFailures.length) {
      throw new Error(`API failures detected: ${apiFailures.join(' | ')}`);
    }

    if (consoleErrors.length) {
      console.log('Browser console errors detected:');
      console.log(JSON.stringify(consoleErrors, null, 2));
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

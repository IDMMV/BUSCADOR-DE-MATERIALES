const { chromium } = require('playwright');
const path = require('path');

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
    const materialRows = await page.locator('.results .v34-stock-table tbody tr, .results .v29-stock-table tbody tr').count().catch(() => 0);
    const statusText = await page.locator('#status, .status').allInnerTexts().catch(() => []);
    return {
      cards,
      materialRows,
      bodyTail: bodyText.slice(-1000),
      statusText,
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      apiFailures: [...apiFailures],
      failedResponses: [...failedResponses]
    };
  };

  const extractMaterialCode = text => {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const matches = normalized.match(/\b\d{4,}\b/g);
    return matches?.[0] || '';
  };

  const materialRowsLocator = page.locator('.results .v34-stock-table tbody tr, .results .v29-stock-table tbody tr');
  const legacyCardsLocator = page.locator('.results .card');

  try {
    console.log(`Opening ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const title = await page.title();
    const bodyText = (await page.locator('body').innerText()).trim();
    const search = page.locator('.search').first();
    const searchInput = search.locator('input').first();
    const searchButton = search.locator('button:not(.mic)').first();

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

    await page.waitForFunction(
      () => document.querySelectorAll('.results .v34-stock-table tbody tr, .results .v29-stock-table tbody tr, .results .card').length > 0,
      { timeout: 30000 }
    ).catch(async () => {
      const d = await diagnostics();
      throw new Error(
        `Material catalog did not populate within 30s. ` +
        `cards=${d.cards}; materialRows=${d.materialRows}; apiFailures=${d.apiFailures.join(' | ') || 'none'}; ` +
        `pageErrors=${d.pageErrors.join(' | ') || 'none'}; status=${d.statusText.join(' | ') || 'none'}; ` +
        `bodyTail=${d.bodyTail.replace(/\s+/g, ' ').slice(-500)}`
      );
    });

    await page.waitForTimeout(500);

    const materialRows = await materialRowsLocator.count();
    const legacyCards = await legacyCardsLocator.count();
    const initialResultCount = materialRows || legacyCards;
    if (initialResultCount < 1) {
      throw new Error('Material results disappeared after the catalog load completed.');
    }

    let searchTerm = '';
    if (materialRows > 0) {
      const firstRow = materialRowsLocator.first();
      const codeLocator = firstRow.locator('.v34-code, .v29-code, td:nth-child(2)').first();
      const codeText = await codeLocator.innerText().catch(() => '');
      searchTerm = extractMaterialCode(codeText);
      if (!searchTerm) searchTerm = extractMaterialCode(await firstRow.innerText().catch(() => ''));
    } else {
      const firstCard = legacyCardsLocator.first();
      const codeLocator = firstCard.locator('.code').first();
      const codeText = await codeLocator.innerText().catch(() => '');
      searchTerm = extractMaterialCode(codeText);
      if (!searchTerm) searchTerm = extractMaterialCode(await firstCard.innerText().catch(() => ''));
    }

    if (!searchTerm) {
      throw new Error('Could not derive a valid numeric material code from the first loaded material.');
    }

    console.log(`Loaded material rows: ${initialResultCount}`);
    console.log(`Using real material code from loaded data: ${searchTerm}`);

    await searchInput.click();
    await searchInput.evaluate((el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, searchTerm);

    await page.waitForTimeout(100);
    const acceptedValue = await searchInput.inputValue();
    if (acceptedValue !== searchTerm) {
      await searchInput.fill('');
      await searchInput.pressSequentially(searchTerm, { delay: 5 });
    }

    const finalInputValue = await searchInput.inputValue();
    if (finalInputValue !== searchTerm) {
      throw new Error(`Search input did not accept the test value. expected="${searchTerm}" actual="${finalInputValue}"`);
    }

    console.log('Executing real search...');
    await searchButton.click();

    await page.waitForFunction(
      term => Array.from(document.querySelectorAll('.results .v34-stock-table tbody tr, .results .v29-stock-table tbody tr, .results .card'))
        .some(row => row.textContent?.toLowerCase().includes(String(term).toLowerCase())),
      searchTerm,
      { timeout: 10000 }
    );

    const filteredRows = await materialRowsLocator.count();
    const filteredCards = await legacyCardsLocator.count();
    const filteredResultCount = filteredRows || filteredCards;
    if (filteredResultCount < 1) {
      throw new Error(`Real search returned no results for known material "${searchTerm}".`);
    }

    const firstResult = filteredRows ? materialRowsLocator.first() : legacyCardsLocator.first();
    const firstResultText = (await firstResult.innerText()).trim();
    if (firstResultText.length < 20) {
      throw new Error('Search returned a result with insufficient visible information.');
    }

    console.log(`Real search: PASS (${filteredResultCount} result row/card(s))`);

    // Functional asset checks: broken images, file-selection controls and
    // download links are validated when the application exposes them.
    console.log('Checking functional assets...');

    const imageCount = await page.locator('img').count();
    let brokenImages = 0;
    for (let i = 0; i < imageCount; i += 1) {
      const img = page.locator('img').nth(i);
      if (!(await img.isVisible().catch(() => false))) continue;
      const ok = await img.evaluate(el => {
        if (!el.currentSrc && !el.src) return true;
        return el.complete && el.naturalWidth > 0;
      }).catch(() => false);
      if (!ok) brokenImages += 1;
    }
    if (brokenImages > 0) {
      throw new Error(`Broken visible images detected: ${brokenImages}/${imageCount}.`);
    }
    console.log(`Visible image integrity: PASS (${imageCount} image element(s))`);

    const fileInputs = page.locator('input[type="file"]');
    const fileInputCount = await fileInputs.count();
    if (fileInputCount > 0) {
      const fixture = path.resolve('tests/fixtures/hugo-test-image.svg');
      const target = fileInputs.first();
      await target.setInputFiles(fixture);
      const selectedFiles = await target.evaluate(el => el.files?.length || 0);
      if (selectedFiles !== 1) {
        throw new Error(`File input did not accept the QA fixture. selected=${selectedFiles}`);
      }
      console.log(`File selection: PASS (${fileInputCount} file input(s))`);
    } else {
      console.log('File selection: SKIP (no file input exposed on this page state)');
    }

    const downloadLinks = page.locator('a[download], a[href$=".pdf"], a[href$=".xlsx"], a[href$=".csv"], a[href$=".zip"]');
    const downloadCount = await downloadLinks.count();
    if (downloadCount > 0) {
      for (let i = 0; i < Math.min(downloadCount, 3); i += 1) {
        const href = await downloadLinks.nth(i).getAttribute('href');
        if (!href || href === '#') throw new Error(`Download link ${i + 1} has no usable target.`);
      }
      console.log(`Download targets: PASS (${downloadCount} link(s) detected)`);
    } else {
      console.log('Download targets: SKIP (no download link exposed on this page state)');
    }

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
    console.log('Functional image check: PASS');
    console.log('Functional file-selection check: PASS/SKIP');
    console.log('Functional download-target check: PASS/SKIP');
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

// S6 acceptance: drive the intake UI end-to-end with fixture answers and
// verify the UI shows the fixture's exact expected scores after submit.
// Requires the vite dev server (dev emulator) running, a provisioned advisor,
// and a company for that advisor's firm.
// Usage: node scripts/e2e-intake.mjs [baseUrl] [email] [fixtureName]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5173';
const email = process.argv[3] ?? 'jo@summit.test';
const fixtureName = process.argv[4] ?? 'company-1-meridian-managed-it';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(join(root, 'seed', 'fixtures', `${fixtureName}.json`), 'utf8'),
);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const fail = async (msg) => {
  console.error(`E2E FAIL: ${msg}`);
  await page.screenshot({ path: 'e2e-failure.png', fullPage: true });
  await browser.close();
  process.exit(1);
};
page.on('pageerror', (e) => console.error('pageerror:', e.message));

// login
await page.goto(`${base}/login`);
await page.getByLabel('Email').fill(email);
await page.getByLabel('Password').fill('demo');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(`${base}/`);

// open (or create) the engagement on the first client
await page.waitForSelector('.client-card');
if (await page.getByRole('button', { name: 'Start engagement' }).count()) {
  await page.getByRole('button', { name: 'Start engagement' }).first().click();
}
await page.getByRole('link', { name: /Engagement \(/ }).first().click();
await page.waitForURL(/\/engagement\//);

// start (or resume) an assessment
const startButton = page.getByRole('button', { name: /Start (baseline assessment|re-assessment)/ });
const resumeLink = page.getByRole('link', { name: 'Resume intake →' });
await startButton.or(resumeLink).first().waitFor();
if (await startButton.count()) {
  await startButton.click();
} else {
  await resumeLink.click();
}
await page.waitForURL(/\/assessment\/.*\/intake/);

// walk all dimension steps, answering from the fixture
const answers = fixture.answers;
await page.waitForSelector('.step');
const dimensionCodes = await page.locator('.step').allInnerTexts();
for (let step = 0; step < dimensionCodes.length; step++) {
  // wait until the stepper marks THIS dimension current (transition-safe)
  await page.waitForFunction(
    (dim) => document.querySelector('.step-current')?.textContent === dim,
    dimensionCodes[step],
  );
  await page.waitForSelector('.question');
  const codes = await page.$$eval('.question', (nodes) =>
    nodes.map((n) => [n.getAttribute('data-qcode'), n.getAttribute('data-qtype')]),
  );
  for (const [code, type] of codes) {
    const q = page.locator(`[data-qcode="${code}"]`);
    const value = answers[code];
    if (value === undefined) continue; // context question with no fixture answer
    if (type === 'numeric' || type === 'scale_1_5' || type === 'numeric_or_unknown') {
      if (value === 'unknown') {
        await q.getByRole('checkbox').check();
      } else if (type === 'scale_1_5') {
        await q.getByRole('radio').nth(Number(value) - 1).check();
      } else {
        await q.locator('input[type=number]').fill(String(value));
      }
    } else if (type === 'numeric_list') {
      await q.locator('input[type=text]').fill(value.join(', '));
    } else if (type === 'select') {
      await q.locator('select').selectOption(value);
    } else if (type === 'text') {
      await q.locator('textarea').fill(String(value));
    } // rank: leave default order (context-only)
  }
  const submitButton = page.getByRole('button', { name: 'Submit & score' });
  if (await submitButton.count()) {
    await submitButton.click();
    break;
  }
  await page.getByRole('button', { name: 'Save & continue →' }).click();
}

// after submit we land on the engagement page — verify the exact scores
await page.waitForURL(/\/engagement\//, { timeout: 20000 });
await page.waitForSelector('.assessment-score');
const scoreText = await page.locator('.assessment-card').last().innerText();
const wanted = [
  `DRS ${fixture.expected.drs}`,
  fixture.expected.tier,
  `ORI ${fixture.expected.owner_readiness_index}`,
];
for (const piece of wanted) {
  if (!scoreText.includes(piece)) {
    await fail(`expected '${piece}' in assessment card, saw: ${scoreText.replace(/\n/g, ' | ')}`);
  }
}
console.log(`E2E PASS: intake walkthrough reproduced ${fixtureName}:`);
console.log(`  UI shows: ${scoreText.replace(/\n/g, ' | ')}`);
await browser.close();

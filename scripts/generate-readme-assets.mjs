import fs from "node:fs/promises";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const baseUrl = process.env.README_BASE_URL ?? "http://127.0.0.1:4173";
const docsAssetDir = path.resolve("docs/assets");
const frameDir = path.resolve("output/readme-frames");
const focusDelayMs = 2350;

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function createRoom(debugPreset) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      debugPreset
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to create debug room: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function renderState(page) {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()));
}

async function waitForPhase(page, phase) {
  await page.waitForFunction(
    (expectedPhase) => JSON.parse(window.render_game_to_text()).phase === expectedPhase,
    phase
  );
}

async function waitForLevel(page, level) {
  await page.waitForFunction(
    (expectedLevel) => JSON.parse(window.render_game_to_text()).level === expectedLevel,
    level
  );
}

async function waitForLives(page, lives) {
  await page.waitForFunction(
    (expectedLives) => JSON.parse(window.render_game_to_text()).lives === expectedLives,
    lives
  );
}

async function waitForRoundToGoLive(page) {
  await page.waitForFunction(() => {
    const state = JSON.parse(window.render_game_to_text());
    return state.focusRemainingMs === 0 && state.self.handCount > 0;
  });
}

async function setName(page, nextName) {
  // The name field lives in the settings menu (speaker button, top right).
  await page.getByRole("button", { name: "Settings" }).click();
  const input = page.getByLabel("Your name");
  await input.fill(nextName);
  await input.press("Enter");
  await page.keyboard.press("Escape");
}

async function captureLandingAssets(browser) {
  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 900
    }
  });

  await page.goto(baseUrl, {
    waitUntil: "networkidle"
  });
  // Let the looping demo play a few cards onto the line first.
  await page.waitForTimeout(4500);
  await page.screenshot({
    path: path.join(docsAssetDir, "readme-hero.png")
  });

  await page.getByRole("button", { name: "How to play", exact: true }).click();
  await page.waitForTimeout(500);
  await page.locator("#how-to-play").screenshot({
    path: path.join(docsAssetDir, "readme-how-to-play.png")
  });

  await page.close();
}

async function playCard(page, value) {
  await page.getByRole("button", { name: new RegExp(`^${value}`) }).click();
}

async function readyBoth(hostPage, guestPage) {
  await hostPage.getByRole("button", { name: "Ready" }).click();
  await guestPage.getByRole("button", { name: "Ready" }).click();
}

async function captureGameplayAssets(browser) {
  // Level 3 is dealt so the guest can open with 14 (a clean play) and then
  // jump the host's 30 with 41 (a misplay that costs a life but not the level).
  const room = await createRoom({
    seed: 123456,
    deals: {
      1: { host: [10], guest: [90] },
      2: { host: [9, 47], guest: [23, 88] },
      3: { host: [30, 55, 72], guest: [14, 41, 95] }
    }
  });

  const viewport = { width: 1440, height: 900 };
  const hostPage = await browser.newPage({ viewport });
  const guestContext = await browser.newContext({ viewport });
  const guestPage = await guestContext.newPage();

  await hostPage.goto(room.hostInviteUrl, { waitUntil: "networkidle" });
  await guestPage.goto(room.guestInviteUrl, { waitUntil: "networkidle" });
  await waitForPhase(hostPage, "between_levels");
  await waitForPhase(guestPage, "between_levels");

  await setName(hostPage, "Mira");
  await setName(guestPage, "Jonas");
  await waitForTimeout(400);

  await hostPage.screenshot({ path: path.join(docsAssetDir, "readme-room-ready.png") });
  await hostPage.screenshot({ path: path.join(frameDir, "room-flow-01-ready.png") });

  await readyBoth(hostPage, guestPage);
  await hostPage.waitForTimeout(500);
  await hostPage.screenshot({ path: path.join(docsAssetDir, "readme-focus-overlay.png") });
  await hostPage.screenshot({ path: path.join(frameDir, "room-flow-02-focus.png") });

  await hostPage.waitForTimeout(focusDelayMs);
  await waitForRoundToGoLive(hostPage);
  await waitForRoundToGoLive(guestPage);
  await hostPage.screenshot({ path: path.join(frameDir, "room-flow-03-live-round.png") });

  await playCard(hostPage, 10);
  await hostPage.waitForTimeout(700);
  await hostPage.screenshot({ path: path.join(frameDir, "room-flow-04-played.png") });

  await playCard(guestPage, 90);
  await waitForLevel(hostPage, 2);
  // Mid-celebration: the line lights up in play order while the melody replays.
  await hostPage.waitForTimeout(650);
  await hostPage.screenshot({ path: path.join(docsAssetDir, "readme-level-clear.png") });
  await hostPage.screenshot({ path: path.join(frameDir, "room-flow-05-level-clear.png") });

  // Level 2, played cleanly.
  await hostPage.waitForTimeout(1600);
  await readyBoth(hostPage, guestPage);
  await hostPage.waitForTimeout(focusDelayMs);
  await waitForRoundToGoLive(hostPage);
  for (const [page, value] of [[hostPage, 9], [guestPage, 23], [hostPage, 47], [guestPage, 88]]) {
    await playCard(page, value);
    await hostPage.waitForTimeout(450);
  }
  await waitForLevel(hostPage, 3);

  // Level 3: the live round shot, then the misplay.
  await hostPage.waitForTimeout(2000);
  await readyBoth(hostPage, guestPage);
  await hostPage.waitForTimeout(focusDelayMs);
  await waitForRoundToGoLive(hostPage);
  await playCard(guestPage, 14);
  await hostPage.waitForTimeout(800);
  await hostPage.screenshot({ path: path.join(docsAssetDir, "readme-live-round.png") });
  await hostPage.screenshot({ path: path.join(frameDir, "misplay-flow-01-live-round.png") });

  await playCard(guestPage, 41);
  await waitForLives(hostPage, 1);
  await hostPage.waitForTimeout(350);
  await hostPage.screenshot({ path: path.join(docsAssetDir, "readme-misplay.png") });
  await hostPage.screenshot({ path: path.join(frameDir, "misplay-flow-02-life-lost.png") });

  const finalState = await renderState(hostPage);
  if (finalState.lives !== 1) {
    throw new Error("Expected the misplay capture to end with one remaining life.");
  }

  // Mobile: a live round on a phone-sized screen.
  const mobileRoom = await createRoom({
    seed: 654321,
    deals: {
      1: { host: [21], guest: [79] }
    }
  });
  const mobileContext = await browser.newContext({ ...devices["Pixel 7"] });
  const mobileGuestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mobilePage = await mobileContext.newPage();
  const mobileGuestPage = await mobileGuestContext.newPage();
  await mobilePage.goto(mobileRoom.hostInviteUrl, { waitUntil: "networkidle" });
  await mobileGuestPage.goto(mobileRoom.guestInviteUrl, { waitUntil: "networkidle" });
  await waitForPhase(mobilePage, "between_levels");
  await readyBoth(mobilePage, mobileGuestPage);
  await mobilePage.waitForTimeout(focusDelayMs);
  await waitForRoundToGoLive(mobilePage);
  await mobilePage.waitForTimeout(300);
  await mobilePage.screenshot({ path: path.join(docsAssetDir, "readme-mobile-room.png") });

  await mobileGuestContext.close();
  await mobileContext.close();
  await guestContext.close();
  await hostPage.close();
}

async function waitForTimeout(milliseconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function main() {
  await ensureDirectory(docsAssetDir);
  await ensureDirectory(frameDir);

  const browser = await chromium.launch({
    headless: true
  });

  try {
    await captureLandingAssets(browser);
    await captureGameplayAssets(browser);
  } finally {
    await browser.close();
  }
}

await main();

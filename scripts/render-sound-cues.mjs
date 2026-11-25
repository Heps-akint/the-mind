// Renders every room sound cue to a WAV file so the sound design can be heard
// and level-checked without playing a game.
//
//   node scripts/render-sound-cues.mjs
//
// Output: output/sound-cues/*.wav plus levels.json (peak and RMS per cue).
// It bundles src/client/card-sound.ts, loads it into headless Chromium, and
// swaps the live AudioContext for an OfflineAudioContext so each cue renders
// faster than real time with exactly the graph the game uses.
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const outDir = "output/sound-cues";
mkdirSync(outDir, { recursive: true });

const bundle = await build({
  bundle: true,
  entryPoints: ["src/client/card-sound.ts"],
  format: "iife",
  globalName: "CardSound",
  logLevel: "silent",
  platform: "browser",
  write: false
});
const script = bundle.outputFiles[0].text;

// Each entry: file name, how long to render, and the events to play.
const cues = [
  ["01-your-card-12", 2, [{ kind: "card", resolution: "played", source: "self", value: 12 }]],
  ["02-partner-card-61", 2, [{ kind: "card", resolution: "played", source: "partner", value: 61 }]],
  ["03-clean-climb", 3.5, [8, 19, 26, 41, 57, 73, 88, 96].map((value, index) => ({
    kind: "card",
    resolution: "played",
    source: index % 2 === 0 ? "partner" : "self",
    value
  }))],
  ["04-misplay", 2.5, [
    { kind: "card", resolution: "misplay_discard", source: "self", value: 30 },
    { kind: "card", resolution: "played", source: "partner", value: 41 },
    { kind: "misplay", value: 41 }
  ]],
  ["05-level-clear", 4, [
    { kind: "card", resolution: "played", source: "partner", value: 88 },
    { kind: "level_clear", melody: [9, 23, 47, 88] }
  ]],
  ["06-game-won", 6, [{ kind: "game_won", melody: [4, 15, 22, 38, 51, 64, 77, 90, 97] }]],
  ["07-game-lost", 5, [{ kind: "game_lost" }]],
  ["08-deal-and-focus", 4, [{ kind: "deal", count: 3 }, { kind: "focus" }]],
  ["09-round-live", 2.5, "live"],
  ["10-partner-arrives", 2, [{ kind: "arrive" }]],
  ["11-partner-leaves", 2, [{ kind: "depart" }]],
  ["12-star-request-from-partner", 2.5, [{ kind: "request", source: "partner" }]],
  ["13-star-thrown", 2, [
    { kind: "card", resolution: "scan_discard", source: "self", value: 30 },
    { kind: "card", resolution: "scan_discard", source: "partner", value: 44 }
  ]],
  ["14-pause-then-resume", 3, [{ kind: "pause" }, { kind: "resume" }]],
  ["15-ready-taps", 1.5, [{ kind: "ready", source: "self" }, { kind: "ready", source: "partner" }]],
  ["16-room-tone", 8, "tone"]
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");
await page.addScriptTag({ content: script });

const levels = {};
for (const [name, seconds, events] of cues) {
  const result = await page.evaluate(async ({ events, seconds }) => {
    const sampleRate = 44100;
    let offline = null;
    window.AudioContext = function OfflineStandIn() {
      offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
      Object.defineProperty(offline, "state", { get: () => "running" });
      offline.resume = async () => {};
      return offline;
    };
    const engine = window.CardSound.createSoundEngine();
    await engine.unlock();
    if (events === "live") {
      engine.live();
    } else if (events === "tone") {
      engine.setRoomTone(true);
    } else {
      engine.play(events);
    }
    const rendered = await offline.startRendering();
    const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
    let peak = 0;
    let sumSquares = 0;
    for (const channel of channels) {
      for (const sample of channel) {
        peak = Math.max(peak, Math.abs(sample));
        sumSquares += sample * sample;
      }
    }
    // 16-bit PCM WAV, interleaved stereo.
    const frames = rendered.length;
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    const writeText = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    writeText(0, "RIFF");
    view.setUint32(4, 36 + frames * 4, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, frames * 4, true);
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const value = Math.max(-1, Math.min(1, channels[channel][frame]));
        view.setInt16(44 + frame * 4 + channel * 2, value * 0x7fff, true);
      }
    }
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return {
      peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
      rmsDb: 10 * Math.log10(Math.max(sumSquares / (frames * 2), 1e-12)),
      wav: btoa(binary)
    };
  }, { events, seconds });

  writeFileSync(`${outDir}/${name}.wav`, Buffer.from(result.wav, "base64"));
  levels[name] = { peakDb: Number(result.peakDb.toFixed(1)), rmsDb: Number(result.rmsDb.toFixed(1)) };
  console.log(`${name.padEnd(32)} peak ${levels[name].peakDb.toFixed(1)} dBFS   rms ${levels[name].rmsDb.toFixed(1)} dBFS`);
}

writeFileSync(`${outDir}/levels.json`, JSON.stringify(levels, null, 2));
await browser.close();

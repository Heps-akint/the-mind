import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { RoomState, SeatId } from "@shared/protocol";

/*
 * Sound design for the room.
 *
 * The idea: the shared pile is a melody. Every card that lands plays a soft
 * mallet note whose pitch comes from the card's value, quantised to a
 * pentatonic scale so any run of ascending cards sounds consonant. A clean
 * round climbs; a misplay breaks the line with a dissonant rub. Your own
 * cards sound close and dry, your partner's sound further away (more room,
 * softer attack, panned slightly), so you can tell who played without
 * looking. Clearing a level replays the melody you made together.
 *
 * Everything is synthesised with Web Audio, so there are no files to load and
 * nothing to fetch past the CSP.
 */

export type RoomSoundCue =
  | "level_clear"
  | "game_won"
  | "life_warning"
  | "game_lost"
  | null;

export type CardSource = "self" | "partner";

export type SoundEvent =
  | { kind: "arrive" }
  | { kind: "depart" }
  | { kind: "deal"; count: number }
  | { kind: "focus" }
  | { kind: "card"; value: number; source: CardSource; resolution: RoomState["pile"][number]["resolution"] }
  | { kind: "misplay"; value: number }
  | { kind: "level_clear"; melody: number[] }
  | { kind: "game_won"; melody: number[] }
  | { kind: "game_lost" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "request"; source: CardSource }
  | { kind: "declined" }
  | { kind: "ready"; source: CardSource };

/* ------------------------------------------------------------------ */
/* Pure helpers (unit tested)                                          */
/* ------------------------------------------------------------------ */

// D major pentatonic: D E F# A B. No semitone steps, so any two notes sit well together.
const PENTATONIC_STEPS = [0, 2, 4, 7, 9] as const;
const SCALE_ROOT_HZ = 146.83; // D3
export const CARD_PITCH_STEPS = 16; // three octaves plus the top D

export function noteIndexForCard(value: number): number {
  const clamped = Math.min(100, Math.max(1, Math.round(value)));
  return Math.min(CARD_PITCH_STEPS - 1, Math.floor(((clamped - 1) * CARD_PITCH_STEPS) / 100));
}

export function frequencyForCard(value: number): number {
  const index = noteIndexForCard(value);
  const octave = Math.floor(index / PENTATONIC_STEPS.length);
  const degree = PENTATONIC_STEPS[index % PENTATONIC_STEPS.length] ?? 0;
  return SCALE_ROOT_HZ * Math.pow(2, (octave * 12 + degree) / 12);
}

export function getRoomSoundCue(
  previousSnapshot: RoomState | null,
  snapshot: RoomState | null
): RoomSoundCue {
  if (!snapshot || !previousSnapshot) {
    return null;
  }

  if (snapshot.summary?.kind === "game_won" && previousSnapshot.summary?.kind !== "game_won") {
    return "game_won";
  }

  if (snapshot.summary?.kind === "level_cleared" && previousSnapshot.summary?.kind !== "level_cleared") {
    return "level_clear";
  }

  if (snapshot.summary?.kind === "game_lost" && previousSnapshot.summary?.kind !== "game_lost") {
    return "game_lost";
  }

  if (snapshot.lives < previousSnapshot.lives) {
    return "life_warning";
  }

  return null;
}

function otherSeat(seatId: SeatId): SeatId {
  return seatId === "host" ? "guest" : "host";
}

/** The notes of the level just finished, in the order they landed. */
function levelMelody(snapshot: RoomState): number[] {
  return snapshot.pile.filter((card) => card.resolution === "played").map((card) => card.value);
}

/**
 * Turns one snapshot transition into the sounds it should make, in order.
 * Pure, so the mapping from game state to sound can be tested without audio.
 */
export function describeSoundEvents(previous: RoomState | null, next: RoomState | null): SoundEvent[] {
  if (!previous || !next) {
    return [];
  }

  const events: SoundEvent[] = [];
  const selfSeat = next.viewerSeatId;
  const partnerSeat = otherSeat(selfSeat);
  const partnerBefore = previous.players[partnerSeat];
  const partnerAfter = next.players[partnerSeat];

  if (!partnerBefore.connected && partnerAfter.connected) {
    events.push({ kind: "arrive" });
  } else if (partnerBefore.connected && !partnerAfter.connected) {
    events.push({ kind: "depart" });
  }

  if (next.phase === "focus_transition" && previous.phase !== "focus_transition") {
    events.push({ kind: "deal", count: next.players[selfSeat].hand.length });
    events.push({ kind: "focus" });
  }

  // Ready taps, so each player hears the other commit.
  if (next.phase === previous.phase && (next.phase === "between_levels" || next.phase === "won" || next.phase === "lost")) {
    if (!previous.players[selfSeat].ready && next.players[selfSeat].ready) {
      events.push({ kind: "ready", source: "self" });
    }
    if (!partnerBefore.ready && partnerAfter.ready) {
      events.push({ kind: "ready", source: "partner" });
    }
  }

  const sameLevelPile = next.pile.length > previous.pile.length;
  if (sameLevelPile) {
    for (const card of next.pile.slice(previous.pile.length)) {
      events.push({
        kind: "card",
        resolution: card.resolution,
        source: card.seatId === selfSeat ? "self" : "partner",
        value: card.value
      });
    }
  }

  const cue = getRoomSoundCue(previous, next);
  const lostLife = next.lives < previous.lives;
  if (lostLife && cue !== "game_lost") {
    const trigger = next.pile.slice(previous.pile.length).find((card) => card.resolution === "played");
    events.push({ kind: "misplay", value: trigger?.value ?? 50 });
  }

  if (cue === "level_clear") {
    events.push({ kind: "level_clear", melody: levelMelody(next) });
  } else if (cue === "game_won") {
    events.push({ kind: "game_won", melody: levelMelody(next) });
  } else if (cue === "game_lost") {
    events.push({ kind: "game_lost" });
  }

  const requestBefore = previous.pendingRequest;
  const requestAfter = next.pendingRequest;
  if (!requestBefore && requestAfter) {
    if (requestAfter.kind === "pause") {
      events.push({ kind: "pause" });
    } else {
      events.push({ kind: "request", source: requestAfter.requesterSeatId === selfSeat ? "self" : "partner" });
    }
  } else if (requestBefore && !requestAfter) {
    if (requestBefore.kind === "pause") {
      events.push({ kind: "resume" });
    } else if (!sameLevelPile) {
      events.push({ kind: "declined" });
    }
  }

  return events;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SOUND_SETTINGS_KEY = "the-mind:sound";

interface SoundSettings {
  effects: boolean;
  roomTone: boolean;
}

interface SoundSettingsState extends SoundSettings {
  setEffects: (value: boolean) => void;
  setRoomTone: (value: boolean) => void;
}

function readSoundSettings(): SoundSettings {
  const fallback = { effects: true, roomTone: true };
  try {
    const raw = window.localStorage.getItem(SOUND_SETTINGS_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      effects: typeof parsed.effects === "boolean" ? parsed.effects : true,
      roomTone: typeof parsed.roomTone === "boolean" ? parsed.roomTone : true
    };
  } catch {
    return fallback;
  }
}

function writeSoundSettings(settings: SoundSettings): void {
  try {
    window.localStorage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be blocked; the toggle still works for this visit.
  }
}

export const useSoundSettings = create<SoundSettingsState>((set, get) => ({
  ...(typeof window === "undefined" ? { effects: true, roomTone: true } : readSoundSettings()),
  setEffects: (effects) => {
    set({ effects });
    writeSoundSettings({ effects, roomTone: get().roomTone });
  },
  setRoomTone: (roomTone) => {
    set({ roomTone });
    writeSoundSettings({ effects: get().effects, roomTone });
  }
}));

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface SoundEngine {
  unlock: () => Promise<void>;
  tap: () => void;
  live: () => void;
  play: (events: SoundEvent[]) => void;
  setRoomTone: (active: boolean) => void;
  dispose: () => void;
}

// Alerts sit above the card notes so a lost life or cleared level cuts through a call.
const ALERT_GAIN = 1.5;
const NOTE_SPACING_S = 0.075;

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createNoiseBuffer(context: AudioContext, seconds: number): AudioBuffer {
  const frames = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const channel = buffer.getChannelData(0);
  const random = seededRandom(0x51_47_4c_45);
  for (let index = 0; index < frames; index += 1) {
    channel[index] = random() * 2 - 1;
  }
  return buffer;
}

/** A soft, dark room: about two seconds of decaying stereo noise. */
function createRoomImpulse(context: AudioContext): AudioBuffer {
  const frames = Math.max(1, Math.floor(context.sampleRate * 2.2));
  const buffer = context.createBuffer(2, frames, context.sampleRate);
  for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    const random = seededRandom(0x4d_49_4e_44 + channelIndex * 977);
    let smoothed = 0;
    for (let index = 0; index < frames; index += 1) {
      const progress = index / frames;
      smoothed = smoothed * 0.55 + (random() * 2 - 1) * 0.45;
      channel[index] = smoothed * Math.pow(1 - progress, 4.2) * 0.6;
    }
  }
  return buffer;
}

// Exported so cues can be rendered offline for listening checks (see scripts/render-sound-cues.mjs).
export function createSoundEngine(): SoundEngine {
  let context: AudioContext | null = null;
  let voiceBus: GainNode | null = null;
  let reverbInput: GainNode | null = null;
  let toneOutput: GainNode | null = null;
  let toneSources: AudioScheduledSourceNode[] = [];
  let noise: AudioBuffer | null = null;
  let warmWave: PeriodicWave | null = null;
  let toneWanted = false;

  function ensureContext(): AudioContext | null {
    if (context) {
      return context;
    }
    if (typeof window === "undefined" || !window.AudioContext) {
      return null;
    }

    context = new window.AudioContext();
    const compressor = context.createDynamicsCompressor();
    const master = context.createGain();
    compressor.threshold.value = -18;
    compressor.knee.value = 14;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.22;
    master.gain.value = 0.62;
    compressor.connect(master);
    master.connect(context.destination);

    voiceBus = context.createGain();
    voiceBus.connect(compressor);

    reverbInput = context.createGain();
    const convolver = context.createConvolver();
    const reverbTone = context.createBiquadFilter();
    const reverbReturn = context.createGain();
    convolver.buffer = createRoomImpulse(context);
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 3200;
    reverbReturn.gain.value = 0.55;
    reverbInput.connect(convolver);
    convolver.connect(reverbTone);
    reverbTone.connect(reverbReturn);
    reverbReturn.connect(compressor);

    // The room tone bypasses the compressor so card notes never pump it.
    toneOutput = context.createGain();
    toneOutput.gain.value = 0;
    toneOutput.connect(master);

    warmWave = context.createPeriodicWave(
      new Float32Array([0, 0, 0, 0, 0, 0]),
      new Float32Array([0, 1, 0.32, 0.12, 0.05, 0.02]),
      { disableNormalization: false }
    );
    noise = createNoiseBuffer(context, 1.5);
    return context;
  }

  function effectsOn(): boolean {
    return useSoundSettings.getState().effects;
  }

  /** Routes a voice to the mix, a little to the reverb, and optionally across the stereo field. */
  function output(node: AudioNode, options: { reverb: number; pan?: number }) {
    if (!context || !voiceBus || !reverbInput) {
      return;
    }
    let tail: AudioNode = node;
    if (options.pan && typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      panner.pan.value = options.pan;
      node.connect(panner);
      tail = panner;
    }
    tail.connect(voiceBus);
    if (options.reverb > 0) {
      const send = context.createGain();
      send.gain.value = options.reverb;
      tail.connect(send);
      send.connect(reverbInput);
    }
  }

  function envelope(gain: GainNode, at: number, peak: number, attack: number, decay: number) {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  function sine(options: {
    frequency: number;
    at: number;
    gain: number;
    attack?: number;
    decay: number;
    glideTo?: number;
    wave?: "sine" | "warm" | "triangle";
    lowpass?: number;
    reverb?: number;
    pan?: number;
    detune?: number;
  }) {
    if (!context) {
      return;
    }
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    if (options.wave === "warm" && warmWave) {
      oscillator.setPeriodicWave(warmWave);
    } else {
      oscillator.type = options.wave === "triangle" ? "triangle" : "sine";
    }
    oscillator.frequency.setValueAtTime(options.frequency, options.at);
    if (options.detune) {
      oscillator.detune.setValueAtTime(options.detune, options.at);
    }
    const attack = options.attack ?? 0.005;
    if (options.glideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(30, options.glideTo),
        options.at + attack + options.decay
      );
    }
    envelope(gain, options.at, options.gain, attack, options.decay);

    let head: AudioNode = oscillator;
    if (options.lowpass) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = options.lowpass;
      oscillator.connect(filter);
      head = filter;
    }
    head.connect(gain);
    output(gain, { pan: options.pan, reverb: options.reverb ?? 0.1 });
    oscillator.start(options.at);
    oscillator.stop(options.at + attack + options.decay + 0.05);
  }

  function noiseBurst(options: {
    at: number;
    gain: number;
    duration: number;
    frequency: number;
    q?: number;
    sweepTo?: number;
    attack?: number;
    reverb?: number;
    pan?: number;
  }) {
    if (!context || !noise) {
      return;
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = noise;
    filter.type = "bandpass";
    filter.Q.value = options.q ?? 0.9;
    filter.frequency.setValueAtTime(options.frequency, options.at);
    if (options.sweepTo) {
      filter.frequency.exponentialRampToValueAtTime(options.sweepTo, options.at + options.duration);
    }
    envelope(gain, options.at, options.gain, options.attack ?? 0.003, options.duration);
    source.connect(filter);
    filter.connect(gain);
    output(gain, { pan: options.pan, reverb: options.reverb ?? 0.05 });
    source.start(options.at, Math.random() * 0.8);
    source.stop(options.at + options.duration + 0.05);
  }

  /** A felt mallet on a wooden bar: sine body, a short 4x "wood" partial and a soft strike. */
  function mallet(frequency: number, at: number, options: { gain: number; distance?: number; decay?: number }) {
    const distance = options.distance ?? 0;
    const pan = distance > 0 ? 0.28 : -0.08;
    const reverb = 0.1 + distance * 0.42;
    const brightness = 1 - distance * 0.55;
    const decay = options.decay ?? 1.25;

    sine({ at, decay, frequency, gain: options.gain, pan, reverb });
    sine({ at, decay: decay * 0.45, frequency: frequency * 2, gain: options.gain * 0.16 * brightness, pan, reverb });
    sine({
      at,
      decay: 0.16,
      frequency: frequency * 3.93,
      gain: options.gain * 0.14 * brightness,
      lowpass: 6000,
      pan,
      reverb
    });
    noiseBurst({
      at,
      duration: 0.018,
      frequency: 2400 * brightness + 600,
      gain: options.gain * 0.35 * brightness,
      pan,
      q: 1.4,
      reverb
    });
  }

  /** The card itself meeting the table: a short low thock. */
  function thock(at: number, options: { gain: number; distance?: number }) {
    const distance = options.distance ?? 0;
    const pan = distance > 0 ? 0.28 : -0.08;
    noiseBurst({ at, duration: 0.05, frequency: 620, gain: options.gain * 0.7, pan, q: 0.7, reverb: 0.04 + distance * 0.2 });
    sine({ at, decay: 0.09, frequency: 120, gain: options.gain, glideTo: 72, pan, reverb: 0.03 + distance * 0.15 });
  }

  function pad(frequencies: number[], at: number, options: { gain: number; attack?: number; decay?: number }) {
    for (const [index, frequency] of frequencies.entries()) {
      sine({
        at: at + index * 0.012,
        attack: options.attack ?? 0.06,
        decay: options.decay ?? 1.8,
        detune: index % 2 === 0 ? -4 : 4,
        frequency,
        gain: options.gain,
        lowpass: 2200,
        reverb: 0.32,
        wave: "warm"
      });
    }
  }

  /** A struck bowl: inharmonic partials in slightly detuned pairs so they beat slowly. */
  function bowl(base: number, at: number, gain: number) {
    const partials = [
      { decay: 3.2, gain: 1, ratio: 1 },
      { decay: 2.4, gain: 0.5, ratio: 2.76 },
      { decay: 1.5, gain: 0.22, ratio: 5.4 },
      { decay: 0.9, gain: 0.08, ratio: 8.93 }
    ];
    for (const partial of partials) {
      for (const offset of [-0.7, 0.7]) {
        sine({
          at,
          attack: 0.01,
          decay: partial.decay,
          frequency: base * partial.ratio + offset,
          gain: gain * partial.gain * 0.5,
          reverb: 0.3
        });
      }
    }
    noiseBurst({ at, duration: 0.03, frequency: 1800, gain: gain * 0.4, q: 1.2, reverb: 0.2 });
  }

  function tick(at: number, source: CardSource) {
    const distance = source === "partner" ? 1 : 0;
    sine({
      at,
      decay: 0.07,
      frequency: source === "partner" ? 1180 : 1480,
      gain: 0.05,
      pan: distance ? 0.28 : -0.08,
      reverb: 0.06 + distance * 0.3
    });
    noiseBurst({ at, duration: 0.012, frequency: 3200, gain: 0.03, q: 2, reverb: 0.04 });
  }

  function arpeggio(values: number[], at: number, gain: number): number {
    // Long levels get thinned evenly so the replay stays under a second.
    const maxNotes = 10;
    const picked = values.length <= maxNotes
      ? values
      : Array.from({ length: maxNotes }, (_, index) => values[Math.round((index * (values.length - 1)) / (maxNotes - 1))] ?? 50);
    picked.forEach((value, index) => {
      mallet(frequencyForCard(value), at + index * 0.085, { decay: 1.1, gain, distance: 0.35 });
    });
    return at + picked.length * 0.085;
  }

  function playEvent(event: SoundEvent, at: number): number {
    const D4 = 293.66;
    const Fs4 = 369.99;
    const A4 = 440;
    const D5 = 587.33;
    const A5 = 880;
    switch (event.kind) {
      case "arrive":
        mallet(D5, at, { gain: 0.07, distance: 0.6 });
        mallet(A5, at + 0.14, { gain: 0.06, distance: 0.6 });
        return at + 0.3;
      case "depart":
        mallet(A4, at, { gain: 0.05, distance: 0.7 });
        mallet(D4, at + 0.16, { gain: 0.05, distance: 0.7 });
        return at + 0.3;
      case "deal": {
        const flicks = Math.min(Math.max(event.count, 1), 6);
        for (let index = 0; index < flicks; index += 1) {
          noiseBurst({ at: at + index * 0.055, duration: 0.045, frequency: 1500, gain: 0.07, q: 0.8, reverb: 0.05 });
        }
        return at + 0.12;
      }
      case "focus":
        bowl(220, at + 0.08, 0.1);
        return at;
      case "card": {
        const distance = event.source === "partner" ? 1 : 0;
        if (event.resolution === "scan_discard") {
          noiseBurst({ at, attack: 0.03, duration: 0.32, frequency: 700, gain: 0.08, q: 2.2, reverb: 0.25, sweepTo: 3400 });
          mallet(frequencyForCard(event.value), at + 0.06, { decay: 0.6, distance: 0.8, gain: 0.05 });
          return at + 0.16;
        }
        if (event.resolution === "misplay_discard") {
          thock(at, { distance, gain: 0.07 });
          sine({ at, decay: 0.3, frequency: frequencyForCard(event.value), gain: 0.05, lowpass: 900, reverb: 0.12, wave: "warm" });
          return at + NOTE_SPACING_S;
        }
        thock(at, { distance, gain: 0.08 });
        mallet(frequencyForCard(event.value), at + 0.004, { distance, gain: distance ? 0.12 : 0.14 });
        return at + NOTE_SPACING_S;
      }
      case "misplay": {
        // The line breaks: a low drop, then a semitone rub that beats against itself.
        const start = at + 0.06;
        const root = frequencyForCard(event.value) / 2;
        sine({ at: start, decay: 0.5, frequency: 98, gain: 0.16 * ALERT_GAIN, glideTo: 46, reverb: 0.1 });
        sine({ at: start, attack: 0.02, decay: 0.75, frequency: root, gain: 0.07 * ALERT_GAIN, glideTo: root * 0.94, lowpass: 1400, reverb: 0.18, wave: "warm" });
        sine({ at: start, attack: 0.02, decay: 0.75, frequency: root * 1.0595, gain: 0.07 * ALERT_GAIN, glideTo: root * 0.99, lowpass: 1400, reverb: 0.18, wave: "warm" });
        sine({ at: start + 0.18, attack: 0.03, decay: 0.7, frequency: root * 0.75, gain: 0.05 * ALERT_GAIN, glideTo: root * 0.7, lowpass: 900, reverb: 0.22, wave: "warm" });
        return start + 0.6;
      }
      case "level_clear": {
        const start = at + 0.32;
        const end = arpeggio(event.melody, start, 0.075 * ALERT_GAIN);
        pad([D4, Fs4, A4, D5], end + 0.05, { decay: 1.9, gain: 0.03 * ALERT_GAIN });
        return end + 0.6;
      }
      case "game_won": {
        const start = at + 0.32;
        const end = arpeggio(event.melody, start, 0.08 * ALERT_GAIN);
        pad([196, 246.94, D4, 493.88], end + 0.05, { decay: 1.2, gain: 0.03 * ALERT_GAIN });
        pad([D4, Fs4, A4, D5, 739.99], end + 0.75, { attack: 0.1, decay: 2.8, gain: 0.032 * ALERT_GAIN });
        mallet(1174.66, end + 0.78, { decay: 2, distance: 0.5, gain: 0.06 * ALERT_GAIN });
        return end + 1.4;
      }
      case "game_lost": {
        // Leaves the scale on purpose: F natural turns the key minor.
        const start = at + 0.25;
        sine({ at: start, decay: 0.5, frequency: 98, gain: 0.14 * ALERT_GAIN, glideTo: 46, reverb: 0.1 });
        const notes = [A4, 349.23, D4, 220];
        notes.forEach((frequency, index) => {
          sine({
            at: start + index * 0.32,
            attack: 0.03,
            decay: 1.1 + index * 0.3,
            frequency,
            gain: 0.06 * ALERT_GAIN,
            lowpass: 1500,
            reverb: 0.3,
            wave: "warm"
          });
        });
        pad([73.42, 110, 146.83], start + 0.96, { attack: 0.2, decay: 2.4, gain: 0.05 * ALERT_GAIN });
        return start + 2;
      }
      case "pause":
        mallet(A4, at, { decay: 0.6, distance: 0.3, gain: 0.06 });
        mallet(329.63, at + 0.12, { decay: 0.9, distance: 0.3, gain: 0.06 });
        return at + 0.3;
      case "resume":
        mallet(329.63, at, { decay: 0.5, distance: 0.3, gain: 0.06 });
        mallet(A4, at + 0.12, { decay: 0.9, distance: 0.3, gain: 0.06 });
        return at + 0.3;
      case "request":
        if (event.source === "partner") {
          // You need to answer this one, so it asks for attention.
          mallet(987.77, at, { decay: 0.8, distance: 0.6, gain: 0.08 });
          mallet(739.99, at + 0.16, { decay: 1, distance: 0.6, gain: 0.08 });
          mallet(987.77, at + 0.32, { decay: 1.2, distance: 0.6, gain: 0.07 });
        } else {
          tick(at, "self");
        }
        return at + 0.4;
      case "declined":
        mallet(493.88, at, { decay: 0.5, distance: 0.4, gain: 0.05 });
        mallet(369.99, at + 0.1, { decay: 0.7, distance: 0.4, gain: 0.05 });
        return at + 0.25;
      case "ready":
        tick(at, event.source);
        return at + 0.05;
    }
  }

  function startRoomTone() {
    const ctx = ensureContext();
    if (!ctx || !toneOutput || !noise || toneSources.length > 0 || ctx.state !== "running") {
      return;
    }
    const now = ctx.currentTime;
    const sum = ctx.createGain();
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 420;
    sum.connect(lowpass);
    lowpass.connect(toneOutput);

    // Two quiet voices a fifth apart (D2 and A2), each breathing on its own slow cycle.
    const voices = [
      { frequency: 73.42, gain: 0.5, rate: 0.071 },
      { frequency: 110, gain: 0.32, rate: 0.053 },
      { frequency: 146.83, gain: 0.12, rate: 0.089 }
    ];
    for (const voice of voices) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoDepth = ctx.createGain();
      oscillator.frequency.value = voice.frequency;
      gain.gain.value = voice.gain;
      lfo.frequency.value = voice.rate;
      lfoDepth.gain.value = voice.gain * 0.45;
      lfo.connect(lfoDepth);
      lfoDepth.connect(gain.gain);
      oscillator.connect(gain);
      gain.connect(sum);
      oscillator.start(now);
      lfo.start(now);
      toneSources.push(oscillator, lfo);
    }

    const air = ctx.createBufferSource();
    const airFilter = ctx.createBiquadFilter();
    const airGain = ctx.createGain();
    air.buffer = noise;
    air.loop = true;
    airFilter.type = "lowpass";
    airFilter.frequency.value = 300;
    airGain.gain.value = 0.18;
    air.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(sum);
    air.start(now);
    toneSources.push(air);

    toneOutput.gain.cancelScheduledValues(now);
    toneOutput.gain.setValueAtTime(toneOutput.gain.value, now);
    // Sits roughly 10 dB under a single card note: felt more than heard.
    toneOutput.gain.linearRampToValueAtTime(0.016, now + 2.5);
  }

  function stopRoomTone() {
    if (!context || !toneOutput || toneSources.length === 0) {
      return;
    }
    const now = context.currentTime;
    toneOutput.gain.cancelScheduledValues(now);
    toneOutput.gain.setValueAtTime(toneOutput.gain.value, now);
    toneOutput.gain.linearRampToValueAtTime(0, now + 1.2);
    const sources = toneSources;
    toneSources = [];
    for (const source of sources) {
      source.stop(now + 1.3);
    }
  }

  return {
    unlock: async () => {
      const ctx = ensureContext();
      if (ctx && ctx.state === "suspended") {
        await ctx.resume();
      }
      if (toneWanted) {
        startRoomTone();
      }
    },
    tap: () => {
      const ctx = ensureContext();
      if (!ctx || !effectsOn()) {
        return;
      }
      const at = ctx.currentTime + 0.003;
      noiseBurst({ at, duration: 0.025, frequency: 1900, gain: 0.05, q: 1.1, reverb: 0.02 });
    },
    live: () => {
      const ctx = ensureContext();
      if (!ctx || !effectsOn()) {
        return;
      }
      // The round is open: one clear, high note so nobody has to look up.
      mallet(880, ctx.currentTime + 0.01, { decay: 1.6, distance: 0.4, gain: 0.07 });
    },
    play: (events) => {
      const ctx = ensureContext();
      if (!ctx || events.length === 0 || !effectsOn() || ctx.state !== "running") {
        return;
      }
      let at = ctx.currentTime + 0.012;
      for (const event of events) {
        at = playEvent(event, at);
      }
    },
    setRoomTone: (active) => {
      toneWanted = active;
      if (active) {
        startRoomTone();
      } else {
        stopRoomTone();
      }
    },
    dispose: () => {
      stopRoomTone();
      if (context && context.state !== "closed") {
        void context.close();
      }
      context = null;
      voiceBus = null;
      reverbInput = null;
      toneOutput = null;
      noise = null;
      warmWave = null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* React hook                                                          */
/* ------------------------------------------------------------------ */

export function useRoomSounds(snapshot: RoomState | null) {
  const engineRef = useRef<SoundEngine | null>(null);
  const previousSnapshotRef = useRef<RoomState | null>(null);
  const roomToneSetting = useSoundSettings((state) => state.roomTone);
  const effectsSetting = useSoundSettings((state) => state.effects);

  if (engineRef.current === null) {
    engineRef.current = createSoundEngine();
  }

  useEffect(() => {
    const engine = engineRef.current ?? createSoundEngine();
    engineRef.current = engine;
    const unlock = () => {
      void engine.unlock();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = previousSnapshotRef.current;
    previousSnapshotRef.current = snapshot;
    engineRef.current?.play(describeSoundEvents(previous, snapshot));
  }, [snapshot]);

  // The "go" note lands exactly when the focus countdown ends.
  const transitionEndsAt = snapshot?.phase === "focus_transition" ? snapshot.transitionEndsAt : null;
  useEffect(() => {
    if (transitionEndsAt === null) {
      return undefined;
    }
    const delay = transitionEndsAt - Date.now();
    if (delay < -500) {
      return undefined;
    }
    const timer = window.setTimeout(() => engineRef.current?.live(), Math.max(0, delay));
    return () => window.clearTimeout(timer);
  }, [transitionEndsAt]);

  const phase = snapshot?.phase ?? null;
  const toneActive = roomToneSetting && effectsSetting && (phase === "in_round" || phase === "focus_transition");
  useEffect(() => {
    engineRef.current?.setRoomTone(toneActive);
  }, [toneActive]);

  return {
    playCardTap: () => {
      engineRef.current?.tap();
    }
  };
}

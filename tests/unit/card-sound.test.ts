import { describe, expect, it } from "vitest";
import {
  bootstrapSeat,
  createPublicRoomState,
  createRoomEngineState,
  maybeAdvanceTimedPhase,
  playLowestCard,
  readyForLevel,
  type DebugRoomPreset,
  type RoomEngineState
} from "@shared/game-core";
import {
  CARD_PITCH_STEPS,
  describeSoundEvents,
  frequencyForCard,
  getRoomSoundCue,
  noteIndexForCard
} from "@client/card-sound";

function makeLiveState(level: number, debugPreset: DebugRoomPreset): RoomEngineState {
  let state = createRoomEngineState({
    roomId: "room-a",
    seed: debugPreset.seed ?? 1234,
    now: 1,
    debugPreset
  });
  state = bootstrapSeat(state, "host", 10);
  state = bootstrapSeat(state, "guest", 20);
  state = {
    ...state,
    currentLevel: level,
    phase: "between_levels"
  };
  state = readyForLevel(state, "host", 30).state;
  state = readyForLevel(state, "guest", 40).state;
  return maybeAdvanceTimedPhase(state, (state.transitionEndsAt ?? 40) + 1);
}

function toHostView(state: RoomEngineState) {
  return createPublicRoomState(
    state,
    "host",
    "https://example.com",
    {
      host: "host-token-123456",
      guest: "guest-token-123456"
    },
    state.lastActivityAt + 1
  );
}

describe("room sound cues", () => {
  it("plays the life warning cue when a misplay burns a life but the run continues", () => {
    const before = makeLiveState(2, {
      deals: {
        2: {
          host: [40, 80],
          guest: [25, 60]
        }
      }
    });

    const after = playLowestCard(before, "host", 100).state;

    expect(getRoomSoundCue(toHostView(before), toHostView(after))).toBe("life_warning");
  });

  it("plays the game over cue instead of the warning cue when the last life is lost", () => {
    const before = {
      ...makeLiveState(2, {
        deals: {
          2: {
            host: [40, 80],
            guest: [25, 60]
          }
        }
      }),
      lives: 1
    };

    const after = playLowestCard(before, "host", 100).state;

    expect(toHostView(after).phase).toBe("lost");
    expect(getRoomSoundCue(toHostView(before), toHostView(after))).toBe("game_lost");
  });

  it("keeps the level clear cue for successful round completion", () => {
    const roundStart = makeLiveState(1, {
      deals: {
        1: {
          host: [10],
          guest: [90]
        }
      }
    });
    const midRound = playLowestCard(roundStart, "host", 100).state;
    const after = playLowestCard(midRound, "guest", 120).state;

    expect(getRoomSoundCue(toHostView(midRound), toHostView(after))).toBe("level_clear");
  });
});

describe("card pitch mapping", () => {
  it("never falls as the card value rises, so a clean pile always climbs", () => {
    for (let value = 2; value <= 100; value += 1) {
      expect(frequencyForCard(value)).toBeGreaterThanOrEqual(frequencyForCard(value - 1));
    }
  });

  it("spans the full scale from 1 to 100", () => {
    expect(noteIndexForCard(1)).toBe(0);
    expect(noteIndexForCard(100)).toBe(CARD_PITCH_STEPS - 1);
    expect(frequencyForCard(1)).toBeCloseTo(146.83, 1);
    expect(frequencyForCard(100)).toBeCloseTo(146.83 * 8, 0);
  });
});

describe("room sound events", () => {
  it("plays your card close and your partner's card from across the table", () => {
    const roundStart = makeLiveState(1, {
      deals: {
        1: {
          host: [10],
          guest: [90]
        }
      }
    });
    const afterHost = playLowestCard(roundStart, "host", 100).state;
    const afterGuest = playLowestCard(afterHost, "guest", 120).state;

    expect(describeSoundEvents(toHostView(roundStart), toHostView(afterHost))).toEqual([
      { kind: "card", resolution: "played", source: "self", value: 10 }
    ]);

    const clearEvents = describeSoundEvents(toHostView(afterHost), toHostView(afterGuest));
    expect(clearEvents[0]).toEqual({ kind: "card", resolution: "played", source: "partner", value: 90 });
    expect(clearEvents).toContainEqual({ kind: "level_clear", melody: [10, 90] });
  });

  it("breaks the line after the cards land when a misplay costs a life", () => {
    const before = makeLiveState(2, {
      deals: {
        2: {
          host: [40, 80],
          guest: [25, 60]
        }
      }
    });
    const after = playLowestCard(before, "host", 100).state;
    const events = describeSoundEvents(toHostView(before), toHostView(after));

    expect(events.map((event) => event.kind)).toEqual(["card", "card", "misplay"]);
    expect(events[events.length - 1]).toEqual({ kind: "misplay", value: 40 });
  });
});

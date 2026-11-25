import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { startTransition, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  bootstrapResponseSchema,
  clientEventSchema,
  createRoomResponseSchema,
  FOCUS_TRANSITION_MS,
  roomIdSchema,
  serverEventSchema,
  type ClientEvent,
  type RoomState,
  type SeatId
} from "@shared/protocol";
import { useRoomStore } from "@client/store";
import { useRoomSounds, useSoundSettings } from "@client/card-sound";
import { APP_VERSION, PROTOCOL_VERSION } from "@shared/version";

type RouteState =
  | { kind: "landing" }
  | { kind: "room"; roomId: string; token: string | null };

type Player = RoomState["players"]["host"];

const ROOM_TOKEN_STORAGE_PREFIX = "the-mind:room-token:";
const revealEase = [0.22, 1, 0.36, 1] as const;
const cardSpring = {
  damping: 30,
  mass: 0.8,
  stiffness: 360,
  type: "spring"
} as const;

function roomTokenStorageKey(roomId: string): string {
  return `${ROOM_TOKEN_STORAGE_PREFIX}${roomId}`;
}

function readStoredRoomToken(roomId: string): string | null {
  try {
    return window.sessionStorage.getItem(roomTokenStorageKey(roomId));
  } catch {
    return null;
  }
}

function persistRoomToken(roomId: string, token: string): void {
  try {
    window.sessionStorage.setItem(roomTokenStorageKey(roomId), token);
  } catch {
    // Private browsing can block storage. The live URL still carries the token.
  }
}

function clearStoredRoomToken(roomId: string): void {
  try {
    window.sessionStorage.removeItem(roomTokenStorageKey(roomId));
  } catch {
    // Nothing else to clear.
  }
}

function parseRoute(url: URL): RouteState {
  const match = /^\/room\/([a-z0-9]+)$/u.exec(url.pathname);
  if (!match) {
    return { kind: "landing" };
  }

  const roomId = roomIdSchema.safeParse(match[1] ?? "");
  if (!roomId.success) {
    return { kind: "landing" };
  }

  return {
    kind: "room",
    roomId: roomId.data,
    token: url.hash ? url.hash.slice(1) : readStoredRoomToken(roomId.data)
  };
}

function selfAndOther(snapshot: RoomState) {
  const self = snapshot.players[snapshot.viewerSeatId];
  const otherSeatId: SeatId = snapshot.viewerSeatId === "host" ? "guest" : "host";
  return { other: snapshot.players[otherSeatId], self };
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Where a card value sits along the 1 to 100 line, as a percentage. */
function linePosition(value: number): string {
  return `${((clampNumber(value, 1, 100) - 1) / 99) * 100}%`;
}

/** A small, stable tilt per card so the pile looks dropped by hand rather than stacked by a machine. */
function cardTilt(value: number): number {
  return ((value * 37) % 11) - 5;
}

function buttonClass(kind: "primary" | "secondary" | "text"): string {
  return classes("ui-button", `ui-button-${kind}`);
}

function describePresence(player: Player): string {
  if (player.connected) {
    return "Here";
  }
  if (player.hasJoined) {
    return "Away";
  }
  return "Not joined yet";
}

function isRoundLive(snapshot: RoomState, nowMs: number): boolean {
  return snapshot.phase === "in_round"
    || (
      snapshot.phase === "focus_transition"
      && snapshot.transitionEndsAt !== null
      && nowMs >= snapshot.transitionEndsAt
    );
}

function useHandFanLayout(measureRef: RefObject<HTMLDivElement | null>, cardCount: number) {
  const [availableSize, setAvailableSize] = useState({ height: 180, width: 640 });

  useEffect(() => {
    const element = measureRef.current;
    if (!element) {
      return undefined;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setAvailableSize({ height: rect.height, width: rect.width });
    };
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measureRef]);

  const compact = availableSize.width < 560;
  const usableWidth = Math.max(availableSize.width - (compact ? 8 : 16), 0);
  const baseMaxCardWidth = compact ? 104 : 128;
  // Leave room above the cards for the active card's lift.
  const heightLimitedCardWidth = Math.floor(Math.max(44, (availableSize.height - 22) / 1.4));
  const maxCardWidth = Math.max(44, Math.min(baseMaxCardWidth, heightLimitedCardWidth));
  const minCardWidth = Math.min(compact ? 60 : 72, maxCardWidth);
  const preferredVisibleStep = compact ? 26 : 38;
  const relaxedGap = compact ? 8 : 14;
  const overlapCount = Math.max(cardCount - 1, 0);
  const cardWidth = cardCount <= 1
    ? maxCardWidth
    : clampNumber(
        Math.round(usableWidth - preferredVisibleStep * overlapCount),
        minCardWidth,
        maxCardWidth
      );
  const step = cardCount <= 1
    ? cardWidth
    : Math.max(0, Math.min(cardWidth + relaxedGap, (usableWidth - cardWidth) / overlapCount));
  const cardHeight = Math.round(cardWidth * 1.4);
  const totalWidth = cardCount === 0 ? 0 : cardWidth + step * overlapCount;
  const valueFontSize = clampNumber(Math.round(cardWidth * 0.56), cardWidth < 62 ? 26 : 32, 76);
  const useCornerValue = step < cardWidth * 0.72;

  return { cardHeight, cardWidth, step, totalWidth, useCornerValue, valueFontSize };
}

async function readJsonOrThrow(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error("Empty response.");
  }
  return JSON.parse(text);
}

export function App() {
  const [route, setRoute] = useState<RouteState>(() => parseRoute(new URL(window.location.href)));

  useEffect(() => {
    const handleLocation = () => setRoute(parseRoute(new URL(window.location.href)));
    window.addEventListener("popstate", handleLocation);
    window.addEventListener("hashchange", handleLocation);
    return () => {
      window.removeEventListener("popstate", handleLocation);
      window.removeEventListener("hashchange", handleLocation);
    };
  }, []);

  useEffect(() => {
    if (route.kind !== "room" || !route.token) {
      return;
    }
    persistRoomToken(route.roomId, route.token);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    }
  }, [route]);

  useEffect(() => {
    const timer = window.setInterval(() => useRoomStore.getState().tickRealClock(), 200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="app-shell">
      {route.kind === "landing" ? (
        <LandingScreen />
      ) : (
        <RoomScreen roomId={route.roomId} token={route.token} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Landing                                                             */
/* ------------------------------------------------------------------ */

function LandingScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  const reducedMotion = Boolean(useReducedMotion());

  const createRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      if (!response.ok) {
        throw new Error("Couldn't open a room. Check your connection and try again.");
      }
      const payload = createRoomResponseSchema.parse(await readJsonOrThrow(response));
      window.location.assign(payload.hostInviteUrl);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Couldn't open a room. Try again.");
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!showRules) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("how-to-play")?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start"
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, showRules]);

  const revealRules = () => {
    if (showRules) {
      document.getElementById("how-to-play")?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start"
      });
      return;
    }
    setShowRules(true);
  };

  return (
    <section className={classes("landing-page", showRules && "landing-page-rules-open")}>
      <section className="landing-hero">
        <p className="wordmark">The Mind</p>
        <div className="landing-copy">
          <h1>Play in order. Say nothing.</h1>
          <p className="landing-lead">
            A private card game for two. You each hold numbers the other can't see, and put them down lowest to highest on timing alone (no hints, no counting out loud).
          </p>
          <div className="landing-actions">
            <button
              className={buttonClass("primary")}
              disabled={busy}
              onClick={() => void createRoom()}
              type="button"
            >
              {busy ? "Opening…" : "Open a room"}
            </button>
            <button
              aria-controls="how-to-play"
              aria-expanded={showRules}
              className={buttonClass("text")}
              onClick={revealRules}
              type="button"
            >
              How to play
            </button>
          </div>
          {error ? <p className="inline-error" role="alert">{error}</p> : null}
        </div>
        <LineDemo reducedMotion={reducedMotion} />
      </section>

      {showRules ? <HowToPlay /> : null}

      <Attribution />
    </section>
  );
}

const demoPlays: Array<{ value: number; source: "self" | "partner" }> = [
  { source: "partner", value: 8 },
  { source: "self", value: 19 },
  { source: "self", value: 26 },
  { source: "partner", value: 41 },
  { source: "self", value: 57 },
  { source: "partner", value: 73 },
  { source: "partner", value: 88 },
  { source: "self", value: 96 }
];

/** A looping miniature of a clean round, so the idea lands before any rules are read. */
function LineDemo(props: { reducedMotion: boolean }) {
  const [step, setStep] = useState(props.reducedMotion ? demoPlays.length : 1);

  useEffect(() => {
    if (props.reducedMotion) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setStep((current) => (current >= demoPlays.length + 2 ? 1 : current + 1));
    }, 1100);
    return () => window.clearInterval(timer);
  }, [props.reducedMotion]);

  const shown = demoPlays.slice(0, Math.min(step, demoPlays.length));
  const latest = shown[shown.length - 1];

  return (
    <div aria-hidden="true" className="landing-demo">
      <div className="demo-card-slot">
        <AnimatePresence initial={false} mode="popLayout">
          {latest ? (
            <motion.div
              animate={{ opacity: 1, rotate: cardTilt(latest.value), y: 0 }}
              className={classes("demo-card", `demo-card-${latest.source}`)}
              exit={{ opacity: 0, scale: 0.96 }}
              initial={props.reducedMotion ? false : { opacity: 0, y: latest.source === "self" ? 36 : -36 }}
              key={latest.value}
              transition={cardSpring}
            >
              {latest.value}
            </motion.div>
          ) : null}
        </AnimatePresence>
        {latest ? (
          <span className={classes("demo-caption", `demo-caption-${latest.source}`)}>
            {latest.source === "self" ? "You" : "Your partner"}
          </span>
        ) : null}
      </div>
      <div className="line-scale">
        <span>1</span>
        <div className="line-track">
          {shown.map((play) => (
            <i
              className={classes("line-dot", `line-dot-${play.source}`)}
              key={play.value}
              style={{ left: linePosition(play.value) }}
            />
          ))}
        </div>
        <span>100</span>
      </div>
    </div>
  );
}

function HowToPlay() {
  return (
    <section className="rules" id="how-to-play">
      <div className="rules-intro">
        <h2>How a round works</h2>
        <p>
          Level 1 deals you one card each, level 2 deals two, and so on all the way up to 12. Once a round starts it's no numbers, no hints and no counting out loud. It's all timing.
        </p>
      </div>
      <ol className="rules-steps">
        <li>
          <h3>Open a room and send the link</h3>
          <p>One of you opens a room and sends the invite. No accounts or codes needed.</p>
        </li>
        <li>
          <h3>Both hit Ready, then go quiet</h3>
          <p>You'll hear a bowl and see a ring close. That's your cue to stop talking until the level's done.</p>
        </li>
        <li>
          <h3>Play when it feels right</h3>
          <p>You can only play your lowest card. Low numbers tend to go quickly, high ones can wait a bit.</p>
        </li>
        <li>
          <h3>Empty both hands to clear the level</h3>
          <p>Every card played has to be higher than the one before it.</p>
        </li>
      </ol>
      <div className="rules-recovery">
        <div>
          <h3>If a card is played too early</h3>
          <p>You lose a life, and any lower cards still in your hands get thrown out so the round can carry on.</p>
        </div>
        <div>
          <h3>If you're both stuck</h3>
          <p>Ask for a throwing star. If the other person agrees, you both drop your lowest card.</p>
        </div>
        <div>
          <h3>Keys</h3>
          <p>Space plays your lowest card. P pauses, T asks for a star and F goes full screen.</p>
        </div>
      </div>
    </section>
  );
}

function Attribution() {
  return (
    <p className="attribution">
      Unofficial fan-made adaptation inspired by <cite>The Mind</cite>. The game and its mechanics are not original to this project.
      <span aria-label={`Version ${APP_VERSION}`}>v{APP_VERSION}</span>
    </p>
  );
}

function CenteredMessage(props: { title: string; body: string; action?: ReactNode }) {
  return (
    <section className="message-screen">
      <p className="wordmark">The Mind</p>
      <div className="message-block">
        <h1>{props.title}</h1>
        <p>{props.body}</p>
        {props.action ? <div className="message-action">{props.action}</div> : null}
      </div>
      <Attribution />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Room                                                                */
/* ------------------------------------------------------------------ */

function RoomScreen(props: { roomId: string; token: string | null }) {
  const snapshot = useRoomStore((state) => state.snapshot);
  const connectionState = useRoomStore((state) => state.connectionState);
  const error = useRoomStore((state) => state.error);
  const banner = useRoomStore((state) => state.banner);
  const clearBanner = useRoomStore((state) => state.clearBanner);
  const levelAdvanceHoldUntilMs = useRoomStore((state) => state.levelAdvanceOverlayHoldUntilMs);
  const nowMs = useRoomStore((state) => state.nowMs);
  const reducedMotion = Boolean(useReducedMotion());
  const { reconnectNow, sendEvent } = useRoomSession(props.roomId, props.token);
  const { playCardTap } = useRoomSounds(snapshot);

  useEffect(() => {
    if (!banner) {
      return undefined;
    }
    const timer = window.setTimeout(clearBanner, 2600);
    return () => window.clearTimeout(timer);
  }, [banner, clearBanner]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!snapshot) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName)) {
        return;
      }

      const key = event.key.toLowerCase();
      const live = isRoundLive(snapshot, Date.now());
      if (key === "f") {
        void toggleFullscreen();
      } else if (live && event.key === " ") {
        event.preventDefault();
        playCardTap();
        sendEvent({ type: "play_lowest_card" });
      } else if (key === "p" && live && snapshot.pendingRequest === null) {
        sendEvent({ type: "request_pause" });
      } else if ((key === "t" || key === "s") && live && snapshot.pendingRequest === null && snapshot.scans > 0) {
        sendEvent({ type: "request_scan" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playCardTap, sendEvent, snapshot]);

  if (!props.token) {
    return (
      <CenteredMessage
        action={<a className={buttonClass("secondary")} href="/">Back to the start</a>}
        body="The private part of the invite got cut off. Ask for the full link again and it should work."
        title="This link is missing a bit"
      />
    );
  }

  if (!snapshot) {
    const failed = connectionState === "error" || connectionState === "closed";
    return (
      <CenteredMessage
        action={failed ? (
          <button className={buttonClass("primary")} onClick={reconnectNow} type="button">Try again</button>
        ) : undefined}
        body={error ?? "Finding your seat…"}
        title={error ? "Couldn't get you in" : "Joining the room"}
      />
    );
  }

  const { other, self } = selfAndOther(snapshot);
  const focusRemainingMs = snapshot.transitionEndsAt === null
    ? 0
    : Math.max(0, snapshot.transitionEndsAt - nowMs);
  const isFocusing = snapshot.phase === "focus_transition" && focusRemainingMs > 0;
  const isRoundInteractive = isRoundLive(snapshot, nowMs);
  const canRequest = isRoundInteractive && snapshot.pendingRequest === null;
  const canRequestStar = canRequest && snapshot.scans > 0;
  const isHoldingLevelClear = levelAdvanceHoldUntilMs !== null && nowMs < levelAdvanceHoldUntilMs;
  const connectionInterrupted = connectionState === "closed"
    || connectionState === "error"
    || connectionState === "reconnecting";
  const showTable = !(
    snapshot.phase === "waiting"
    || (snapshot.phase === "between_levels" && !isHoldingLevelClear)
    || isFocusing
    || snapshot.phase === "won"
    || snapshot.phase === "lost"
  );
  const playLowestCard = () => {
    playCardTap();
    sendEvent({ type: "play_lowest_card" });
  };

  return (
    <section
      className={classes(
        "room-screen",
        `room-phase-${snapshot.phase}`,
        isFocusing && "room-focusing",
        connectionInterrupted && "room-screen-interrupted"
      )}
    >
      <header className="room-bar">
        <p className="wordmark">The Mind</p>
        <LevelReadout level={snapshot.currentLevel} maxLevel={snapshot.maxLevel} />
        <div className="room-status">
          <ResourceIcons count={snapshot.lives} kind="life" />
          <ResourceIcons count={snapshot.scans} kind="star" />
          {snapshot.inviteLink && !other.hasJoined ? (
            <span className="room-bar-invite"><CopyInviteButton inviteLink={snapshot.inviteLink} /></span>
          ) : null}
          <SettingsMenu
            inviteLink={snapshot.inviteLink}
            name={self.displayName}
            onRename={(displayName) => sendEvent({ displayName, type: "set_name" })}
          />
        </div>
      </header>

      <AnimatePresence>
        {banner ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            aria-live="polite"
            className={classes("event-banner", `event-banner-${banner.tone}`)}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.16 } }}
            initial={{ opacity: 0, y: -14 }}
            key={`${banner.tone}-${banner.text}`}
            role="status"
            transition={{ duration: 0.22, ease: revealEase }}
          >
            <i aria-hidden="true" />
            <strong>{banner.text}</strong>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {banner?.effect === "life_lost" && !reducedMotion ? (
        <div aria-hidden="true" className="life-flash" key={`flash-${banner.text}`} />
      ) : null}

      <section className="game-board">
        <PartnerLane phase={snapshot.phase} player={other} />

        {connectionInterrupted ? (
          <div className="reconnect-strip" role="status">
            <div>
              <strong>Connection dropped</strong>
              <span>Trying to get you back in. The table stays as it was.</span>
            </div>
            <button className={buttonClass("secondary")} onClick={reconnectNow} type="button">Retry now</button>
          </div>
        ) : null}

        <div className="table-center">
          {showTable ? (
            <div className="live-table-content">
              <PileStack
                partnerName={other.displayName}
                pile={snapshot.pile}
                reducedMotion={reducedMotion}
                selfSeatId={snapshot.viewerSeatId}
                summary={snapshot.summary}
              />
              <AnimatePresence>
                {snapshot.pendingRequest ? (
                  <PendingRequestPanel
                    key={snapshot.pendingRequest.kind}
                    selfSeatId={snapshot.viewerSeatId}
                    sendEvent={sendEvent}
                    snapshot={snapshot}
                  />
                ) : null}
              </AnimatePresence>
            </div>
          ) : (
            <TableState
              focusRemainingMs={focusRemainingMs}
              onRename={(displayName) => sendEvent({ displayName, type: "set_name" })}
              other={other}
              self={self}
              sendEvent={sendEvent}
              snapshot={snapshot}
            />
          )}
        </div>

        <NumberLine
          celebrating={isHoldingLevelClear || snapshot.phase === "won"}
          hand={self.hand}
          live={isRoundInteractive}
          pile={snapshot.pile}
          selfSeatId={snapshot.viewerSeatId}
        />

        <HandZone
          isRoundInteractive={isRoundInteractive && snapshot.pendingRequest === null && !connectionInterrupted}
          onPlay={playLowestCard}
          phase={snapshot.phase}
          self={self}
        />

        <div className="table-actions">
          <button
            className={buttonClass("secondary")}
            disabled={!canRequest}
            onClick={() => sendEvent({ type: "request_pause" })}
            type="button"
          >
            Pause
          </button>
          <p className="shortcut-note">Space plays your lowest card · P pause · T star · F full screen</p>
          <button
            className={buttonClass("secondary")}
            disabled={!canRequestStar}
            onClick={() => sendEvent({ type: "request_scan" })}
            type="button"
          >
            Throw star
          </button>
        </div>
      </section>
    </section>
  );
}

function LevelReadout(props: { level: number; maxLevel: number }) {
  return (
    <div className="level-readout" aria-label={`Level ${props.level} of ${props.maxLevel}`}>
      <strong>Level {props.level}</strong>
      <span className="level-track" aria-hidden="true">
        {Array.from({ length: props.maxLevel }, (_, index) => (
          <i
            className={classes(index + 1 < props.level && "level-done", index + 1 === props.level && "level-current")}
            key={index}
          />
        ))}
      </span>
      <span className="level-of">of {props.maxLevel}</span>
    </div>
  );
}

function ResourceIcons(props: { kind: "life" | "star"; count: number }) {
  const label = props.kind === "life" ? countLabel(props.count, "life", "lives") : countLabel(props.count, "throwing star");
  const shown = Math.min(props.count, 5);
  return (
    <div aria-label={label} className={classes("resource", `resource-${props.kind}`)} role="img" title={label}>
      {Array.from({ length: shown }, (_, index) => (
        <motion.svg
          animate={{ opacity: 1, scale: 1 }}
          initial={{ opacity: 0, scale: 0.4 }}
          key={index}
          transition={{ duration: 0.24, ease: revealEase }}
          viewBox="0 0 24 24"
        >
          {props.kind === "life" ? (
            <path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z" />
          ) : (
            <path d="M12 2.5l2.6 6.9 6.9 2.6-6.9 2.6L12 21.5l-2.6-6.9L2.5 12l6.9-2.6Z" />
          )}
        </motion.svg>
      ))}
      {props.count === 0 ? <span className="resource-none">0</span> : null}
      {props.count > 5 ? <span className="resource-extra">+{props.count - 5}</span> : null}
    </div>
  );
}

function TableState(props: {
  snapshot: RoomState;
  self: Player;
  other: Player;
  focusRemainingMs: number;
  sendEvent: (event: ClientEvent) => void;
  onRename: (name: string) => void;
}) {
  const { other, self, snapshot } = props;

  let content: ReactNode;
  let key: string;

  if (snapshot.phase === "waiting") {
    key = "waiting";
    content = (
      <>
        <h2>{other.hasJoined ? "You're both here" : "Waiting for your partner"}</h2>
        <p>
          {other.hasJoined
            ? "Setting things up…"
            : "Send them the invite link. They can join straight from it, no account needed."}
        </p>
        {snapshot.inviteLink && !other.hasJoined ? <CopyInviteButton inviteLink={snapshot.inviteLink} primary /> : null}
        <NameEditor key={self.displayName} onSubmit={props.onRename} value={self.displayName} />
      </>
    );
  } else if (snapshot.phase === "focus_transition") {
    key = "focus";
    const progress = clampNumber(props.focusRemainingMs / FOCUS_TRANSITION_MS, 0, 1);
    content = (
      <>
        <div className="focus-ring" style={{ "--focus-progress": progress } as CSSProperties}>
          <svg aria-hidden="true" viewBox="0 0 120 120">
            <circle className="focus-ring-track" cx="60" cy="60" r="54" />
            <circle className="focus-ring-fill" cx="60" cy="60" pathLength="1" r="54" />
          </svg>
          <strong>{Math.max(1, Math.ceil(props.focusRemainingMs / 1000))}</strong>
        </div>
        <h2>Get quiet</h2>
        <p>The round starts when the ring closes.</p>
      </>
    );
  } else if (snapshot.phase === "won" || snapshot.phase === "lost") {
    key = snapshot.phase;
    const won = snapshot.phase === "won";
    const reached = snapshot.summary && "level" in snapshot.summary ? snapshot.summary.level : snapshot.currentLevel;
    content = (
      <>
        <h2>{won ? "All 12 levels done" : "Out of lives"}</h2>
        <p>{won ? "You read each other the whole way up. Not bad at all." : `You made it to level ${reached}. Same room, fresh cards. Go again?`}</p>
        <ReadinessRow other={other} self={self} />
        <button
          className={buttonClass("primary")}
          disabled={self.ready}
          onClick={() => props.sendEvent({ type: "request_rematch" })}
          type="button"
        >
          {self.ready ? `Waiting for ${other.displayName}` : "Rematch"}
        </button>
      </>
    );
  } else {
    key = `ready-${snapshot.currentLevel}`;
    const cleared = snapshot.summary?.kind === "level_cleared" ? snapshot.summary : null;
    content = (
      <>
        {cleared ? <p className="state-kicker">Level {cleared.level} done</p> : null}
        <h2>Level {snapshot.currentLevel}</h2>
        <p>{countLabel(snapshot.currentLevel, "card")} each this time.</p>
        {cleared && (cleared.rewards.life || cleared.rewards.scan) ? (
          <div className="reward-row">
            {cleared.rewards.life ? <span className="reward reward-life">+1 life</span> : null}
            {cleared.rewards.scan ? <span className="reward reward-star">+1 throwing star</span> : null}
          </div>
        ) : null}
        <ReadinessRow other={other} self={self} />
        <button
          className={buttonClass("primary")}
          disabled={!snapshot.canStartLevel}
          onClick={() => props.sendEvent({ type: "ready_for_level" })}
          type="button"
        >
          {self.ready ? `Waiting for ${other.displayName}` : "Ready"}
        </button>
      </>
    );
  }

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={classes("state-message", key === "focus" && "state-message-focus")}
      initial={{ opacity: 0, y: 10 }}
      key={key}
      transition={{ duration: 0.26, ease: revealEase }}
    >
      {content}
    </motion.div>
  );
}

function ReadinessRow(props: { self: Player; other: Player }) {
  return (
    <ul className="readiness" aria-label="Who is ready">
      <li className={classes("readiness-self", props.self.ready && "is-ready")}>
        <i aria-hidden="true" />{props.self.ready ? "You're ready" : "You're not ready yet"}
      </li>
      <li className={classes("readiness-partner", props.other.ready && "is-ready")}>
        <i aria-hidden="true" />{props.other.displayName} {props.other.ready ? "is ready" : props.other.connected ? "isn't ready yet" : "is away"}
      </li>
    </ul>
  );
}

function PartnerLane(props: { player: Player; phase: RoomState["phase"] }) {
  const visibleBacks = Math.min(props.player.handCount, 8);
  const presence = describePresence(props.player);
  return (
    <div className="partner-lane">
      <div className="partner-id">
        <i aria-hidden="true" className={classes("presence-dot", props.player.connected && "presence-here")} />
        <strong>{props.player.displayName}</strong>
        <span>{presence}</span>
      </div>
      <div className="partner-hand" aria-label={`${props.player.displayName} holds ${countLabel(props.player.handCount, "hidden card")}`}>
        <div className="partner-backs" aria-hidden="true">
          <AnimatePresence initial={false}>
            {Array.from({ length: visibleBacks }).map((_, index) => (
              <motion.i
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 18 }}
                initial={{ opacity: 0, y: -10 }}
                key={index}
                transition={{ duration: 0.22, ease: revealEase }}
              />
            ))}
          </AnimatePresence>
        </div>
        {props.player.handCount > 0 || props.phase === "in_round" ? (
          <span>{countLabel(props.player.handCount, "card")}</span>
        ) : null}
      </div>
    </div>
  );
}

function PileStack(props: {
  pile: RoomState["pile"];
  selfSeatId: SeatId;
  partnerName: string;
  summary: RoomState["summary"];
  reducedMotion: boolean;
}) {
  if (props.pile.length === 0) {
    return (
      <div className="empty-pile">
        <i aria-hidden="true" />
        <span>Whoever has the lowest card goes first.</span>
      </div>
    );
  }

  const visible = props.pile.slice(-4);
  const latest = visible[visible.length - 1];
  const misplayed = props.summary?.kind === "misplay" && latest?.value === props.summary.playedCard;
  let caption = "";
  if (latest) {
    const who = latest.seatId === props.selfSeatId ? "You" : props.partnerName;
    if (misplayed) {
      caption = `${latest.value} was played too early`;
    } else if (latest.resolution === "scan_discard") {
      caption = "Thrown out with a star";
    } else if (latest.resolution === "misplay_discard") {
      caption = "Thrown out after the slip";
    } else {
      caption = `${who} played ${latest.value}`;
    }
  }

  return (
    <div className="pile">
      <div className="pile-stack">
        {visible.map((card, index) => {
          const depth = visible.length - 1 - index;
          const fromSelf = card.seatId === props.selfSeatId;
          return (
            <motion.div
              animate={{
                opacity: depth === 0 ? 1 : 0.92 - depth * 0.18,
                rotate: depth === 0 ? cardTilt(card.value) * 0.4 : cardTilt(card.value),
                scale: depth === 0 ? 1 : 0.9,
                x: depth * -22,
                y: depth * 4
              }}
              aria-label={`${card.value}`}
              className={classes(
                "pile-card",
                depth === 0 && "pile-card-top",
                fromSelf ? "pile-card-self" : "pile-card-partner",
                card.resolution === "misplay_discard" && "pile-card-misplay",
                card.resolution === "scan_discard" && "pile-card-star",
                depth === 0 && misplayed && "pile-card-too-early"
              )}
              initial={props.reducedMotion ? false : { opacity: 0, scale: 0.94, y: fromSelf ? 70 : -70 }}
              key={`${card.value}-${card.timestamp}-${card.resolution}`}
              style={{ zIndex: 10 - depth }}
              transition={cardSpring}
            >
              {card.value}
            </motion.div>
          );
        })}
      </div>
      <p
        className={classes(
          "pile-caption",
          latest?.seatId === props.selfSeatId ? "pile-caption-self" : "pile-caption-partner",
          misplayed && "pile-caption-danger"
        )}
        key={caption}
      >
        {caption}
      </p>
    </div>
  );
}

/**
 * The 1 to 100 line under the pile. Played cards mark where the count has
 * reached; your own cards hang beneath it. The shaded stretch between the
 * last card and your lowest is the gap you are counting through.
 */
function NumberLine(props: {
  pile: RoomState["pile"];
  hand: number[];
  selfSeatId: SeatId;
  live: boolean;
  celebrating: boolean;
}) {
  const played = props.pile;
  const latest = played[played.length - 1];
  const lowest = props.hand[0];
  const gapStart = latest ? latest.value : 1;
  const showGap = props.live && lowest !== undefined && lowest > gapStart;
  let playedIndex = 0;

  return (
    <div aria-hidden="true" className={classes("number-line", props.celebrating && "number-line-celebrate")}>
      <div className="line-scale">
        <span>1</span>
        <div className="line-track">
          {showGap ? (
            <i
              className="line-gap"
              style={{
                left: linePosition(gapStart),
                width: `calc(${linePosition(lowest)} - ${linePosition(gapStart)})`
              }}
            />
          ) : null}
          {played.map((card) => {
            const order = card.resolution === "played" ? playedIndex++ : playedIndex;
            return (
              <i
                className={classes(
                  "line-dot",
                  card.seatId === props.selfSeatId ? "line-dot-self" : "line-dot-partner",
                  card.resolution === "misplay_discard" && "line-dot-misplay",
                  card.resolution === "scan_discard" && "line-dot-star",
                  card === latest && "line-dot-latest"
                )}
                key={`${card.value}-${card.timestamp}`}
                style={{ "--order": order, left: linePosition(card.value) } as CSSProperties}
              />
            );
          })}
          {latest ? (
            <b className="line-marker" style={{ left: linePosition(latest.value) }}>{latest.value}</b>
          ) : null}
          {props.hand.map((value, index) => (
            <i
              className={classes("line-tick", index === 0 && "line-tick-next")}
              key={value}
              style={{ left: linePosition(value) }}
            >
              {index === 0 ? <b>{value}</b> : null}
            </i>
          ))}
        </div>
        <span>100</span>
      </div>
    </div>
  );
}

function HandZone(props: {
  self: Player;
  phase: RoomState["phase"];
  isRoundInteractive: boolean;
  onPlay: () => void;
}) {
  const measureRef = useRef<HTMLDivElement | null>(null);
  const handLayout = useHandFanLayout(measureRef, props.self.hand.length);
  const roundStarted = props.phase === "in_round" || props.phase === "paused" || props.phase === "focus_transition";

  return (
    <div className="hand-zone">
      <div className="hand-measure" ref={measureRef}>
        {props.self.hand.length > 0 ? (
          <div
            aria-label={`Your hand, ${countLabel(props.self.handCount, "card")}`}
            className="hand-fan"
            role="group"
            style={{
              minHeight: handLayout.cardHeight + 16,
              width: handLayout.totalWidth || undefined
            }}
          >
            <AnimatePresence initial={false}>
              {props.self.hand.map((value, index) => {
                const isActive = index === 0;
                const style = {
                  "--card-font-size": `${handLayout.valueFontSize}px`,
                  height: handLayout.cardHeight,
                  marginLeft: index === 0 ? 0 : handLayout.step - handLayout.cardWidth,
                  width: handLayout.cardWidth,
                  zIndex: props.self.hand.length - index
                } as CSSProperties;
                const playable = isActive && props.isRoundInteractive;
                return (
                  <motion.button
                    animate={{ opacity: 1, y: playable ? -10 : 0 }}
                    className={classes("hand-card", isActive ? "hand-card-active" : "hand-card-muted", playable && "hand-card-playable")}
                    disabled={!playable}
                    exit={{ opacity: 0, transition: { duration: 0.12 }, y: -60 }}
                    initial={{ opacity: 0, y: 40 }}
                    key={value}
                    layout
                    onClick={props.onPlay}
                    style={style}
                    transition={cardSpring}
                    type="button"
                    whileHover={playable ? { y: -16 } : undefined}
                    whileTap={playable ? { scale: 0.97, y: -4 } : undefined}
                  >
                    <span className={handLayout.useCornerValue && !isActive ? "card-corner-value" : ""}>{value}</span>
                    {playable ? <small>Play</small> : null}
                  </motion.button>
                );
              })}
            </AnimatePresence>
          </div>
        ) : (
          <div className="empty-hand">
            <span>{roundStarted ? "You're out of cards. It's on your partner now." : "Your cards will show up here."}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PendingRequestPanel(props: {
  snapshot: RoomState;
  selfSeatId: SeatId;
  sendEvent: (event: ClientEvent) => void;
}) {
  const pending = props.snapshot.pendingRequest;
  if (!pending) {
    return null;
  }

  const partnerName = props.snapshot.players[props.selfSeatId === "host" ? "guest" : "host"].displayName;
  const isAwaitingViewer = !pending.approvals[props.selfSeatId];
  const isPause = pending.kind === "pause";
  const title = isPause
    ? "Round paused"
    : isAwaitingViewer ? "Throw a star?" : "Star requested";
  const body = isAwaitingViewer
    ? isPause
      ? "Talk it through if you need to. Resume when you're both ready."
      : `${partnerName} asked. You'd both drop your lowest card.`
    : `Waiting on ${partnerName}.`;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={classes("request-sheet", !isPause && "request-sheet-star")}
      exit={{ opacity: 0, transition: { duration: 0.14 }, y: 8 }}
      initial={{ opacity: 0, y: 12 }}
      role="dialog"
      aria-label={title}
      transition={{ duration: 0.22, ease: revealEase }}
    >
      <h3>{title}</h3>
      <p>{body}</p>
      {isAwaitingViewer ? (
        <div className="request-actions">
          {isPause ? (
            <button className={buttonClass("primary")} onClick={() => props.sendEvent({ type: "resume_round" })} type="button">
              Resume
            </button>
          ) : (
            <>
              <button className={buttonClass("primary")} onClick={() => props.sendEvent({ accepted: true, type: "respond_scan" })} type="button">
                Throw star
              </button>
              <button className={buttonClass("text")} onClick={() => props.sendEvent({ accepted: false, type: "respond_scan" })} type="button">
                Keep it
              </button>
            </>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}

function SettingsMenu(props: { name: string; inviteLink: string | null; onRename: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const effects = useSoundSettings((state) => state.effects);
  const roomTone = useSoundSettings((state) => state.roomTone);
  const setEffects = useSoundSettings((state) => state.setEffects);
  const setRoomTone = useSoundSettings((state) => state.setRoomTone);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Settings"
        className={classes("icon-button", !effects && "icon-button-muted")}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          {effects ? (
            <path className="icon-stroke" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
          ) : (
            <path className="icon-stroke" d="M16 9.5l5 5m0-5l-5 5" />
          )}
        </svg>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            aria-label="Settings"
            className="settings-panel"
            exit={{ opacity: 0, transition: { duration: 0.12 }, y: -4 }}
            initial={{ opacity: 0, y: -6 }}
            role="dialog"
            transition={{ duration: 0.18, ease: revealEase }}
          >
            <NameEditor key={props.name} onSubmit={props.onRename} value={props.name} />
            <Switch checked={effects} label="Sound" onChange={setEffects} />
            <Switch
              checked={roomTone && effects}
              disabled={!effects}
              hint="A low hum while you play"
              label="Room tone"
              onChange={setRoomTone}
            />
            {props.inviteLink ? <CopyInviteButton inviteLink={props.inviteLink} /> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Switch(props: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      aria-checked={props.checked}
      className="switch-row"
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      role="switch"
      type="button"
    >
      <span>
        <strong>{props.label}</strong>
        {props.hint ? <small>{props.hint}</small> : null}
      </span>
      <i aria-hidden="true" className="switch-track"><b /></i>
    </button>
  );
}

function CopyInviteButton(props: { inviteLink: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={buttonClass(props.primary ? "primary" : "secondary")}
      onClick={() => {
        void navigator.clipboard.writeText(props.inviteLink).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
      type="button"
    >
      {copied ? "Link copied" : "Copy invite"}
    </button>
  );
}

function NameEditor(props: { value: string; onSubmit: (nextValue: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  const inputId = useId();
  const trimmed = draft.trim();
  const unchanged = trimmed === props.value || trimmed.length === 0;
  return (
    <form
      className="name-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged) {
          props.onSubmit(trimmed);
        }
      }}
    >
      <label htmlFor={inputId}>Your name</label>
      <div>
        <input
          autoComplete="nickname"
          id={inputId}
          maxLength={24}
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        <button className={buttonClass("text")} disabled={unchanged} type="submit">Save</button>
      </div>
    </form>
  );
}

function useRoomSession(roomId: string, token: string | null) {
  const setBootstrap = useRoomStore((state) => state.setBootstrap);
  const applyServerEvent = useRoomStore((state) => state.applyServerEvent);
  const setConnectionState = useRoomStore((state) => state.setConnectionState);
  const setError = useRoomStore((state) => state.setError);
  const reset = useRoomStore((state) => state.reset);
  const [connectNonce, setConnectNonce] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const intentionalCloseRef = useRef(false);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    let cancelled = false;
    requestRef.current += 1;
    const currentAttempt = requestRef.current;
    intentionalCloseRef.current = false;
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }

    setConnectionState(connectNonce === 0 ? "bootstrapping" : "reconnecting");
    setError(null);

    const bootstrapAndConnect = async () => {
      try {
        const response = await fetch(`/api/rooms/${roomId}/bootstrap`, {
          body: JSON.stringify({
            appVersion: APP_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            token
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 404) {
            clearStoredRoomToken(roomId);
          }
          throw new Error(
            response.status === 400
              ? "App version mismatch. Refresh the page, then reopen the invite."
              : response.status === 401
                ? "Invite link is invalid or expired."
                : "Couldn't join the room."
          );
        }
        const payload = bootstrapResponseSchema.parse(await readJsonOrThrow(response));
        if (cancelled || currentAttempt !== requestRef.current) {
          return;
        }

        startTransition(() => setBootstrap(payload));
        setConnectionState("connecting");
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const socket = new WebSocket(`${protocol}://${window.location.host}${payload.wsPath}`);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (cancelled || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("open");
          socket.send(JSON.stringify(clientEventSchema.parse({
            lastEventId: useRoomStore.getState().snapshot?.eventId ?? null,
            type: "join_room"
          })));
        });

        socket.addEventListener("message", (event) => {
          const parsed = serverEventSchema.parse(JSON.parse(String(event.data)));
          startTransition(() => applyServerEvent(parsed));
        });

        socket.addEventListener("close", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("closed");
          retryRef.current = window.setTimeout(() => setConnectNonce((value) => value + 1), 1000);
        });

        socket.addEventListener("error", () => {
          if (cancelled || intentionalCloseRef.current || currentAttempt !== requestRef.current) {
            return;
          }
          setConnectionState("error");
          retryRef.current = window.setTimeout(() => setConnectNonce((value) => value + 1), 1000);
        });
      } catch (caughtError) {
        if (cancelled || currentAttempt !== requestRef.current) {
          return;
        }
        setConnectionState("error");
        setError(caughtError instanceof Error ? caughtError.message : "Couldn't join the room.");
      }
    };

    void bootstrapAndConnect();

    return () => {
      cancelled = true;
      intentionalCloseRef.current = true;
      requestRef.current += 1;
      if (retryRef.current !== null) {
        window.clearTimeout(retryRef.current);
      }
      socketRef.current?.close(1000, "Leaving room");
      socketRef.current = null;
      reset();
    };
  }, [applyServerEvent, connectNonce, reset, roomId, setBootstrap, setConnectionState, setError, token]);

  const sendEvent = (event: ClientEvent) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Connection dropped. Reconnecting…");
      return;
    }
    socket.send(JSON.stringify(clientEventSchema.parse(event)));
  };

  return {
    reconnectNow: () => setConnectNonce((value) => value + 1),
    sendEvent
  };
}

async function toggleFullscreen(): Promise<void> {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    return;
  }
  await document.exitFullscreen();
}

"use client";

import { useEffect, useRef, useState } from "react";
import { resolveAssignmentLifecycle } from "@/lib/assignmentLifecycle";
import { assignmentBoundary, type AssignmentClock } from "@/lib/studentAssignmentPresentation";

/**
 * Server-anchored, monotonic "now" for assignment availability. The student
 * dashboard calls this once and shares the result with every AssignmentBlock
 * (and its headline), so all of them agree on which assignments are open.
 * Moved verbatim from AssignmentBlock.
 */

export type AssignmentServerClock = {
    serverNow: string;
    requestStartedMonotonicMs: number;
    receivedMonotonicMs: number;
};

type MonotonicClock = {
  latestServerMs: number;
  anchorServerMs: number;
  anchorMonotonicMs: number;
  highWaterMs: number;
  uncertaintyMs: number;
};

function validServerTime(value: string): number | null {
  if (resolveAssignmentLifecycle({ state: "open", now: value }) === "invalid") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleClock(clock: MonotonicClock, monotonicNow: number): number {
  const elapsed = Math.max(0, monotonicNow - clock.anchorMonotonicMs);
  clock.highWaterMs = Math.max(clock.highWaterMs, clock.anchorServerMs + elapsed);
  return clock.highWaterMs;
}

function acceptAuthoritativeTime(
  clock: MonotonicClock | null,
  serverNow: string,
  monotonicNow: number,
  requestStartedMonotonicMs: number,
  receivedMonotonicMs: number,
): MonotonicClock | null {
  const parsed = validServerTime(serverNow);
  if (parsed === null) return clock;
  if (!clock) {
    return {
      latestServerMs: parsed,
      anchorServerMs: parsed,
      anchorMonotonicMs: monotonicNow,
      highWaterMs: parsed,
      uncertaintyMs: Math.max(0, receivedMonotonicMs - requestStartedMonotonicMs),
    };
  }
  sampleClock(clock, monotonicNow);
  if (parsed > clock.latestServerMs) {
    clock.latestServerMs = parsed;
    clock.anchorServerMs = Math.max(parsed, clock.highWaterMs);
    clock.anchorMonotonicMs = monotonicNow;
    clock.highWaterMs = clock.anchorServerMs;
    clock.uncertaintyMs = Math.max(0, receivedMonotonicMs - requestStartedMonotonicMs);
  }
  return clock;
}

export function useMonotonicAssignmentTime(
  serverNow: string,
  serverClock: AssignmentServerClock | undefined,
  exams: readonly object[],
  onClockRefresh?: () => void,
): AssignmentClock {
  const initialServerMs = serverClock?.serverNow === serverNow ? validServerTime(serverNow) : null;
  const initialClock: MonotonicClock | null = initialServerMs === null || !serverClock
    ? null
    : {
        latestServerMs: initialServerMs,
        anchorServerMs: initialServerMs,
        anchorMonotonicMs: serverClock.receivedMonotonicMs,
        highWaterMs: initialServerMs,
        uncertaintyMs: Math.max(0, serverClock.receivedMonotonicMs - serverClock.requestStartedMonotonicMs),
      };
  const clockRef = useRef<MonotonicClock | null>(initialClock);
  const [nowMs, setNowMs] = useState(() => initialClock
    ? sampleClock(initialClock, performance.now())
    : Number.NaN);
  const [uncertaintyMs, setUncertaintyMs] = useState(initialClock?.uncertaintyMs || 0);
  const [trusted, setTrusted] = useState(!!initialClock);

  useEffect(() => {
    let cancelled = false;
    if (!serverClock || serverClock.serverNow !== serverNow) {
      queueMicrotask(() => {
        if (!cancelled) setTrusted(false);
      });
      return () => { cancelled = true; };
    }
    const clock = acceptAuthoritativeTime(
      clockRef.current,
      serverNow,
      serverClock.receivedMonotonicMs,
      serverClock.requestStartedMonotonicMs,
      serverClock.receivedMonotonicMs,
    );
    clockRef.current = clock;
    if (clock) {
      queueMicrotask(() => {
        if (cancelled) return;
        setTrusted(true);
        setUncertaintyMs(clock.uncertaintyMs);
        setNowMs(current => Math.max(current, sampleClock(clock, performance.now())));
      });
    }
    return () => { cancelled = true; };
  }, [serverClock, serverNow]);

  useEffect(() => {
    const invalidate = () => setTrusted(false);
    const handleVisibility = () => {
      invalidate();
      if (document.visibilityState === "visible") onClockRefresh?.();
    };
    const handlePageShow = () => {
      invalidate();
      onClockRefresh?.();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [onClockRefresh]);

  useEffect(() => {
    const clock = clockRef.current;
    if (!clock || !Number.isFinite(nowMs)) return;
    let nextBoundary = Number.POSITIVE_INFINITY;
    for (const exam of exams) {
      for (const value of [assignmentBoundary(exam, "start"), assignmentBoundary(exam, "end")]) {
        if (typeof value !== "string") continue;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > nowMs) nextBoundary = Math.min(nextBoundary, parsed);
      }
    }
    if (!Number.isFinite(nextBoundary)) return;
    const timer = window.setTimeout(() => {
      const active = clockRef.current;
      if (active) setNowMs(sampleClock(active, performance.now()));
    }, Math.min(Math.max(0, nextBoundary - nowMs), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [exams, nowMs, serverNow]);

  return Number.isFinite(nowMs)
    ? {
        lowerNow: new Date(nowMs).toISOString(),
        upperNow: new Date(nowMs + uncertaintyMs).toISOString(),
        trusted,
      }
    : { lowerNow: "", upperNow: "", trusted: false };
}

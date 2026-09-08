/**
 * Abort plumbing.
 *
 * Every fetch this player makes belongs to something with a lifetime — a
 * player, an element, a source — and when that thing is torn down its requests
 * are waste: bytes still arriving for a video nobody is watching, on a link the
 * NEXT video needs. HttpSource worked this out early and gave itself a
 * `lifetimeAbort`; everything added since (probes, subtitle loaders, manifest
 * fallbacks) made its own arrangement, and each was only as cancellable as
 * whoever wrote it remembered to make it. Measured on a destroy during startup:
 * a 2.9MB pre-play probe and a 2MB rung probe both ran to completion, and a
 * subtitle rendition kept fetching every one of its segments.
 *
 * The rule is one owner, one signal, threaded down. These two helpers are what
 * make that cheap enough to actually do everywhere.
 */

/**
 * A controller that also aborts when any of `parents` does.
 *
 * For the places that already have their own reason to give up — a probe with a
 * 6s cap, a range read with a 10s one — and now need to give up for the owner's
 * reason too. Neither signal is privileged; whichever fires first wins.
 *
 * Aborts immediately if a parent is already aborted, so a fetch started after
 * teardown never leaves the ground.
 */
export function childAbort(
  ...parents: (AbortSignal | null | undefined)[]
): AbortController {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  for (const parent of parents) {
    if (!parent) continue;
    if (parent.aborted) {
      ctl.abort();
      break;
    }
    // `once` so the listener retires itself — these are attached per fetch, and
    // a long-lived parent signal would otherwise accumulate one per request.
    parent.addEventListener("abort", onAbort, { once: true });
  }
  return ctl;
}

/**
 * True when the signal says to stop. Reads better than `?.aborted === true` at
 * the top of the loops that check between iterations.
 */
export function isAborted(signal?: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

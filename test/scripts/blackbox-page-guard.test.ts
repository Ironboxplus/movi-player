/**
 * The page guard turns "the page under test went away" into a named fact.
 *
 * Why it exists: on 2026-09-15 Good Will Hunting failed its middle seek with
 * `playback invariant missing` and then timed out every later step at 60s.
 * The decoder log showed playback had resumed after the seek, then the element
 * re-initialised four times. A zero-media probe on 2026-10-05
 * (tmp/hmr-reload-probe.mjs) confirmed the mechanism: touching
 * src/source/HttpSource.ts while the dev page is open makes vite reload it
 * (2 main-frame navigations for edit + revert, element re-initialised each
 * time) — and HttpSource.ts was being edited during that run. The harness had
 * no listener for navigation or crash, so the report could only say "missing".
 *
 * The emitter below stands in for Playwright's Page event surface only (the
 * same `on(event, fn)` contract and the same `framenavigated` / `crash` /
 * `close` event names); the guard's job is pure bookkeeping over those events.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createPageGuard } from "../../scripts/blackbox-page-guard.mjs";

function fakePage() {
  const page = new EventEmitter() as EventEmitter & { mainFrame(): object };
  const main = { url: () => "http://127.0.0.1:4173/dev/" };
  page.mainFrame = () => main;
  return { page, main, child: { url: () => "about:blank" } };
}

describe("createPageGuard", () => {
  it("ignores navigations before the initial load is armed", () => {
    const { page, main } = fakePage();
    const guard = createPageGuard(page);
    page.emit("framenavigated", main); // the initial goto itself
    expect(guard.lostReason()).toBeNull();
  });

  it("names a main-frame reload after arming", () => {
    const { page, main } = fakePage();
    const guard = createPageGuard(page);
    guard.arm();
    page.emit("framenavigated", main);
    expect(guard.lostReason()).toMatch(/page reloaded/);
    expect(guard.lostReason()).toContain("http://127.0.0.1:4173/dev/");
  });

  it("does not treat a child-frame navigation as losing the page", () => {
    const { page, child } = fakePage();
    const guard = createPageGuard(page);
    guard.arm();
    page.emit("framenavigated", child);
    expect(guard.lostReason()).toBeNull();
  });

  it("names a renderer crash, even before arming", () => {
    const { page } = fakePage();
    const guard = createPageGuard(page);
    page.emit("crash");
    expect(guard.lostReason()).toMatch(/renderer crashed/);
  });

  it("keeps the first cause when several follow", () => {
    const { page, main } = fakePage();
    const guard = createPageGuard(page);
    guard.arm();
    page.emit("framenavigated", main);
    page.emit("crash");
    page.emit("close");
    expect(guard.lostReason()).toMatch(/page reloaded/);
  });
});

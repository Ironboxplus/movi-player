/**
 * Tells the harness when the page it is measuring has gone away.
 *
 * Once the page is lost — reloaded by the dev server, navigated, or its
 * renderer crashed — every later step is measuring a fresh page (or none), not
 * the session that was being tested. Without this, the report can only say
 * `state: missing` and then burn a 60s timeout per remaining step, which is how
 * a dev-server reload during the 2026-09-15 Good Will Hunting run read as
 * "seek never recovers".
 *
 * `arm()` is called after the initial `page.goto` settles, so the navigation
 * that loads the page in the first place is not counted. A crash counts at any
 * time. Only the first cause is kept: later events are consequences of it.
 */
export function createPageGuard(page) {
  let armed = false;
  let reason = null;
  const lose = (why) => {
    if (reason === null) reason = why;
  };
  page.on("framenavigated", (frame) => {
    if (!armed || frame !== page.mainFrame()) return;
    lose(
      `page reloaded mid-session (main frame navigated to ${frame.url()}); ` +
        "the vite dev server reloads the page whenever a watched source file " +
        "changes, so nothing after this point measures the original session",
    );
  });
  page.on("crash", () => lose("page renderer crashed"));
  page.on("close", () => lose("page closed"));
  return {
    arm() {
      armed = true;
    },
    lostReason() {
      return reason;
    },
  };
}

type Posted = { type: string; requestId?: unknown };

/**
 * Resolve once the worker has posted `type` for `requestId`.
 *
 * The decode workers answer "configure" only after `loadWasmModuleNew()`
 * resolves, which is real WebAssembly compilation and instantiation: ~100-200ms
 * warm and ~6s for the first one on a cold CI runner. A fixed number of
 * `setTimeout(0)` ticks does not wait for that, so a test that sent its next
 * message after such a tick raced the load and counted the previous request's
 * late reply as the new one's. Waiting on the reply itself is both faster and
 * independent of the machine; once it has arrived the worker handles every
 * later message synchronously, so a short settle is enough afterwards.
 */
export async function waitForReply(
  bridge: { posted: Posted[] },
  type: string,
  requestId: unknown,
  timeoutMs = 60_000,
): Promise<Posted> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = bridge.posted.find(
      (message) => message.type === type && message.requestId === requestId,
    );
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`worker never posted ${type} for request ${requestId} within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

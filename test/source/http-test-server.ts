/**
 * Real local HTTP server for HttpSource integration tests.
 *
 * No mocks: Node's http module serves real bytes over a real TCP port.
 * Vitest's global fetch (undici) hits 127.0.0.1 just like a browser would.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export type RangePolicy =
  | "normal" // Accept any Range, reply 206 with Content-Range
  | "bounded-0-forbidden" // 403 for bounded bytes=0-N; accept open-ended bytes=0- and non-zero offsets
  | "all-forbidden" // Always 403 on Range
  | "ignore"; // Ignore Range and return the complete body with 200

export interface HttpFixtureOptions {
  /** Raw file body. */
  body: Uint8Array | Buffer;
  /** Reject HEAD entirely (destroy socket / throw at connection). Default false. */
  rejectHead?: boolean;
  /** HEAD returns 200 but omits Content-Length. Default false. */
  headNoContentLength?: boolean;
  /** How Range GETs are handled. */
  rangePolicy?: RangePolicy;
  /** Content-Disposition value, if any. */
  contentDisposition?: string;
  /** Extra response headers on successful GET/HEAD. */
  extraHeaders?: Record<string, string>;
  /** Write response bodies in chunks to keep real TCP reads in flight. */
  responseChunkBytes?: number;
  /** Delay between response chunks. Default 0 (send immediately). */
  responseChunkDelayMs?: number;
  /** Delay before the first response-body byte, after headers are flushed. */
  responseInitialDelayMs?: number;
  /**
   * Cut the connection after writing this many body bytes — a real truncated
   * response, the way a proxy timing out mid-transfer behaves. The client sees
   * headers and some bytes, then the socket dies.
   */
  abortBodyAfterBytes?: number;
  /**
   * Limit `abortBodyAfterBytes` to the first N GETs; later ones are served in
   * full. Lets a test exercise the retry path and then let it succeed.
   */
  abortBodyForFirstGets?: number;
  /**
   * Statuses to return for successive GETs before serving normally, e.g.
   * [503] for "one transient server error, then fine".
   */
  getFailStatuses?: number[];
  /** Answer an unsatisfiable Range (start >= size) with a real 416. */
  strict416?: boolean;
  /**
   * Go silent mid-body: send this many bytes, then send nothing at all for
   * `stallMs` while holding the connection open — a link that hangs rather
   * than resets, which is what the read-stall watchdog exists for.
   */
  stallAfterBytes?: number;
  /** How long the mid-body silence lasts. Default 8000ms. */
  stallMs?: number;
  /** Limit the mid-body stall to the first N GETs. */
  stallForFirstGets?: number;
  /** Start stalling only from this GET onwards (1-based). Default 1. */
  stallFromGet?: number;
  /**
   * Stall only GETs whose Range starts at or after this offset.
   *
   * Lets a test single out one particular request — e.g. the one-off range
   * fetch a far-out-of-window read issues — while the sequential stream from
   * byte 0 keeps being served normally. GET ordinals are too brittle for that:
   * size resolution, retries and the stream's own chunking all consume them.
   */
  stallRangeStartAtLeast?: number;
  /** Stall only the first N GETs matching `stallRangeStartAtLeast`. */
  stallMatchLimit?: number;
}

export interface HttpFixture {
  url: string;
  body: Buffer;
  /** Request log for assertions (method, range header, status we sent). */
  requests: Array<{ method: string; range: string | undefined; status: number }>;
  close: () => Promise<void>;
}

function parseRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number; openEnded: boolean } | null {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const openEnded = m[2] === "";
  const end = openEnded ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  if (Number.isNaN(start) || start < 0 || start >= size || end < start) return null;
  return { start, end, openEnded };
}

export async function startHttpFixture(
  options: HttpFixtureOptions,
): Promise<HttpFixture> {
  const body = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body);
  const size = body.length;
  const rangePolicy = options.rangePolicy ?? "normal";
  const requests: HttpFixture["requests"] = [];

  let getCount = 0;
  let stallMatches = 0;

  const sendBody = (
    res: http.ServerResponse,
    payload: Buffer,
    abortAfter?: number,
    stallAfter?: number,
  ): void => {
    const chunkBytes = options.responseChunkBytes ?? payload.length;
    const delayMs = options.responseChunkDelayMs ?? 0;

    if (stallAfter !== undefined && stallAfter < payload.length) {
      // Headers, a few bytes, then nothing — connection open, no data. The
      // socket never errors, so only a watchdog can notice.
      res.flushHeaders();
      if (stallAfter > 0) res.write(payload.subarray(0, stallAfter));
      // unref: a long silence must not hold the test runner's event loop open
      // after the suite has moved on.
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        res.end(payload.subarray(stallAfter));
      }, options.stallMs ?? 8000).unref();
      return;
    }

    if (abortAfter !== undefined && abortAfter < payload.length) {
      // Headers promised more than we send, then the socket dies: undici
      // surfaces this to the reader as a real terminated-stream error.
      res.flushHeaders();
      res.write(payload.subarray(0, abortAfter));
      setTimeout(() => res.socket?.destroy(), 10);
      return;
    }

    const writePayload = () => {
      if (res.destroyed || res.writableEnded) return;
      if (delayMs <= 0 || chunkBytes >= payload.length) {
        res.end(payload);
        return;
      }

      let offset = 0;
      const writeNext = () => {
        if (res.destroyed || res.writableEnded) return;
        const end = Math.min(offset + chunkBytes, payload.length);
        res.write(payload.subarray(offset, end));
        offset = end;
        if (offset >= payload.length) {
          res.end();
          return;
        }
        setTimeout(writeNext, delayMs);
      };
      writeNext();
    };

    const initialDelayMs = options.responseInitialDelayMs ?? 0;
    if (initialDelayMs > 0) {
      // Make fetch() resolve with a real response/reader immediately while the
      // body socket remains silent for the configured interval.
      res.flushHeaders();
      setTimeout(writePayload, initialDelayMs);
    } else {
      writePayload();
    }
  };

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const rangeHeader = req.headers["range"] as string | undefined;

    if (method === "HEAD") {
      if (options.rejectHead) {
        // Hard-fail the HEAD the way some CDNs/proxies do (connection reset /
        // abrupt close). undici surfaces this as a thrown fetch TypeError —
        // the exact path issue #14 covers.
        req.socket.destroy();
        requests.push({ method, range: rangeHeader, status: 0 });
        return;
      }
      const headers: Record<string, string> = {
        ...(options.extraHeaders || {}),
      };
      if (!options.headNoContentLength) {
        headers["Content-Length"] = String(size);
      }
      if (options.contentDisposition) {
        headers["Content-Disposition"] = options.contentDisposition;
      }
      res.writeHead(200, headers);
      res.end();
      requests.push({ method, range: rangeHeader, status: 200 });
      return;
    }

    if (method !== "GET") {
      res.writeHead(405);
      res.end();
      requests.push({ method, range: rangeHeader, status: 405 });
      return;
    }

    getCount++;
    const failStatus = options.getFailStatuses?.[getCount - 1];
    if (failStatus) {
      res.writeHead(failStatus, { "Content-Type": "text/plain" });
      res.end("injected failure");
      requests.push({ method, range: rangeHeader, status: failStatus });
      return;
    }
    const abortAfter =
      options.abortBodyAfterBytes !== undefined &&
      (options.abortBodyForFirstGets === undefined ||
        getCount <= options.abortBodyForFirstGets)
        ? options.abortBodyAfterBytes
        : undefined;
    const parsed = parseRange(rangeHeader, size);

    let rangeStallMatches = true;
    if (options.stallRangeStartAtLeast !== undefined) {
      rangeStallMatches =
        parsed !== null && parsed.start >= options.stallRangeStartAtLeast;
      if (rangeStallMatches) {
        stallMatches++;
        if (
          options.stallMatchLimit !== undefined &&
          stallMatches > options.stallMatchLimit
        ) {
          rangeStallMatches = false;
        }
      }
    }
    const stallAfter =
      options.stallAfterBytes !== undefined &&
      rangeStallMatches &&
      getCount >= (options.stallFromGet ?? 1) &&
      (options.stallForFirstGets === undefined ||
        getCount <= options.stallForFirstGets)
        ? options.stallAfterBytes
        : undefined;

    if (options.strict416 && rangeHeader && !parsed) {
      // Only a start beyond EOF is unsatisfiable here; a malformed header would
      // have been ignored by a real server rather than refused.
      const startOnly = /^bytes=(\d+)-/i.exec(rangeHeader.trim());
      if (startOnly && parseInt(startOnly[1], 10) >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        requests.push({ method, range: rangeHeader, status: 416 });
        return;
      }
    }

    if (parsed) {
      if (rangePolicy === "all-forbidden") {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
        requests.push({ method, range: rangeHeader, status: 403 });
        return;
      }
      if (
        rangePolicy === "bounded-0-forbidden" &&
        parsed.start === 0 &&
        !parsed.openEnded
      ) {
        // Mimic Telegram/CDN proxy workers: first-chunk bounded range at 0 is
        // rejected, open-ended (and non-zero offsets) work.
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("bounded zero-offset range forbidden");
        requests.push({ method, range: rangeHeader, status: 403 });
        return;
      }

      // Some object stores and reverse proxies silently ignore Range. Keep
      // the original Range header in the request log, but deliberately fall
      // through to the full 200 response below so HttpSource exercises its
      // real no-Range recovery path over TCP.
      if (rangePolicy === "ignore") {
        // fall through
      } else {

        const slice = body.subarray(parsed.start, parsed.end + 1);
        res.writeHead(206, {
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${parsed.start}-${parsed.end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Type": "application/octet-stream",
          ...(options.extraHeaders || {}),
          ...(options.contentDisposition
            ? { "Content-Disposition": options.contentDisposition }
            : {}),
        });
        sendBody(res, slice, abortAfter, stallAfter);
        requests.push({ method, range: rangeHeader, status: 206 });
        return;
      }
    }

    // Plain full GET
    res.writeHead(200, {
      "Content-Length": String(size),
      "Content-Type": "application/octet-stream",
      "Accept-Ranges": "bytes",
      ...(options.extraHeaders || {}),
      ...(options.contentDisposition
        ? { "Content-Disposition": options.contentDisposition }
        : {}),
    });
    sendBody(res, body, abortAfter, stallAfter);
    requests.push({ method, range: rangeHeader, status: 200 });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/video.bin`;

  return {
    url,
    body,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Build a deterministic payload of `size` bytes (index % 256). */
export function makePayload(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i & 0xff;
  return buf;
}

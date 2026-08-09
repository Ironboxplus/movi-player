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

  const sendBody = (res: http.ServerResponse, payload: Buffer): void => {
    const chunkBytes = options.responseChunkBytes ?? payload.length;
    const delayMs = options.responseChunkDelayMs ?? 0;
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

    const parsed = parseRange(rangeHeader, size);

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
        sendBody(res, slice);
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
    sendBody(res, body);
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

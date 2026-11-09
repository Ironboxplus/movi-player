// A static server with Range support and a request log, for the black-box
// pages. The log is what lets a test say how many bytes of a file the player
// actually asked for.
import http from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".srt": "text/plain; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

/**
 * @param {{ mounts: Record<string,string>, pages?: Record<string,string> }} opts
 *   mounts: URL prefix ("/media/") -> directory. pages: exact path -> html.
 */
export function startServer({ mounts, pages = {} }) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/__log") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(log));
      return;
    }
    if (pages[pathname] !== undefined) {
      res.setHeader("content-type", TYPES[".html"]);
      res.end(pages[pathname]);
      return;
    }
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (!pathname.startsWith(prefix)) continue;
      const rel = normalize(pathname.slice(prefix.length));
      const file = join(dir, rel);
      if (rel.startsWith("..") || !file.startsWith(dir + sep) && file !== dir) break;
      if (!existsSync(file) || !statSync(file).isFile()) break;
      const size = statSync(file).size;
      const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (range && (range[1] !== "" || range[2] !== "")) {
        if (range[1] === "") {
          start = Math.max(0, size - Number(range[2]));
        } else {
          start = Number(range[1]);
          if (range[2] !== "") end = Math.min(end, Number(range[2]));
        }
        if (start > end || start >= size) {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${size}`);
          res.end();
          return;
        }
        status = 206;
      }
      res.statusCode = status;
      res.setHeader("content-type", type);
      res.setHeader("accept-ranges", "bytes");
      res.setHeader("content-length", String(end - start + 1));
      res.setHeader("cache-control", "no-store");
      if (status === 206) res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
      log.push({ path: pathname, start, end, bytes: end - start + 1, status, at: Date.now() });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        log,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

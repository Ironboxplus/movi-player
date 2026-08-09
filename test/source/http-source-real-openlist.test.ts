import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpSource } from "../../src/source/HttpSource";

const baseUrl = process.env.OPENLIST_BASE_URL?.replace(/\/$/, "");
const username = process.env.OPENLIST_USERNAME;
const password = process.env.OPENLIST_PASSWORD;
const mediaPath = process.env.OPENLIST_MEDIA_PATH;
const enabled = Boolean(baseUrl && username && password && mediaPath);

type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

async function post<T>(
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<ApiResponse<T>>;
}

describe.skipIf(!enabled)("HttpSource against a real OpenList media stream", () => {
  let rawUrl = "";
  let expectedSize = 0;
  const sources: HttpSource[] = [];

  beforeAll(async () => {
    const login = await post<{ token: string }>("/api/auth/login", {
      username,
      password,
    });
    expect(login.code).toBe(200);

    const media = await post<{ raw_url: string; size: number }>(
      "/api/fs/get",
      { path: mediaPath, password: "" },
      login.data.token,
    );
    expect(media.code).toBe(200);
    expect(media.data.raw_url).toBeTruthy();
    expect(media.data.size).toBeGreaterThan(0);
    rawUrl = media.data.raw_url;
    expectedSize = media.data.size;
  }, 60_000);

  afterAll(() => {
    for (const source of sources) source.close();
  });

  it("reads real bytes at the head, middle, and tail without leaking its signed URL", async () => {
    const source = new HttpSource(rawUrl, {}, 8);
    sources.push(source);

    expect(await source.getSize()).toBe(expectedSize);
    const length = 64 * 1024;
    const offsets = [
      0,
      Math.floor(expectedSize * 0.05),
      Math.floor(expectedSize * 0.5),
      expectedSize - length,
    ];

    for (const offset of offsets) {
      const bytes = new Uint8Array(await source.read(offset, length));
      expect(bytes.byteLength).toBe(length);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    }

    const stats = source.getNetworkStats();
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.streamGeneration).toBeGreaterThan(0);
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(rawUrl);
  }, 120_000);

  it("lets a far seek replace a real in-flight Range read without hanging the new generation", async () => {
    const source = new HttpSource(rawUrl, {}, 8);
    sources.push(source);

    expect(await source.getSize()).toBe(expectedSize);
    const oldRead = source.read(0, 4 * 1024 * 1024).then(
      () => "completed" as const,
      () => "superseded" as const,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The fork deliberately serves the first two small out-of-window reads as
    // one-off Range requests so metadata/Cues probes do not tear down healthy
    // sequential playback. The third far read is therefore the real seek that
    // crosses MAX_ONEOFF_BEFORE_RESTART and replaces the stream generation.
    for (const ratio of [0.2, 0.3]) {
      const probe = new Uint8Array(
        await source.read(Math.floor(expectedSize * ratio), 64 * 1024),
      );
      expect(probe.byteLength).toBe(64 * 1024);
    }

    const replacementOffset = Math.floor(expectedSize * 0.6);
    const replacement = new Uint8Array(
      await source.read(replacementOffset, 64 * 1024),
    );
    expect(replacement.byteLength).toBe(64 * 1024);
    expect(replacement.some((byte) => byte !== 0)).toBe(true);

    const oldResult = await Promise.race([
      oldRead,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 20_000),
      ),
    ]);
    expect(oldResult).not.toBe("timeout");
    expect(source.getNetworkStats().streamGeneration).toBeGreaterThanOrEqual(2);
  }, 120_000);
});

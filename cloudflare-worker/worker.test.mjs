import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const origin = "https://example.test";
const valid = { editor: "劉羿岑 Yitsen", primary: "劉羿岑 Yitsen", partners: ["陳向柔 Naomi"], turnstileToken: "token" };

function database({ failOnce = false } = {}) {
  const db = {
    schemaCalls: 0, writes: 0,
    prepare(sql) { return { sql, bind() { return this; }, async all() { return { results: [] }; } }; },
    async batch(statements) {
      if (statements[0].sql.startsWith("CREATE")) {
        db.schemaCalls++;
        if (failOnce) { failOnce = false; throw new Error("internal-db-password"); }
      } else db.writes++;
      return [];
    }
  };
  return db;
}
function environment(db = database()) { return { DB: db, ALLOWED_ORIGIN: origin, TURNSTILE_SECRET: "test-secret" }; }
function post(body = JSON.stringify(valid), headers = {}, path = "/api/update") {
  return new Request(`https://worker.test${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body });
}
function upstream(t, data = { success: true, hostname: "example.test" }) {
  return t.mock.method(globalThis, "fetch", async () => Response.json(data));
}

test("origin rejection, preflight and unknown paths do not touch DB", async () => {
  const env = environment();
  assert.equal((await worker.fetch(post(undefined, { Origin: "https://evil.test" }), env)).status, 403);
  assert.equal((await worker.fetch(new Request("https://worker.test", { method: "OPTIONS", headers: { Origin: origin } }), env)).status, 204);
  assert.equal((await worker.fetch(post(undefined, {}, "/unknown"), env)).status, 404);
  assert.equal(env.DB.schemaCalls, 0);
});

test("JSON media type, malformed input and non-object values get explicit errors", async (t) => {
  const fetchMock = upstream(t);
  const env = environment();
  assert.equal((await worker.fetch(post("{}", { "Content-Type": "text/plain" }), env)).status, 415);
  for (const body of ["{", "null", "[]", '"string"', "", "{}"]) {
    assert.equal((await worker.fetch(post(body), env)).status, 400);
  }
  assert.equal(env.DB.schemaCalls, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("stream byte bound ignores false Content-Length and rejects multibyte overflow", async (t) => {
  const fetchMock = upstream(t);
  const env = environment();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(" ".repeat(8192)));
    controller.enqueue(encoder.encode("中".repeat(3000)));
    controller.close();
  } });
  const request = new Request("https://worker.test/api/update", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": "1" },
    body: stream, duplex: "half"
  });
  assert.equal((await worker.fetch(request, env)).status, 413);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(env.DB.schemaCalls, 0);
});

test("valid JSON exactly at byte limit succeeds", async (t) => {
  upstream(t);
  const env = environment();
  const text = JSON.stringify(valid);
  const body = text + " ".repeat(16384 - Buffer.byteLength(text));
  assert.equal((await worker.fetch(post(body, { "Content-Type": "application/json; charset=utf-8" }), env)).status, 200);
  assert.equal(env.DB.writes, 1);
});

test("Turnstile requires success and matching hostname before schema or write", async (t) => {
  const fetchMock = upstream(t, { success: true, hostname: "wrong.test" });
  const env = environment();
  assert.equal((await worker.fetch(post(), env)).status, 400);
  assert.equal(env.DB.schemaCalls, 0);
  assert.equal(env.DB.writes, 0);
  assert.ok(fetchMock.mock.calls[0].arguments[1].signal instanceof AbortSignal);
});

test("Turnstile timeout aborts and denies writing", async (t) => {
  const realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, milliseconds, ...args) => realTimeout(fn, milliseconds === 5000 ? 1 : milliseconds, ...args));
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("upstream-private-detail")), { once: true });
  }));
  const env = environment();
  const response = await worker.fetch(post(), env);
  assert.equal(response.status, 400);
  assert.equal(env.DB.schemaCalls, 0);
  assert.doesNotMatch(await response.text(), /private-detail/);
});

test("public GET shares schema promise per DB binding and distinct DB initializes separately", async () => {
  const env = environment();
  const get = () => new Request("https://worker.test/api/records");
  const responses = await Promise.all([worker.fetch(get(), env), worker.fetch(get(), env)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal(env.DB.schemaCalls, 1);
  assert.equal((await worker.fetch(new Request("https://worker.test/api/export-md"), env)).status, 200);
  assert.equal(env.DB.schemaCalls, 1);
  const otherEnv = environment();
  assert.equal((await worker.fetch(get(), otherEnv)).status, 200);
  assert.equal(otherEnv.DB.schemaCalls, 1);
});

test("schema failures conceal internals and retry next request", async () => {
  const env = environment(database({ failOnce: true }));
  const get = () => new Request("https://worker.test/api/records");
  const response = await worker.fetch(get(), env);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /internal-db-password/);
  assert.equal((await worker.fetch(get(), env)).status, 200);
  assert.equal(env.DB.schemaCalls, 2);
  assert.equal((await worker.fetch(get(), env)).status, 200);
  assert.equal(env.DB.schemaCalls, 2);
});

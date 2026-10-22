const MEMBERS = ["劉羿岑 Yitsen","陳向柔 Naomi","王寶佳 Renee","陳靖薇","黃冠霖","陳黎玲 Jossie","林佩君","蔡岱達","蔡淯思 Mina","鍾智媛 Fiona","張怡蘋 April","張耕豪"];
const schemaReady = new WeakMap();
const MAX_JSON_BYTES = 16 * 1024;

class InputError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new InputError(415, "請使用 application/json。");
  }
  if (!request.body) throw new InputError(400, "請提供 JSON 物件。");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) {
        void reader.cancel().catch(() => {});
        throw new InputError(413, "請求內容不得超過 16 KB。");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new InputError(400, "請提供 JSON 物件。");
    }
    return input;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(400, "JSON 格式不正確。");
  } finally {
    reader.releaseLock();
  }
}

const clean = (value) => String(value || "").replace(/[|\r\n]/g, " ").trim();
const pairKey = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh-Hant")).join("|");

const cors = (request, env) => ({
  "Access-Control-Allow-Origin": request.headers.get("Origin") === env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : "",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin"
});

const json = (request, env, data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request, env) }
});

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Worker 缺少環境變數或綁定：${missing.join(", ")}`);
}

async function ensureSchema(env) {
  requireEnv(env, ["DB"]);
  let ready = schemaReady.get(env.DB);
  if (ready) return ready;
  ready = initializeSchema(env.DB).catch((error) => {
    schemaReady.delete(env.DB);
    throw error;
  });
  schemaReady.set(env.DB, ready);
  return ready;
}

async function initializeSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      editor TEXT NOT NULL,
      member_a TEXT NOT NULL,
      member_b TEXT NOT NULL,
      pair_key TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT '完成'
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_records_pair_created ON records(pair_key, created_at DESC, id DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC, id DESC)")
  ]);
}

async function verifyTurnstile(token, request, env) {
  requireEnv(env, ["TURNSTILE_SECRET", "ALLOWED_ORIGIN"]);
  if (typeof token !== "string" || !token || token.length > 2048) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body, signal: controller.signal
    });
    if (!result.ok) return false;
    const data = await result.json();
    return data?.success === true && data.hostname === new URL(env.ALLOWED_ORIGIN).hostname;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLatestRecords(env) {
  const result = await env.DB.prepare(`
    WITH ranked AS (
      SELECT
        id,
        substr(created_at, 1, 10) AS date,
        created_at,
        editor,
        member_a AS a,
        member_b AS b,
        status,
        COALESCE(NULLIF(note, ''), '—') AS note,
        pair_key,
        ROW_NUMBER() OVER (PARTITION BY pair_key ORDER BY created_at DESC, id DESC) AS rn
      FROM records
    )
    SELECT id, date, created_at, editor, a, b, status, note, pair_key
    FROM ranked
    WHERE rn = 1
    ORDER BY created_at DESC, id DESC
  `).all();

  return result.results || [];
}

async function getHistoryRecords(env, limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const result = await env.DB.prepare(`
    SELECT
      id,
      substr(created_at, 1, 10) AS date,
      created_at,
      editor,
      member_a AS a,
      member_b AS b,
      status,
      COALESCE(NULLIF(note, ''), '—') AS note,
      pair_key
    FROM records
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).bind(safeLimit).all();

  return result.results || [];
}

function validateInput(input) {
  const editor = clean(input.editor);
  const primary = clean(input.primary);
  const partners = [...new Set(Array.isArray(input.partners) ? input.partners.map(clean) : [])].filter(Boolean);
  const note = clean(input.note);

  if (
    input.website ||
    !MEMBERS.includes(editor) ||
    !MEMBERS.includes(primary) ||
    !partners.length ||
    partners.some((name) => !MEMBERS.includes(name) || name === primary) ||
    note.length > 120
  ) {
    return { ok: false, error: "欄位內容不正確。" };
  }

  return { ok: true, editor, primary, partners, note };
}

async function saveRecords(env, input) {
  const createdAt = new Date().toISOString();
  const statements = input.partners.map((partner) => env.DB.prepare(`
    INSERT INTO records (created_at, editor, member_a, member_b, pair_key, note, status)
    VALUES (?, ?, ?, ?, ?, ?, '完成')
  `).bind(createdAt, input.editor, input.primary, partner, pairKey(input.primary, partner), input.note));

  await env.DB.batch(statements);
  return { createdAt, updated: statements.length };
}

function markdown(records) {
  const head = [
    "# D 組 121 完成紀錄",
    "",
    "> 每組成員可保留完整歷史；此匯出檔顯示每組最新一筆完成紀錄。",
    "",
    "| 日期 | 修改人 | 成員 A | 成員 B | 狀態 | 備註 |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  const rows = records.map((record) => `| ${record.date} | ${record.editor} | ${record.a} | ${record.b} | ${record.status} | ${record.note || "—"} |`);
  return `${[...head, ...rows].join("\n")}\n`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });

    try {
      const origin = request.headers.get("Origin");
      const isDirectRead = request.method === "GET" && !origin && ["/api/records", "/api/export-md"].includes(url.pathname);
      if (origin !== env.ALLOWED_ORIGIN && !isDirectRead) {
        return json(request, env, { ok: false, error: "不允許的請求。" }, 403);
      }

      if (url.pathname === "/api/records" && request.method === "GET") {
        await ensureSchema(env);
        const view = url.searchParams.get("view");
        const records = view === "history" ? await getHistoryRecords(env, url.searchParams.get("limit")) : await getLatestRecords(env);
        return json(request, env, { ok: true, view: view === "history" ? "history" : "latest", total: records.length, records });
      }

      if (url.pathname === "/api/export-md" && request.method === "GET") {
        await ensureSchema(env);
        return new Response(markdown(await getLatestRecords(env)), {
          status: 200,
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": "inline; filename=\"121-log.md\"",
            ...cors(request, env)
          }
        });
      }

      if (url.pathname === "/api/update" && request.method === "POST") {
        const input = await readJson(request);
        const checked = validateInput(input);
        if (!checked.ok) return json(request, env, { ok: false, error: checked.error }, 400);
        if (!await verifyTurnstile(input.turnstileToken, request, env)) return json(request, env, { ok: false, error: "人機驗證失敗，請重新操作。" }, 400);

        await ensureSchema(env);
        const saved = await saveRecords(env, checked);
        return json(request, env, { ok: true, ...saved });
      }

      return json(request, env, { ok: false, error: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof InputError) return json(request, env, { ok: false, error: error.message }, error.status);
      return json(request, env, { ok: false, error: "處理失敗，請稍後再試。" }, 500);
    }
  }
};

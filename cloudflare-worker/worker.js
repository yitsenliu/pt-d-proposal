const MEMBERS = ["劉羿岑 Yitsen","陳向柔 Naomi","王寶佳 Renee","陳靖薇","黃冠霖","陳黎玲 Jossie","林佩君","蔡岱達","蔡淯思 Mina","鍾智媛 Fiona","張怡蘋 April","張耕豪"];
const HEAD = "# D 組 121 完成紀錄\n\n> 每組成員僅保留最新一筆完成紀錄；由 121 互動頁面寫入。\n\n| 日期 | 修改人 | 成員 A | 成員 B | 狀態 | 備註 |\n| --- | --- | --- | --- | --- | --- |";

const encode = (text) => { const bytes = new TextEncoder().encode(text); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return btoa(binary); };
const decode = (text) => { const binary = atob(text); return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))); };
const clean = (value) => String(value || "").replace(/[|\r\n]/g, " ").trim();
const pairKey = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh-Hant")).join("|");
const cors = (request, env) => ({ "Access-Control-Allow-Origin": request.headers.get("Origin") === env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : "", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" });
const response = (request, env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request, env) } });

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireEnv(env, names) {
  if (names.some((name) => !env[name])) throw new RequestError(503, "服務尚未設定完成。");
}

async function readJsonBody(body, limit) {
  if (!body) throw new RequestError(400, "內容必須是 JSON 物件。");
  const reader = body.getReader();
  let timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new RequestError(408, "讀取內容逾時。"));
      }, 5000); }),
      (async () => {
        const chunks = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new RequestError(413, "內容不得超過 16 KiB。");
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new RequestError(400, "內容不是有效 JSON。"); }
      })()
    ]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

// One deadline includes connection, headers and the actual response body.
async function upstreamJson(url, options = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("upstream timeout")); }, 5000); }),
      (async () => {
        const result = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
        if (!result.ok) { void result.body?.cancel().catch(() => {}); return { ok: false, status: result.status }; }
        return { ok: true, status: result.status, data: await readJsonBody(result.body, 2 * 1024 * 1024) };
      })()
    ]);
  } catch { throw new Error("upstream unavailable"); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function verifyTurnstile(token, request, env) {
  requireEnv(env, ["TURNSTILE_SECRET", "ALLOWED_ORIGIN"]);
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET); body.append("response", token);
  try {
    const result = await upstreamJson("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    return result.ok && result.data?.success === true && result.data.hostname === new URL(env.ALLOWED_ORIGIN).hostname;
  } catch { return false; }
}

async function github(env, path, options = {}) {
  requireEnv(env, ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN"]);
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH || "main"}`;
  return upstreamJson(url, { ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pt-d-proposal-worker", ...(options.headers || {}) } });
}

async function updateLog(env, rows) {
  const path = env.LOG_PATH || "data/121-log.md";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await github(env, path);
    if (!current.ok) throw new Error("無法讀取紀錄檔");
    const file = current.data;
    const oldLines = decode(file.content.replace(/\n/g, "")).split("\n");
    const latestPairs = new Set(rows.map((row) => pairKey(row.a, row.b)));
    const kept = oldLines.filter((line) => {
      if (!line.startsWith("|") || line.includes("---") || line.includes("日期")) return true;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      return cells.length < 4 || !latestPairs.has(pairKey(cells[2], cells[3]));
    });
    const divider = kept.findIndex((line) => line.includes("| --- |"));
    const lines = divider >= 0 ? [...kept.slice(0, divider + 1), ...rows.map((row) => `| ${row.date} | ${row.editor} | ${row.a} | ${row.b} | 完成 | ${row.note || "—"} |`), ...kept.slice(divider + 1)] : [...HEAD.split("\n"), ...rows.map((row) => `| ${row.date} | ${row.editor} | ${row.a} | ${row.b} | 完成 | ${row.note || "—"} |`)];
    const saved = await github(env, path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: `121 紀錄更新：${rows[0].editor}（${rows.length} 筆）`, content: encode(lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n"), sha: file.sha, branch: env.GITHUB_BRANCH || "main" }) });
    if (saved.ok) return;
    if (saved.status !== 409) throw new Error("GitHub 寫入失敗");
  }
  throw new Error("同時更新的人較多，請重新整理後再送出。");
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
  if (url.pathname !== "/api/update") return response(request, env, { error: "找不到此端點。" }, 404);
  if (request.method !== "POST" || !env.ALLOWED_ORIGIN || request.headers.get("Origin") !== env.ALLOWED_ORIGIN) return response(request, env, { error: "不允許的請求。" }, 403);
  try {
    if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
        || (request.headers.get("Content-Encoding") || "identity").toLowerCase() !== "identity") {
      return response(request, env, { error: "只接受未壓縮的 application/json。" }, 415);
    }
    const input = await readJsonBody(request.body, 16 * 1024);
    if (!input || typeof input !== "object" || Array.isArray(input)) return response(request, env, { error: "內容必須是 JSON 物件。" }, 400);
    const editor = clean(input.editor), primary = clean(input.primary), partners = [...new Set(Array.isArray(input.partners) ? input.partners.map(clean) : [])].filter(Boolean), note = clean(input.note);
    if (input.website || !MEMBERS.includes(editor) || !MEMBERS.includes(primary) || !partners.length || partners.some((name) => !MEMBERS.includes(name) || name === primary) || note.length > 120) return response(request, env, { error: "欄位內容不正確。" }, 400);
    if (!await verifyTurnstile(input.turnstileToken, request, env)) return response(request, env, { error: "人機驗證失敗，請重新操作。" }, 400);
    const date = new Date().toISOString().slice(0, 10);
    await updateLog(env, partners.map((partner) => ({ date, editor, a: primary, b: partner, note })));
    return response(request, env, { ok: true, updated: partners.length });
  } catch (error) {
    return response(request, env, { error: error instanceof RequestError ? error.message : "處理失敗，請稍後再試。" }, error instanceof RequestError ? error.status : 500);
  }
} };

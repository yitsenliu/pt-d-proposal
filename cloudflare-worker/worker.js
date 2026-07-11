const MEMBERS = ["劉羿岑 Yitsen","陳向柔 Naomi","王寶佳 Renee","陳靖薇","黃冠霖","陳黎玲 Jossie","林佩君","蔡岱達","蔡淯思 Mina","鍾智媛 Fiona","張怡蘋 April","張耕豪"];
const HEAD = "# D 組 121 完成紀錄\n\n> 每組成員僅保留最新一筆完成紀錄；由 121 互動頁面寫入。\n\n| 日期 | 修改人 | 成員 A | 成員 B | 狀態 | 備註 |\n| --- | --- | --- | --- | --- | --- |";

const encode = (text) => { const bytes = new TextEncoder().encode(text); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); return btoa(binary); };
const decode = (text) => { const binary = atob(text); return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))); };
const clean = (value) => String(value || "").replace(/[|\r\n]/g, " ").trim();
const pairKey = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh-Hant")).join("|");
const cors = (request, env) => ({ "Access-Control-Allow-Origin": request.headers.get("Origin") === env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : "", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" });
const response = (request, env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(request, env) } });

function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Worker 缺少環境變數：${missing.join(", ")}`);
}

async function verifyTurnstile(token, request, env) {
  requireEnv(env, ["TURNSTILE_SECRET"]);
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET); body.append("response", token);
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  return Boolean((await result.json()).success);
}

async function github(env, path, options = {}) {
  requireEnv(env, ["GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN"]);
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH || "main"}`;
  return fetch(url, { ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pt-d-proposal-worker", ...(options.headers || {}) } });
}

async function githubErrorMessage(res, fallback) {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return `${fallback}（GitHub HTTP ${res.status}${body.message ? `：${body.message}` : ""}）`;
  } catch {
    return `${fallback}（GitHub HTTP ${res.status}${text ? `：${text.slice(0, 180)}` : ""}）`;
  }
}

async function updateLog(env, rows) {
  const path = env.LOG_PATH || "data/121-log.md";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await github(env, path);
    if (!current.ok) throw new Error(await githubErrorMessage(current, "無法讀取紀錄檔"));
    const file = await current.json();
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
    if (saved.status !== 409) throw new Error(await githubErrorMessage(saved, "GitHub 寫入失敗"));
  }
  throw new Error("同時更新的人較多，請重新整理後再送出。");
}

export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
  if (request.method !== "POST" || url.pathname !== "/api/update" || request.headers.get("Origin") !== env.ALLOWED_ORIGIN) return response(request, env, { error: "不允許的請求。" }, 403);
  try {
    const input = await request.json();
    const editor = clean(input.editor), primary = clean(input.primary), partners = [...new Set(Array.isArray(input.partners) ? input.partners.map(clean) : [])].filter(Boolean), note = clean(input.note);
    if (input.website || !MEMBERS.includes(editor) || !MEMBERS.includes(primary) || !partners.length || partners.some((name) => !MEMBERS.includes(name) || name === primary) || note.length > 120) return response(request, env, { error: "欄位內容不正確。" }, 400);
    if (!await verifyTurnstile(input.turnstileToken, request, env)) return response(request, env, { error: "人機驗證失敗，請重新操作。" }, 400);
    const date = new Date().toISOString().slice(0, 10);
    await updateLog(env, partners.map((partner) => ({ date, editor, a: primary, b: partner, note })));
    return response(request, env, { ok: true, updated: partners.length });
  } catch (error) { return response(request, env, { error: error.message || "處理失敗。" }, 500); }
} };

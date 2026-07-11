(() => {
  const config = window.PTD121_CONFIG || {};
  const state = { members: [], records: [], turnstileToken: "", turnstileWidgetId: null };
  const $ = (selector) => document.querySelector(selector);
  const editor = $("#editor");
  const primary = $("#primary-member");
  const partners = $("#partner-list");
  const partnerFieldset = $("#partner-fieldset");
  const form = $("#record-form");
  const status = $("#form-status");
  const dialog = $("#confirm-dialog");

  const esc = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const pairKey = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, "zh-Hant")).join("|");
  const setStatus = (message, isError = false) => { status.textContent = message; status.classList.toggle("error", isError); };

  const populateSelect = (select) => {
    state.members.forEach((member) => {
      const option = document.createElement("option");
      option.value = member.name;
      option.textContent = `${member.name}｜${member.role}`;
      select.append(option);
    });
  };

  const parseRecords = (markdown) => markdown.split("\n").filter((line) => line.startsWith("|")).slice(2).map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    return cells.length === 6 ? { date: cells[0], editor: cells[1], a: cells[2], b: cells[3], status: cells[4], note: cells[5] } : null;
  }).filter(Boolean);

  const renderRecords = () => {
    const list = $("#record-list");
    const summary = $("#record-summary");
    const latest = new Map();
    state.records.forEach((record) => { if (!latest.has(pairKey(record.a, record.b))) latest.set(pairKey(record.a, record.b), record); });
    const records = [...latest.values()];
    summary.textContent = `目前共有 ${records.length} 組已完成的 121 紀錄。`;
    list.innerHTML = records.length ? records.map((record) => `<article class="record-item"><div class="record-date">${esc(record.date)}</div><div><div class="record-pair">${esc(record.a)} <span aria-hidden="true">×</span> ${esc(record.b)}</div><div class="record-meta">更新人：${esc(record.editor)} · ${esc(record.status)}</div>${record.note && record.note !== "—" ? `<div class="record-note">${esc(record.note)}</div>` : ""}</div></article>`).join("") : '<p class="empty-state">尚無完成紀錄。</p>';
    const counts = new Map(state.members.map((member) => [member.name, 0]));
    records.forEach((record) => { counts.set(record.a, (counts.get(record.a) || 0) + 1); counts.set(record.b, (counts.get(record.b) || 0) + 1); });
    $("#progress-grid").innerHTML = state.members.map((member) => `<article class="progress-card"><strong>${counts.get(member.name) || 0}</strong><span>${esc(member.name)}</span><small>${esc(member.role)}</small></article>`).join("");
  };

  const loadRecords = async () => {
    $("#record-summary").textContent = "正在讀取紀錄…";
    try {
      const response = await fetch(`data/121-log.md?updated=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("讀取失敗");
      state.records = parseRecords(await response.text());
      renderRecords();
    } catch {
      $("#record-summary").textContent = "暫時無法讀取雲端紀錄，請稍後重新整理。";
    }
  };

  const renderPartners = () => {
    const selected = primary.value;
    partners.innerHTML = "";
    if (!selected) { partnerFieldset.disabled = true; $(".selection-hint").textContent = "請先選擇主成員。"; return; }
    partnerFieldset.disabled = false;
    $(".selection-hint").textContent = "可一次勾選多位已完成交流的夥伴。";
    state.members.filter((member) => member.name !== selected).forEach((member) => {
      const label = document.createElement("label");
      label.className = "partner-choice";
      label.innerHTML = `<input type="checkbox" name="partners" value="${esc(member.name)}"><span>${esc(member.name)}<br><small>${esc(member.role)}</small></span>`;
      partners.append(label);
    });
  };

  const setupTurnstile = () => {
    if (!config.turnstileSiteKey) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      state.turnstileWidgetId = window.turnstile.render("#turnstile-box", { sitekey: config.turnstileSiteKey, callback: (token) => { state.turnstileToken = token; }, "expired-callback": () => { state.turnstileToken = ""; }, "error-callback": () => { state.turnstileToken = ""; } });
    };
    document.head.append(script);
  };

  const resetTurnstile = () => {
    state.turnstileToken = "";
    if (window.turnstile && state.turnstileWidgetId !== null) window.turnstile.reset(state.turnstileWidgetId);
  };

  const sendRecords = async (payload) => {
    if (!config.workerUrl || config.workerUrl.includes("replace-after-deploy")) throw new Error("管理者尚未完成雲端寫入設定。");
    const response = await fetch(config.workerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    console.log("121 update status:", response.status);
    console.log("121 update response:", body);
    if (!response.ok) throw new Error(body.error || `儲存失敗（HTTP ${response.status}）。`);
    return body;
  };

  const submit = async (payload) => {
    const button = $("#submit-record");
    button.disabled = true;
    setStatus("正在寫入雲端紀錄…");
    try {
      await sendRecords(payload);
      setStatus("已更新。正在重新讀取最新紀錄…");
      form.reset(); renderPartners();
      await loadRecords();
      setStatus("更新完成；同組舊紀錄已由本次資料取代。");
    } catch (error) { setStatus(error.message, true); }
    finally { resetTurnstile(); button.disabled = false; }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = [...partners.querySelectorAll("input:checked")].map((item) => item.value);
    if (!selected.length) { setStatus("請至少勾選一位完成 121 的夥伴。", true); return; }
    if (form.website.value) { setStatus("送出失敗。", true); return; }
    if (config.turnstileSiteKey && !state.turnstileToken) { setStatus("請先完成人機驗證。", true); return; }
    const payload = { editor: editor.value, primary: primary.value, partners: selected, note: $("#note").value.trim(), turnstileToken: state.turnstileToken, website: form.website.value };
    $("#confirm-text").innerHTML = `由 <strong>${esc(payload.editor)}</strong> 更新：<strong>${esc(payload.primary)}</strong> 已完成與 <strong>${selected.map(esc).join("、")}</strong> 的 121。相同組合的舊紀錄會被本次資料取代。`;
    dialog.showModal();
    dialog.returnValue = "";
    dialog.addEventListener("close", () => { if (dialog.returnValue === "confirm") submit(payload); }, { once: true });
  });

  $("#refresh-records").addEventListener("click", loadRecords);
  primary.addEventListener("change", renderPartners);
  fetch("data/members.json", { cache: "no-store" }).then((response) => response.json()).then((members) => {
    state.members = members;
    populateSelect(editor); populateSelect(primary); renderPartners(); renderRecords(); loadRecords(); setupTurnstile();
  }).catch(() => { $("#record-summary").textContent = "成員名單讀取失敗。"; });
})();

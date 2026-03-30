const DEFAULT_API_BASE = "http://localhost:5000";

function normalizeBase(base) {
  const b = String(base || "").trim();
  if (!b) return DEFAULT_API_BASE;
  return b.replace(/\/$/, "");
}

function joinUrl(base, path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function setMsg(el, text, type) {
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (type) el.classList.add(type);
}

document.addEventListener("DOMContentLoaded", async () => {
  const apiBaseEl = document.getElementById("apiBase");
  const ytApiKeyEl = document.getElementById("ytApiKey");
  const msgEl = document.getElementById("msg");
  const testBtn = document.getElementById("testBtn");
  const rebuildBtn = document.getElementById("rebuildBtn");

  const saved = await chrome.storage.sync.get({
    apiBase: DEFAULT_API_BASE,
    ytApiKey: "",
  });

  apiBaseEl.value = normalizeBase(saved.apiBase);
  ytApiKeyEl.value = saved.ytApiKey || "";

  async function saveSettings() {
    const apiBase = normalizeBase(apiBaseEl.value);
    const ytApiKey = String(ytApiKeyEl.value || "").trim();
    await chrome.storage.sync.set({ apiBase, ytApiKey });
    return { apiBase, ytApiKey };
  }

  testBtn.addEventListener("click", async () => {
    setMsg(msgEl, "Testing connection…");
    const { apiBase } = await saveSettings();
    try {
      const url = joinUrl(apiBase, "/api/stats");
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(msgEl, JSON.stringify(data, null, 2) || `HTTP ${res.status}`, "err");
        return;
      }
      setMsg(msgEl, "Connection OK:\n" + JSON.stringify(data, null, 2), "ok");
    } catch (e) {
      setMsg(msgEl, "Connection failed:\n" + String(e.message || e), "err");
    }
  });

  rebuildBtn.addEventListener("click", async () => {
    setMsg(msgEl, "Rebuilding index…");
    const { apiBase } = await saveSettings();
    try {
      const url = joinUrl(apiBase, "/api/index/rebuild");
      const res = await fetch(url, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(msgEl, JSON.stringify(data, null, 2) || `HTTP ${res.status}`, "err");
        return;
      }
      setMsg(msgEl, "Rebuild complete:\n" + JSON.stringify(data, null, 2), "ok");
    } catch (e) {
      setMsg(msgEl, "Rebuild failed:\n" + String(e.message || e), "err");
    }
  });
});


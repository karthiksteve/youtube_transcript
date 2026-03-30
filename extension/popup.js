function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

function formatTime(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const remS = s % 60;
  let res = `${remM.toString().padStart(2, "0")}:${remS.toString().padStart(2, "0")}`;
  if (h > 0) res = `${h}:${res}`;
  return res;
}

const STOP_WORDS = new Set([
  "i",
  "me",
  "my",
  "myself",
  "we",
  "our",
  "ours",
  "ourselves",
  "you",
  "you're",
  "you've",
  "you'll",
  "you'd",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "theirs",
  "what",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "a",
  "an",
  "the",
  "and",
  "but",
  "if",
  "or",
  "because",
  "as",
  "until",
  "while",
  "of",
  "at",
  "by",
  "for",
  "with",
  "about",
  "against",
  "between",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "to",
  "from",
  "up",
  "down",
  "in",
  "out",
  "on",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "any",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "can",
  "will",
  "just",
  "don",
  "don't",
  "should",
  "now",
  "d",
  "ll",
  "m",
  "o",
  "re",
  "ve",
  "y",
  "aren",
  "isn",
  "wasn",
  "weren",
  "won",
  "wouldn",
]);

function tokenize(text) {
  const t = String(text || "").toLowerCase();
  const raw = t.match(/\b[a-z0-9]+\b/g) || [];
  return raw.filter((x) => x.length >= 3 && !STOP_WORDS.has(x));
}

function highlightText(text, terms) {
  let html = escapeHtml(text);
  for (const term of terms) {
    if (!term) continue;
    const re = new RegExp(escapeRegex(term), "gi");
    html = html.replace(re, (m) => `<span class="hl">${m}</span>`);
  }
  return html;
}

function sendMessageWithRetry(tabId, message, attempts = 20, delayMs = 250) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = () => {
      chrome.tabs
        .sendMessage(tabId, message)
        .then((res) => {
          if (res) resolve(res);
          else throw new Error("Empty response");
        })
        .catch((e) => {
          i += 1;
          if (i >= attempts) reject(e);
          else setTimeout(tick, delayMs);
        });
    };
    tick();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const queryEl = document.getElementById("query");
  const searchBtn = document.getElementById("searchBtn");
  const resultsEl = document.getElementById("results");
  const matchCountEl = document.getElementById("matchCount");

  const apiPill = document.getElementById("apiPill");
  const apiDot = document.getElementById("apiDot");
  const apiText = document.getElementById("apiText");

  const tabButtons = document.querySelectorAll(".tab-btn");

  let currentMode = "current";
  let apiAvailable = false;

  let currentTranscript = null;
  let currentVideoId = null;

  function setApiStatus(online) {
    apiPill.classList.remove("online", "offline");
    apiPill.classList.add(online ? "online" : "offline");
    if (online) {
      apiText.textContent = "Online";
      apiDot.style.background = "#2ea44f";
    } else {
      apiText.textContent = "Offline";
      apiDot.style.background = "#6e6e6e";
    }
  }

  async function checkApi() {
    try {
      const res = await chrome.runtime.sendMessage({ action: "CHECK_API" });
      apiAvailable = !!res.available;
      setApiStatus(apiAvailable);
    } catch (e) {
      apiAvailable = false;
      setApiStatus(false);
    }
  }

  async function loadCurrent() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) throw new Error("No active tab.");
    if (!String(tab.url).includes("youtube.com")) throw new Error("Open a YouTube video page first.");

    const response = await sendMessageWithRetry(tab.id, { action: "GET_TRANSCRIPT" });
    if (!response || response.error) throw new Error(response?.error || "Failed to load transcript.");

    currentTranscript = response.transcript || [];
    currentVideoId = response.videoId || null;
  }

  function localSearch(query) {
    if (!currentTranscript) return [];
    const qTerms = tokenize(query);
    if (!qTerms.length) return [];

    const qLower = String(query || "").toLowerCase().trim();
    const scored = currentTranscript
      .map((seg) => {
        const text = String(seg.text || "");
        const tLower = text.toLowerCase();
        let score = 0;

        if (qLower && tLower.includes(qLower)) score += 20;

        for (const term of qTerms) {
          if (!term) continue;
          const matches = tLower.match(new RegExp(escapeRegex(term), "gi"));
          if (matches) score += matches.length;
        }

        // light normalization: prefer earlier segments when equal
        return { segment: seg, score, time: seg.time };
      })
      .filter((x) => x.score > 0);

    scored.sort((a, b) => b.score - a.score || a.time - b.time);
    return scored.slice(0, 25).map((x) => ({ ...x.segment, score: x.score }));
  }

  function renderCurrentResults(results, query) {
    resultsEl.innerHTML = "";
    matchCountEl.textContent = results.length ? `${results.length} match(es)` : "";

    if (!results.length) {
      resultsEl.innerHTML = '<div class="error">No matches found</div>';
      return;
    }

    const terms = tokenize(query);
    for (const seg of results) {
      const ts = formatTime(seg.time);
      const jumpUrl = currentVideoId ? `https://www.youtube.com/watch?v=${currentVideoId}&t=${Math.floor(seg.time)}s` : "#";

      const block = document.createElement("div");
      block.className = "result-block";

      block.innerHTML = `
        <div class="seg-top">
          <a href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener" class="ts" data-jump="${escapeHtml(String(seg.time))}">
            ${escapeHtml(ts)}
          </a>
        </div>
        <div class="seg-text">${highlightText(seg.text, terms)}</div>
      `;

      const tsLink = block.querySelector("[data-jump]");
      tsLink.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, { action: "JUMP_TO_TIME", time: seg.time }).catch(() => {});
      });

      resultsEl.appendChild(block);
    }
  }

  async function searchAll(query) {
    if (!apiAvailable) throw new Error("Backend offline. Open settings to configure API.");
    const response = await chrome.runtime.sendMessage({
      action: "SEARCH",
      query,
      limit: 20,
    });
    if (!response?.success) throw new Error(response?.error || "Search failed.");
    return response.data;
  }

  function renderAllResults(data, query) {
    const results = data.results || [];
    resultsEl.innerHTML = "";
    const terms = tokenize(query);

    matchCountEl.textContent = results.length ? `${results.length} video(s) found` : "";

    if (!results.length) {
      resultsEl.innerHTML = '<div class="error">No videos found</div>';
      return;
    }

    for (const video of results) {
      const card = document.createElement("div");
      card.className = "video-card";

      const segments = (video.segments || []).slice(0, 3);
      const segHtml = segments
        .map((seg) => {
          const ts = formatTime(seg.time);
          const jumpUrl = `${video.url}&t=${Math.floor(seg.time)}s`;
          return `
            <div class="seg-item">
              <div class="seg-top">
                <div class="ts">${escapeHtml(ts)}</div>
              </div>
              <div class="seg-text">${highlightText(seg.text, terms)}</div>
              <div class="actions">
                <a class="mini-btn primary" href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener">▶ Jump</a>
                <button class="mini-btn" type="button" data-copy="${escapeHtml(jumpUrl)}">🔗 Copy</button>
              </div>
            </div>
          `;
        })
        .join("");

      card.innerHTML = `
        <div class="video-row">
          <img class="video-thumb" src="${escapeHtml(video.thumbnail || "")}" alt="" onerror="this.style.display='none'"/>
          <div style="flex:1; min-width:0;">
            <div class="video-title">
              <a href="${escapeHtml(video.url)}" target="_blank" rel="noopener">${escapeHtml(video.title || "")}</a>
            </div>
            <div class="video-meta">Channel: ${escapeHtml(video.channel || "Unknown")}</div>
            ${segHtml}
          </div>
        </div>
      `;

      card.querySelectorAll("button[data-copy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const url = btn.getAttribute("data-copy") || "";
          try {
            await navigator.clipboard.writeText(url);
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(() => {
              btn.textContent = "🔗 Copy";
              btn.classList.remove("copied");
            }, 1200);
          } catch (e) {
            alert("Copy failed. Copy manually:\n" + url);
          }
        });
      });

      resultsEl.appendChild(card);
    }
  }

  async function runSearch() {
    const query = queryEl.value.trim();
    if (!query) return;

    resultsEl.innerHTML = '<div class="loading">Searching…</div>';
    matchCountEl.textContent = "";

    try {
      if (currentMode === "current") {
        if (!currentTranscript) {
          await loadCurrent();
        }
        const results = localSearch(query);
        renderCurrentResults(results, query);
      } else {
        const data = await searchAll(query);
        renderAllResults(data, query);
      }
    } catch (e) {
      resultsEl.innerHTML = `<div class="error">${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentMode = btn.dataset.mode === "current" ? "current" : "all";

      currentTranscript = null;
      currentVideoId = null;

      queryEl.value = "";
      matchCountEl.textContent = "";
      resultsEl.innerHTML = `<div class="placeholder">${currentMode === "current" ? "Load a transcript to search." : "Type to search your indexed library."}</div>`;
    });
  });

  searchBtn.addEventListener("click", runSearch);
  queryEl.addEventListener("keypress", (e) => {
    if (e.key === "Enter") runSearch();
  });

  checkApi();

  // initial placeholder
  resultsEl.innerHTML = '<div class="placeholder">Type to search in the current video.</div>';
});


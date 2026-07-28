/* Hyperion, Unfinished — single-user MVP.
   Renders both fragments, rules the space the poem never filled,
   and keeps the visitor's continuation in localStorage / a JSON file. */

"use strict";

const LINE_PX = 34;                       // must match --line in styles.css
const STORE_PREFIX = "hyperion-unfinished:v1:";
const APP_ID = "hyperion-unfinished";
const PUBLISH_COOLDOWN_MS = 10 * 60 * 1000;
const LAST_PUBLISH_KEY = "hyperion-unfinished:last-publish";

const COPY = {
  "hyperion": {
    eyebrow: "John Keats · 1818–19 · abandoned",
    subtitle: "A Fragment",
    thesis: "Keats set out to tell how the Titans fell and how Apollo rose, " +
      "and stopped mid-line in the third book — at the very instant Apollo " +
      "becomes the god of poetry. The blank after line 136 has waited two " +
      "centuries. It is ruled and numbered below; take up the verse.",
    charge: "Keats broke off half-way through line 136 — its first word, " +
      "“Celestial”, is already set down below for you to finish. He may have " +
      "meant to complete Book III alone, or to carry on into a Book IV — the " +
      "ruled space leaves room for either, or anything in between.",
    defaultTarget: 800,
    // Book III ends mid-line, so the continuation re-opens line 136 itself.
    seed: "Celestial ",
  },
  "fall-of-hyperion": {
    eyebrow: "John Keats · 1819 · abandoned again",
    subtitle: "A Dream",
    thesis: "That autumn Keats came back to rebuild the epic as a dream vision, " +
      "and gave it up once more — sixty-one lines into the second canto, as " +
      "Hyperion flares onward. The dream is still open. Write what the poet " +
      "saw next.",
    charge: "Continue from line 62 of Canto II. The ruled space is roughly what " +
      "a finished canto would ask for.",
    defaultTarget: 400,
  },
};

let DATA = null;
let current = null;        // poem id
let saveTimer = null;
let els = {};              // per-render element cache

/* ---------------- utilities ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function storeKey(id) { return STORE_PREFIX + id; }

function loadDraft(id) {
  try {
    const raw = localStorage.getItem(storeKey(id));
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupted or unavailable storage: start fresh */ }
  return { text: "", target: COPY[id].defaultTarget, updated: null };
}

function saveDraft(id, draft) {
  draft.updated = new Date().toISOString();
  try {
    localStorage.setItem(storeKey(id), JSON.stringify(draft));
    return true;
  } catch (e) { return false; }
}

/* Rough syllable count for the meter hint (blank verse aims at 10). */
function syllablesInWord(word) {
  let w = word.toLowerCase()
    .replace(/[’']d\b/, "d")        // pluck'd, dream'd: elided, no vowel
    .replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g) || [];
  let n = groups.length;
  if (n > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n--; // silent e (stone, vale) but not syllabic -le (gentle)
  if (n > 1 && /[^td]ed$/.test(w)) n--;              // walk(ed), not hated
  return Math.max(1, n);
}
function syllablesInLine(line) {
  return line.split(/\s+/).reduce((sum, w) => sum + syllablesInWord(w), 0);
}

/* ---------------- gallery backend (Supabase REST, anon key) ---------------- */

function sbHeaders() {
  const cfg = window.HYPERION_CONFIG;
  return {
    apikey: cfg.supabaseAnonKey,
    Authorization: "Bearer " + cfg.supabaseAnonKey,
    "Content-Type": "application/json",
  };
}

async function fetchEndings(poemFilter) {
  let url = window.HYPERION_CONFIG.supabaseUrl +
    "/rest/v1/continuations?select=id,poem,pen_name,body,created_at" +
    "&order=created_at.desc&limit=50";
  if (poemFilter !== "all") url += "&poem=eq." + encodeURIComponent(poemFilter);
  const resp = await fetch(url, { headers: sbHeaders() });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.json();
}

async function publishEnding(row) {
  const resp = await fetch(
    window.HYPERION_CONFIG.supabaseUrl + "/rest/v1/continuations",
    {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify(row),
    },
  );
  if (!resp.ok) throw new Error("HTTP " + resp.status);
}

/* ---------------- rendering ---------------- */

function poemById(id) { return DATA.poems.find((p) => p.id === id); }

function startLineOf(poemId) {
  const poem = poemById(poemId);
  if (!poem) return 1;
  const last = poem.sections[poem.sections.length - 1].lineCount;
  // A mid-line break (seeded poem) re-opens the broken line instead of
  // starting the next one.
  return COPY[poemId] && COPY[poemId].seed ? last : last + 1;
}

function setActiveTab(view) {
  document.querySelectorAll(".poem-tabs a").forEach((a) => {
    a.setAttribute("aria-selected", a.dataset.view === view ? "true" : "false");
  });
}

function sectionHTML(section, isLast) {
  let n = 0;
  const stanzas = section.stanzas.map((stanza, si) => {
    const lines = stanza.map((line, li) => {
      n++;
      const showNum = n % 5 === 0 || (isLast && n === section.lineCount);
      const num = showNum ? `<span class="n" aria-hidden="true">${n}</span>` : "";
      const cls = si === 0 && li === 0 ? "vline dropcap" : "vline";
      return `<div class="${cls}">${num}${esc(line)}</div>`;
    }).join("");
    return `<div class="stanza">${lines}</div>`;
  }).join("");
  const count = isLast
    ? `breaks off at line ${section.lineCount}`
    : `${section.lineCount} lines`;
  return `
    <section class="poem-section">
      <div class="section-head">
        <h2>${esc(section.title)}</h2>
        <span class="flourish"></span>
        <span class="count">${count}</span>
      </div>
      ${stanzas}
    </section>`;
}

function render(id) {
  const poem = poemById(id);
  const copy = COPY[id];
  const draft = loadDraft(id);
  const startLine = startLineOf(id);

  setActiveTab(id);

  const sections = poem.sections
    .map((s, i) => sectionHTML(s, i === poem.sections.length - 1))
    .join("");

  $("#page").innerHTML = `
    <header class="hero">
      <p class="eyebrow">${copy.eyebrow}</p>
      <h1>${esc(poem.title)}</h1>
      <p class="subtitle">${esc(copy.subtitle)}</p>
      <p class="thesis">${copy.thesis}</p>
      <p class="actions">
        <a href="#" data-act="read">Begin reading</a>
        <a href="#" data-act="write">Go to the last line</a>
      </p>
    </header>

    <div id="keats-text">${sections}</div>

    <div class="break-marker" id="the-break" role="separator">
      <span>Here the manuscript breaks off</span>
    </div>

    <section class="workshop" aria-label="Your continuation">
      <div class="workshop-head">
        <h2>The remainder is yours</h2>
        <p class="charge">${copy.charge}</p>
      </div>
      <div class="workshop-tools">
        <span class="status" id="status"></span>
        <span class="meter" id="meter"></span>
        <span class="spacer"></span>
        <label>target
          <input type="number" id="target" min="10" max="3000" step="10" value="${draft.target}">
        </label>
        <button class="tool" id="download">Download draft</button>
        <button class="tool" id="load">Load draft</button>
        <button class="tool" id="publish-open">Publish to gallery</button>
        <span class="whisper" id="whisper"></span>
      </div>
      <div class="publish-panel" id="publish-panel" hidden>
        <p class="disclaimer">Published continuations are anonymous and
        unreviewed — they speak for their pen names, not for this site or for
        Keats. Anything abusive will be removed. Your local draft stays yours;
        publishing sends a copy.</p>
        <div class="publish-row">
          <label>write your name in water
            <input id="pen-name" maxlength="60"
              placeholder="leave blank to be writ in water">
          </label>
          <input id="hp-field" class="hp" name="website" tabindex="-1"
            autocomplete="off" aria-hidden="true">
          <button class="tool" id="publish-confirm">Publish</button>
          <button class="tool" id="publish-cancel">Cancel</button>
        </div>
        <p class="import-error" id="publish-error"></p>
      </div>
      <div class="scriptorium">
        <div class="gutter" id="gutter" aria-hidden="true"></div>
        <textarea id="draft" wrap="off" spellcheck="false"
          aria-label="Your continuation of the poem, starting at line ${startLine}"
          placeholder="…take up the verse at line ${startLine}"></textarea>
      </div>
      <input type="file" id="filepick" accept="application/json,.json" hidden>
      <p class="import-error" id="import-error"></p>
    </section>`;

  els = {
    textarea: $("#draft"),
    gutter: $("#gutter"),
    status: $("#status"),
    meter: $("#meter"),
    whisper: $("#whisper"),
    target: $("#target"),
    importError: $("#import-error"),
    breakMarker: $("#the-break"),
    keatsText: $("#keats-text"),
  };
  // A fresh draft of a mid-line poem opens with Keats' hanging word.
  els.textarea.value = draft.text || copy.seed || "";
  els.startLine = startLine;
  els.draft = draft;

  wireWorkshop(id);
  refreshEditor(id);
  if (draft.updated) whisper(`kept in this browser · last saved ${timeAgo(draft.updated)}`);
  else whisper("kept in this browser as you type");
  updateRail();
}

/* ---------------- editor behaviour ---------------- */

function lineStats(text) {
  const lines = text.length ? text.split("\n") : [];
  const written = lines.filter((l) => l.trim().length > 0).length;
  return { lines, written };
}

function refreshEditor(id) {
  const ta = els.textarea;
  const target = els.draft.target;
  const { lines, written } = lineStats(ta.value);
  // lines are a fixed 34px grid with wrapping off, so height is exact;
  // +1 spare row so the caret never sits against the bottom edge
  const total = Math.max(target, lines.length + 1);

  ta.style.height = total * LINE_PX + "px";

  // margin numbers, continuing Keats's count, every fifth line
  let marks = "";
  for (let i = 0; i < total; i++) {
    const lineNo = els.startLine + i;
    if (lineNo % 5 === 0 || i === 0) {
      marks += `<span style="top:${i * LINE_PX}px">${lineNo}</span>`;
    }
  }
  els.gutter.innerHTML = marks;
  els.gutter.style.height = total * LINE_PX + "px";

  els.status.innerHTML =
    `written <b>${written}</b> of ~${target} lines`;
  updateMeter();
  updateRail();
}

function updateMeter() {
  const ta = els.textarea;
  const upToCaret = ta.value.slice(0, ta.selectionStart);
  const lineIdx = upToCaret.split("\n").length - 1;
  const line = (ta.value.split("\n")[lineIdx] || "").trim();
  if (!line) { els.meter.textContent = ""; els.meter.classList.remove("true"); return; }
  const s = syllablesInLine(line);
  els.meter.textContent = `line ${els.startLine + lineIdx} · ~${s} syllables`;
  els.meter.classList.toggle("true", s === 10);
}

function whisper(msg) { els.whisper.textContent = msg; }

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function scheduleSave(id) {
  whisper("…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    els.draft.text = els.textarea.value;
    const ok = saveDraft(id, els.draft);
    whisper(ok ? "kept in this browser · saved just now"
               : "could not save — storage unavailable; download your draft");
  }, 500);
}

function flushSave(id) {
  clearTimeout(saveTimer);
  if (!els.textarea) return;
  els.draft.text = els.textarea.value;
  saveDraft(id, els.draft);
}

function wireWorkshop(id) {
  const ta = els.textarea;

  ta.addEventListener("input", () => { refreshEditor(id); scheduleSave(id); });
  ["keyup", "click", "focus"].forEach((ev) => ta.addEventListener(ev, updateMeter));
  ta.addEventListener("blur", () => flushSave(id));

  els.target.addEventListener("change", () => {
    const v = clamp(parseInt(els.target.value, 10) || COPY[id].defaultTarget, 10, 3000);
    els.target.value = v;
    els.draft.target = v;
    refreshEditor(id);
    scheduleSave(id);
  });

  $("#download").addEventListener("click", () => {
    flushSave(id);
    const poem = poemById(id);
    const payload = {
      app: APP_ID,
      version: 1,
      poem: id,
      poemTitle: poem.title,
      author: "you, after John Keats",
      exported: new Date().toISOString(),
      startLine: els.startLine,
      target: els.draft.target,
      lines: els.textarea.value.split("\n"),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${id}-continuation.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#load").addEventListener("click", () => $("#filepick").click());
  $("#filepick").addEventListener("change", async (e) => {
    els.importError.textContent = "";
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let obj;
    try { obj = JSON.parse(await file.text()); }
    catch { els.importError.textContent = "That file is not valid JSON."; return; }
    if (obj.app !== APP_ID || !COPY[obj.poem] || !Array.isArray(obj.lines)) {
      els.importError.textContent =
        "That file was not made here — expected a draft downloaded from this page.";
      return;
    }
    const incoming = {
      text: obj.lines.join("\n"),
      target: clamp(parseInt(obj.target, 10) || COPY[obj.poem].defaultTarget, 10, 3000),
      updated: null,
    };
    const existing = loadDraft(obj.poem);
    if (existing.text.trim() &&
        existing.text !== incoming.text &&
        !confirm(`Replace your current ${poemById(obj.poem).title} draft with the file's?`)) {
      return;
    }
    saveDraft(obj.poem, incoming);
    if (obj.poem === id) render(id);
    else location.hash = obj.poem;   // switch; render() picks up the saved draft
  });

  const panel = $("#publish-panel");
  $("#publish-open").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) $("#pen-name").focus();
  });
  $("#publish-cancel").addEventListener("click", () => { panel.hidden = true; });
  $("#publish-confirm").addEventListener("click", () => doPublish(id));

  document.querySelectorAll(".hero .actions a").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (a.dataset.act === "read") els.keatsText.scrollIntoView({ block: "start" });
      else { els.breakMarker.scrollIntoView({ block: "center" }); ta.focus(); }
    });
  });
}

async function doPublish(id) {
  const errEl = $("#publish-error");
  errEl.textContent = "";
  flushSave(id);

  const text = els.textarea.value;
  const { written } = lineStats(text);
  if (text.trim().length < 50 || written < 2) {
    errEl.textContent = "Write at least a couple of lines (50+ characters) before publishing.";
    return;
  }
  const waitMs = parseInt(localStorage.getItem(LAST_PUBLISH_KEY) || "0", 10) +
    PUBLISH_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    errEl.textContent = `The press is still warm — you can publish again in ${Math.ceil(waitMs / 60000)} min.`;
    return;
  }

  // Keats' epitaph: "Here lies One Whose Name was writ in Water."
  const pen = ($("#pen-name").value.trim() || "Writ in water").slice(0, 60);
  const honeypot = $("#hp-field").value;   // bots fill hidden fields; humans can't
  const btn = $("#publish-confirm");
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    if (!honeypot) await publishEnding({ poem: id, pen_name: pen, body: text });
    localStorage.setItem(LAST_PUBLISH_KEY, String(Date.now()));
    $("#publish-panel").hidden = true;
    whisper("published — it is in the gallery now");
  } catch (e) {
    errEl.textContent =
      `Publishing failed (${e.message}). Check your connection and try again.`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Publish";
  }
}

/* ---------------- the gallery ---------------- */

let galleryFilter = "all";

function endingCardHTML(row) {
  const poem = poemById(row.poem);
  const title = poem ? poem.title : row.poem;
  const start = startLineOf(row.poem);
  const lines = row.body.split("\n");
  const written = lines.filter((l) => l.trim()).length;
  const date = new Date(row.created_at).toLocaleDateString(undefined,
    { day: "numeric", month: "short", year: "numeric" });
  const firstLine = lines.find((l) => l.trim()) || "";
  const body = lines.map((ln, i) => {
    const n = start + i;
    const num = (n % 5 === 0 || i === 0)
      ? `<span class="n" aria-hidden="true">${n}</span>` : "";
    return `<div class="vline">${num}${esc(ln) || "&nbsp;"}</div>`;
  }).join("");
  return `<details class="ending-card">
    <summary>
      <span class="pen">${esc(row.pen_name)}</span>
      <span class="meta">${esc(title)} · ${written} lines · ${date}</span>
      <span class="first">${esc(firstLine)}&hellip;</span>
    </summary>
    <div class="card-body">${body}</div>
  </details>`;
}

async function loadGalleryList() {
  const listEl = $("#gallery-list");
  if (!listEl) return;
  listEl.innerHTML = `<p class="loading">Unrolling the scrolls&hellip;</p>`;
  try {
    const rows = await fetchEndings(galleryFilter);
    if (!rows.length) {
      listEl.innerHTML = `<p class="loading">Nothing here yet. Be the first:
        open a poem and take up the verse.</p>`;
      return;
    }
    listEl.innerHTML = rows.map(endingCardHTML).join("");
  } catch (e) {
    listEl.innerHTML = `<p class="loading">The gallery could not be reached
      (${esc(e.message)}). Reload to try again.</p>`;
  }
}

function renderGallery() {
  els = {};
  setActiveTab("gallery");
  const filters = [
    ["all", "All"],
    ["hyperion", "Hyperion"],
    ["fall-of-hyperion", "The Fall"],
  ];
  $("#page").innerHTML = `
    <header class="hero">
      <p class="eyebrow">the gallery</p>
      <h1>Endings</h1>
      <p class="thesis">Continuations published by visitors, newest first.
      They are anonymous and unreviewed — they speak for their pen names, not
      for this site or for Keats. Abusive entries are removed.</p>
      <p class="filter-tabs">${filters.map(([f, label]) =>
        `<button class="filter" data-f="${f}"
          aria-pressed="${f === galleryFilter}">${label}</button>`).join("")}
      </p>
    </header>
    <div id="gallery-list"></div>`;
  document.querySelectorAll(".filter-tabs .filter").forEach((b) => {
    b.addEventListener("click", () => {
      galleryFilter = b.dataset.f;
      document.querySelectorAll(".filter-tabs .filter").forEach((x) =>
        x.setAttribute("aria-pressed", x === b ? "true" : "false"));
      loadGalleryList();
    });
  });
  loadGalleryList();
}

/* ---------------- the sun rail ---------------- */

function updateRail() {
  if (!els.keatsText) return;
  const sun = $("#rail-sun");
  const star = $("#rail-star");
  const scrollY = window.scrollY;
  const eye = scrollY + window.innerHeight * 0.6;
  const poemTop = els.keatsText.getBoundingClientRect().top + scrollY;
  const breakY = els.breakMarker.getBoundingClientRect().top + scrollY;
  const read = clamp((eye - poemTop) / Math.max(1, breakY - poemTop), 0, 1);
  sun.style.top = (6 + 44 * read) + "%";

  const { written } = lineStats(els.textarea.value);
  const write = clamp(written / Math.max(1, els.draft.target), 0, 1);
  star.style.top = (94 - 44 * write) + "%";
  star.classList.toggle("dawned", write >= 1);
  star.title = `Apollo’s star — ${written} of ~${els.draft.target} lines written. ` +
    `Click to go to your draft.`;
}

/* ---------------- routing & boot ---------------- */

function route() {
  const id = location.hash.replace("#", "");
  if (current) flushSave(current);
  const isGallery = id === "gallery";
  document.body.classList.toggle("no-rail", isGallery);
  if (isGallery) {
    current = null;
    renderGallery();
  } else {
    const next = COPY[id] ? id : "hyperion";
    current = next;
    if (location.hash !== "#" + next) {
      history.replaceState(null, "", "#" + next);
    }
    render(next);
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function boot() {
  try {
    const resp = await fetch("poems.json");
    if (!resp.ok) throw new Error(resp.status);
    DATA = await resp.json();
  } catch (e) {
    $("#page").innerHTML =
      `<p class="loading">The manuscript could not be fetched (poems.json). ` +
      `Reload the page to try again.</p>`;
    return;
  }
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", () => updateRail(), { passive: true });
  window.addEventListener("resize", () => updateRail());
  window.addEventListener("beforeunload", () => { if (current) flushSave(current); });

  $("#rail-sun").addEventListener("click", () =>
    els.keatsText && els.keatsText.scrollIntoView({ block: "start" }));
  $("#rail-star").addEventListener("click", () => {
    if (!els.breakMarker) return;
    els.breakMarker.scrollIntoView({ block: "center" });
    els.textarea.focus({ preventScroll: true });
  });
}

boot();

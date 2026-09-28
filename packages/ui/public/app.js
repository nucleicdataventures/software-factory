const STAGES = [
  ["intake", "Intake"],
  ["plan", "Planning"],
  ["plan-gate", "Plan gate"],
  ["author-tests", "Test author"],
  ["implement", "Implement"],
  ["independent-review", "Review"],
  ["verify-in-fresh-sandbox", "Verify"],
  ["merge-gate", "Merge gate"],
  ["package-draft-pr", "Package"],
  ["complete", "Complete"],
];
const RESUMABLE = new Set(["author-tests", "implement", "independent-review", "verify-in-fresh-sandbox"]);
const TABS = ["Spec", "Plan", "Runs", "Reviewer", "Evidence", "Provenance"];
const state = { items: [], detail: null, selectedTab: "Spec", evidenceText: new Map(), error: "", busy: false, fingerprint: "", polling: false };
const main = document.querySelector("#main-content");
const healthStrip = document.querySelector("#health-strip");
const errorBanner = document.querySelector("#error-banner");
const errorMessage = document.querySelector("#error-message");
const modal = document.querySelector("#job-modal");
const jobForm = document.querySelector("#job-form");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function humanStage(stage) {
  return STAGES.find(([key]) => key === stage)?.[1] ?? stage;
}

function statusLabel(status) {
  return String(status ?? "unknown").replaceAll("-", " ");
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === "object" ? body.error ?? `Request failed (${response.status})` : body || `Request failed (${response.status})`);
  return body;
}

function selectedId() {
  const match = location.hash.match(/^#work\/(forge-[0-9]{8}-[a-f0-9]{8})$/i);
  return match?.[1] ?? null;
}

function showError(message) {
  state.error = message;
  errorMessage.textContent = message;
  errorBanner.hidden = false;
}

function clearError() {
  state.error = "";
  errorBanner.hidden = true;
  errorMessage.textContent = "";
}

async function refresh() {
  if (state.polling) return;
  state.polling = true;
  try {
    const id = selectedId();
    const [health, listing] = await Promise.all([api("/api/health"), api("/api/work")]);
    renderHealth(health);
    state.items = listing.items ?? [];
    state.detail = id ? await api(`/api/work/${encodeURIComponent(id)}`) : null;
    render();
  } catch (error) {
    renderHealth(null);
    if (!state.error) showError(error instanceof Error ? error.message : String(error));
  } finally {
    state.polling = false;
  }
}

function renderHealth(health) {
  if (!health) {
    healthStrip.innerHTML = '<span class="health-label">SYSTEM CHECK</span><span class="health-value"><span class="health-dot down"></span> Forge API unavailable</span>';
    return;
  }
  const docker = health.docker === "up" ? "up" : "down";
  healthStrip.innerHTML = `<span class="health-label">SYSTEM CHECK</span><span class="health-value"><span class="health-pill"><span class="health-dot"></span> Node ${escapeHtml(health.node)}</span><span class="health-sep">·</span><span class="health-pill"><span class="health-dot ${docker === "down" ? "down" : ""}"></span> Docker ${docker}</span><span class="health-sep">·</span><span class="health-pill">Harness ${escapeHtml(health.harness)}</span></span>`;
  const states = {
    "logged-in": "Codex logged in",
    "logged-out": "Codex logged out",
    missing: "Codex CLI missing",
    unavailable: "Codex status unavailable",
  };
  const codexState = states[health.codex] ?? "Codex status unavailable";
  const status = document.createElement("span");
  status.className = "health-pill";
  status.title = health.codexMessage ? String(health.codexMessage) : "";
  const dot = document.createElement("span");
  dot.className = "health-dot" + (health.codex === "logged-in" ? "" : " down");
  status.append(dot, document.createTextNode(codexState));
  const separator = document.createElement("span");
  separator.className = "health-sep";
  separator.textContent = "·";
  healthStrip.querySelector(".health-value")?.append(separator, status);
}

function render() {
  const currentId = selectedId();
  const fingerprint = JSON.stringify({ id: currentId, items: state.items, detail: state.detail, tab: state.selectedTab, evidenceText: [...state.evidenceText.entries()], busy: state.busy });
  if (fingerprint === state.fingerprint) return;
  state.fingerprint = fingerprint;
  if (!currentId) renderBoard();
  else if (!state.detail) renderNotFound();
  else renderDetail();
  errorMessage.textContent = state.error;
  errorBanner.hidden = !state.error;
}

function renderBoard() {
  const waiting = state.items.filter((item) => item.status === "waiting-approval").length;
  const running = state.items.filter((item) => item.status === "running" || item.status === "queued").length;
  const columns = STAGES.map(([stage, label]) => {
    const items = state.items.filter((item) => item.status !== "dead-letter" && item.currentStage === stage);
    return laneMarkup(stage, label, items);
  });
  columns.push(laneMarkup("dead-letter", "Dead letter", state.items.filter((item) => item.status === "dead-letter")));
  main.innerHTML = `<section class="page-heading"><div><div class="eyebrow">FACTORY FLOOR</div><h1>Work in motion</h1><p>Specs become plans, plans wait for you, and work moves through isolated stations.</p></div><div class="heading-meta"><strong>${state.items.length}</strong> work items <span>·</span> ${waiting} waiting on you <span>·</span> ${running} active</div></section><div class="board-scroll"><div class="board">${columns.join("")}</div></div><div class="board-note"><span class="board-note-mark">✳</span> Every card is a durable work item. The plan and merge gates stay in your hands.</div>`;
}

function laneMarkup(stage, label, items) {
  const cards = items.length ? items.map(cardMarkup).join("") : '<div class="empty-lane">Nothing in this station</div>';
  return `<section class="lane" data-stage="${escapeHtml(stage)}"><div class="lane-head"><span class="lane-title"><span class="lane-marker"></span>${escapeHtml(label)}</span><span class="lane-count">${items.length}</span></div><div class="lane-body">${cards}</div></section>`;
}

function cardMarkup(item) {
  const gateCopy = item.status === "waiting-approval" ? (item.currentStage === "plan-gate" ? "Plan needs your approval" : "Merge needs your approval") : "";
  return `<article class="work-card" data-open-work="${escapeHtml(item.id)}" tabindex="0" role="link" aria-label="Open ${escapeHtml(item.title)}"><div class="card-top"><span class="card-id">${escapeHtml(item.id)}</span><span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div><h3>${escapeHtml(item.title)}</h3><div class="card-stage"><span>Current station</span><strong>${escapeHtml(humanStage(item.currentStage))}</strong></div>${gateCopy ? `<div class="card-approval">↳ ${gateCopy}</div>` : ""}</article>`;
}

function renderNotFound() {
  main.innerHTML = '<section class="not-found"><div class="eyebrow">WORK ITEM</div><h1>That item is not on this floor.</h1><p>It may have been removed or the link may be incomplete.</p><button class="button button-quiet" data-action="back-board">Return to board</button></section>';
}

function renderDetail() {
  const detail = state.detail;
  const item = detail.item;
  const gateEnabled = item.status === "waiting-approval";
  const canPlan = gateEnabled && item.currentStage === "plan-gate";
  const canMerge = gateEnabled && item.currentStage === "merge-gate";
  const canResume = ["queued", "running"].includes(item.status) && RESUMABLE.has(item.currentStage);
  const tabs = TABS.map((tab) => `<button class="tab-button ${state.selectedTab === tab ? "active" : ""}" data-tab="${tab}" role="tab" aria-selected="${state.selectedTab === tab}">${tab}</button>`).join("");
  main.innerHTML = `<div class="detail-top"><button class="back-button" data-action="back-board">← Factory floor</button></div><div class="page-heading"><div><div class="detail-title-line"><h1>${escapeHtml(item.title)}</h1><span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></div><p class="detail-subtitle">${escapeHtml(item.id)} &nbsp;·&nbsp; ${escapeHtml(item.specRef)} &nbsp;·&nbsp; ${escapeHtml(humanStage(item.currentStage))}</p></div><div class="heading-meta">UPDATED <strong>${escapeHtml(formatDate(item.updatedAt))}</strong></div></div><div class="detail-layout"><section class="detail-main"><nav class="tab-row" role="tablist" aria-label="Work item details">${tabs}</nav><div class="tab-panel" id="tab-panel" role="tabpanel">${panelMarkup(detail, item)}</div></section><aside class="detail-side"><div class="side-heading"><h2>Work item</h2><span class="eyebrow">${escapeHtml(item.id.slice(-8))}</span></div><div class="side-section"><div class="side-label">Current station</div><div class="side-value">${escapeHtml(humanStage(item.currentStage))}</div><div class="side-label" style="margin-top:11px">Assigned to</div><div class="side-value">${escapeHtml(item.assigneeRole ?? "CODE / control plane")}</div></div><div class="side-section"><div class="side-label">Budgets</div>${budgetMarkup("Tokens", item.tokensUsed, item.budgetTokens, Number(item.tokensUsed) / Math.max(1, Number(item.budgetTokens)) * 100)}${budgetMarkup("USD", `$${Number(item.usdUsed).toFixed(2)}`, `$${Number(item.budgetUsd).toFixed(2)}`, Number(item.usdUsed) / Math.max(.01, Number(item.budgetUsd)) * 100)}<div class="budget-line"><span>Retries</span><span>${escapeHtml(item.retryCount)} / ${escapeHtml(item.retries)}</span></div></div><div class="side-section"><div class="side-label">Latest sandbox</div><div class="side-value"><code>${escapeHtml(item.sandboxId ?? "Not assigned")}</code></div><div class="side-label" style="margin-top:11px">Harness · model</div><div class="side-value">${escapeHtml(item.harness)} · ${escapeHtml(item.model)}</div></div><div class="action-stack">${canPlan ? '<button class="button button-primary" data-gate-action="approve" data-gate="plan">Approve plan <span aria-hidden="true">→</span></button><button class="button button-danger" data-gate-action="reject" data-gate="plan">Reject plan</button>' : ""}${canMerge ? '<button class="button button-primary" data-gate-action="approve" data-gate="merge">Approve merge package <span aria-hidden="true">→</span></button><button class="button button-danger" data-gate-action="reject" data-gate="merge">Reject merge</button>' : ""}${canResume ? '<button class="button button-outline" data-item-action="resume">Resume work <span aria-hidden="true">↻</span></button>' : ""}${!canPlan && !canMerge && !canResume ? '<button class="button button-quiet" disabled>No action at this stage</button>' : ""}</div><p class="action-note">Forge creates a local draft bundle. It never merges code or pushes to a remote.</p></aside></div>`;
}

function budgetMarkup(label, used, budget, percent) {
  const width = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="budget-line"><span>${label}</span><span>${escapeHtml(used)} / ${escapeHtml(budget)}</span></div><div class="budget-track"><div class="budget-fill" style="width:${width}%"></div></div>`;
}

function panelMarkup(detail, item) {
  if (state.selectedTab === "Spec") return `<div class="panel-heading"><h2>Specification</h2><span class="panel-hint">SOURCE OF TRUTH</span></div>${detail.specText ? `<pre class="file-surface">${escapeHtml(detail.specText)}</pre>` : `<div class="empty-evidence">${escapeHtml(detail.specError ?? "Spec is unavailable")}</div>`}`;
  if (state.selectedTab === "Plan") return evidencePanel(item.id, "plan.md", "Plan", "PLANNER OUTPUT");
  if (state.selectedTab === "Runs") return runsPanel(detail.runs);
  if (state.selectedTab === "Reviewer") return reviewerPanel(item.id, detail.specText);
  if (state.selectedTab === "Evidence") return evidenceListPanel(item.id, detail);
  return provenancePanel(detail.provenance);
}

function evidencePanel(id, file, title, hint) {
  const content = state.evidenceText.get(`${id}/${file}`);
  if (content?.loading) return `<div class="panel-heading"><h2>${title}</h2><span class="panel-hint">${hint}</span></div><div class="empty-evidence">Loading evidence…</div>`;
  if (!content || content.error) return `<div class="panel-heading"><h2>${title}</h2><span class="panel-hint">${hint}</span></div><div class="empty-evidence">${escapeHtml(content?.error ?? "This file will appear when the work reaches that station.")}</div>`;
  return `<div class="panel-heading"><h2>${title}</h2><span class="panel-hint">${hint}</span></div><pre class="file-surface">${escapeHtml(content.text)}</pre>`;
}

function runsPanel(runs) {
  const rows = runs.length ? runs.map((run) => `<article class="run-row"><div><div class="run-stage">${escapeHtml(humanStage(run.stage))}</div><span class="run-role">${escapeHtml(run.role ?? "Control plane")}</span></div><div><span class="run-meta">${escapeHtml(formatDate(run.startedAt))}</span><span class="run-role">${escapeHtml(run.tokensUsed)} tokens · $${Number(run.usdUsed).toFixed(2)}</span></div><div><span class="run-meta">Sandbox</span><span class="run-role">${escapeHtml(run.sandboxId ?? "—")}</span></div><div class="run-result"><span class="status-badge status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run.status))}</span></div></article>`).join("") : '<div class="empty-evidence">Runs will appear here as the factory works.</div>';
  return `<div class="panel-heading"><h2>Station runs</h2><span class="panel-hint">${runs.length} RECORDED</span></div><div class="run-list">${rows}</div>`;
}

function reviewerPanel(id, specText) {
  const diff = state.evidenceText.get(`${id}/candidate.patch`);
  const verifiedOutput = state.evidenceText.get(`${id}/test-output.txt`);
  const test = verifiedOutput?.text ? verifiedOutput : state.evidenceText.get(`${id}/pre-review-test-output.txt`);
  const block = (title, value, loading, fallback) => `<section class="review-section"><h3>${title}</h3>${loading ? '<div class="empty-evidence">Loading…</div>' : value ? `<pre class="file-surface">${escapeHtml(value)}</pre>` : `<div class="empty-evidence">${escapeHtml(fallback)}</div>`}</section>`;
  return `<div class="panel-heading"><h2>Independent review</h2><span class="panel-hint">SPEC · DIFF · VERIFICATION ONLY</span></div>${block("Specification", specText, false, "Spec is unavailable")}${block("Candidate diff", diff?.text, diff?.loading, diff?.error ?? "Candidate diff is not available yet")}${block("Verification output", test?.text, test?.loading, test?.error ?? "Verification output is not available yet")}`;
}

function evidenceListPanel(id, detail) {
  const files = detail.evidenceFiles ?? [];
  const metadata = new Map((detail.evidence ?? []).map((entry) => [entry.file, entry]));
  const rows = files.map((file) => {
    const entry = metadata.get(file);
    return `<div class="evidence-row"><div><div class="evidence-name">${escapeHtml(file)}</div><span class="evidence-kind">${escapeHtml(entry?.kind ?? "Factory evidence")}${entry?.sha256 ? ` · sha256 ${escapeHtml(entry.sha256.slice(0, 12))}…` : ""}</span></div><button class="button button-quiet" data-evidence-file="${escapeHtml(file)}">View</button></div>`;
  }).join("");
  const loaded = state.evidenceText.get(`${id}/__selected`);
  return `<div class="panel-heading"><h2>Evidence</h2><span class="panel-hint">LOCAL, READ-ONLY FILES</span></div><div class="evidence-list">${rows || '<div class="empty-evidence">Evidence files appear as each station completes.</div>'}</div>${loaded ? `<section class="review-section" style="margin-top:20px"><h3>${escapeHtml(loaded.file)}</h3>${loaded.loading ? '<div class="empty-evidence">Loading…</div>' : loaded.error ? `<div class="empty-evidence">${escapeHtml(loaded.error)}</div>` : `<pre class="file-surface">${escapeHtml(loaded.text)}</pre>`}</section>` : ""}`;
}

function provenancePanel(provenance) {
  if (!provenance) return `<div class="panel-heading"><h2>Provenance</h2><span class="panel-hint">CHAIN OF CUSTODY</span></div><div class="empty-evidence">Provenance is written after the merge gate is approved and the local draft bundle is packaged.</div>`;
  return `<div class="panel-heading"><h2>Provenance</h2><span class="panel-hint">HOST PATHS OMITTED</span></div><pre class="file-surface">${escapeHtml(JSON.stringify(provenance, null, 2))}</pre>`;
}

async function loadEvidence(file) {
  const id = selectedId();
  if (!id) return;
  const key = `${id}/${file}`;
  const existing = state.evidenceText.get(key);
  if (existing && !existing.error) return;
  state.evidenceText.set(key, { loading: true });
  render();
  try {
    const response = await fetch(`/api/work/${encodeURIComponent(id)}/evidence/${encodeURIComponent(file)}`, { cache: "no-store" });
    const text = await response.text();
    if (!response.ok) throw new Error(text ? (() => { try { return JSON.parse(text).error ?? text; } catch { return text; } })() : `Request failed (${response.status})`);
    state.evidenceText.set(key, { text });
  } catch (error) {
    state.evidenceText.set(key, { error: error instanceof Error ? error.message : String(error) });
  }
  render();
}

async function performAction(path, body) {
  state.busy = true;
  render();
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    clearError();
    state.evidenceText.clear();
    state.fingerprint = "";
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    state.fingerprint = "";
  } finally {
    state.busy = false;
    await refresh();
  }
}

function openJob() {
  modal.hidden = false;
  document.querySelector("#job-prompt").focus();
}

function closeJob() {
  modal.hidden = true;
}

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const action = target.closest("[data-action]")?.getAttribute("data-action");
  if (action === "new-job") openJob();
  if (action === "close-job") closeJob();
  if (action === "dismiss-error") clearError();
  if (action === "back-board") location.hash = "";

  const card = target.closest("[data-open-work]");
  if (card) {
    state.selectedTab = "Spec";
    state.evidenceText.clear();
    location.hash = `work/${card.getAttribute("data-open-work")}`;
  }

  const tab = target.closest("[data-tab]");
  if (tab) {
    state.selectedTab = tab.getAttribute("data-tab") ?? "Spec";
    state.fingerprint = "";
    render();
    if (state.selectedTab === "Plan") await loadEvidence("plan.md");
    if (state.selectedTab === "Reviewer") {
      await Promise.all([loadEvidence("candidate.patch"), loadEvidence("test-output.txt")]);
      if (!state.evidenceText.get(`${selectedId()}/test-output.txt`)?.text) await loadEvidence("pre-review-test-output.txt");
    }
  }

  const evidenceButton = target.closest("[data-evidence-file]");
  if (evidenceButton) {
    const file = evidenceButton.getAttribute("data-evidence-file");
    if (file) {
      state.evidenceText.set(`${selectedId()}/__selected`, { file, loading: true });
      await loadEvidence(file);
      const loaded = state.evidenceText.get(`${selectedId()}/${file}`);
      state.evidenceText.set(`${selectedId()}/__selected`, { file, ...(loaded ?? { error: "Evidence unavailable" }) });
      state.fingerprint = "";
      render();
    }
  }

  const gateButton = target.closest("[data-gate-action]");
  if (gateButton && !state.busy) {
    const decision = gateButton.getAttribute("data-gate-action");
    const gate = gateButton.getAttribute("data-gate");
    const body = { gate };
    if (decision === "reject") {
      const reason = window.prompt(`Why reject the ${gate} gate?`, "Needs changes");
      if (!reason?.trim()) return;
      body.reason = reason.trim();
    }
    await performAction(`/api/work/${encodeURIComponent(selectedId())}/${decision}`, body);
  }

  if (target.closest('[data-item-action="resume"]') && !state.busy) {
    await performAction(`/api/work/${encodeURIComponent(selectedId())}/resume`, {});
  }
});

document.addEventListener("keydown", (event) => {
  const card = event.target instanceof Element ? event.target.closest("[data-open-work]") : null;
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    location.hash = `work/${card.getAttribute("data-open-work")}`;
  }
  if (event.key === "Escape" && !modal.hidden) closeJob();
});

document.querySelector("#job-kind").addEventListener("change", (event) => {
  const example = event.target.value === "example";
  document.querySelector("#prompt-field-wrap").hidden = example;
  document.querySelector("#example-field-wrap").hidden = !example;
  document.querySelector("#create-job-button").innerHTML = example ? 'Seed example <span aria-hidden="true">→</span>' : 'Create job <span aria-hidden="true">→</span>';
});

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#create-job-button");
  button.disabled = true;
  const kind = document.querySelector("#job-kind").value;
  try {
    const result = kind === "example"
      ? await api("/api/seed", { method: "POST", body: JSON.stringify({ specPath: "specs/EXAMPLE.md" }) })
      : await api("/api/run", { method: "POST", body: JSON.stringify({ prompt: document.querySelector("#job-prompt").value }) });
    closeJob();
    jobForm.reset();
    document.querySelector("#prompt-field-wrap").hidden = false;
    document.querySelector("#example-field-wrap").hidden = true;
    state.selectedTab = "Spec";
    state.evidenceText.clear();
    clearError();
    location.hash = `work/${result.item.id}`;
    state.fingerprint = "";
    await refresh();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  state.selectedTab = "Spec";
  state.evidenceText.clear();
  state.detail = null;
  state.fingerprint = "";
  void refresh();
});

void refresh();
window.setInterval(() => { void refresh(); }, 1000);

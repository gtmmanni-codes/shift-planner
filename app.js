(() => {
  "use strict";

  const STORAGE_KEY = "shiftPlannerData";
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const NAV_ITEMS = [
    { id: "log", label: "Log shift", mark: "+" },
    { id: "best", label: "Best times", mark: "↗" },
    { id: "week", label: "My week", mark: "▦" },
    { id: "history", label: "History", mark: "≡" },
    { id: "settings", label: "Settings", mark: "settings" }
  ];
  const CURRENCIES = ["EUR", "GBP", "USD", "PLN", "CHF"];

  const main = document.querySelector("#app-main");
  const nav = document.querySelector("#bottom-nav");
  const toast = document.querySelector("#toast");
  const storageNotice = document.querySelector("#storage-notice");

  let state = defaultState();
  let currentScreen = "log";
  let editingShiftId = null;
  let historyPlatform = "all";
  let toastTimer = null;
  let pendingUndo = null;
  let storageAvailable = true;

  function defaultState() {
    return {
      setupComplete: false,
      profile: { name: "", city: "", currency: "EUR", platforms: [] },
      slots: [
        { id: "lunch", name: "Lunch", start: 11, end: 14 },
        { id: "afternoon", name: "Afternoon", start: 14, end: 17 },
        { id: "dinner", name: "Dinner", start: 17, end: 21 },
        { id: "late", name: "Late", start: 21, end: 1 }
      ],
      shifts: [],
      plans: []
    };
  }

  // Keep the rider's information only in this browser.
  function readStoredState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return defaultState();
      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== "object" || !parsed.profile || !Array.isArray(parsed.slots)
        || !Array.isArray(parsed.shifts) || !Array.isArray(parsed.plans)) {
        throw new Error("Saved Shift Planner data has an unexpected format.");
      }
      return {
        ...defaultState(),
        ...parsed,
        profile: { ...defaultState().profile, ...parsed.profile },
        slots: parsed.slots,
        shifts: parsed.shifts,
        plans: parsed.plans
      };
    } catch (error) {
      storageAvailable = false;
      storageNotice.textContent = error instanceof Error && error.name !== "SyntaxError"
        ? `${error.message} Your existing data was not changed.`
        : "Saved data could not be read. Changes can be tried in this session, but won't be saved.";
      storageNotice.hidden = false;
      return defaultState();
    }
  }

  function saveState(message, undoCallback = null) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
      storageNotice.hidden = true;
      if (message) showToast(message, undoCallback);
      return true;
    } catch (error) {
      storageAvailable = false;
      storageNotice.textContent = `Your browser couldn't save this change (${error.message}). The data is visible for this session only.`;
      storageNotice.hidden = false;
      if (message) showToast(`${message}, but not saved`, undoCallback);
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function localDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseLocalDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function formatDate(value, options = { weekday: "short", day: "numeric", month: "short", year: "numeric" }) {
    return new Intl.DateTimeFormat(undefined, options).format(parseLocalDate(value));
  }

  function formatCurrency(amount, compact = false) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: state.profile.currency || "EUR",
      maximumFractionDigits: 0,
      notation: compact ? "compact" : "standard"
    }).format(Number(amount) || 0);
  }

  function formatNumber(value, digits = 1) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value);
  }

  function formatTime(hour) {
    const normalized = ((Number(hour) % 24) + 24) % 24;
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .format(new Date(2020, 0, 1, normalized));
  }

  function durationHours(slot) {
    return (Number(slot.end) - Number(slot.start) + 24) % 24 || 24;
  }

  function getWeekday(dateString) {
    return (parseLocalDate(dateString).getDay() + 6) % 7;
  }

  function getSlotForHour(hour) {
    const value = Number(hour);
    return state.slots.find((slot) => {
      const start = Number(slot.start);
      const end = Number(slot.end);
      return start < end ? value >= start && value < end : value >= start || value < end;
    }) || null;
  }

  // Earnings and order rates are weighted from the rider's logged hours only.
  function getStats(weekday, slotId) {
    const records = state.shifts.filter((shift) =>
      getWeekday(shift.date) === weekday && getSlotForHour(Number(shift.startTime.split(":")[0]))?.id === slotId);
    if (!records.length) return null;
    const totalHours = records.reduce((sum, shift) => sum + Number(shift.hours), 0);
    const totalEarned = records.reduce((sum, shift) => sum + Number(shift.earned), 0);
    const totalOrders = records.reduce((sum, shift) => sum + Number(shift.orders), 0);
    return {
      count: records.length,
      earningsPerHour: totalHours ? totalEarned / totalHours : 0,
      ordersPerHour: totalHours ? totalOrders / totalHours : 0,
      hours: totalHours
    };
  }

  function getAggregateStats(slotId) {
    const records = state.shifts.filter((shift) =>
      getSlotForHour(Number(shift.startTime.split(":")[0]))?.id === slotId);
    if (!records.length) return null;
    const hours = records.reduce((sum, shift) => sum + Number(shift.hours), 0);
    return {
      count: records.length,
      earningsPerHour: hours ? records.reduce((sum, shift) => sum + Number(shift.earned), 0) / hours : 0,
      ordersPerHour: hours ? records.reduce((sum, shift) => sum + Number(shift.orders), 0) / hours : 0
    };
  }

  function showToast(message, undoCallback = null) {
    window.clearTimeout(toastTimer);
    if (pendingUndo?.timer) window.clearTimeout(pendingUndo.timer);
    pendingUndo = null;
    toast.replaceChildren();
    const text = document.createElement("span");
    text.textContent = message;
    toast.append(text);
    if (undoCallback) {
      const undoButton = document.createElement("button");
      undoButton.type = "button";
      undoButton.textContent = "Undo";
      undoButton.addEventListener("click", () => {
        window.clearTimeout(pendingUndo?.timer);
        const undo = pendingUndo?.callback;
        pendingUndo = null;
        toast.hidden = true;
        if (undo) undo();
      }, { once: true });
      toast.append(undoButton);
      pendingUndo = {
        callback: undoCallback,
        timer: window.setTimeout(() => {
          pendingUndo = null;
          toast.hidden = true;
        }, 6000)
      };
    } else {
      toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
    }
    toast.hidden = false;
  }

  function setScreen(screen) {
    currentScreen = screen;
    editingShiftId = null;
    render();
  }

  function heading(title, description, eyebrow = "Your shift planner") {
    return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="subheading">${escapeHtml(description)}</p></div></div>`;
  }

  function emptyState(title, message, sampleButton = true) {
    return `<div class="empty-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>
      ${sampleButton ? '<button class="button secondary" type="button" data-action="load-sample">Load sample data</button>' : ""}</div>`;
  }

  function render() {
    const setup = !state.setupComplete;
    nav.hidden = setup || !storageAvailable && !state.setupComplete;
    if (setup) {
      main.innerHTML = renderSetup();
    } else {
      nav.hidden = false;
      main.innerHTML = ({
        log: renderLog,
        best: renderBest,
        week: renderWeek,
        history: renderHistory,
        settings: renderSettings
      }[currentScreen] || renderLog)();
    }
    renderNav();
  }

  function renderNav() {
    if (!state.setupComplete) {
      nav.hidden = true;
      return;
    }
    nav.innerHTML = NAV_ITEMS.map((item) =>
      `<button class="nav-button" type="button" data-screen="${item.id}" aria-current="${currentScreen === item.id ? "page" : "false"}">
        <span class="nav-icon" aria-hidden="true">${navIcon(item.mark)}</span><span>${item.label}</span>
      </button>`).join("");
  }

  function navIcon(mark) {
    const paths = {
      "+": '<path d="M12 5v14M5 12h14"/>',
      "↗": '<path d="M7 17 17 7M8 7h9v9"/>',
      "▦": '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
      "≡": '<path d="M5 7h14M5 12h14M5 17h14"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a7.8 7.8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a7.8 7.8 0 0 1-1.8-1l-1.7.7-1.4-2.4 1.4-1.1a7.4 7.4 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.7a7.8 7.8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a7.8 7.8 0 0 1 1.8 1l1.7-.7 1.4 2.4-1.4 1.1a7.4 7.4 0 0 1 0 2Z"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[mark]}</svg>`;
  }

  function renderSetup() {
    return `<section class="setup-wrap screen" aria-labelledby="setup-title">
      <div class="card setup-card">
        <p class="eyebrow">A useful start, on your terms</p>
        <h1 id="setup-title">Make your shifts work for you.</h1>
        <p class="setup-intro">Keep a private log, learn from your own shifts, and plan the week ahead. No demand forecasts or outside data.</p>
        <form id="setup-form" class="form-grid" novalidate>
          ${textField("name", "First name (optional)", state.profile.name, "e.g. Alex", false)}
          ${textField("city", "City", state.profile.city, "Your city", false)}
          <div class="field"><label for="currency">Currency</label><select id="currency" name="currency">${currencyOptions()}</select></div>
          ${textField("platforms", "Platforms you work for", state.profile.platforms.join(", "), "e.g. Wolt, Uber Eats", false)}
          <p class="field-hint">Separate platform names with commas. You can change these later in Settings.</p>
          <p class="field-error" data-error="setup" aria-live="polite"></p>
          <button class="button" type="submit">Set up my planner</button>
        </form>
      </div>
    </section>`;
  }

  function currencyOptions(selected = state.profile.currency) {
    return CURRENCIES.map((currency) =>
      `<option value="${currency}" ${currency === selected ? "selected" : ""}>${currency}</option>`).join("");
  }

  function textField(name, label, value, placeholder = "", required = false, type = "text") {
    return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${required ? "required" : ""}></div>`;
  }

  function renderLog() {
    const edit = state.shifts.find((shift) => shift.id === editingShiftId);
    const platforms = state.profile.platforms;
    const today = localDateString();
    const date = edit?.date || today;
    const time = edit?.startTime || "18:00";
    const hours = edit?.hours ?? 3;
    const orders = edit?.orders ?? 0;
    const earned = edit?.earned ?? "";
    const platform = edit?.platform || platforms[0] || "";
    const waitMinutes = edit?.waitMinutes ?? "";
    return `<section class="screen">
      ${heading(edit ? "Edit your shift" : "Log a shift", "A quick record is all it takes to start spotting your own patterns.", edit ? "Update a shift" : "Build your own picture")}
      <div class="grid grid-two">
        <form id="shift-form" class="card form-grid" novalidate>
          <input type="hidden" name="shiftId" value="${escapeHtml(edit?.id || "")}">
          <div class="field"><label for="shift-date">Date</label><input id="shift-date" name="date" type="date" value="${escapeHtml(date)}" required><p class="field-error" data-error="date"></p></div>
          <div class="field"><label for="shift-time">Start time</label><input id="shift-time" name="startTime" type="time" value="${escapeHtml(time)}" required><p class="field-error" data-error="startTime"></p></div>
          <div class="field"><label for="shift-hours">Hours worked</label><input id="shift-hours" name="hours" type="number" min="0.5" max="16" step="0.5" value="${escapeHtml(hours)}" required aria-describedby="hours-hint hours-error"><p class="field-hint" id="hours-hint">Between 0.5 and 16 hours.</p><p class="field-error" id="hours-error" data-error="hours"></p></div>
          <div class="field"><label for="shift-orders">Orders</label><input id="shift-orders" name="orders" type="number" min="0" step="1" value="${escapeHtml(orders)}" required><p class="field-error" data-error="orders"></p></div>
          <div class="field"><label for="shift-earned">Total earned (${escapeHtml(state.profile.currency)})</label><input id="shift-earned" name="earned" type="number" min="0" step="0.01" value="${escapeHtml(earned)}" required><p class="field-error" data-error="earned"></p></div>
          <div class="field"><label for="shift-platform">Platform</label>
            <select id="shift-platform" name="platform" required ${platforms.length ? "" : "disabled"}>
              ${platforms.length ? platforms.map((item) => `<option value="${escapeHtml(item)}" ${item === platform ? "selected" : ""}>${escapeHtml(item)}</option>`).join("") : '<option value="">Add a platform in Settings first</option>'}
            </select><p class="field-error" data-error="platform"></p>
          </div>
          <div class="field"><label for="shift-wait">Waiting with no orders (minutes, optional)</label><input id="shift-wait" name="waitMinutes" type="number" min="0" step="1" value="${escapeHtml(waitMinutes)}" placeholder="Leave blank if unknown"><p class="field-error" data-error="waitMinutes"></p></div>
          <p class="field-error" data-error="form" aria-live="polite"></p>
          <div class="form-actions"><button class="button" type="submit">${edit ? "Save changes" : "Save shift"}</button><button class="button secondary" type="button" data-action="cancel-entry">Cancel</button></div>
        </form>
        <div class="stack">
          ${state.shifts.length ? `<div class="card"><h2>Your log so far</h2><div class="metric-row">
            <div class="metric"><span>Shifts logged</span><strong>${state.shifts.length}</strong></div>
            <div class="metric"><span>Hours worked</span><strong>${formatNumber(state.shifts.reduce((sum, shift) => sum + Number(shift.hours), 0))}</strong></div>
          </div></div>` : emptyState("Your shift history starts here", "After a few shifts, compare your own earnings across times and plan from your personal averages.", true)}
        </div>
      </div>
    </section>`;
  }

  function renderBest() {
    if (!state.shifts.length) {
      return `<section class="screen">${heading("Best times", "See how your own earnings and orders vary by weekday and time slot.")}${emptyState("Your patterns will show here", "Log shifts on different days and at different times. This screen uses only your saved shifts—there are no demand predictions.")}</section>`;
    }

    const stats = [];
    for (let day = 0; day < 7; day += 1) {
      for (const slot of state.slots) {
        const stat = getStats(day, slot.id);
        if (stat) stats.push({ ...stat, day, slot });
      }
    }
    const values = stats.map((item) => item.earningsPerHour);
    const max = Math.max(...values, 0);
    const cells = WEEKDAYS.map((dayName, day) => {
      const dayRows = state.slots.map((slot) => {
        const stat = getStats(day, slot.id);
        const level = stat ? (max === 0 ? 1 : Math.max(1, Math.ceil((stat.earningsPerHour / max) * 3))) : 0;
        return `<div class="heat-cell ${stat ? `heat-${level}` : ""}" aria-label="${escapeHtml(dayName)}, ${escapeHtml(slot.name)}: ${stat ? `${formatCurrency(stat.earningsPerHour)} per hour, ${stat.count} shifts` : "no shifts logged"}">
          <strong>${stat ? formatCurrency(stat.earningsPerHour) : "—"}</strong><span>${stat ? `${stat.count} shift${stat.count === 1 ? "" : "s"}` : "No data"}</span>
        </div>`;
      });
      return { dayName, dayRows };
    });
    const ranked = stats.slice().sort((a, b) => b.earningsPerHour - a.earningsPerHour).slice(0, 3);
    const insight = buildInsight(stats);
    return `<section class="screen">
      ${heading("Best times", "Compare your average hourly earnings by weekday and time slot. Results come only from the shifts you log.")}
      <div class="stack">
        ${insight ? `<p class="insight">${escapeHtml(insight)}</p>` : ""}
        <section class="card" aria-labelledby="heat-title">
          <div class="section-title"><h2 id="heat-title">Average earnings per hour</h2><span class="heat-legend"><span class="legend-chip"></span>More in your log</span></div>
          <div class="heatmap-wrap"><div class="heatmap" role="table" aria-label="Average earnings by weekday and time slot">
            <div class="heatmap-head" role="columnheader">Time slot</div>${WEEKDAYS.map((day) => `<div class="heatmap-head" role="columnheader">${day.slice(0, 3)}</div>`).join("")}
            ${state.slots.map((slot) => `<div class="heatmap-label" role="rowheader">${escapeHtml(slot.name)}</div>${cells.map((row) => `<div role="cell">${row.dayRows[state.slots.indexOf(slot)]}</div>`).join("")}`).join("")}
          </div></div>
          <p class="small muted">A dash means you haven't logged a shift in that slot yet.</p>
        </section>
        <section class="card" aria-labelledby="top-slots-title">
          <div class="section-title"><h2 id="top-slots-title">Top 3 slots</h2></div>
          ${ranked.length ? `<ol class="slot-list">${ranked.map((item, index) => `<li class="slot-row">
            <span class="rank">${index + 1}</span><div><h3>${WEEKDAYS[item.day]} · ${escapeHtml(item.slot.name)}</h3>
            <div class="slot-stats"><span>${formatCurrency(item.earningsPerHour)} / hour</span><span>${formatNumber(item.ordersPerHour)} orders / hour</span><span>${item.count} shift${item.count === 1 ? "" : "s"}</span></div>
            ${item.count < 3 ? '<span class="confidence">Few shifts, low confidence</span>' : ""}</div></li>`).join("")}</ol>` : '<p class="muted">Log more shifts to see your top slots.</p>'}
        </section>
      </div>
    </section>`;
  }

  function buildInsight(stats) {
    const ranked = stats.filter((item) => item.count >= 3).sort((a, b) => b.earningsPerHour - a.earningsPerHour);
    if (!ranked.length) return "";
    const top = ranked[0];
    const others = stats.filter((item) => item !== top);
    if (!others.length) return "";
    const otherAverage = others.reduce((sum, item) => sum + item.earningsPerHour, 0) / others.length;
    if (otherAverage <= 0 || top.earningsPerHour <= otherAverage) return "";
    const percent = Math.round(((top.earningsPerHour - otherAverage) / otherAverage) * 100);
    return `Your ${WEEKDAYS[top.day]} ${top.slot.name.toLowerCase()} shifts average ${formatCurrency(top.earningsPerHour)} per hour, about ${percent}% above your other logged slots (${top.count} shifts).`;
  }

  function upcomingMonday() {
    const today = new Date();
    const daysUntil = 8 - (today.getDay() || 7);
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysUntil, 12);
    return monday;
  }

  function dateOffset(date, offset) {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12);
    return localDateString(next);
  }

  function planKey(date, slotId) {
    return `${date}:${slotId}`;
  }

  function renderWeek() {
    if (!state.shifts.length) {
      return `<section class="screen">${heading("My week", "Tap the time slots you'd like to work next week. Estimates appear only when your shifts give us enough data.")}${emptyState("Plan from your own experience", "Log some shifts first. Slots with no matching weekday and time-slot data will stay marked as unknown.")}</section>`;
    }
    const monday = upcomingMonday();
    const days = Array.from({ length: 7 }, (_, index) => dateOffset(monday, index));
    let plannedHours = 0;
    let estimatedEarnings = 0;
    let unknownCount = 0;
    let plannedCount = 0;
    const dayCards = days.map((date) => {
      const weekday = getWeekday(date);
      const planSlots = state.slots.map((slot) => {
        const selected = state.plans.some((plan) => plan.date === date && plan.slotId === slot.id);
        const stat = getStats(weekday, slot.id);
        if (selected) {
          plannedCount += 1;
          const hours = durationHours(slot);
          plannedHours += hours;
          if (stat) estimatedEarnings += stat.earningsPerHour * hours;
          else unknownCount += 1;
        }
        return `<button type="button" class="plan-slot" data-action="toggle-plan" data-date="${date}" data-slot="${escapeHtml(slot.id)}" aria-pressed="${selected}">
          <strong>${escapeHtml(slot.name)} · ${formatTime(slot.start)}–${formatTime(slot.end)}</strong>
          <span>${stat ? `${formatCurrency(stat.earningsPerHour)} / hour · ${stat.count} past shift${stat.count === 1 ? "" : "s"}` : "Unknown · no matching shifts"}</span>
          <span>${selected ? "Planned" : "Tap to plan"}</span>
        </button>`;
      }).join("");
      return `<article class="day-card"><div class="day-heading"><h2>${WEEKDAYS[weekday]}</h2><time datetime="${date}">${formatDate(date, { day: "numeric", month: "short" })}</time></div><div class="plan-slots">${planSlots}</div></article>`;
    }).join("");
    const knownCount = plannedCount - unknownCount;
    const summary = plannedCount
      ? `<strong>${plannedCount} planned slot${plannedCount === 1 ? "" : "s"} · ${formatNumber(plannedHours)} estimated hours</strong><p>${knownCount ? `Estimated earnings from your logged averages: ${formatCurrency(estimatedEarnings)}.` : ""}${unknownCount ? `${knownCount ? " " : ""}${unknownCount} planned slot${unknownCount === 1 ? " is" : "s are"} unknown because there's no matching logged data. These aren't counted as zero.` : ""}</p>`
      : "<strong>No slots planned yet</strong><p>Choose any time slots above to see estimated hours and, where your own history allows, estimated earnings.</p>";
    return `<section class="screen">
      ${heading("My week", `Plan the week starting ${formatDate(days[0], { day: "numeric", month: "long", year: "numeric" })}. Estimates use your own logged shifts, not predicted demand.`)}
      <div class="week-list">${dayCards}</div><div class="week-summary" aria-live="polite">${summary}</div>
    </section>`;
  }

  function renderHistory() {
    const shifts = state.shifts.filter((shift) => historyPlatform === "all" || shift.platform === historyPlatform)
      .slice().sort((a, b) => `${b.date}T${b.startTime}`.localeCompare(`${a.date}T${a.startTime}`));
    return `<section class="screen">
      ${heading("History", "Review, edit, or export the shifts you've recorded.")}
      <section class="card">
        <div class="history-toolbar"><div class="field"><label for="history-platform">Filter by platform</label>
          <select class="filter-select" id="history-platform" name="historyPlatform">
            <option value="all" ${historyPlatform === "all" ? "selected" : ""}>All platforms</option>
            ${state.profile.platforms.map((platform) => `<option value="${escapeHtml(platform)}" ${historyPlatform === platform ? "selected" : ""}>${escapeHtml(platform)}</option>`).join("")}
          </select></div>
          <div class="button-row"><button type="button" class="button secondary" data-action="export-csv" ${shifts.length ? "" : "disabled"}>Export CSV</button>
          ${state.shifts.length ? '<button type="button" class="button ghost small-button" data-action="remove-sample">Remove sample data</button>' : ""}</div>
        </div>
        ${shifts.length ? `<div class="table-wrap"><table class="shift-table"><thead><tr><th>Date</th><th>Time</th><th>Hours</th><th>Orders</th><th>Earned</th><th>Platform</th><th>Record</th><th>Actions</th></tr></thead><tbody>
          ${shifts.map((shift) => `<tr><td>${formatDate(shift.date)}</td><td>${escapeHtml(shift.startTime)}</td><td>${formatNumber(Number(shift.hours))}</td><td>${escapeHtml(shift.orders)}</td><td>${formatCurrency(shift.earned)}</td><td>${escapeHtml(shift.platform)}</td><td>${shift.sample ? "Sample data" : "Your log"}</td><td><div class="table-actions">
            <button type="button" class="button secondary small-button" data-action="edit-shift" data-id="${escapeHtml(shift.id)}">Edit</button>
            <button type="button" class="button danger small-button" data-action="delete-shift" data-id="${escapeHtml(shift.id)}" aria-label="Delete shift on ${formatDate(shift.date)}">Delete</button>
          </div></td></tr>`).join("")}</tbody></table></div>` :
          emptyState("No shifts match this filter", state.shifts.length ? "Choose another platform or view all platforms." : "Save a shift to start your history. You can also add clearly labelled sample data and remove it any time.", !state.shifts.length)}
      </section>
    </section>`;
  }

  function renderSettings() {
    const profile = state.profile;
    return `<section class="screen">
      ${heading("Settings", "Keep your details, platforms, and time slots up to date.")}
      <div class="stack">
        <form id="settings-form" class="card form-grid" novalidate>
          <h2>Profile</h2>
          ${textField("name", "First name (optional)", profile.name, "Your first name")}
          ${textField("city", "City", profile.city, "Your city")}
          <div class="field"><label for="settings-currency">Currency</label><select id="settings-currency" name="currency">${currencyOptions()}</select></div>
          ${textField("platforms", "Platforms (comma-separated)", profile.platforms.join(", "), "e.g. Wolt, Uber Eats")}
          <p class="field-error" data-error="settings" aria-live="polite"></p>
          <div class="form-actions"><button class="button" type="submit">Save settings</button><button class="button secondary" type="button" data-action="cancel-settings">Cancel</button></div>
        </form>
        <form id="slots-form" class="card" novalidate>
          <div class="section-title"><div><h2>Time slots</h2><p class="small muted">Choose a name and start/end hours. Overnight slots are supported.</p></div>
            <button class="button secondary small-button" type="button" data-action="add-slot">Add slot</button></div>
          <div id="slot-settings">${state.slots.map((slot) => renderSlotSetting(slot)).join("")}</div>
          <p class="field-error" data-error="slots" aria-live="polite"></p>
          <div class="form-actions"><button class="button" type="submit">Save time slots</button><button class="button secondary" type="button" data-action="cancel-settings">Cancel</button></div>
        </form>
        <section class="card">
          <div class="section-title"><h2>Sample data</h2></div>
          <p class="small muted">Sample shifts are clearly labelled and can be removed with one click. Adding them mixes them into your history and averages.</p>
          <div class="button-row"><button class="button secondary" type="button" data-action="load-sample">Load sample data</button><button class="button ghost" type="button" data-action="remove-sample">Remove sample data</button></div>
        </section>
        <section class="card danger-zone">
          <h2>Clear all data</h2><p class="small muted">Remove your profile, platforms, time slots, plans, and every saved shift from this browser.</p>
          <button class="button danger" type="button" data-action="clear-data">Clear all data</button>
        </section>
      </div>
    </section>`;
  }

  function renderSlotSetting(slot) {
    return `<div class="slot-setting" data-slot-row="${escapeHtml(slot.id)}">
      <div class="field"><label for="slot-name-${escapeHtml(slot.id)}">Slot name</label><input id="slot-name-${escapeHtml(slot.id)}" name="slotName" value="${escapeHtml(slot.name)}" required></div>
      <div class="field"><label for="slot-start-${escapeHtml(slot.id)}">Start hour</label><input id="slot-start-${escapeHtml(slot.id)}" name="slotStart" type="number" min="0" max="23" step="1" value="${escapeHtml(slot.start)}" required></div>
      <div class="field"><label for="slot-end-${escapeHtml(slot.id)}">End hour</label><input id="slot-end-${escapeHtml(slot.id)}" name="slotEnd" type="number" min="0" max="23" step="1" value="${escapeHtml(slot.end)}" required></div>
      <button type="button" class="button danger small-button remove-slot" data-action="remove-slot" data-id="${escapeHtml(slot.id)}" aria-label="Remove ${escapeHtml(slot.name)} time slot">Remove</button>
    </div>`;
  }

  function validateShift(formData) {
    const errors = {};
    const date = formData.get("date");
    const startTime = formData.get("startTime");
    const hours = Number(formData.get("hours"));
    const ordersValue = formData.get("orders");
    const orders = Number(formData.get("orders"));
    const earnedValue = formData.get("earned");
    const earned = Number(earnedValue);
    const waitValue = formData.get("waitMinutes");
    const waitMinutes = waitValue === "" ? null : Number(waitValue);
    const platform = String(formData.get("platform") || "");
    if (!date || Number.isNaN(parseLocalDate(date).getTime())) errors.date = "Choose a valid date.";
    if (!startTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) errors.startTime = "Enter a valid start time.";
    if (!Number.isFinite(hours) || hours < 0.5 || hours > 16) errors.hours = "Hours must be between 0.5 and 16.";
    if (ordersValue === "" || !Number.isInteger(orders) || orders < 0) errors.orders = "Enter a whole number of 0 or more orders.";
    if (earnedValue === "" || !Number.isFinite(earned) || earned < 0) errors.earned = "Enter earnings of 0 or more.";
    if (waitMinutes !== null && (!Number.isInteger(waitMinutes) || waitMinutes < 0)) errors.waitMinutes = "Enter 0 or more whole minutes.";
    if (!state.profile.platforms.includes(platform)) errors.platform = "Choose one of your saved platforms.";
    return { errors, record: { date, startTime, hours, orders, earned, platform, waitMinutes } };
  }

  function showFormErrors(form, errors) {
    form.querySelectorAll("[data-error]").forEach((node) => { node.textContent = ""; });
    for (const [field, message] of Object.entries(errors)) {
      const target = form.querySelector(`[data-error="${field}"]`);
      if (target) target.textContent = message;
      const input = form.elements.namedItem(field);
      if (input instanceof HTMLElement) input.setAttribute("aria-invalid", "true");
    }
    const firstError = Object.keys(errors)[0];
    const firstInput = firstError && form.elements.namedItem(firstError);
    if (firstInput instanceof HTMLElement) firstInput.focus();
  }

  function normalizePlatforms(value) {
    return [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
  }

  function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function handleSetup(form) {
    const data = new FormData(form);
    const platforms = normalizePlatforms(data.get("platforms"));
    if (!platforms.length) {
      const error = form.querySelector('[data-error="setup"]');
      error.textContent = "Add at least one platform so you can select it when logging a shift.";
      form.elements.namedItem("platforms").focus();
      return;
    }
    state.profile = {
      name: String(data.get("name")).trim(),
      city: String(data.get("city")).trim(),
      currency: String(data.get("currency")),
      platforms
    };
    state.setupComplete = true;
    currentScreen = "log";
    saveState("Your planner is ready");
    render();
  }

  function handleShiftSubmit(form) {
    const validation = validateShift(new FormData(form));
    if (Object.keys(validation.errors).length) {
      showFormErrors(form, validation.errors);
      return;
    }
    const id = String(new FormData(form).get("shiftId") || "");
    if (id) {
      state.shifts = state.shifts.map((shift) => shift.id === id ? { ...validation.record, id, sample: false } : shift);
      editingShiftId = null;
      saveState("Shift updated");
    } else {
      state.shifts.push({ ...validation.record, id: makeId(), sample: false });
      saveState("Shift saved");
    }
    render();
  }

  function handleSettingsSubmit(form) {
    const data = new FormData(form);
    const updatedProfile = {
      name: String(data.get("name")).trim(),
      city: String(data.get("city")).trim(),
      currency: String(data.get("currency")),
      platforms: normalizePlatforms(data.get("platforms"))
    };
    if (!updatedProfile.platforms.length) {
      showFormErrors(form, { settings: "Add at least one platform to keep logging shifts." });
      return;
    }
    const removedPlatform = state.shifts.find((shift) => !updatedProfile.platforms.includes(shift.platform));
    if (removedPlatform) {
      showFormErrors(form, { settings: `“${removedPlatform.platform}” is used by a saved shift. Edit or delete those shifts before removing this platform.` });
      return;
    }
    state.profile = updatedProfile;
    saveState("Settings saved");
    render();
  }

  function handleSlotsSubmit(form) {
    const rows = [...form.querySelectorAll("[data-slot-row]")];
    const errors = [];
    const slots = rows.map((row) => {
      const id = row.dataset.slotRow;
      const name = row.querySelector('[name="slotName"]').value.trim();
      const start = Number(row.querySelector('[name="slotStart"]').value);
      const end = Number(row.querySelector('[name="slotEnd"]').value);
      if (!name || !Number.isInteger(start) || start < 0 || start > 23 || !Number.isInteger(end) || end < 0 || end > 23 || start === end) {
        errors.push(`${name || "Each slot"} needs a name and different whole start/end hours from 0 to 23.`);
      }
      return { id, name, start, end };
    });
    const names = slots.map((slot) => slot.name.toLowerCase());
    if (new Set(names).size !== names.length) errors.push("Each time slot needs a unique name.");
    if (errors.length || !slots.length) {
      const error = form.querySelector('[data-error="slots"]');
      error.textContent = errors[0] || "Keep at least one time slot.";
      return;
    }
    const occupiedHours = new Set();
    for (const slot of slots) {
      for (let hour = slot.start; hour !== slot.end; hour = (hour + 1) % 24) {
        if (occupiedHours.has(hour)) {
          form.querySelector('[data-error="slots"]').textContent = "Time slots cannot overlap. Change their start or end hours.";
          return;
        }
        occupiedHours.add(hour);
      }
    }
    state.slots = slots;
    saveState("Time slots saved");
    render();
  }

  function togglePlan(date, slotId) {
    const previous = state.plans;
    const exists = previous.some((plan) => plan.date === date && plan.slotId === slotId);
    state.plans = exists
      ? previous.filter((plan) => !(plan.date === date && plan.slotId === slotId))
      : [...previous, { date, slotId }];
    saveState(exists ? "Slot removed from your plan" : "Slot added to your plan");
    render();
  }

  function deleteShift(id) {
    const removed = state.shifts.find((shift) => shift.id === id);
    if (!removed) return;
    state.shifts = state.shifts.filter((shift) => shift.id !== id);
    saveState("Shift deleted", () => {
      state.shifts.push(removed);
      saveState("Shift restored");
      render();
    });
    render();
  }

  function sampleShifts() {
    const today = new Date();
    const samples = [];
    const templates = [
      { offset: -8, time: "12:00", hours: 3, orders: 8, earned: 39, platformIndex: 0 },
      { offset: -15, time: "18:00", hours: 4, orders: 13, earned: 68, platformIndex: 0 },
      { offset: -22, time: "19:00", hours: 4, orders: 14, earned: 73, platformIndex: 0 },
      { offset: -29, time: "18:30", hours: 3.5, orders: 12, earned: 62, platformIndex: 0 },
      { offset: -11, time: "13:00", hours: 3, orders: 7, earned: 34, platformIndex: 0 },
      { offset: -18, time: "21:30", hours: 3, orders: 7, earned: 31, platformIndex: 0 },
      { offset: -25, time: "18:00", hours: 4, orders: 12, earned: 66, platformIndex: 0 },
      { offset: -32, time: "12:00", hours: 3, orders: 9, earned: 41, platformIndex: 0 }
    ];
    for (const template of templates) {
      const sampleDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + template.offset, 12);
      samples.push({
        id: makeId(),
        date: localDateString(sampleDate),
        startTime: template.time,
        hours: template.hours,
        orders: template.orders,
        earned: template.earned,
        platform: state.profile.platforms[template.platformIndex],
        waitMinutes: null,
        sample: true
      });
    }
    return samples;
  }

  function loadSampleData() {
    if (state.shifts.some((shift) => shift.sample)) {
      showToast("Sample shifts are already loaded");
      return;
    }
    const platforms = state.profile.platforms;
    if (!platforms.length) {
      showToast("Add a platform in Settings before loading sample data");
      return;
    }
    state.shifts.push(...sampleShifts());
    saveState("Sample shifts loaded");
    render();
  }

  function removeSampleData() {
    const samples = state.shifts.filter((shift) => shift.sample);
    if (!samples.length) {
      showToast("There is no sample data to remove");
      return;
    }
    state.shifts = state.shifts.filter((shift) => !shift.sample);
    const restoreSamples = () => {
      state.shifts.push(...samples);
      saveState("Sample data restored");
      render();
    };
    saveState("Sample data removed", restoreSamples);
    render();
  }

  function exportCsv() {
    const records = state.shifts.filter((shift) => historyPlatform === "all" || shift.platform === historyPlatform)
      .slice().sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
    if (!records.length) return;
    const headers = ["Date", "Start time", "Hours worked", "Orders", `Total earned (${state.profile.currency})`, "Platform", "Waiting minutes", "Sample data"];
    const rows = records.map((shift) => [
      shift.date, shift.startTime, shift.hours, shift.orders, shift.earned, shift.platform, shift.waitMinutes ?? "", shift.sample ? "Yes" : "No"
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `shift-planner-${localDateString()}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("CSV exported");
  }

  function csvCell(value) {
    const text = String(value ?? "");
      const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return /[",\r\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText;
  }

  function clearAllData() {
    if (!window.confirm("Clear your profile, all shifts, plans, and settings from this browser?")) return;
    const previous = JSON.parse(JSON.stringify(state));
    state = defaultState();
    try {
      localStorage.removeItem(STORAGE_KEY);
      storageAvailable = true;
      storageNotice.hidden = true;
    } catch (error) {
      storageAvailable = false;
      storageNotice.textContent = `Your data could not be cleared from browser storage (${error.message}).`;
      storageNotice.hidden = false;
    }
    render();
    showToast("All data cleared", () => {
      state = previous;
      saveState("Data restored");
      render();
    });
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.id === "setup-form") handleSetup(form);
    else if (form.id === "shift-form") handleShiftSubmit(form);
    else if (form.id === "settings-form") handleSettingsSubmit(form);
    else if (form.id === "slots-form") handleSlotsSubmit(form);
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.getAttribute("aria-invalid") === "true") {
      target.removeAttribute("aria-invalid");
      const error = target.closest(".field")?.querySelector(".field-error");
      if (error) error.textContent = "";
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.id === "history-platform") {
      historyPlatform = target.value;
      render();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action], [data-screen]") : null;
    if (!target) return;
    if (target.hasAttribute("data-screen")) {
      setScreen(target.getAttribute("data-screen"));
      return;
    }
    const action = target.getAttribute("data-action");
    if (action === "home") setScreen("log");
    else if (action === "cancel-entry") {
      editingShiftId = null;
      showToast("Entry cancelled");
      render();
    } else if (action === "cancel-settings") {
      showToast("Changes cancelled");
      render();
    } else if (action === "edit-shift") {
      editingShiftId = target.getAttribute("data-id");
      currentScreen = "log";
      render();
    } else if (action === "delete-shift") deleteShift(target.getAttribute("data-id"));
    else if (action === "toggle-plan") togglePlan(target.getAttribute("data-date"), target.getAttribute("data-slot"));
    else if (action === "load-sample") loadSampleData();
    else if (action === "remove-sample") removeSampleData();
    else if (action === "export-csv") exportCsv();
    else if (action === "clear-data") clearAllData();
    else if (action === "add-slot") {
      const form = document.querySelector("#slots-form");
      const newSlot = { id: `slot-${makeId()}`, name: "", start: 10, end: 12 };
      document.querySelector("#slot-settings").insertAdjacentHTML("beforeend", renderSlotSetting(newSlot));
      form.querySelector(`[data-slot-row="${newSlot.id}"] input[name="slotName"]`).focus();
      showToast("Time slot added; save your changes when ready");
    } else if (action === "remove-slot") {
      if (state.slots.length <= 1) {
        document.querySelector('[data-error="slots"]').textContent = "Keep at least one time slot.";
      } else {
        const row = target.closest("[data-slot-row]");
        row.remove();
        showToast("Time slot removed; save your changes when ready");
      }
    }
  });

  state = readStoredState();
  if (state.profile.currency && !CURRENCIES.includes(state.profile.currency)) {
    state.profile.currency = "EUR";
  }
  render();
})();

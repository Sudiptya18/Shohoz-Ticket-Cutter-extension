const fromEl = document.getElementById("from");
const toEl = document.getElementById("to");
const dateEl = document.getElementById("date");
const classEl = document.getElementById("seatClass");
const trainEl = document.getElementById("train");
const coachEl = document.getElementById("coach");
const retryEl = document.getElementById("retry");
const preferMiddleEl = document.getElementById("preferMiddle");
const seatCountEl = document.getElementById("seatCount");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const logEl = document.getElementById("log");
const pill = document.getElementById("runPill");
const trainHint = document.getElementById("trainHint");

let seatCount = 2;
let routeTrains = [];
let routeKey = "";
let fetchToken = 0;
let trainFetchTimer = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayISO() {
  return isoLocal(new Date());
}

function plusDaysISO(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

dateEl.min = todayISO();
dateEl.max = plusDaysISO(10);
if (!dateEl.value) dateEl.value = plusDaysISO(1);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function trainSource() {
  return routeTrains.slice();
}

function updateTrainHint(state, count) {
  if (!trainHint) return;
  if (state === "need") {
    trainHint.textContent = "Select From & To first";
  } else if (state === "loading") {
    trainHint.textContent = "Loading trains…";
  } else if (state === "ok") {
    trainHint.textContent = `${count} train(s) on this route`;
  } else if (state === "empty") {
    trainHint.textContent = "No trains found — check date/class";
  } else {
    trainHint.textContent = "Could not load trains";
  }
}

function bindCombo(input, kind) {
  const wrap = input.closest(".combo");
  const list = wrap.querySelector(".combo-list");
  let active = -1;

  const source = () => (kind === "station" ? STC_STATIONS : trainSource());

  function render(q) {
    if (kind === "train") {
      if (!fromEl.value.trim() || !toEl.value.trim()) {
        list.innerHTML = `<div class="empty">Select From and To first</div>`;
        list.hidden = false;
        return;
      }
      if (!routeTrains.length) {
        list.innerHTML = `<div class="empty">No trains for this route yet</div>`;
        list.hidden = false;
        return;
      }
    }
    const query = (q || "").trim().toLowerCase();
    const items = source().filter((s) => !query || s.toLowerCase().includes(query)).slice(0, 80);
    active = items.length ? 0 : -1;
    list.innerHTML = items.length
      ? items.map((s, i) => `<button type="button" class="opt${i === 0 ? " active" : ""}" data-i="${i}">${escapeHtml(s)}</button>`).join("")
      : `<div class="empty">No match</div>`;
    list.hidden = false;
  }

  input.addEventListener("focus", () => {
    if (kind === "train") refreshRouteTrains();
    render(input.value);
  });
  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    const opts = [...list.querySelectorAll(".opt")];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden) render(input.value);
      active = Math.min(opts.length - 1, active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
    } else if (e.key === "Enter") {
      if (!list.hidden && opts[active]) {
        e.preventDefault();
        input.value = opts[active].textContent;
        list.hidden = true;
        persist();
        if (kind === "station") scheduleTrainRefresh();
      }
    } else if (e.key === "Escape") {
      list.hidden = true;
    }
    opts.forEach((o, i) => o.classList.toggle("active", i === active));
    opts[active]?.scrollIntoView({ block: "nearest" });
  });

  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    input.value = opt.textContent;
    list.hidden = true;
    persist();
    if (kind === "station") scheduleTrainRefresh();
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) list.hidden = true;
  });
}

bindCombo(fromEl, "station");
bindCombo(toEl, "station");
bindCombo(trainEl, "train");

document.getElementById("swapBtn").addEventListener("click", () => {
  const a = fromEl.value;
  fromEl.value = toEl.value;
  toEl.value = a;
  trainEl.value = "";
  persist();
  scheduleTrainRefresh();
});

document.getElementById("seatMinus").addEventListener("click", () => {
  seatCount = Math.max(1, seatCount - 1);
  seatCountEl.textContent = String(seatCount);
  persist();
});
document.getElementById("seatPlus").addEventListener("click", () => {
  seatCount = Math.min(4, seatCount + 1);
  seatCountEl.textContent = String(seatCount);
  persist();
});

function setRunningUi(running, state) {
  startBtn.hidden = running;
  stopBtn.hidden = !running;
  startBtn.disabled = running;
  clearBtn.disabled = running;
  if (state === "done") {
    pill.textContent = "OTP";
    pill.className = "pill done";
  } else if (state === "error") {
    pill.textContent = "Error";
    pill.className = "pill err";
  } else if (running) {
    pill.textContent = "Running";
    pill.className = "pill run";
  } else {
    pill.textContent = "Idle";
    pill.className = "pill idle";
  }
}

function renderLogs(logs) {
  logEl.innerHTML = (logs || []).slice(-30).map((row) => {
    const t = row.time || "";
    return `<li><time>${escapeHtml(t)}</time>${escapeHtml(row.msg || "")}</li>`;
  }).join("");
  logEl.scrollTop = logEl.scrollHeight;
}

function collectConfig() {
  return STC.sanitizeConfig({
    from: fromEl.value,
    to: toEl.value,
    date: dateEl.value,
    seatClass: classEl.value,
    train: trainEl.value,
    coach: coachEl.value,
    seatCount,
    retry: retryEl.checked,
    preferMiddle: preferMiddleEl.checked
  });
}

function applyConfig(cfg) {
  const safe = STC.sanitizeConfig(cfg);
  fromEl.value = safe.from;
  toEl.value = safe.to;
  if (safe.date) dateEl.value = safe.date;
  if (STC.CLASSES.includes(safe.seatClass)) classEl.value = safe.seatClass;
  trainEl.value = safe.train;
  coachEl.value = safe.coach;
  seatCount = safe.seatCount;
  seatCountEl.textContent = String(seatCount);
  retryEl.checked = safe.retry;
  preferMiddleEl.checked = safe.preferMiddle;
}

async function persist() {
  const config = collectConfig();
  await chrome.storage.local.set({ config });
}

function scheduleTrainRefresh() {
  clearTimeout(trainFetchTimer);
  trainFetchTimer = setTimeout(() => refreshRouteTrains(), 350);
}

async function refreshRouteTrains(force) {
  const from = fromEl.value.trim();
  const to = toEl.value.trim();
  if (!from || !to) {
    routeTrains = [];
    routeKey = "";
    updateTrainHint("need");
    return;
  }

  const key = `${from}|${to}|${dateEl.value}|${classEl.value}`.toLowerCase();
  if (!force && key === routeKey && routeTrains.length) {
    updateTrainHint("ok", routeTrains.length);
    return;
  }

  const token = ++fetchToken;
  updateTrainHint("loading");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "STC_FETCH_TRAINS",
      from,
      to,
      date: dateEl.value,
      seatClass: classEl.value
    });
    if (token !== fetchToken) return;
    if (!res?.ok) {
      routeTrains = [];
      routeKey = key;
      updateTrainHint("err");
      return;
    }
    routeTrains = Array.isArray(res.trains) ? res.trains : [];
    routeKey = key;
    if (trainEl.value && !routeTrains.some((t) => t.toLowerCase() === trainEl.value.trim().toLowerCase())) {
      trainEl.value = "";
      persist();
    }
    updateTrainHint(routeTrains.length ? "ok" : "empty", routeTrains.length);
    await chrome.storage.local.set({ routeTrains, routeKey: key });
  } catch {
    if (token !== fetchToken) return;
    routeTrains = [];
    updateTrainHint("err");
  }
}

["from", "to", "date", "seatClass", "train", "coach", "retry", "preferMiddle"].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("change", () => {
    persist();
    if (id === "from" || id === "to" || id === "date" || id === "seatClass") scheduleTrainRefresh();
  });
  el.addEventListener("blur", persist);
});

clearBtn.addEventListener("click", async () => {
  fromEl.value = "";
  toEl.value = "";
  dateEl.value = plusDaysISO(1);
  classEl.value = "S_CHAIR";
  trainEl.value = "";
  coachEl.value = "";
  seatCount = 2;
  seatCountEl.textContent = "2";
  preferMiddleEl.checked = true;
  retryEl.checked = true;
  routeTrains = [];
  routeKey = "";
  updateTrainHint("need");
  await chrome.storage.local.set({
    config: collectConfig(),
    botLogs: [],
    routeTrains: [],
    routeKey: ""
  });
  renderLogs([]);
  setRunningUi(false, "idle");
});

startBtn.addEventListener("click", async () => {
  const config = collectConfig();
  const err = STC.validateConfig(config);
  if (err) {
    renderLogs([{ time: nowTime(), msg: err }]);
    return;
  }
  if (routeTrains.length && !routeTrains.some((t) => t.toLowerCase() === config.train.toLowerCase())) {
    renderLogs([{ time: nowTime(), msg: "Choose a train from the available route list." }]);
    return;
  }
  await chrome.storage.local.set({ config, botRunning: true, botState: "starting", botLogs: [] });
  setRunningUi(true);
  chrome.runtime.sendMessage({ type: "STC_START", config });
});

stopBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ botRunning: false, botState: "idle" });
  chrome.runtime.sendMessage({ type: "STC_STOP" });
  setRunningUi(false);
});

document.getElementById("clearLog").addEventListener("click", async () => {
  await chrome.storage.local.set({ botLogs: [] });
  renderLogs([]);
});

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "STC_STATUS") {
    setRunningUi(!!msg.running, msg.state);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.botLogs) renderLogs(changes.botLogs.newValue || []);
  if (changes.botRunning || changes.botState) {
    const running = changes.botRunning ? changes.botRunning.newValue : startBtn.hidden;
    const state = changes.botState ? changes.botState.newValue : "";
    setRunningUi(!!running && state !== "done" && state !== "idle", state);
    if (state === "done") setRunningUi(false, "done");
  }
  if (changes.routeTrains) {
    routeTrains = changes.routeTrains.newValue || [];
    updateTrainHint(routeTrains.length ? "ok" : "empty", routeTrains.length);
  }
});

chrome.storage.local.get(["config", "botRunning", "botState", "botLogs", "routeTrains", "routeKey"], (data) => {
  applyConfig(data.config);
  routeTrains = data.routeTrains || [];
  routeKey = data.routeKey || "";
  if (fromEl.value && toEl.value) {
    updateTrainHint(routeTrains.length ? "ok" : "need", routeTrains.length);
    scheduleTrainRefresh();
  } else {
    updateTrainHint("need");
  }
  renderLogs(data.botLogs || []);
  const running = !!data.botRunning && data.botState !== "done" && data.botState !== "idle";
  setRunningUi(running, data.botState);
});

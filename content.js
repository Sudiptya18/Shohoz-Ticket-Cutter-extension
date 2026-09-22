(() => {
  if (!STC?.isAllowedHost(location.hostname)) return;

  const MONTHS = STC.MONTHS;
  const RETRY_MS = 1400;

  let running = false;
  let config = null;
  let loopPromise = null;
  let purchaseClicked = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  async function log(msg) {
    const row = { time: nowTime(), msg };
    const { botLogs = [] } = await chrome.storage.local.get("botLogs");
    botLogs.push(row);
    await chrome.storage.local.set({ botLogs: botLogs.slice(-40) });
    updateHud(msg);
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  }

  function visible(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function clickEl(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
    return true;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc.set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitFor(fn, timeout = 20000, interval = 180) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!running) return null;
      const v = await fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function textOf(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function pageText() {
    return (document.body?.innerText || "").replace(/\s+/g, " ");
  }

  function dismissModals() {
    const agree = qsa("button").find((b) => /^i agree$/i.test(textOf(b)));
    if (agree) clickEl(agree);
    const close = qs(".btn-close-seat-layout");
    // do not close seat layout while cutting
    return !!agree;
  }

  function isOtpPage() {
    const t = pageText();
    if (qs(".otp-input-div, input[name*='otp' i], input[id*='otp' i], .otp-input")) return true;
    if (/\/otp|verify-otp|confirm.booking/i.test(location.href)) return true;
    if (/otp has been sent|enter otp|verify otp|one time password/i.test(t)) {
      if (qsa("input").some((i) => /otp|code|pin/i.test(`${i.id}${i.name}${i.placeholder}`)) || qsa("input[type='tel'], input[maxlength='1'], input[maxlength='4'], input[maxlength='6']").length) {
        return true;
      }
    }
    return false;
  }

  function isLoginPage() {
    return /\/login/i.test(location.pathname) || !!qs("app-login");
  }

  function isSearchFormPage() {
    return !!qs("#trainsearch, #dest_from") && !isSearchResultPage();
  }

  function isSearchResultPage() {
    return /\/booking\/train\/search/i.test(location.pathname) || !!qs("app-search-result, app-single-trip, .single-trip-wrapper");
  }

  function seatLayout() {
    const layout = qs("app-seat-layout, .seat_layout, .seat-layout-view");
    return layout && visible(layout) ? layout : null;
  }

  function formatDoJ(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${String(d).padStart(2, "0")}-${MONTHS[m - 1]}-${y}`;
  }

  function searchUrl(cfg) {
    const doj = formatDoJ(cfg.date);
    const params = new URLSearchParams({
      fromcity: cfg.from,
      tocity: cfg.to,
      doj,
      class: cfg.seatClass
    });
    return `https://train.shohoz.com/booking/train/search?${params.toString()}`;
  }

  function sameSearch(cfg) {
    try {
      const u = new URL(location.href);
      if (!/\/booking\/train\/search/i.test(u.pathname)) return false;
      const from = decodeURIComponent(u.searchParams.get("fromcity") || "").toLowerCase();
      const to = decodeURIComponent(u.searchParams.get("tocity") || "").toLowerCase();
      const doj = decodeURIComponent(u.searchParams.get("doj") || "").toLowerCase();
      const cls = decodeURIComponent(u.searchParams.get("class") || "").toLowerCase();
      return (
        from === cfg.from.toLowerCase() &&
        to === cfg.to.toLowerCase() &&
        doj === formatDoJ(cfg.date).toLowerCase() &&
        cls === cfg.seatClass.toLowerCase()
      );
    } catch {
      return false;
    }
  }

  function ensureHud() {
    let hud = qs("#stc-hud");
    if (hud) return hud;
    hud = document.createElement("div");
    hud.id = "stc-hud";
    hud.className = "stc-idle";
    hud.innerHTML = `
      <div class="stc-h">
        <span>Shohoz Ticket Cutter</span>
        <span id="stc-h-state">Idle</span>
      </div>
      <div class="stc-body">
        <p class="stc-step" id="stc-step">Ready</p>
        <p class="stc-msg" id="stc-msg">Press Start in the extension.</p>
        <button type="button" id="stc-stop">Stop bot</button>
      </div>`;
    document.documentElement.appendChild(hud);
    hud.querySelector("#stc-stop").addEventListener("click", () => stopBot("Stopped from page"));
    return hud;
  }

  function updateHud(msg, state) {
    const hud = ensureHud();
    if (running) {
      hud.className = "";
      hud.querySelector("#stc-h-state").textContent = "Running";
      hud.querySelector("#stc-step").textContent = "Cutting seats";
    } else if (state === "done") {
      hud.className = "stc-done";
      hud.querySelector("#stc-h-state").textContent = "Done";
      hud.querySelector("#stc-step").textContent = "OTP page";
    } else if (state === "error") {
      hud.className = "stc-err";
      hud.querySelector("#stc-h-state").textContent = "Error";
      hud.querySelector("#stc-step").textContent = "Stopped";
    } else if (!running) {
      hud.className = "stc-idle";
    }
    if (msg) hud.querySelector("#stc-msg").textContent = msg;
  }

  async function scrapeTrainsFromPage() {
    const names = qsa("app-single-trip .trip-name h2, app-single-trip h2, .trip-name h2")
      .map(textOf)
      .filter(Boolean)
      .map((n) => STC.cleanText(n, 80))
      .filter(Boolean);
    if (!names.length) return [];
    const unique = [...new Map(names.map((t) => [t.toLowerCase(), t])).values()].sort((a, b) =>
      a.localeCompare(b)
    );
    await chrome.storage.local.set({ scrapedTrains: unique });
    return unique;
  }

  function listTrainsForRoute(req) {
    const names = scrapeSyncTrainNames();
    if (!req?.from || !req?.to) return names;
    if (!sameSearch(STC.sanitizeConfig({ ...req, train: "x", seatCount: 1 }))) {
      // Still return page trains if user is already on a search result for any route —
      // popup mainly uses API. Page scrape is a fallback.
    }
    return names;
  }

  function scrapeSyncTrainNames() {
    return [...new Map(
      qsa("app-single-trip .trip-name h2, app-single-trip h2, .trip-name h2")
        .map(textOf)
        .map((n) => STC.cleanText(n, 80))
        .filter(Boolean)
        .map((t) => [t.toLowerCase(), t])
    ).values()].sort((a, b) => a.localeCompare(b));
  }

  function findTrainCard(name) {
    const cards = qsa("app-single-trip, .single-trip-wrapper");
    const target = name.trim().toLowerCase();
    const num = (name.match(/\((\d+)\)/) || [])[1];
    const strip = (s) => s.replace(/\s*\(\d+\)\s*$/, "").trim();

    const scored = cards.map((card) => {
      const title = textOf(card.querySelector(".trip-name h2, h2"));
      const t = title.toLowerCase();
      let score = 0;
      if (t === target) score = 100;
      else if (num && t.includes(`(${num})`)) score = 90;
      else if (strip(t) === strip(target) && strip(t)) score = 80;
      else if (t.includes(target) || target.includes(t)) score = 50;
      else if (strip(t) && strip(target) && (strip(t).includes(strip(target)) || strip(target).includes(strip(t)))) score = 40;
      return { card, title, score };
    }).filter((x) => x.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.card || null;
  }

  function seatLabel(btn) {
    return (btn?.title || textOf(btn) || "").replace(/\s+/g, "").toUpperCase();
  }

  function isLiveSeat(btn) {
    if (!btn || btn.disabled) return false;
    if (btn.classList.contains("seat-hidden") || btn.classList.contains("seat-booked")) return false;
    if (btn.classList.contains("seat-disabled")) return false;
    if (/progress/i.test(btn.className)) return false;
    if (!seatLabel(btn)) return false;
    return btn.classList.contains("seat-available") || btn.classList.contains("seat-selected");
  }

  function availableSeats(root = document) {
    return qsa("button.btn-seat", root).filter((b) => isLiveSeat(b) && b.classList.contains("seat-available") && !b.classList.contains("seat-selected"));
  }

  function selectedSeats(root = document) {
    return qsa("button.btn-seat.seat-selected", root).filter((b) => !b.classList.contains("seat-hidden"));
  }

  function findSeatButton(label, root = document) {
    const want = String(label || "").toUpperCase();
    return qsa("button.btn-seat", root).find((b) => seatLabel(b) === want && !b.classList.contains("seat-hidden")) || null;
  }

  function cartSeatLabels() {
    const found = new Set(selectedSeats().map(seatLabel).filter(Boolean));
    const wrap = qs(".selected-seats-table-wrapper");
    if (wrap) {
      for (const el of qsa("td, span, div, li", wrap)) {
        const t = textOf(el);
        if (/^[A-Z]{1,8}-\d+[A-Z]?$/i.test(t)) found.add(t.toUpperCase());
      }
    }
    return [...found];
  }

  function parseCoachMap(root = document) {
    const layout = qs(".seat_layout", root) || qs("app-seat-layout") || root;
    const rows = qsa(".seat-row", layout);
    const sides = { left: [], right: [] };
    rows.forEach((row, ri) => {
      const groups = qsa(":scope > .seat-in-row", row);
      groups.forEach((group, gi) => {
        const seats = qsa("button.btn-seat", group).filter(isLiveSeat);
        if (!seats.length) return;
        const key = gi === 0 ? "left" : "right";
        if (!sides[key]) sides[key] = [];
        sides[key].push({ row: ri, seats, labels: seats.map(seatLabel) });
      });
    });
    return {
      rowCount: rows.length,
      sides,
      availableCount: availableSeats(layout).length
    };
  }

  function scoreBlock(r0, r1, rowCount, preferMiddle, allowTail) {
    const mid = (rowCount - 1) / 2;
    const center = (r0 + r1) / 2;
    const tailStart = Math.max(0, rowCount - 3);
    const inTail = r1 >= tailStart;
    return {
      dist: Math.abs(center - mid),
      inTail,
      preferMiddle,
      allowTail
    };
  }

  function findSeatBlocks(count, { allowTail = false, preferMiddle = true } = {}) {
    const parsed = parseCoachMap();
    const { rowCount, sides, availableCount } = parsed;
    if (!rowCount) return [];
    // Middle priority only when user wants it and the coach still has room.
    const useMiddle = !!preferMiddle && availableCount >= 50;
    const cands = [];

    for (const [side, groups] of Object.entries(sides)) {
      const byRow = new Map(groups.map((g) => [g.row, g]));
      const rowIdxs = [...byRow.keys()].sort((a, b) => a - b);

      const push = (seats, rowsUsed) => {
        if (seats.length < count) return;
        const r0 = rowsUsed[0];
        const r1 = rowsUsed[rowsUsed.length - 1];
        const meta = scoreBlock(r0, r1, rowCount, useMiddle, allowTail);
        if (meta.inTail && !allowTail) return;
        cands.push({
          side,
          seats,
          labels: seats.map(seatLabel),
          rows: rowsUsed,
          availableCount,
          preferMiddle: useMiddle,
          ...meta
        });
      };

      if (count <= 1) {
        for (const g of groups) g.seats.forEach((s) => push([s], [g.row]));
        continue;
      }

      if (count === 2) {
        for (const g of groups) {
          if (g.seats.length >= 2) push(g.seats.slice(0, 2), [g.row]);
        }
        continue;
      }

      if (count === 3) {
        for (const r0 of rowIdxs) {
          const r1 = r0 + 1;
          if (!byRow.has(r1)) continue;
          const combo = [...byRow.get(r0).seats, ...byRow.get(r1).seats];
          if (combo.length >= 3) push(combo.slice(0, 3), [r0, r1]);
        }
        continue;
      }

      for (const r0 of rowIdxs) {
        const r1 = r0 + 1;
        if (!byRow.has(r1)) continue;
        const a = byRow.get(r0).seats;
        const b = byRow.get(r1).seats;
        if (a.length >= 2 && b.length >= 2) push([...a.slice(0, 2), ...b.slice(0, 2)], [r0, r1]);
      }
    }

    cands.sort((a, b) => {
      if (useMiddle) return a.dist - b.dist || a.rows.length - b.rows.length;
      return a.rows.length - b.rows.length || a.dist - b.dist;
    });
    return cands;
  }

  async function selectCoach(preferred) {
    const sel = qs("#select-bogie");
    if (!sel || !sel.options.length) return [0];
    const options = [...sel.options];
    let order = options.map((_, i) => i);
    if (preferred) {
      const hit = options.findIndex((o) => o.textContent.toLowerCase().includes(preferred.toLowerCase()));
      if (hit >= 0) order = [hit, ...order.filter((i) => i !== hit)];
    }
    return order;
  }

  function currentCoachName() {
    const sel = qs("#select-bogie");
    return sel?.options[sel.selectedIndex]?.textContent?.trim() || "Coach";
  }

  async function setCoachIndex(i) {
    const sel = qs("#select-bogie");
    if (!sel || !sel.options[i]) return;
    const already = sel.selectedIndex === i;
    if (!already) {
      sel.selectedIndex = i;
      setNativeValue(sel, sel.options[i].value);
    }
    await sleep(already ? 200 : 850);
    await waitFor(() => qsa(".seat-row").length > 0, 8000, 200);
  }

  async function selectSeatByLabel(label) {
    const btn = findSeatButton(label);
    if (!btn) return false;
    if (btn.classList.contains("seat-selected")) return true;
    clickEl(btn);
    return !!(await waitFor(() => {
      const live = findSeatButton(label);
      return live && live.classList.contains("seat-selected");
    }, 2800, 80));
  }

  async function deselectSeatByLabel(label) {
    const btn = findSeatButton(label);
    if (!btn || !btn.classList.contains("seat-selected")) return true;
    clickEl(btn);
    return !!(await waitFor(() => {
      const live = findSeatButton(label);
      return !live || !live.classList.contains("seat-selected");
    }, 2200, 80));
  }

  async function deselectAllInView() {
    const labels = selectedSeats().map(seatLabel).filter(Boolean);
    for (const label of labels) {
      if (!running) return;
      await deselectSeatByLabel(label);
      await sleep(120);
    }
  }

  async function clearSelectionsAcrossCoaches(indices) {
    for (let pass = 0; pass < 2; pass++) {
      for (const i of indices) {
        if (!running) return;
        await setCoachIndex(i);
        await deselectAllInView();
      }
      if (cartSeatLabels().length === 0) return;
    }
  }

  function sameCoachLabels(labels) {
    if (!labels.length) return false;
    const prefix = labels[0].split("-")[0];
    return labels.every((l) => l.startsWith(`${prefix}-`));
  }

  async function clickClassAndBook(card, seatClass) {
    const classes = qsa(".single-seat-class", card);
    const wanted = seatClass.toUpperCase();
    let target = classes.find((c) => textOf(c.querySelector(".seat-class-name")).toUpperCase() === wanted);
    if (!target) return false;
    if (target.classList.contains("no-seat-available-wrap")) return false;
    const availText = textOf(target.querySelector(".all-seats"));
    if (availText && /^0+$/.test(availText.replace(/\D/g, "") || "x")) return false;
    clickEl(target);
    const btn = await waitFor(() => {
      const b = qs(".book-now-btn", target);
      if (!b || b.disabled) return null;
      if (qs(".fa-spinner", b)) return null;
      return b;
    }, 15000, 200);
    if (!btn) return false;
    clickEl(btn);
    return true;
  }

  async function goToSearch(cfg) {
    const url = searchUrl(cfg);
    if (sameSearch(cfg) && isSearchResultPage()) return false;
    await log(`Searching ${cfg.from} → ${cfg.to} · ${formatDoJ(cfg.date)} · ${cfg.seatClass}`);
    location.href = url;
    return true;
  }

  async function selectTrainAndOpenSeats(cfg) {
    await waitFor(() => qs("app-single-trip, .single-trip-wrapper") || /no train|not found/i.test(pageText()), 25000, 250);
    await waitFor(() => {
      const buttons = qsa(".book-now-btn");
      if (!buttons.length) return qs("app-single-trip");
      const spinning = buttons.filter((b) => qs(".fa-spinner", b)).length;
      return spinning === 0 || buttons.some((b) => !b.disabled);
    }, 18000, 250);
    await scrapeTrainsFromPage();

    const card = findTrainCard(cfg.train);
    if (!card) {
      await log(`Train not listed yet: ${cfg.train}`);
      return false;
    }
    await log(`Found ${textOf(card.querySelector("h2"))}`);
    const opened = await clickClassAndBook(card, cfg.seatClass);
    if (!opened) {
      await log(`${cfg.seatClass} has no seats yet`);
      return false;
    }
    const layout = await waitFor(() => seatLayout(), 12000, 200);
    if (!layout) {
      await log("Seat map did not open");
      return false;
    }
    await log("Seat map opened");
    return true;
  }

  async function tryBlocksInCurrentCoach(cfg, allowTail) {
    const coachName = currentCoachName();
    await deselectAllInView();
    const blocks = findSeatBlocks(cfg.seatCount, {
      allowTail,
      preferMiddle: cfg.preferMiddle !== false
    });
    if (!blocks.length) {
      await log(`${coachName}: no side-by-side block of ${cfg.seatCount}${allowTail ? "" : " (skipping last rows)"}`);
      return false;
    }

    const mode = cfg.preferMiddle === false
      ? "same-side only"
      : (blocks[0].preferMiddle ? "middle first" : "same-side (coach under 50 free)");
    await log(`${coachName}: ${blocks[0].availableCount} free · ${mode} · ${blocks.length} option(s)`);

    for (const block of blocks) {
      if (!running) return false;
      await deselectAllInView();
      await log(`${coachName}: trying ${block.labels.join(", ")} (${block.side})`);
      let ok = true;
      for (const label of block.labels) {
        if (!running) return false;
        const selected = await selectSeatByLabel(label);
        if (!selected) {
          ok = false;
          await log(`${label} did not lock, next pair in this coach`);
          break;
        }
        await sleep(220);
      }
      const cart = cartSeatLabels();
      if (ok && cart.length >= cfg.seatCount && sameCoachLabels(cart.slice(0, cfg.seatCount))) {
        await log(`Locked ${cart.slice(0, cfg.seatCount).join(", ")} in ${coachName}`);
        return true;
      }
      await deselectAllInView();
    }
    return false;
  }

  async function cutSeats(cfg) {
    const indices = await selectCoach(cfg.coach);
    await clearSelectionsAcrossCoaches(indices);

    for (const allowTail of [false, true]) {
      for (const i of indices) {
        if (!running) return false;
        await setCoachIndex(i);
        const ok = await tryBlocksInCurrentCoach(cfg, allowTail);
        if (ok) return true;
      }
    }

    await log("No same-coach side-by-side block found");
    await clearSelectionsAcrossCoaches(indices);
    return false;
  }

  async function continuePurchase() {
    const btn = qsa("button").find((b) => /continue purchase/i.test(textOf(b))) || qs(".continue-btn");
    if (!btn) return false;
    if (btn.disabled) {
      await log("Continue is still disabled");
      return false;
    }
    await log("Confirming purchase");
    clickEl(btn);
    return true;
  }

  async function clickProceedIfAny() {
    const labels = /^(continue purchase|continue|proceed to pay|confirm booking|confirm)$/i;
    const btn = qsa("button, a.btn, input[type='submit']").find((b) => labels.test(textOf(b)) && visible(b) && !b.disabled);
    if (btn) {
      await log(`Clicking ${textOf(btn)}`);
      clickEl(btn);
      return true;
    }
    return false;
  }

  async function finish(reason) {
    running = false;
    await chrome.storage.local.set({ botRunning: false, botState: "done" });
    await log(reason || "OTP page reached. Bot finished — enter OTP yourself.");
    updateHud("Enter the OTP. Bot task is done.", "done");
  }

  async function stopBot(reason) {
    running = false;
    await chrome.storage.local.set({ botRunning: false, botState: "idle" });
    await log(reason || "Stopped");
    updateHud(reason || "Stopped", "error");
  }

  async function tick(cfg) {
    dismissModals();

    if (isOtpPage() && !isLoginPage()) {
      await finish("OTP page arrived. Bot task is done.");
      return "done";
    }

    if (isLoginPage()) {
      if (isOtpPage()) {
        await log("Login OTP — verify it, then press Start again.");
        await chrome.storage.local.set({ botRunning: false, botState: "idle" });
        running = false;
        updateHud("Login OTP — finish login, then Start again.", "error");
        return "done";
      }
      await log("Please log in on Shohoz, then press Start.");
      await chrome.storage.local.set({ botRunning: false, botState: "idle" });
      running = false;
      updateHud("Log in first, then Start.", "error");
      return "done";
    }

    if (seatLayout()) {
      const trip = qs("app-seat-layout")?.closest("app-single-trip");
      const title = textOf(trip?.querySelector("h2"));
      const trainKey = cfg.train.replace(/\s*\(\d+\)\s*$/, "").trim().toLowerCase();
      if (title && trainKey && !title.toLowerCase().includes(trainKey) && !trainKey.includes(title.toLowerCase())) {
        const close = qs(".btn-close-seat-layout");
        if (close) clickEl(close);
        await sleep(400);
        return "ok";
      }
      const cart = cartSeatLabels();
      const complete = cart.length >= cfg.seatCount && sameCoachLabels(cart.slice(0, cfg.seatCount));
      if (!complete) {
        const ok = await cutSeats(cfg);
        if (!ok) return "retry";
      }
      if (!purchaseClicked) {
        const went = await continuePurchase();
        if (!went) return "wait";
        purchaseClicked = true;
      }
      await waitFor(() => isOtpPage() || !seatLayout() || /trip-info|payment|passenger/i.test(location.href), 15000, 250);
      return "ok";
    }

    if (isSearchResultPage()) {
      if (!sameSearch(cfg)) {
        const navigated = await goToSearch(cfg);
        return navigated ? "nav" : "ok";
      }
      const ok = await selectTrainAndOpenSeats(cfg);
      return ok ? "ok" : "retry";
    }

    if (isSearchFormPage() || location.pathname === "/" || location.pathname === "") {
      const navigated = await goToSearch(cfg);
      return navigated ? "nav" : "ok";
    }

    const progressed = await clickProceedIfAny();
    if (progressed) return "ok";
    return "wait";
  }

  async function runLoop(cfg) {
    config = cfg;
    running = true;
    await chrome.storage.local.set({ botRunning: true, botState: "running", config: cfg });
    ensureHud();
    updateHud("Bot started");
    purchaseClicked = false;
    await log("Bot started — same coach, side by side");

    while (running) {
      try {
        const result = await tick(cfg);
        if (!running || result === "done") break;
        if (result === "nav") {
          return;
        }
        if (result === "retry") {
          if (!cfg.retry) {
            await stopBot("No seats. Retry is off.");
            break;
          }
          await log("Retrying search…");
          await sleep(RETRY_MS);
          if (!running) break;
          if (isSearchResultPage()) {
            location.reload();
            return;
          }
          const navigated = await goToSearch(cfg);
          if (navigated) return;
        } else {
          await sleep(400);
        }
      } catch (err) {
        await log(`Error: ${err.message || err}`);
        await sleep(1000);
      }
    }
  }

  async function startFromConfig(raw) {
    const cfg = STC.sanitizeConfig(raw);
    const err = STC.validateConfig(cfg);
    if (err) {
      await stopBot(err);
      return;
    }
    if (loopPromise) {
      running = false;
      await sleep(50);
    }
    loopPromise = runLoop(cfg);
    await loopPromise;
    loopPromise = null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!STC.isTrustedSender(sender)) {
      sendResponse({ ok: false });
      return false;
    }
    if (msg?.type === "STC_LIST_TRAINS") {
      (async () => {
        const trains = listTrainsForRoute(msg);
        if (!trains.length) await scrapeTrainsFromPage();
        sendResponse({ ok: true, trains: trains.length ? trains : scrapeSyncTrainNames() });
      })();
      return true;
    }
    if (msg?.type === "STC_START") {
      startFromConfig(msg.config || config);
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "STC_STOP") {
      stopBot("Stopped");
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  chrome.storage.local.get(["botRunning", "config", "botState"], (data) => {
    ensureHud();
    scrapeTrainsFromPage();
    if (data.botRunning && data.config && data.botState !== "done") {
      startFromConfig(data.config);
    }
  });
})();

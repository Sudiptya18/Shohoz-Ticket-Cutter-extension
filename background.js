importScripts("security.js");

const MATCH = [
  "https://train.shohoz.com/*",
  "https://eticket.railway.gov.bd/*"
];
const HOME = "https://train.shohoz.com/";
const API = "https://railspaapi.shohoz.com/v1.0/web/bookings/search-trips-v2";

async function activeShohozTab() {
  const tabs = await chrome.tabs.query({ url: MATCH });
  const focused = tabs.find((t) => t.active) || tabs[0];
  if (focused) return focused;
  return chrome.tabs.create({ url: HOME, active: true });
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["security.js", "content.js"]
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["overlay.css"]
      });
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (err) {
      console.warn("STC inject failed", err);
      return false;
    }
  }
}

function extractTrainNames(payload) {
  const trains =
    payload?.data?.trains ||
    payload?.trains ||
    payload?.data?.data?.trains ||
    [];
  if (!Array.isArray(trains)) return [];
  const names = [];
  for (const t of trains) {
    const raw =
      t?.trip_number ||
      t?.train_name ||
      t?.trip_name ||
      t?.name ||
      (typeof t === "string" ? t : "");
    const name = STC.cleanText(raw, 80);
    if (name) names.push(name);
  }
  return [...new Map(names.map((n) => [n.toLowerCase(), n])).values()].sort((a, b) =>
    a.localeCompare(b)
  );
}

async function scrapeTrainsFromOpenTab(from, to, date, seatClass) {
  const tabs = await chrome.tabs.query({ url: MATCH });
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "STC_LIST_TRAINS",
        from,
        to,
        date,
        seatClass
      });
      if (res?.ok && Array.isArray(res.trains) && res.trains.length) {
        return res.trains;
      }
    } catch {
      /* tab may not have content script yet */
    }
  }
  return [];
}

async function fetchRouteTrains({ from, to, date, seatClass }) {
  const safe = STC.sanitizeConfig({ from, to, date, seatClass, seatCount: 1, train: "x" });
  if (!safe.from || !safe.to || !safe.date) {
    return { ok: false, trains: [], error: "Missing From, To or date" };
  }
  const doj = STC.formatDoJ(safe.date);
  const attempts = [
    `${API}?${new URLSearchParams({
      from_city: safe.from,
      to_city: safe.to,
      date_of_journey: doj,
      seat_class: safe.seatClass
    })}`,
    `https://railspaapi.shohoz.com/v1.0/app/bookings/search-trips-v2?${new URLSearchParams({
      from_city: safe.from,
      to_city: safe.to,
      date_of_journey: doj,
      seat_class: safe.seatClass
    })}`
  ];

  for (const url of attempts) {
    try {
      const res = await fetch(url, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!res.ok) continue;
      const json = await res.json();
      const trains = extractTrainNames(json);
      if (trains.length) return { ok: true, trains };
    } catch {
      /* try next */
    }
  }

  const scraped = await scrapeTrainsFromOpenTab(safe.from, safe.to, safe.date, safe.seatClass);
  if (scraped.length) return { ok: true, trains: scraped };
  return { ok: false, trains: [], error: "No trains" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!STC.isTrustedSender(sender)) {
    sendResponse({ ok: false, error: "untrusted" });
    return false;
  }

  if (msg?.type === "STC_FETCH_TRAINS") {
    (async () => {
      const result = await fetchRouteTrains(msg);
      sendResponse(result);
    })();
    return true;
  }

  if (msg?.type === "STC_START") {
    (async () => {
      const config = STC.sanitizeConfig(msg.config);
      const err = STC.validateConfig(config);
      if (err) {
        sendResponse({ ok: false, error: err });
        return;
      }
      const tab = await activeShohozTab();
      if (tab?.url) {
        try {
          const host = new URL(tab.url).hostname;
          if (tab.url !== "chrome://newtab/" && tab.url !== HOME && !STC.isAllowedHost(host) && !/^https:\/\/(train\.shohoz\.com|eticket\.railway\.gov\.bd)/.test(tab.url)) {
            // still allow if we just created home tab mid-load
          }
        } catch {
          /* ignore */
        }
      }
      await chrome.storage.local.set({ config, botRunning: true, botState: "running" });
      await sendToTab(tab.id, { type: "STC_START", config });
      sendResponse({ ok: true, tabId: tab.id });
    })();
    return true;
  }

  if (msg?.type === "STC_STOP") {
    chrome.storage.local.set({ botRunning: false, botState: "idle" });
    chrome.tabs.query({ url: MATCH }, (tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: "STC_STOP" }).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

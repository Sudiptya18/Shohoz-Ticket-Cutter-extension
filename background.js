importScripts("security.js");

const MATCH = [
  "https://train.shohoz.com/*",
  "https://eticket.railway.gov.bd/*"
];
const HOME = "https://train.shohoz.com/";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function searchUrl(from, to, date, seatClass) {
  const safe = STC.sanitizeConfig({ from, to, date, seatClass, train: "x", seatCount: 1 });
  const doj = STC.formatDoJ(safe.date);
  const params = new URLSearchParams({
    fromcity: safe.from,
    tocity: safe.to,
    doj,
    class: safe.seatClass
  });
  return `https://train.shohoz.com/booking/train/search?${params.toString()}`;
}

async function activeShohozTab() {
  const tabs = await chrome.tabs.query({ url: MATCH });
  const focused = tabs.find((t) => t.active) || tabs[0];
  if (focused) return focused;
  return chrome.tabs.create({ url: HOME, active: true });
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "STC_PING" });
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
      return true;
    } catch (err) {
      console.warn("STC inject failed", err);
      return false;
    }
  }
}

async function sendToTab(tabId, message) {
  const ok = await ensureContent(tabId);
  if (!ok) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function askTabForTrains(tabId, payload) {
  const injected = await ensureContent(tabId);
  if (!injected) return null;
  return sendToTab(tabId, { type: "STC_FETCH_ROUTE_TRAINS", ...payload });
}

async function waitTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch {
      return false;
    }
    await sleep(250);
  }
  return false;
}

async function fetchRouteTrains(msg) {
  const safe = STC.sanitizeConfig({
    from: msg.from,
    to: msg.to,
    date: msg.date,
    seatClass: msg.seatClass,
    train: "x",
    seatCount: 1
  });
  if (!safe.from || !safe.to || !safe.date) {
    return { ok: false, trains: [], error: "missing_fields" };
  }

  const payload = {
    from: safe.from,
    to: safe.to,
    date: safe.date,
    seatClass: safe.seatClass
  };

  // 1) Try any open Shohoz tab with the user's login session
  const openTabs = await chrome.tabs.query({ url: MATCH });
  for (const tab of openTabs) {
    const res = await askTabForTrains(tab.id, payload);
    if (res?.ok && res.trains?.length) return { ok: true, trains: res.trains };
    if (res?.error === "not_logged_in") {
      // keep trying other strategies, but remember
    }
  }

  // 2) Open search in a quiet tab, wait for trains (uses site session + DOM)
  const url = searchUrl(safe.from, safe.to, safe.date, safe.seatClass);
  let tempTab = null;
  try {
    tempTab = await chrome.tabs.create({ url, active: false });
    await waitTabComplete(tempTab.id, 25000);
    await sleep(1200);

    for (let i = 0; i < 20; i++) {
      const res = await askTabForTrains(tempTab.id, payload);
      if (res?.ok && res.trains?.length) {
        return { ok: true, trains: res.trains };
      }
      if (res?.error === "not_logged_in" && i > 2) {
        return { ok: false, trains: [], error: "not_logged_in" };
      }
      await sleep(700);
    }
  } catch (err) {
    return { ok: false, trains: [], error: String(err?.message || err) };
  } finally {
    if (tempTab?.id) {
      try {
        await chrome.tabs.remove(tempTab.id);
      } catch {
        /* ignore */
      }
    }
  }

  // 3) Last try: existing home tab auth API only
  if (openTabs[0]) {
    const res = await askTabForTrains(openTabs[0].id, payload);
    if (res?.ok && res.trains?.length) return { ok: true, trains: res.trains };
    if (res?.error) return { ok: false, trains: [], error: res.error };
  }

  return { ok: false, trains: [], error: "no_trains" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!STC.isTrustedSender(sender)) {
    sendResponse({ ok: false, error: "untrusted" });
    return false;
  }

  if (msg?.type === "STC_FETCH_TRAINS") {
    (async () => {
      try {
        sendResponse(await fetchRouteTrains(msg));
      } catch (err) {
        sendResponse({ ok: false, trains: [], error: String(err?.message || err) });
      }
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

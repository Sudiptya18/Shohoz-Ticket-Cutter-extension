/** Shared sanitization & allowlists for Shohoz Ticket Cutter */
(function (root) {
  const CLASSES = Object.freeze([
    "S_CHAIR", "SHOVAN", "SNIGDHA", "F_CHAIR", "F_SEAT", "F_BERTH", "AC_S", "AC_B", "SHULOV", "AC_CHAIR"
  ]);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ALLOWED_HOSTS = new Set(["train.shohoz.com", "eticket.railway.gov.bd"]);

  function cleanText(value, max) {
    return String(value || "")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDoJ(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    return `${pad2(d)}-${MONTHS[mo - 1]}-${y}`;
  }

  function sanitizeConfig(raw) {
    const cfg = raw && typeof raw === "object" ? raw : {};
    const seatClass = CLASSES.includes(cfg.seatClass) ? cfg.seatClass : "S_CHAIR";
    let seatCount = Number(cfg.seatCount);
    if (!Number.isFinite(seatCount)) seatCount = 2;
    seatCount = Math.min(4, Math.max(1, Math.round(seatCount)));
    return {
      from: cleanText(cfg.from, 40),
      to: cleanText(cfg.to, 40),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(cfg.date || "")) ? String(cfg.date) : "",
      seatClass,
      train: cleanText(cfg.train, 80),
      coach: cleanText(cfg.coach, 20).replace(/[^A-Za-z0-9\s\-]/g, ""),
      seatCount,
      retry: cfg.retry !== false,
      preferMiddle: cfg.preferMiddle !== false
    };
  }

  function validateConfig(cfg) {
    if (!cfg.from) return "Choose a From station.";
    if (!cfg.to) return "Choose a To station.";
    if (cfg.from.toLowerCase() === cfg.to.toLowerCase()) return "From and To cannot be the same.";
    if (!cfg.date || !formatDoJ(cfg.date)) return "Pick a journey date.";
    if (!CLASSES.includes(cfg.seatClass)) return "Choose a class.";
    if (!cfg.train) return "Choose a train.";
    return "";
  }

  function isAllowedHost(hostname) {
    return ALLOWED_HOSTS.has(String(hostname || "").toLowerCase());
  }

  function isTrustedSender(sender) {
    if (!sender) return false;
    if (sender.id && chrome.runtime && sender.id !== chrome.runtime.id) return false;
    if (sender.tab && sender.tab.url) {
      try {
        const host = new URL(sender.tab.url).hostname;
        if (!isAllowedHost(host) && sender.url && !String(sender.url).startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  root.STC = {
    CLASSES,
    MONTHS,
    cleanText,
    formatDoJ,
    sanitizeConfig,
    validateConfig,
    isAllowedHost,
    isTrustedSender
  };
})(typeof globalThis !== "undefined" ? globalThis : self);

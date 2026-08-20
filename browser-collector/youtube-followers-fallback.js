(() => {
  const STORAGE_KEY = "mediaOpsYouTubeFollowersFallback";

  function isAccountPage() {
    if (!location.hostname.toLowerCase().endsWith("youtube.com")) return false;
    const path = location.pathname;
    if (path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/")) return false;
    const parts = path.split("/").filter(Boolean);
    return Boolean(parts[0]?.startsWith("@") || (["channel", "user", "c"].includes(parts[0]) && parts[1]));
  }

  function parseCount(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim().replace(/\u00a0/g, " ");
    if (!raw) return null;
    const chinese = raw.match(/([\d,.]+)\s*(万|亿)/);
    if (chinese) {
      const number = Number(chinese[1].replace(/,/g, ""));
      if (!Number.isFinite(number)) return null;
      return Math.round(number * (chinese[2] === "亿" ? 100000000 : 10000));
    }
    const compact = raw.match(/([\d,.]+)\s*([KMBT])/i);
    if (compact) {
      const number = Number(compact[1].replace(/,/g, ""));
      if (!Number.isFinite(number)) return null;
      const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[compact[2].toUpperCase()] || 1;
      return Math.round(number * multiplier);
    }
    const plain = raw.match(/\d[\d,.\s]*/);
    if (!plain) return null;
    const number = Number(plain[0].replace(/[\s,]/g, ""));
    return Number.isFinite(number) ? Math.round(number) : null;
  }

  function countNear(source) {
    if (!source) return null;
    const labels = ["subscribers", "subscriber", "订阅者", "位订阅者"];
    const suffix = "(?:[KMBT]|万|亿)?";
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = source.match(new RegExp(`([\\d,.]+\\s*${suffix})\\s*${escaped}`, "i"));
      if (before) {
        const parsed = parseCount(before[1]);
        if (parsed !== null) return parsed;
      }
      const after = source.match(new RegExp(`${escaped}\\s*[:：]?\\s*([\\d,.]+\\s*${suffix})`, "i"));
      if (after) {
        const parsed = parseCount(after[1]);
        if (parsed !== null) return parsed;
      }
    }
    return null;
  }

  function mainWorldFollowers() {
    const raw = document.documentElement?.getAttribute("data-media-ops-yt-account-metrics") || "";
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Number.isFinite(parsed?.followers) ? parsed.followers : null;
    } catch {
      return null;
    }
  }

  function extractFollowers() {
    const main = mainWorldFollowers();
    if (main !== null) return main;

    const selectors = [
      "#subscriber-count",
      "ytd-c4-tabbed-header-renderer #subscriber-count",
      "yt-content-metadata-view-model",
      '[aria-label*="subscriber" i]',
      '[aria-label*="订阅"]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const source = `${node.textContent || ""} ${node.getAttribute?.("aria-label") || ""}`;
        const value = countNear(source);
        if (value !== null) return value;
      }
    }

    const bodyValue = countNear((document.body?.innerText || "").slice(0, 120000));
    if (bodyValue !== null) return bodyValue;

    for (const script of document.querySelectorAll("script")) {
      const source = script.textContent || "";
      if (!source || (!/subscriber/i.test(source) && !source.includes("订阅"))) continue;
      const focused = source.match(/"subscriberCount(?:Text|Label)?"[\s\S]{0,1200}/i)?.[0] || source.slice(0, 250000);
      const value = countNear(focused);
      if (value !== null) return value;
    }
    return null;
  }

  function profileUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0]?.startsWith("@")) return `${location.origin}/${parts[0]}`;
    if (["channel", "user", "c"].includes(parts[0]) && parts[1]) return `${location.origin}/${parts[0]}/${parts[1]}`;
    return location.href;
  }

  async function send() {
    if (!isAccountPage()) return false;
    const followers = extractFollowers();
    if (!Number.isFinite(followers)) return false;
    const fingerprint = `${profileUrl()}|${followers}`;
    if (sessionStorage.getItem(STORAGE_KEY) === fingerprint) return true;
    const title = String(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || document.title || "")
      .replace(/\s*[|·-]\s*YouTube\s*$/i, "")
      .trim();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "PUBLIC_METRICS",
        payload: {
          platform: "youtube",
          page_type: "account",
          url: location.href,
          title,
          account_name: title,
          handle: location.pathname.split("/").filter(Boolean)[0]?.startsWith("@")
            ? location.pathname.split("/").filter(Boolean)[0]
            : "",
          profile_url: profileUrl(),
          metrics: { followers },
          discovered_urls: [],
          discovery_complete: false,
          feed_empty: false
        }
      });
      if (response?.ok) {
        sessionStorage.setItem(STORAGE_KEY, fingerprint);
        return true;
      }
    } catch {}
    return false;
  }

  if (!isAccountPage()) return;
  document.addEventListener("media-ops-yt-account-metrics-ready", () => send().catch(() => null));
  [1500, 3000, 5000, 8000, 12000, 18000, 25000, 35000, 45000, 55000].forEach((delay) => {
    setTimeout(() => send().catch(() => null), delay);
  });
})();

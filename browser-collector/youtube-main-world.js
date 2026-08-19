(() => {
  const ATTR = "data-media-ops-yt-account-metrics";
  const MAX_NODES = 50000;

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

  function countNear(source, labels) {
    const suffix = "(?:[KMBT]|万|亿)?";
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const before = source.match(new RegExp(`([\\d,.]+\\s*${suffix})\\s*${escaped}`, "i"));
      if (before) {
        const value = parseCount(before[1]);
        if (value !== null) return value;
      }
      const after = source.match(new RegExp(`${escaped}\\s*[:：]?\\s*([\\d,.]+\\s*${suffix})`, "i"));
      if (after) {
        const value = parseCount(after[1]);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function valueText(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.slice(0, 80).map((item) => valueText(item, depth + 1)).filter(Boolean).join(" ");
    if (typeof value !== "object") return "";
    if (typeof value.simpleText === "string") return value.simpleText;
    if (Array.isArray(value.runs)) {
      const runText = value.runs.map((run) => run?.text || run?.content || "").filter(Boolean).join(" ");
      if (runText) return runText;
    }
    for (const key of ["text", "label", "content", "accessibilityLabel"]) {
      if (typeof value[key] === "string") return value[key];
    }
    return Object.values(value).slice(0, 80).map((item) => valueText(item, depth + 1)).filter(Boolean).join(" ");
  }

  function findValues(root, wantedKeys) {
    if (!root || typeof root !== "object") return [];
    const wanted = new Set(wantedKeys);
    const values = [];
    const stack = [root];
    const seen = new WeakSet();
    let visited = 0;
    while (stack.length && visited < MAX_NODES) {
      const current = stack.pop();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      visited += 1;
      for (const [key, value] of Object.entries(current)) {
        if (wanted.has(key)) values.push(value);
        if (value && typeof value === "object") stack.push(value);
      }
    }
    return values;
  }

  function findMetric(roots, keys, labels) {
    for (const root of roots) {
      for (const value of findValues(root, keys)) {
        const source = valueText(value);
        const labeled = countNear(source, labels);
        if (labeled !== null) return labeled;
        const direct = parseCount(source);
        if (direct !== null) return direct;
      }
    }
    return null;
  }

  function findString(roots, keys, accept = () => true) {
    for (const root of roots) {
      for (const value of findValues(root, keys)) {
        const text = valueText(value).trim();
        if (text && accept(text)) return text;
      }
    }
    return "";
  }

  function flattenedText(roots) {
    const output = [];
    const seen = new WeakSet();
    const stack = [...roots];
    let visited = 0;
    while (stack.length && visited < MAX_NODES && output.length < 8000) {
      const current = stack.pop();
      if (current === null || current === undefined) continue;
      if (typeof current === "string" || typeof current === "number") {
        const text = String(current).trim();
        if (text && text.length <= 240) output.push(text);
        continue;
      }
      if (typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      visited += 1;
      if (Array.isArray(current)) {
        for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      } else {
        const values = Object.values(current);
        for (let index = values.length - 1; index >= 0; index -= 1) stack.push(values[index]);
      }
    }
    return output.join(" ");
  }

  function isAccountPage() {
    if (!location.hostname.toLowerCase().endsWith("youtube.com")) return false;
    const path = location.pathname;
    if (path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/")) return false;
    const parts = path.split("/").filter(Boolean);
    return Boolean(parts[0]?.startsWith("@") || (["channel", "user", "c"].includes(parts[0]) && parts[1]));
  }

  function profileFromLocation() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (!parts.length) return "";
    if (parts[0].startsWith("@")) return `${location.origin}/${parts[0]}`;
    if (["channel", "user", "c"].includes(parts[0]) && parts[1]) return `${location.origin}/${parts[0]}/${parts[1]}`;
    return "";
  }

  function extract() {
    if (!isAccountPage()) return null;
    const roots = [window.ytInitialData, window.ytInitialPlayerResponse, window.ytInitialGuideData].filter(Boolean);
    if (!roots.length) return null;
    const subscriberLabels = ["subscribers", "subscriber", "订阅者", "位订阅者"];
    const videoLabels = ["videos", "video", "视频", "个视频"];
    let followers = findMetric(roots, ["subscriberCountText", "subscriberCount", "subscriberCountLabel", "subscribersText"], subscriberLabels);
    let contentCount = findMetric(roots, ["videosCountText", "videoCountText", "contentCountText", "videoCount", "videosCount"], videoLabels);
    if (followers === null || contentCount === null) {
      const source = flattenedText(roots);
      if (followers === null) followers = countNear(source, subscriberLabels);
      if (contentCount === null) contentCount = countNear(source, videoLabels);
    }
    const metadata = window.ytInitialData?.metadata?.channelMetadataRenderer || {};
    const title = String(metadata.title || findString(roots, ["channelName", "title"], (value) => value.length < 180) || "").trim();
    const externalId = String(metadata.externalId || findString(roots, ["externalId", "channelId"], (value) => /^UC[\w-]{10,}$/.test(value)) || "").trim();
    const vanity = String(metadata.vanityChannelUrl || metadata.channelUrl || "").trim();
    const profileUrl = vanity || profileFromLocation();
    if (!Number.isFinite(followers) && !Number.isFinite(contentCount) && !externalId && !title) return null;
    return {
      followers: Number.isFinite(followers) ? followers : null,
      content_count: Number.isFinite(contentCount) ? contentCount : null,
      title,
      external_id: externalId,
      profile_url: profileUrl,
      captured_at: new Date().toISOString()
    };
  }

  function publish() {
    const payload = extract();
    if (!payload || !document.documentElement) return;
    document.documentElement.setAttribute(ATTR, JSON.stringify(payload));
    document.dispatchEvent(new CustomEvent("media-ops-yt-account-metrics-ready"));
  }

  function scheduleBurst() {
    [0, 1000, 2500, 5000, 8000, 12000, 20000, 30000].forEach((delay) => setTimeout(publish, delay));
  }

  scheduleBurst();
  window.addEventListener("yt-navigate-finish", scheduleBurst);
})();

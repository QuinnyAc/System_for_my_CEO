function ytMetricParseCount(value) {
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
  const cleaned = plain[0].replace(/[\s,]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function ytMetricCountNear(source, labels) {
  const suffix = "(?:[KMBT]|万|亿)?";
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = source.match(new RegExp(`([\\d,.]+\\s*${suffix})\\s*${escaped}`, "i"));
    if (before) {
      const value = ytMetricParseCount(before[1]);
      if (value !== null) return value;
    }
    const after = source.match(new RegExp(`${escaped}\\s*[:：]?\\s*([\\d,.]+\\s*${suffix})`, "i"));
    if (after) {
      const value = ytMetricParseCount(after[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function ytMetricDecode(value) {
  if (!value) return "";
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\u0026/g, "&").replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
}

function ytMetricTextForKey(key) {
  const marker = `"${key}"`;
  for (const script of document.querySelectorAll("script")) {
    const source = script.textContent || "";
    let position = source.indexOf(marker);
    while (position >= 0) {
      const fragment = source.slice(position, position + 2200);
      const direct = fragment.match(/"(?:simpleText|label)"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (direct) return ytMetricDecode(direct[1]);
      const texts = [...fragment.matchAll(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
        .slice(0, 6)
        .map((match) => ytMetricDecode(match[1]))
        .filter(Boolean);
      if (texts.length) return texts.join(" ");
      position = source.indexOf(marker, position + marker.length);
    }
  }
  return "";
}

function ytMetricFromScripts(keys, labels) {
  for (const key of keys) {
    const source = ytMetricTextForKey(key);
    if (!source) continue;
    const labeled = ytMetricCountNear(source, labels);
    if (labeled !== null) return labeled;
    const plain = ytMetricParseCount(source);
    if (plain !== null) return plain;
  }
  return null;
}

function ytMetricBodyText() {
  return (document.body?.innerText || "").slice(0, 60000);
}

function ytMetricProfileUrl() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (!parts.length) return "";
  if (parts[0].startsWith("@")) return `${location.origin}/${parts[0]}`;
  if (["channel", "user", "c"].includes(parts[0]) && parts[1]) {
    return `${location.origin}/${parts[0]}/${parts[1]}`;
  }
  return "";
}

function ytMetricIsAccountPage() {
  if (!location.hostname.toLowerCase().endsWith("youtube.com")) return false;
  const path = location.pathname;
  if (path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/")) return false;
  const parts = path.split("/").filter(Boolean);
  return Boolean(parts[0]?.startsWith("@") || (["channel", "user", "c"].includes(parts[0]) && parts[1]));
}

function ytMetricExtract() {
  if (!ytMetricIsAccountPage()) return null;
  const body = ytMetricBodyText();

  let followers = null;
  for (const selector of [
    "#subscriber-count",
    "yt-content-metadata-view-model .yt-content-metadata-view-model-wiz__metadata-text",
    "yt-content-metadata-view-model span",
    "ytd-c4-tabbed-header-renderer #subscriber-count"
  ]) {
    for (const node of document.querySelectorAll(selector)) {
      const source = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`;
      const value = ytMetricCountNear(source, ["subscribers", "subscriber", "订阅者", "位订阅者"]);
      if (value !== null) {
        followers = value;
        break;
      }
    }
    if (followers !== null) break;
  }
  if (followers === null) {
    followers = ytMetricCountNear(body, ["subscribers", "subscriber", "订阅者", "位订阅者"]);
  }
  if (followers === null) {
    followers = ytMetricFromScripts(
      ["subscriberCountText", "subscriberCount", "subscriberCountLabel"],
      ["subscribers", "subscriber", "订阅者", "位订阅者"]
    );
  }

  let contentCount = ytMetricCountNear(body, ["videos", "video", "视频", "个视频"]);
  if (contentCount === null) {
    contentCount = ytMetricFromScripts(
      ["videoCountText", "videosCountText", "contentCountText", "videoCount"],
      ["videos", "video", "视频", "个视频"]
    );
  }

  if (!Number.isFinite(followers) && !Number.isFinite(contentCount)) return null;

  const profileUrl = ytMetricProfileUrl();
  const pathParts = location.pathname.split("/").filter(Boolean);
  const handle = pathParts[0]?.startsWith("@") ? pathParts[0] : "";
  const title = (document.querySelector('meta[property="og:title"]')?.getAttribute("content") || document.title || "")
    .replace(/\s*[|·-]\s*YouTube\s*$/i, "")
    .trim();

  return {
    platform: "youtube",
    page_type: "account",
    url: location.href,
    title,
    account_name: title,
    handle,
    profile_url: profileUrl || location.href,
    metrics: {
      followers: Number.isFinite(followers) ? followers : null,
      content_count: Number.isFinite(contentCount) ? contentCount : null
    },
    discovered_urls: [],
    discovery_complete: false,
    feed_empty: false
  };
}

async function ytMetricSend() {
  const payload = ytMetricExtract();
  if (!payload) return false;
  const fingerprint = JSON.stringify(payload.metrics);
  if (sessionStorage.getItem("mediaOpsYouTubeAccountMetrics") === fingerprint) return true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "PUBLIC_METRICS", payload });
    if (response?.ok) {
      sessionStorage.setItem("mediaOpsYouTubeAccountMetrics", fingerprint);
      return true;
    }
  } catch {
    // The main collector keeps retrying the queued task.
  }
  return false;
}

if (ytMetricIsAccountPage()) {
  const retryDelays = [4500, 8500, 13500, 20000, 30000];
  for (const delay of retryDelays) {
    setTimeout(() => ytMetricSend().catch(() => null), delay);
  }
}

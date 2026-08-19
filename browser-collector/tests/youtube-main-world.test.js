const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "youtube-main-world.js"), "utf8");
let published = "";

const documentElement = {
  setAttribute(name, value) {
    if (name === "data-media-ops-yt-account-metrics") published = value;
  }
};

const context = {
  window: {
    ytInitialData: {
      metadata: {
        channelMetadataRenderer: {
          title: "Example Channel",
          externalId: "UC12345678901234567890",
          vanityChannelUrl: "https://www.youtube.com/@example"
        }
      },
      header: {
        subscriberCountText: { simpleText: "1.23K subscribers" },
        videosCountText: { runs: [{ text: "45 videos" }] }
      }
    },
    addEventListener() {}
  },
  document: {
    documentElement,
    dispatchEvent() {}
  },
  location: {
    hostname: "www.youtube.com",
    pathname: "/@example/videos",
    origin: "https://www.youtube.com"
  },
  CustomEvent: function CustomEvent(type) { this.type = type; },
  setTimeout(callback) { callback(); return 1; },
  clearTimeout() {},
  console
};
context.globalThis = context;

vm.runInNewContext(source, context, { filename: "youtube-main-world.js" });
assert.ok(published, "main-world parser did not publish account metrics");
const metrics = JSON.parse(published);
assert.equal(metrics.followers, 1230);
assert.equal(metrics.content_count, 45);
assert.equal(metrics.title, "Example Channel");
assert.equal(metrics.external_id, "UC12345678901234567890");
assert.equal(metrics.profile_url, "https://www.youtube.com/@example");
console.log("youtube main-world account metrics ok");

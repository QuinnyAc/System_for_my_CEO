# Media Ops Public Metrics Collector

This Chrome extension is the simple/default collection mode for Media Ops.

It only reads metrics that are already visible on social media pages opened by the user. It does not automate login, navigation, likes, comments, follows, posting, or any access-control bypass.

Supported targets:

- YouTube channel and video/Shorts pages
- Instagram public profile and post/Reel pages when counts are visible
- Facebook public Page/post/video/Reel pages when counts are visible
- Pinterest public profile/Pin pages when counts are visible

Because social platforms change their page markup frequently, missing values are intentionally skipped rather than guessed or uploaded as fabricated data.

## One-time setup per computer

1. Start the central Media Ops Codespace.
2. Run `bash .devcontainer/show-collector-config.sh` in the central Codespace and copy the Collector URL and Token privately.
3. Open Chrome `chrome://extensions`.
4. Enable Developer mode.
5. Choose Load unpacked and select this `browser-collector` folder.
6. Open the extension options page.
7. Enter the Collector URL, Collector Token, and a unique computer name.
8. Click Test connection.

After that, simply browse the supported social media pages normally. The extension waits for the page to settle, reads visible counts, and sends changed values to the central database. Identical values are not repeatedly uploaded from the same page session, and the server also suppresses unchanged snapshots within 30 minutes.

## Security

The Collector Token is stored in `chrome.storage.local`, not Chrome Sync. Do not commit it to Git or paste it into chat.

// Groups the tabs an agent works in under its name, and tells the viewer when the
// human picks a different tab, so the two always show the same session.
const COLORS = { claude: "orange", hermes: "blue", codex: "green", gemini: "yellow", antigravity: "purple", cursor: "pink" };
let queue = Promise.resolve();

const group = async (tab, name) => {
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
  // Only normal windows have tab groups. Grouping a tab in a popup window (a sign-in
  // popup opened with window.open and a size) crashes Brave instead of failing.
  const win = await chrome.windows.get(tab.windowId);
  if (win.type !== "normal") return;
  const [existing] = await chrome.tabGroups.query({ windowId: tab.windowId, title: name });
  const groupId = await chrome.tabs.group({
    tabIds: tab.id,
    ...(existing ? { groupId: existing.id } : { createProperties: { windowId: tab.windowId } }),
  });
  if (!existing) {
    await chrome.tabGroups.update(groupId, { title: name, color: COLORS[name.toLowerCase().replace(/ \d+$/, "")] ?? "grey" });
  }
};

const remember = async (tabId, session, viewer) => {
  const { owners = {} } = await chrome.storage.session.get("owners");
  owners[tabId] = session;
  await chrome.storage.session.set({ owners, viewer });
  await learned(tabId, session);
};

// The session whose tab the viewer last took as the one in front. Kept so the
// extension can correct the viewer when it learns a tab's owner too late.
let reported;

const report = async (tabId) => {
  const { owners = {}, viewer } = await chrome.storage.session.get(["owners", "viewer"]);
  if (!viewer) return null;
  const session = owners[tabId] ?? null;
  const res = await fetch(`${viewer}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session }),
  }).catch(() => null);
  if (!res?.ok) return null;
  // An older viewer says nothing back, and takes every report.
  const { taken = true, retry = 0 } = await res.json().catch(() => ({}));
  if (taken) reported = session;
  return taken ? null : retry;
};

// The tab on screen: the active tab of the window that has focus.
const inFront = async () => {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win?.focused) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  return tab ?? null;
};

chrome.tabs.onActivated.addListener(({ tabId }) => { report(tabId); });

// Each session's tab sits in a window of its own, and moving between windows
// activates no tab.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) report(tab.id);
});

// A tab is reported before the agent's first cursor message names its owner,
// so the viewer takes it for one of the human's own. Correct that once the owner is known.
// The viewer turns reports down while an agent is opening tabs, so ask again after that.
const learned = async (tabId, session) => {
  const front = await inFront();
  if (front?.id !== tabId || session === reported) return;
  const retry = await report(tabId);
  if (retry !== null && retry < 60000) setTimeout(() => learned(tabId, session), retry + 100);
};

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Any page can reach this listener, so only ever talk to the viewer on this machine.
  // One at a time, or two tabs that learn their owner at once overwrite each other.
  if (msg.session && sender.tab && /^http:\/\/127\.0\.0\.1:\d+$/.test(msg.viewer)) {
    queue = queue.then(() => remember(sender.tab.id, msg.session, msg.viewer)).catch(() => {});
  }
  if (msg.group && sender.tab) queue = queue.then(() => group(sender.tab, msg.group)).catch(() => {});
});

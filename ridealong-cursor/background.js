// Groups the tabs an agent works in under its name, and tells the viewer when the
// human picks a different tab, so the two always show the same session.
const COLORS = { claude: "orange", hermes: "blue" };
let queue = Promise.resolve();

const group = async (tab, name) => {
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;
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
};

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { owners = {}, viewer } = await chrome.storage.session.get(["owners", "viewer"]);
  if (!viewer) return;
  fetch(`${viewer}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: owners[tabId] ?? null }),
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.session && sender.tab) remember(sender.tab.id, msg.session, msg.viewer);
  if (msg.reveal && sender.tab) chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
  if (msg.group && sender.tab) queue = queue.then(() => group(sender.tab, msg.group)).catch(() => {});
});

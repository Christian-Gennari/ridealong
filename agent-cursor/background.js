// Groups the tabs an agent works in under its name, and brings its tab forward.
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

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.reveal && sender.tab) chrome.tabs.update(sender.tab.id, { active: true }).catch(() => {});
  if (msg.group && sender.tab) queue = queue.then(() => group(sender.tab, msg.group)).catch(() => {});
});

const autoScrollStateByTab = {};

chrome.runtime.onInstalled.addListener(() => {
    chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
        chrome.declarativeContent.onPageChanged.addRules([
            {
                conditions: [
                    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: "www.facebook.com", pathPrefix: "/reel" } }),
                    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: "www.youtube.com", pathPrefix: "/shorts" } }),
                    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: "www.instagram.com", pathPrefix: "/reels" } }),
                    new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: "www.tiktok.com" } })
                ],
                actions: [new chrome.declarativeContent.ShowAction()]
            }
        ]);
    });
});

chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;
    const tabId = tab.id;

    chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.autoScrollInjected
    }).then((results) => {
        if (!(results && results[0] && results[0].result)) {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ["content.js"]
            }).catch(() => { });
        }
    });

    const currentState = autoScrollStateByTab[tabId] || false;
    const newState = !currentState;
    autoScrollStateByTab[tabId] = newState;
    updateIcon(tabId, newState);

    chrome.tabs.sendMessage(tabId, { action: "setAutoScroll", enabled: newState });
});

function updateIcon(tabId, isOn) {
    const iconFile = isOn ? "colored-active.png" : "colored-inactive.png";
    chrome.action.setIcon({
        tabId,
        path: {
            "16": chrome.runtime.getURL(`icons/16/${iconFile}`),
            "32": chrome.runtime.getURL(`icons/32/${iconFile}`),
            "48": chrome.runtime.getURL(`icons/48/${iconFile}`),
            "128": chrome.runtime.getURL(`icons/128/${iconFile}`)
        }
    });
}

chrome.tabs.onRemoved.addListener((tabId) => {
    delete autoScrollStateByTab[tabId];
});

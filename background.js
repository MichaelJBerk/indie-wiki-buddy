if (typeof importScripts !== 'undefined') {
  importScripts('scripts/common-functions.js');
}

function onTabUpdated(_tabId, _changeInfo, tab) {
  main(tab.url, tab.id);
}
chrome.tabs.onUpdated.addListener(onTabUpdated);

let cachedStorage = {};

function getLocalStorageData() {
  // Wrap the extensionAPI.storage.sync.get method in a promise
  // Needed for Firefox manifest v2
  return new Promise((resolve, reject) => {
      extensionAPI.storage.local.get(null, (items) => {
        resolve(items);
      });
  });
}

function getSyncStorageData() {
  // Wrap the extensionAPI.storage.sync.get method in a promise
  // Needed for Firefox manifest v2
  return new Promise((resolve, reject) => {
      extensionAPI.storage.sync.get(null, (items) => {
        resolve(items);
      });
  });
}

async function updateCachedStorage() {
  let localStorage = await getLocalStorageData();
  let syncStorage = await getSyncStorageData();
  cachedStorage = {...localStorage, ...syncStorage};
}

async function getCachedStorage() {
  if (Object.keys(cachedStorage).length === 0) {
    await updateCachedStorage();
  }
  return cachedStorage;
}

// Cache Chrome's storage in memory so that we don't need to make repeated calls
updateCachedStorage();

// Listen for user turning extension on or off, to update icon
extensionAPI.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.action === 'updateIcon') {
    setPowerIcon(msg.value);
  } else if (msg.action === 'getStorage') {
    getCachedStorage().then((res) => {
      sendResponse(res);
      return res;
    });
    return true;
  }
});

// Listen for browser starting, to set initial icon state
extensionAPI.runtime.onStartup.addListener(() => {
  extensionAPI.storage.local.get({ 'power': 'on' }, (item) => {
    setPowerIcon(item.power);
  });
});

// Listen for changes to stored data, and updated our cached data
extensionAPI.storage.onChanged.addListener(() => {
  updateCachedStorage();
})

// Listen for extension installed/updating
extensionAPI.runtime.onInstalled.addListener(async (detail) => {
  // Set initial icon state
  extensionAPI.storage.local.get({ 'power': 'on' }, (item) => {
    setPowerIcon(item.power);
  });

  // If new install, open settings with starter guide
  if (detail.reason === 'install') {
    extensionAPI.tabs.create({ url: 'pages/settings/index.html?newinstall=true' });
  }

  // If update, open changelog if setting is enabled
  extensionAPI.storage.sync.get({ 'openChangelog': 'off' }, (item) => {
    if (item.openChangelog === 'on' && detail.reason === 'update') {
      extensionAPI.tabs.create({ url: 'https://getindie.wiki/changelog/?updated=true', active: false });
    }
  });

  // Temporary functions for 3.0 migration
  // SAFARI-DIFF (not needed since Safari started with v3)
  // if (detail.reason === 'update') {
  //   commonFunctionMigrateToV3();
  // }
});

function setPowerIcon(status) {
  const manifestVersion = extensionAPI.runtime.getManifest().manifest_version;
  if (status === 'on') {
    if (manifestVersion === 2) {
      extensionAPI.browserAction.setIcon({ path: "/images/logo-128.png" });
    } else {
      extensionAPI.action.setIcon({ path: "/images/logo-128.png" });
    }
  } else {
    if (manifestVersion === 2) {
      extensionAPI.browserAction.setIcon({ path: "/images/logo-off.png" });
    } else {
      extensionAPI.action.setIcon({ path: "/images/logo-off.png" });
    }
  }
}

function redirectToBreezeWiki(storage, tabId, url) {
  function processRedirect(host) {
    // Extract article from URL
    const urlFormatted = new URL(url);
    urlFormatted.search = '';
    const subdomain = urlFormatted.hostname.split(".")[0];
    const article = String(urlFormatted).split('fandom.com/wiki/')[1].replaceAll('%20', '_');

    // Perform redirect
    if (article) {
      extensionAPI.tabs.update(tabId, { url: host + '/' + subdomain + '/wiki/' + article });
    } else {
      extensionAPI.tabs.update(tabId, { url: host + '/' + subdomain });
    }

    // Increase BreezeWiki stat count
    extensionAPI.storage.sync.set({ 'countBreezeWiki': (storage.countBreezeWiki ?? 0) + 1 });

    // SAFARI-DIFF (Safari currently does not support notifications)
    // if ((storage.notifications ?? 'on') === 'on') {
    //  // Notify that user is being redirected to BreezeWiki
    //   let notifID = 'independent-wiki-redirector-notification-' + Math.floor(Math.random() * 1E16);
    //   extensionAPI.notifications.create(notifID, {
    //     "type": "basic",
    //     "iconUrl": 'images/logo-48.png',
    //     "title": "You've been redirected to BreezeWiki!",
    //     "message": "Indie Wiki Buddy has sent you to BreezeWiki for a cleaner, ad-free experience on Fandom."
    //   });
    //   // Self-clear notification after 6 seconds
    //   setTimeout(() => { extensionAPI.notifications.clear(notifID); }, 6000);
    // }
  }

  if (url.includes('fandom.com/wiki/') && !url.includes('fandom=allow')) {
    if (!(storage.breezewikiHost ?? null)) {
      fetch('https://bw.getindie.wiki/instances.json')
        .then((response) => {
          if (response.ok) {
            return response.json();
          }
          throw new Error('Indie Wiki Buddy failed to get BreezeWiki data.');
        }).then((breezewikiHosts) => {
          breezewikiHosts = breezewikiHosts.filter(host =>
            extensionAPI.runtime.getManifest().version.localeCompare(host.iwb_version,
              undefined,
              { numeric: true, sensitivity: 'base' }
            ) >= 0
          );
          // Check if BreezeWiki's main site is available
          let breezewikiMain = breezewikiHosts.filter(host => host.instance === 'https://breezewiki.com');
          if (breezewikiMain.length > 0) {
            extensionAPI.storage.sync.set({ 'breezewikiHost': breezewikiMain[0].instance });
          } else {
            // If BreezeWiki.com is not available, set to a random mirror
            try {
              extensionAPI.storage.sync.set({ 'breezewikiHost': breezewikiHosts[Math.floor(Math.random() * breezewikiHosts.length)].instance });
            } catch (e) {
              console.log('Indie Wiki Buddy failed to get BreezeWiki data: ' + e);
            }
          }
          extensionAPI.storage.sync.set({ 'breezewikiHostOptions': breezewikiHosts });
          extensionAPI.storage.sync.set({ 'breezewikiHostFetchTimestamp': Date.now() });
          processRedirect(host);
        }).catch((e) => {
          console.log('Indie Wiki Buddy failed to get BreezeWiki data: ' + e);
          extensionAPI.storage.sync.set({ 'breezewikiHost': 'https://breezewiki.com' });
        });
    } else {
      if (storage.breezewikiHost === 'CUSTOM') {
        processRedirect(storage.breezewikiCustomHost || 'https://breezewiki.com');
      } else {
        processRedirect(storage.breezewikiHost);
      }
    }
  }
}

async function main(url, tabId) {
  let storage = await getCachedStorage();

  if ((storage.power ?? 'on') === 'on') {
    let crossLanguageSetting = storage.crossLanguage || 'off';
    let matchingSite = await commonFunctionFindMatchingSite(url, crossLanguageSetting);

    if (matchingSite) {
      // Get user's settings for the wiki
      let settings = await commonFunctionDecompressJSON(storage.wikiSettings) || {};
      let id = matchingSite['id'];
      let siteSetting = settings[id] || storage.defaultWikiAction || 'alert';

      // Check if redirects are enabled for the site
      if (siteSetting === 'redirect') {
        let newURL = commonFunctionGetNewURL(url, matchingSite);

        // Perform redirect
        extensionAPI.tabs.update(tabId, { url: newURL });

        // Increase redirect count
        extensionAPI.storage.sync.set({ 'countRedirects': (storage.countRedirects ?? 0) + 1 });

        // SAFARI-DIFF (Safari currently does not support notifications)
        // // Notify if enabled
        // if ((storage.notifications ?? 'on') === 'on') {
        //   // Notify that user is being redirected
        //   let notifID = 'independent-wiki-redirector-notification-' + Math.floor(Math.random() * 1E16);
        //   extensionAPI.notifications.create(notifID, {
        //     "type": "basic",
        //     "iconUrl": 'images/logo-48.png',
        //     "title": "You've been redirected!",
        //     "message": "Indie Wiki Buddy has sent you from " + matchingSite['origin'] + " to " + matchingSite['destination']
        //   });
        //   // Self-clear notification after 6 seconds
        //   setTimeout(() => { extensionAPI.notifications.clear(notifID); }, 6000);
        // }
      } else if ((storage.breezewiki ?? 'off') === 'on' || (storage.breezewiki ?? 'off') === 'redirect') {
        redirectToBreezeWiki(storage, tabId, url);
      }
    } else if ((storage.breezewiki ?? 'off') === 'on' || (storage.breezewiki ?? 'off') === 'redirect') {
      redirectToBreezeWiki(storage, tabId, url);
    }
  }
}

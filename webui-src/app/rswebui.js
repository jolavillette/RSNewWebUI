const m = require('mithril');

const RsEventsType = {
  NONE: 0, // Used internally to detect invalid event type passed

  // @see RsBroadcastDiscovery
  BROADCAST_DISCOVERY: 1,

  // @see RsDiscPendingPgpReceivedEvent
  GOSSIP_DISCOVERY: 2,

  // @see AuthSSL
  AUTHSSL_CONNECTION_AUTENTICATION: 3,

  // @see pqissl
  PEER_CONNECTION: 4,

  // @see RsGxsChanges, used also in @see RsGxsBroadcast
  GXS_CHANGES: 5,

  // Emitted when a peer state changes, @see RsPeers
  PEER_STATE_CHANGED: 6,

  // @see RsMailStatusEvent
  MAIL_STATUS: 7,

  // @see RsGxsCircleEvent
  GXS_CIRCLES: 8,

  // @see RsGxsChannelEvent
  GXS_CHANNELS: 9,

  // @see RsGxsForumEvent
  GXS_FORUMS: 10,

  // @see RsGxsPostedEvent
  GXS_POSTED: 11,

  // @see RsGxsPostedEvent
  GXS_IDENTITY: 12,

  // @see RsFiles @deprecated
  SHARED_DIRECTORIES: 13,

  // @see RsFiles
  FILE_TRANSFER: 14,

  // @see RsMsgs
  CHAT_MESSAGE: 15,

  // @see rspeers.h
  NETWORK: 16,

  // @see RsMailTagEvent
  MAIL_TAG: 17,

  /** Emitted to update library clients about file hashing being completed */
  FILE_HASHING_COMPLETED: 20,

  // @see rspeers.h
  TOR_MANAGER: 21,

  // @see rsfriendserver.h
  FRIEND_SERVER: 22,

  // _MAX //used internally, keep last
};

const API_URL = 'http://127.0.0.1:9092';
const loginKey = {
  username: localStorage.getItem('rs_username') || '',
  passwd: localStorage.getItem('rs_passwd') || '',
  isVerified: localStorage.getItem('rs_isVerified') === 'true',
  url: localStorage.getItem('rs_url') || API_URL,
};

// Make this as object property?
function setKeys(username, password, url = API_URL, verified = true) {
  loginKey.username = username;
  loginKey.passwd = password;
  loginKey.url = url;
  loginKey.isVerified = verified;

  if (verified) {
    localStorage.setItem('rs_username', username);
    localStorage.setItem('rs_passwd', password);
    localStorage.setItem('rs_url', url);
    localStorage.setItem('rs_isVerified', 'true');
  } else {
    localStorage.removeItem('rs_isVerified');
  }
}

function logout() {
  setKeys('', '', loginKey.url, false);
  m.route.set('/');
}

function rsJsonApiRequest(
  path,
  data = {},
  callback = () => { },
  async = true,
  headers = {},
  handleDeserialize = JSON.parse,
  handleSerialize = JSON.stringify,
  config = null
) {
  console.warn('[RS-DEBUG] rsJsonApiRequest called for path:', path, 'with config:', !!config);
  headers['Accept'] = 'application/json';
  if (loginKey.isVerified) {
    if (loginKey.username && loginKey.passwd) {
      headers['Authorization'] = 'Basic ' + btoa(loginKey.username + ':' + loginKey.passwd);
    } else {
      console.warn('[RS-DEBUG] API Request with isVerified=true but missing username/password for path:', path);
    }
  }
  // NOTE: After upgrading to mithrilv2, options.extract is no longer required
  // since the status will become part of return value and then
  // handleDeserialize can also be simply passed as options.deserialize
  return m
    .request({
      method: 'POST',
      url: loginKey.url + path,
      async,
      extract: (xhr) => {
        // Empty string is not valid json and fails on parse
        const response = xhr.responseText || '""';
        return {
          status: xhr.status,
          statusText: xhr.statusText,
          body: handleDeserialize(response),
        };
      },
      serialize: handleSerialize,
      headers,
      body: data,

      xhr: config,
    })
    .then((result) => {
      if (result.status === 200) {
        try {
          callback(result.body, true);
        } catch (e) {
          console.error('[RS] Error in success callback for path:', path, e);
        }
      } else {
        if (result.status === 401) {
          setKeys(loginKey.username, loginKey.passwd, loginKey.url, false);
          m.route.set('/');
        }
        try {
          callback(result, false);
        } catch (e) {
          console.error('[RS] Error in error callback for path:', path, e);
        }
      }
      return result;
    })
    .catch(function (e) {
      try {
        callback(e, false);
      } catch (cbErr) {
        console.error('[RS-DEBUG] Error in catch callback for path:', path, cbErr);
      }
      console.error('[RS-DEBUG] Error: While sending request for path:', path, '\ninfo:', e);
    });
}

function setBackgroundTask(task, interval, taskInScope) {
  // Always use bound(.bind) function when accsssing outside objects
  // to avoid loss of scope
  task();
  let taskId = setTimeout(function caller() {
    if (taskInScope()) {
      task();
      taskId = setTimeout(caller, interval);
    } else {
      clearTimeout(taskId);
    }
  }, interval);
  return taskId;
}

function computeIfMissing(map, key, missing = () => ({})) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] = missing();
  }
  return map[key];
}

function deeperIfExist(map, key, action) {
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    action(map[key]);
    return true;
  } else {
    return false;
  }
}

const eventQueue = {
  events: {
    [RsEventsType.CHAT_MESSAGE]: {
      // Chat-Messages
      types: {
        //                #define RS_CHAT_TYPE_PUBLIC  1
        //                #define RS_CHAT_TYPE_PRIVATE 2

        2: (chatId) => (typeof chatId.peer_id === 'object' ? chatId.peer_id.xstr64 : chatId.peer_id), // RS_CHAT_TYPE_PRIVATE
        3: (chatId) => (typeof chatId.lobby_id === 'object' ? chatId.lobby_id.xstr64 : chatId.lobby_id), // RS_CHAT_TYPE_LOBBY
        4: (chatId) => (typeof chatId.distant_chat_id === 'object' ? chatId.distant_chat_id.xstr64 : chatId.distant_chat_id), // RS_CHAT_TYPE_DISTANT
      },
      messages: {},
      chatMessages: (chatId, owner, action) => {
        if (
          !deeperIfExist(owner.types, chatId.type, (keyfn) =>
            action(
              computeIfMissing(
                computeIfMissing(owner.messages, chatId.type),
                keyfn(chatId),

                () => []
              )
            )
          )
        ) {
          console.info('unknown chat event', chatId);
        }
      },
      handler: (event, owner) => {
        if (event && event.mChatMessage && event.mChatMessage.chat_id) {
          owner.chatMessages(event.mChatMessage.chat_id, owner, (r) => {
            r.push(event.mChatMessage);
            owner.notify(event.mChatMessage);
          });
        } else if (event && event.mCid) {
          // Administrative chat event (e.g. lobby info change, peer join/leave)
          // Silent for now to avoid console spam, as actual messages use mChatMessage
        } else if (event && event.mLobbyId) {
          // It's a lobby update/event, not a message.
        } else {
          console.warn('[RS-DEBUG] Received unknown CHAT_MESSAGE event structure:', event);
        }
      },
      notify: () => { },
    },
    [RsEventsType.GXS_CIRCLES]: {
      // Circles (ignore in the meantime)
      handler: (event, owner) => { },
    },
    [RsEventsType.SHARED_DIRECTORIES]: {
      // Deprecated/Administrative (ignore quietly)
      handler: (event, owner) => { },
    },
  },
  handler: (event) => {
    console.warn('[RS-DEBUG] Event queue handler received type:', event.mType);
    if (!deeperIfExist(eventQueue.events, event.mType, (owner) => owner.handler(event, owner))) {
      console.info('[RS-DEBUG] unhandled event', event);
    }
  },
};

const userList = {
  users: [],
  userMap: {},
  pendingIds: new Set(),
  fetchTimer: null,

  triggerFetch: () => {
    if (userList.fetchTimer) return;
    userList.fetchTimer = setTimeout(() => {
      userList.fetchTimer = null;
      if (userList.pendingIds.size === 0) return;

      const ids = Array.from(userList.pendingIds);
      userList.pendingIds.clear();

      console.info('[RS-DEBUG] Fetching info for ' + ids.length + ' unknown identities...');

      rsJsonApiRequest('/rsIdentity/getIdentitiesInfo', { ids }, (data, success) => {
        if (success && data.idsInfo) {
          let count = 0;
          data.idsInfo.forEach((info) => {
            if (info.mMeta && info.mMeta.mGroupId) {
              userList.userMap[info.mMeta.mGroupId] = info.mMeta.mGroupName;
              count++;
            }
          });
          console.info('[RS-DEBUG] Resolved ' + count + ' identities.');
          m.redraw();
        } else {
          console.warn('[RS-DEBUG] Failed to fetch identities info.', data);
        }
      });
    }, 2000);
  },

  loadUsers: () => {
    rsJsonApiRequest('/rsIdentity/getIdentitiesSummaries', {}, (list) => {
      if (list !== undefined) {
        console.info('[RS-DEBUG] loading ' + list.ids.length + ' users ...');
        userList.users = list.ids;
        userList.userMap = list.ids.reduce((a, c) => {
          a[c.mGroupId] = c.mGroupName;
          // Also map by direct hex name if provided in some responses
          if (c.mId) a[c.mId] = c.mGroupName;
          return a;
        }, {});
      }
    });
  },
  username: (id) => {
    if (!id) return '';
    const name = userList.userMap[id];
    if (!name && id.length > 10) { // Avoid fetching short/invalid IDs
      if (!userList.pendingIds.has(id)) {
        userList.pendingIds.add(id);
        userList.triggerFetch();
      }
      return id; // Return ID while fetching
    }
    return name || id;
  },
};

/*
  path,
  data = {},
  callback = () => {},
  async = true,
  headers = {},
  handleDeserialize = JSON.parse,
  handleSerialize = JSON.stringify
  config
*/
function startEventQueue(
  info,
  loginHeader = {},
  displayAuthError = () => { },
  displayErrorMessage = () => { },
  successful = () => { }
) {
  console.warn('[RS-DEBUG] startEventQueue starting raw XHR for:', info);
  const xhr = new window.XMLHttpRequest();
  let lastIndex = 0;
  xhr.open('POST', loginKey.url + '/rsEvents/registerEventsHandler', true);

  // Set headers for authentication
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    ...loginHeader,
  };

  if (loginKey.isVerified && !headers['Authorization']) {
    if (loginKey.username && loginKey.passwd) {
      console.warn('[RS-DEBUG] Setting persistent Auth header for event queue');
      headers['Authorization'] = 'Basic ' + btoa(loginKey.username + ':' + loginKey.passwd);
    } else {
      console.warn('[RS-DEBUG] Missing credentials for event queue auth');
    }
  }

  Object.keys(headers).forEach((key) => {
    xhr.setRequestHeader(key, headers[key]);
  });

  xhr.onreadystatechange = () => {
    console.warn('[RS-DEBUG] Event Queue XHR state changed:', xhr.readyState, 'status:', xhr.status);
    if (xhr.readyState === 4) {
      if (xhr.status === 401) {
        displayAuthError('Incorrect login/password.');
      } else if (xhr.status === 0) {
        console.error('[RS-DEBUG] Event Queue connection failed (status 0)');
      }
    }
  };

  xhr.onprogress = (ev) => {
    const currIndex = xhr.responseText.length;
    if (currIndex > lastIndex) {
      const parts = xhr.responseText.substring(lastIndex, currIndex);
      lastIndex = currIndex;
      console.warn('[RS-DEBUG] RAW DATA RECEIVED:', parts);
      parts
        .trim()
        .split('\n\n')
        .filter((e) => e.trim().length > 0)
        .forEach((e) => {
          if (e.startsWith('data: {')) {
            try {
              const data = JSON.parse(e.substr(6));
              console.warn('[RS-DEBUG] PARSED EVENT:', data);
              if (Object.prototype.hasOwnProperty.call(data, 'retval')) {
                console.info(
                  '[RS-DEBUG] ' + info + ' [' + data.retval.errorCategory + '] ' + data.retval.errorMessage
                );
                data.retval.errorNumber === 0
                  ? successful()
                  : displayErrorMessage(
                    `[RS-DEBUG] ${info} failed: [${data.retval.errorCategory}] ${data.retval.errorMessage}`
                  );
              } else if (Object.prototype.hasOwnProperty.call(data, 'event')) {
                data.event.queueSize = currIndex;
                try {
                  eventQueue.handler(data.event);
                } catch (err) {
                  console.error('[RS-DEBUG] Error in event handler:', err, data.event);
                }
              }
            } catch (err) {
              console.error('[RS-DEBUG] JSON parse error for part:', e, err);
            }
          } else {
            console.info('[RS-DEBUG] Ignored non-data part:', e);
          }
        });
      if (currIndex > 1e6) {
        // max 1 MB eventQueue
        console.warn('[RS-DEBUG] Restarting event queue (size > 1MB)');
        startEventQueue('restart queue');
        xhr.abort();
      }
    }
  };

  xhr.onload = () => {
    console.warn('[RS-DEBUG] Event Queue XHR load finished. Status:', xhr.status);
  };

  xhr.onerror = (err) => {
    console.error('[RS-DEBUG] Event Queue XHR error occurred:', err);
  };

  // We need to send an eventType to registerEventsHandler
  // 0 means all events
  xhr.send(JSON.stringify({ eventType: 0 }));
  return xhr;
}

function logon(loginHeader, displayAuthError, displayErrorMessage, successful) {
  startEventQueue('login', loginHeader, displayAuthError, displayErrorMessage, () => {
    successful();
    userList.loadUsers();
  });
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

module.exports = {
  rsJsonApiRequest,
  setKeys,
  setBackgroundTask,
  logon,
  events: eventQueue.events,
  RsEventsType,
  userList,
  loginKey,
  formatBytes,
  logout,
};

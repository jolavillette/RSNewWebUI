const m = require('mithril');
const rs = require('rswebui');
const peopleUtil = require('people/people_util');

// **************** utility functions ********************

function loadLobbyDetails(id, apply) {
  rs.rsJsonApiRequest(
    '/rsChats/getChatLobbyInfo',
    {
      id,
    },
    (detail, success) => {
      if (success && detail.retval) {
        detail.info.chatType = 3; // LOBBY
        apply(detail.info);
      } else {
        apply(null);
      }
    },
    true,
    {},
    undefined,
    () => '{"id":' + id + '}'
  );
}

function loadDistantChatDetails(pid, apply) {
  // pid is DistantChatPeerId (uint32)
  rs.rsJsonApiRequest(
    '/rsChats/getDistantChatStatus',
    {
      pid: parseInt(pid),
    },
    (detail, success) => {
      if (success && detail.retval) {
        // Map to lobby-like structure for UI compatibility
        const info = detail.info;
        info.chatType = 4; // DISTANT
        info.lobby_name = rs.userList.username(info.to_id) || 'Distant Chat ' + pid;
        info.lobby_topic = 'Private Encrypted Chat';
        info.gxs_id = info.own_id;
        info.lobby_id = { xstr64: pid.toString() }; // Mock lobby_id for keying
        apply(info);
      } else {
        console.error('[RS-DEBUG] Failed to load distant chat info for PID:', pid);
        apply(null);
      }
    },
    true
  );
}

function sortLobbies(lobbies) {
  if (lobbies !== undefined && lobbies !== null) {
    const list = [...lobbies];
    list.sort((a, b) => a.lobby_name.localeCompare(b.lobby_name));
    return list;
  }
  return []; // return empty array instead of undefined
}

// ***************************** models ***********************************

const MobileState = {
  showLobbies: false,
  showUsers: false,
  toggleLobbies() {
    this.showLobbies = !this.showLobbies;
    this.showUsers = false;
  },
  toggleUsers() {
    this.showUsers = !this.showUsers;
    this.showLobbies = false;
  },
  closeAll() {
    this.showLobbies = false;
    this.showUsers = false;
  },
};


const ChatRoomsModel = {
  allRooms: [],
  knownSubscrIds: [], // to exclude subscribed from public rooms (subscribedRooms filled to late)
  subscribedRooms: {},
  loadPublicRooms() {
    // TODO: this doesn't preserve id of rooms,
    // use regex on response to extract ids.
    rs.rsJsonApiRequest(
      '/rsChats/getListOfNearbyChatLobbies',
      {},
      (data) => {
        if (data && data.public_lobbies) {
          // Deduplicate by ID to avoid double display if backend returns redundant info
          const seen = new Set();
          const uniqueLobbies = data.public_lobbies.filter((lobby) => {
            const id = lobby.lobby_id.xstr64;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          ChatRoomsModel.allRooms = sortLobbies(uniqueLobbies);
        } else {
          console.warn('[RS-DEBUG] No public lobbies found or malformed response:', data);
          ChatRoomsModel.allRooms = [];
        }
      }
    );
  },
  loadSubscribedRooms(after = null) {
    rs.rsJsonApiRequest(
      '/rsChats/getChatLobbyList',
      {},
      (data) => {
        if (data && data.cl_list) {
          // Robust deduplication of IDs
          const ids = [...new Set(data.cl_list.map((lid) => lid.xstr64))];
          ChatRoomsModel.knownSubscrIds = ids;

          // Remove stale entries that are no longer in the subscribed list
          Object.keys(ChatRoomsModel.subscribedRooms).forEach((id) => {
            if (!ids.includes(id)) {
              delete ChatRoomsModel.subscribedRooms[id];
            }
          });

          if (ids.length === 0) {
            ChatRoomsModel.loadPublicRooms();
            if (after != null) after();
            m.redraw();
            return;
          }

          let count = 0;
          ids.forEach((id) =>
            loadLobbyDetails(id, (info) => {
              if (info) {
                ChatRoomsModel.subscribedRooms[id] = info;
              }
              count++;
              if (count === ids.length) {
                ChatRoomsModel.loadPublicRooms(); // Load public rooms after we know all subscribed IDs
                if (after != null) {
                  after();
                }
                m.redraw();
              }
            })
          );
        } else {
          console.warn('[RS-DEBUG] No subscribed lobbies found or malformed response:', data);
          ChatRoomsModel.loadPublicRooms();
        }
      }
    );
  },
  subscribed(info) {
    return this.knownSubscrIds.includes(info.lobby_id.xstr64);
  },
};

/**
 * Message displays a single Chat-Message<br>
 * currently removes formatting and in consequence inline links
 * msg: Message to Display
 */
const Message = () => {
  return {
    view: (vnode) => {
      const msg = vnode.attrs;
      const datetime = new Date(msg.sendTime * 1000).toLocaleTimeString();
      // Handle both HistoryMsg (peerId) and ChatMessage (lobby_peer_gxs_id)
      const rawGxsId = msg.lobby_peer_gxs_id || msg.peerId;
      const gxsId =
        rawGxsId && typeof rawGxsId === 'object' ? rawGxsId.xstr64 : rawGxsId;
      let username = rs.userList.username(gxsId) || msg.peerName || '???';
      // If we only have the hex ID, try to fallback to the peerName from the message
      if (username === gxsId && msg.peerName) {
        username = msg.peerName;
      }
      if (username === gxsId && gxsId && gxsId.length > 12) {
        username = gxsId.substring(0, 8) + '...';
      }
      const text = (msg.msg || msg.message || '')
        .replaceAll('<br/>', '\n')
        .replace(new RegExp('<style[^<]*</style>|<[^>]*>', 'gm'), '');
      return m(
        '.message',
        m('span.datetime', datetime),
        m('span.username', username),
        m('span.messagetext', text)
      );
    },
  };
};

const ChatLobbyModel = {
  currentLobby: {
    lobby_name: '...',
  },
  lobby_user: '...',
  isSubscribed: false,
  messages: [],
  users: [],
  messageKeys: new Set(),
  lastLobbyId: null,

  // Helper to generate a unique key for deduplication
  getMessageKey(msg) {
    if (msg.msgId && msg.msgId !== 0) return 'id_' + msg.msgId;
    // Fallback for live messages or history without IDs
    const text = msg.msg || msg.message || '';
    return 't_' + msg.sendTime + '_' + text.substring(0, 32);
  },

  addMessages(newMsgs, scroll = false) {
    let added = false;
    newMsgs.forEach((msg) => {
      const key = this.getMessageKey(msg);
      if (!this.messageKeys.has(key)) {
        this.messageKeys.add(key);
        this.messages.push(m(Message, msg));
        added = true;
      }
    });

    if (added) {
      this.messages.sort((a, b) => a.attrs.sendTime - b.attrs.sendTime);
      m.redraw();
      if (scroll) {
        setTimeout(() => {
          const element = document.querySelector('.messages');
          if (element) {
            element.scrollTop = element.scrollHeight;
          }
        }, 100);
      }
    }
  },

  loadHistory(id, type) {
    const chatPeerId = {
      broadcast_status_peer_id: { xstr64: '0' },
      type: type,
      peer_id: { xstr64: '0' },
      distant_chat_id: { xstr64: '0' },
      lobby_id: { xstr64: '0' },
    };

    if (type === 3) chatPeerId.lobby_id.xstr64 = id;
    else if (type === 4) chatPeerId.distant_chat_id = parseInt(id); // DistantChatPeerId is uint32
    else if (type === 2) chatPeerId.peer_id.xstr64 = id;

    rs.rsJsonApiRequest(
      '/rsHistory/getMessages',
      {
        chatPeerId: chatPeerId,
        loadCount: 20,
      },
      (data, success) => {
        if (success && data.msgs) {
          this.addMessages(data.msgs);
        }
      }
    );
  },
  setupAction: (lobbyId, nick) => { },
  setIdentity(lobbyId, nick) {
    rs.rsJsonApiRequest(
      '/rsChats/setIdentityForChatLobby',
      {},
      () => m.route.set('/chat/:lobby_id', { lobbyId }),
      true,
      {},
      JSON.parse,
      () => '{"lobby_id":' + lobbyId + ',"nick":"' + nick + '"}'
    );
  },
  enterPublicLobby(lobbyId, nick) {
    console.info('joinVisibleChatLobby', nick, '@', lobbyId);
    rs.rsJsonApiRequest(
      '/rsChats/joinVisibleChatLobby',
      {},
      () => {
        loadLobbyDetails(lobbyId, (info) => {
          ChatRoomsModel.subscribedRooms[lobbyId] = info;
          ChatRoomsModel.loadSubscribedRooms(() => {
            m.route.set('/chat/:lobby', { lobby: info.lobby_id.xstr64 });
          });
        });
      },
      true,
      {},
      JSON.parse,
      () => '{"lobby_id":' + lobbyId + ',"own_id":"' + nick + '"}'
    );
  },
  unsubscribeChatLobby(lobbyId, follow) {
    console.info('unsubscribe lobby', lobbyId);
    rs.rsJsonApiRequest(
      '/rsChats/unsubscribeChatLobby',
      {},
      () => ChatRoomsModel.loadSubscribedRooms(follow),
      true,
      {},
      JSON.parse,
      () => '{"lobby_id":' + lobbyId + '}'
    );
  },
  chatId() {
    const type = (this.currentLobby && this.currentLobby.chatType) || 3;
    const id = this.lastLobbyId || m.route.param('lobby');
    const cid = {
      broadcast_status_peer_id: { xstr64: '0' },
      type: type,
      peer_id: { xstr64: '0' },
      distant_chat_id: { xstr64: '0' },
      lobby_id: { xstr64: '0' },
    };
    if (type === 3) cid.lobby_id.xstr64 = id;
    else if (type === 4) cid.distant_chat_id = parseInt(id);
    return cid;
  },
  loadLobby(currentlobbyid) {
    this.lastLobbyId = currentlobbyid;

    const finishLoad = (detail) => {
      this.setupAction = this.setIdentity;
      this.currentLobby = detail;
      this.isSubscribed = true;
      this.lobby_user = rs.userList.username(detail.gxs_id) || '???';

      // Reset local state for this lobby
      this.messages = [];
      this.messageKeys.clear();

      // Load history first
      this.loadHistory(currentlobbyid, detail.chatType);

      // Apply existing messages from live cache
      const cid = this.chatId();
      rs.events[15].chatMessages(cid, rs.events[15], (l) => {
        this.addMessages(l);
      });

      // Register for chatEvents for future messages
      // Register for chatEvents for future messages
      rs.events[15].notify = (chatMessage) => {
        const msgCid = chatMessage.chat_id;
        console.warn('[RS-DEBUG] Incoming chat msg:', chatMessage, 'Current Type:', detail.chatType, 'LobbyID:', currentlobbyid);
        let match = false;
        if (msgCid.type === detail.chatType) {
          if (detail.chatType === 3) {
            const clid = msgCid.lobby_id ? (typeof msgCid.lobby_id === 'object' ? msgCid.lobby_id.xstr64 : msgCid.lobby_id) : undefined;
            if (clid === currentlobbyid) match = true;
          } else if (detail.chatType === 4) {
            const dChatId = msgCid.distant_chat_id ? (typeof msgCid.distant_chat_id === 'object' ? msgCid.distant_chat_id.xstr64 : msgCid.distant_chat_id) : undefined;
            console.warn('[RS-DEBUG] D-Chat check:', dChatId, 'vs', currentlobbyid);
            if (dChatId == currentlobbyid) match = true; // compare with auto-cast
          }
        }
        if (match) {
          this.addMessages([chatMessage]);
        }
      };

      // Lookup for chat-user names (Only for lobbies for now)
      // Lookup for chat-user names
      if (detail.gxs_ids) {
        let names = [];
        if (Array.isArray(detail.gxs_ids)) {
          names = detail.gxs_ids.reduce((a, u) => a.concat(rs.userList.username(u.key)), []);
        } else if (typeof detail.gxs_ids === 'object') {
          names = Object.keys(detail.gxs_ids).map(key => rs.userList.username(key));
        }
        names.sort((a, b) => a.localeCompare(b));
        this.users = [];
        names.forEach((name) => (this.users = this.users.concat([m('.user', name)])));
      } else {
        this.users = [m('.user', detail.lobby_name)];
      }
      m.redraw();
    };

    // Try determining type
    loadLobbyDetails(currentlobbyid, (detail) => {
      if (detail) {
        finishLoad(detail);
      } else {
        // Fallback to Distant Chat
        loadDistantChatDetails(currentlobbyid, (dDetail) => {
          if (dDetail) {
            finishLoad(dDetail);
          } else {
            console.error('[RS-DEBUG] Failed to load chat info (Lobby or Distant) for ID:', currentlobbyid);
          }
        });
      }
    });
  },
  loadPublicLobby(currentlobbyid) {
    console.info('loadPublicLobby ChatRoomsModel:', ChatRoomsModel);
    this.setupAction = this.enterPublicLobby;
    this.isSubscribed = false;
    ChatRoomsModel.allRooms.forEach((it) => {
      if (it.lobby_id.xstr64 === currentlobbyid) {
        this.currentLobby = it;
        this.lobby_user = '???';
        this.lobbyid = currentlobbyid;
      }
    });
    this.users = [];
  },
  sendMessage(msg, onsuccess) {
    const echoMsg = {
      chat_id: this.chatId(),
      msg: msg,
      sendTime: Math.floor(Date.now() / 1000),
      lobby_peer_gxs_id: this.lobby_user,
    };
    this.addMessages([echoMsg], true);

    rs.rsJsonApiRequest(
      '/rsChats/sendChat',
      {
        id: this.chatId(),
        msg: msg,
      },
      (data, success) => {
        if (success) {
          onsuccess();
        }
      }
    );
  },
  selected(info, selName, defaultName) {
    const currid = (ChatLobbyModel.currentLobby.lobby_id || { xstr64: m.route.param('lobby') })
      .xstr64;
    return (info.lobby_id.xstr64 === currid ? selName : '') + defaultName;
  },
  switchToEvent(info) {
    return () => {
      ChatLobbyModel.currentLobby = info;
      m.route.set('/chat/:lobby', { lobby: info.lobby_id.xstr64 });
      ChatLobbyModel.loadLobby(info.lobby_id.xstr64); // update
    };
  },
  setupEvent(info) {
    return () => {
      m.route.set('/chat/:lobby/setup', { lobby: info.lobby_id.xstr64 });
      ChatLobbyModel.loadPublicLobby(info.lobby_id.xstr64); // update
    };
  },
};

// ************************* views ****************************

const Lobby = () => {
  return {
    view: (vnode) => {
      const { info, tagname, onclick, lobbytagname = 'mainname' } = vnode.attrs;
      return m(
        ChatLobbyModel.selected(info, '.selected-lobby', tagname),
        {
          key: info.lobby_id.xstr64,
          onclick,
        },
        [
          m('h5', { class: lobbytagname }, info.lobby_name === '' ? '<unnamed>' : info.lobby_name),
          m('.topic', info.lobby_topic),
        ]
      );
    },
  };
};

const LobbyList = {
  view(vnode) {
    const tagname = vnode.attrs.tagname;
    const lobbytagname = vnode.attrs.lobbytagname;
    const onclick = vnode.attrs.onclick || (() => null);
    return [
      vnode.attrs.rooms.map((info) =>
        m(Lobby, {
          info,
          tagname,
          lobbytagname,
          onclick: onclick(info),
        })
      ),
    ];
  },
};

const SubscribedLeftLobbies = {
  view() {
    return [
      m('h5.lefttitle', 'subscribed:'),
      m(LobbyList, {
        rooms: sortLobbies(Object.values(ChatRoomsModel.subscribedRooms)),
        tagname: '.leftlobby.subscribed',
        lobbytagname: 'leftname',
        onclick: ChatLobbyModel.switchToEvent,
      }),
    ];
  },
};

const SubscribedLobbies = {
  view() {
    return m('.widget', [
      m('.widget__heading', m('h3', 'Subscribed chat rooms')),
      m('.widget__body', [
        m(LobbyList, {
          rooms: sortLobbies(Object.values(ChatRoomsModel.subscribedRooms)),
          tagname: '.lobby.subscribed',
          onclick: ChatLobbyModel.switchToEvent,
        }),
      ]),
    ]);
  },
};

const PublicLeftLobbies = {
  view() {
    return [
      m('h5.lefttitle', 'public:'),
      m(LobbyList, {
        rooms: Object.values(ChatRoomsModel.allRooms || {}).filter(
          (info) => !ChatRoomsModel.subscribed(info)
        ),
        tagname: '.leftlobby.public',
        lobbytagname: 'leftname',
        onclick: ChatLobbyModel.setupEvent,
      }),
    ];
  },
};

const PublicLobbies = {
  view() {
    return m('.widget', [
      m('.widget__heading', m('h3', 'Public chat rooms')),
      m('.widget__body', [
        m(LobbyList, {
          rooms: (ChatRoomsModel.allRooms || []).filter((info) => !ChatRoomsModel.subscribed(info)),
          tagname: '.lobby.public',
          onclick: ChatLobbyModel.setupEvent,
        }),
      ]),
    ]);
  },
};

const LobbyName = () => {
  return m(
    'h3.lobbyName',
    m('.mobile-menu-icons', [
      m('i.fas.fa-bars', { onclick: () => MobileState.toggleLobbies() }),
    ]),
    ChatLobbyModel.isSubscribed
      ? [m('span.chatusername', ChatLobbyModel.lobby_user), m('span.chatatchar', '@')]
      : [],
    m('span.chatlobbyname', ChatLobbyModel.currentLobby.lobby_name),
    m('.mobile-menu-icons', [
      m('i.fas.fa-users', { onclick: () => MobileState.toggleUsers() }),
    ]),
    m.route.param('subaction') !== 'setup'
      ? [
        m('i.fas.fa-cog.setupicon', {
          title: 'configure lobby',
          onclick: () =>
            m.route.set(
              '/chat/:lobby/:subaction',
              {
                lobby: m.route.param('lobby'),
                subaction: 'setup',
              },
              { replace: true }
            ),
        }),
      ]
      : [],
    ChatLobbyModel.isSubscribed
      ? [
        m('i.fas.fa-sign-out-alt.leaveicon', {
          title: 'leaving lobby',
          onclick: () =>
            ChatLobbyModel.unsubscribeChatLobby(m.route.param('lobby'), () => {
              m.route.set('/chat', null, { replace: true });
            }),
        }),
      ]
      : []
  );
};

// ***************************** Page Layouts ******************************

const Layout = {
  view: () => m('.node-panel.chat-panel.chat-hub', [m(SubscribedLobbies), m(PublicLobbies)]),
};

const LayoutSingle = () => {
  const onResize = () => {
    const element = document.querySelector('.messages');
    if (element) element.scrollTop = element.scrollHeight;
  };
  return {
    oninit: () => {
      ChatLobbyModel.loadLobby(m.route.param('lobby'));
      window.addEventListener('resize', onResize);
    },
    onremove: () => window.removeEventListener('resize', onResize),
    view: (vnode) =>
      m(
        '.node-panel.chat-panel.chat-room',
        {
          class:
            (MobileState.showLobbies ? 'show-lobbies ' : '') +
            (MobileState.showUsers ? 'show-users' : ''),
        },
        [
          m('.chat-overlay', { onclick: () => MobileState.closeAll() }),
          LobbyName(),
          m('.lobbies', m(SubscribedLeftLobbies), m(PublicLeftLobbies)),
          m('.messages', { onclick: () => MobileState.closeAll() }, ChatLobbyModel.messages),
          m('.rightbar', ChatLobbyModel.users),
          m(
            '.chatMessage',
            {},
            [
              m('textarea.chatMsg', {
                placeholder: 'Type a message...',
                enterkeyhint: 'send',
                onkeydown: (e) => {
                  if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey) {
                    const msg = e.target.value;
                    if (msg.trim() === '') return false;
                    e.target.value = ' sending ... ';
                    ChatLobbyModel.sendMessage(msg, () => (e.target.value = ''));
                    return false;
                  }
                },
              }),
              m(
                'button.chat-send-btn',
                {
                  onclick: (e) => {
                    const textarea = e.target.closest('.chatMessage').querySelector('textarea');
                    const msg = textarea.value;
                    if (msg.trim() === '') return;
                    textarea.value = ' sending ... ';
                    ChatLobbyModel.sendMessage(msg, () => (textarea.value = ''));
                  },
                },
                m('i.fas.fa-paper-plane')
              ),
            ]
          ),
        ]
      ),
  };
};

const LayoutSetup = () => {
  let ownIds = [];
  return {
    oninit: () => peopleUtil.ownIds((data) => (ownIds = data)),
    view: (vnode) =>
      m(
        '.node-panel.chat-panel.chat-room.chat-setup',
        {
          class:
            (MobileState.showLobbies ? 'show-lobbies ' : '') +
            (MobileState.showUsers ? 'show-users' : ''),
        },
        [
          m('.chat-overlay', { onclick: () => MobileState.closeAll() }),
          LobbyName(),
          m('.lobbies', m(SubscribedLeftLobbies), m(PublicLeftLobbies)),
          m('.setup', [
            m('h5.selectidentity', 'Select identity to use'),
            ownIds.map((nick) =>
              m(
                '.identity' +
                (ChatLobbyModel.currentLobby.gxs_id === nick ? '.selectedidentity' : ''),
                {
                  onclick: () => ChatLobbyModel.setupAction(m.route.param('lobby'), nick),
                },
                rs.userList.username(nick)
              )
            ),
          ]),
        ]
      ),
  };
};

/*
    /rsChats/initiateDistantChatConnexion
   * @param[in] to_pid RsGxsId to start the connection
   * @param[in] from_pid owned RsGxsId who start the connection
   * @param[out] pid distant chat id
   * @param[out] error_code if the connection can't be stablished
   * @param[in] notify notify remote that the connection is stablished
*/
const LayoutCreateDistant = () => {
  let ownIds = [];
  return {
    oninit: () => peopleUtil.ownIds((data) => (ownIds = data)),
    view: (vnode) =>
      m('.node-panel.chat-panel.chat-room', [
        m('.createDistantChat', [
          'choose identitiy to chat with ',
          rs.userList.username(m.route.param('lobby')),
          ownIds.map((id) =>
            m(
              '.identity',
              {
                onclick: () =>
                  rs.rsJsonApiRequest(
                    '/rsChats/initiateDistantChatConnexion',
                    {
                      to_pid: m.route.param('lobby'),
                      from_pid: id,
                      notify: true,
                    },
                    (result) => {
                      console.info('initiateDistantChatConnexion', result);
                      m.route.set('/chat/:lobbyid', { lobbyid: result.pid });
                    }
                  ),
              },
              rs.userList.username(id)
            )
          ),
        ]),
      ]),
  };
};

module.exports = {
  oninit: () => {
    ChatRoomsModel.loadSubscribedRooms();
  },
  view: (vnode) => {
    if (m.route.param('lobby') === undefined) {
      return m(Layout);
    } else if (m.route.param('subaction') === 'setup') {
      return m(LayoutSetup);
    } else if (m.route.param('subaction') === 'createdistantchat') {
      return m(LayoutCreateDistant);
    } else {
      return m(LayoutSingle);
    }
  },
};

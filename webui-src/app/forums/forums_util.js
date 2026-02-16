const m = require('mithril');
const rs = require('rswebui');

const GROUP_SUBSCRIBE_ADMIN = 0x01; // means: you have the admin key for this group
const GROUP_SUBSCRIBE_PUBLISH = 0x02; // means: you have the publish key for thiss group. Typical use: publish key in forums are shared with specific friends.
const GROUP_SUBSCRIBE_SUBSCRIBED = 0x04; // means: you are subscribed to a group, which makes you a source for this group to your friend nodes.
const GROUP_SUBSCRIBE_NOT_SUBSCRIBED = 0x08;
const GROUP_MY_FORUM = GROUP_SUBSCRIBE_ADMIN + GROUP_SUBSCRIBE_SUBSCRIBED + GROUP_SUBSCRIBE_PUBLISH;

const THREAD_UNREAD = 0x00000003;

const Data = {
  DisplayForums: {},
  Threads: {},
  ParentThreads: {},
  ParentThreadMap: {},
  loading: new Set(),
};

async function updatedisplayforums(keyid, details = {}) {
  if (Data.loading.has(keyid)) return;
  Data.loading.add(keyid);

  try {
    const res = await rs.rsJsonApiRequest('/rsgxsforums/getForumsInfo', {
      forumIds: [keyid], // keyid: Forumid
    });
    if (res && res.body && res.body.forumsInfo && res.body.forumsInfo.length > 0) {
      details = res.body.forumsInfo[0];
      Data.DisplayForums[keyid] = {
        // struct for a forum
        name: details.mMeta.mGroupName,
        author: details.mMeta.mAuthorId,
        isSearched: true,
        description: details.mDescription,
        isSubscribed:
          details.mMeta.mSubscribeFlags === GROUP_SUBSCRIBE_SUBSCRIBED ||
          details.mMeta.mSubscribeFlags === GROUP_MY_FORUM,
        activity: details.mMeta.mLastPost,
        created: details.mMeta.mPublishTs,
      };
      if (Data.Threads[keyid] === undefined) {
        Data.Threads[keyid] = {};
      }
      const res2 = await rs.rsJsonApiRequest('/rsgxsforums/getForumMsgMetaData', {
        forumId: keyid,
      });
      if (res2 && res2.body && res2.body.retval && res2.body.msgMetas && res2.body.msgMetas.length > 0) {
        const ids = res2.body.msgMetas.map((thread) => thread.mMsgId);

        // Chunking: process messages in batches of 100
        const chunkSize = 100;
        const chunks = [];
        for (let i = 0; i < ids.length; i += chunkSize) {
          chunks.push(ids.slice(i, i + chunkSize));
        }

        // Process chunks in parallel to speed up loading
        await Promise.all(
          chunks.map(async (chunk) => {
            const res3 = await rs.rsJsonApiRequest('/rsgxsforums/getForumContent', {
              forumId: keyid,
              msgsIds: chunk,
            });

            if (res3 && res3.body && res3.body.retval && res3.body.msgs) {
              res3.body.msgs.forEach((msg) => {
                const mMeta = msg.mMeta;
                if (
                  Data.Threads[keyid][mMeta.mOrigMsgId] === undefined ||
                  Data.Threads[keyid][mMeta.mOrigMsgId].thread.mMeta.mPublishTs.xint64 <
                  mMeta.mPublishTs.xint64
                ) {
                  Data.Threads[keyid][mMeta.mOrigMsgId] = { thread: msg, showReplies: false };
                  if (
                    Data.Threads[keyid][mMeta.mOrigMsgId] &&
                    Data.Threads[keyid][mMeta.mOrigMsgId].thread.mMeta.mMsgStatus === THREAD_UNREAD
                  ) {
                    let parent = Data.Threads[keyid][mMeta.mOrigMsgId].thread.mMeta.mParentId;
                    while (Data.Threads[keyid][parent]) {
                      Data.Threads[keyid][parent].thread.mMeta.mMsgStatus = THREAD_UNREAD;
                      parent = Data.Threads[keyid][parent].thread.mMeta.mParentId;
                    }
                  }

                  if (Data.ParentThreads[keyid] === undefined) {
                    Data.ParentThreads[keyid] = {};
                  }
                  if (mMeta.mThreadId === mMeta.mParentId) {
                    Data.ParentThreads[keyid][mMeta.mOrigMsgId] = mMeta;
                  } else {
                    if (Data.ParentThreadMap[mMeta.mParentId] === undefined) {
                      Data.ParentThreadMap[mMeta.mParentId] = {};
                    }
                    Data.ParentThreadMap[mMeta.mParentId][mMeta.mOrigMsgId] = mMeta;
                  }
                }
              });
              m.redraw(); // Show progress as chunks arrive
            }
          })
        );
      }
    }
  } catch (e) {
    console.error('[RS-DEBUG] Error updating forum display for:', keyid, e);
  } finally {
    Data.loading.delete(keyid);
    m.redraw(); // Final redraw just in case
  }
}

const DisplayForumsFromList = () => {
  return {
    view: (v) =>
      m(
        'tr',
        {
          key: v.attrs.id,
          class:
            Data.DisplayForums[v.attrs.id] && Data.DisplayForums[v.attrs.id].isSearched
              ? ''
              : 'hidden',
          onclick: () => {
            m.route.set('/forums/:tab/:mGroupId', {
              tab: v.attrs.category,
              mGroupId: v.attrs.id,
            });
          },
        },
        [m('td', Data.DisplayForums[v.attrs.id] ? Data.DisplayForums[v.attrs.id].name : '')]
      ),
  };
};

const ForumSummary = () => {
  let keyid = {};
  return {
    oninit: (v) => {
      keyid = v.attrs.details.mGroupId;
      updatedisplayforums(keyid);
    },
    view: (v) => { },
  };
};

const ForumTable = () => {
  return {
    view: (v) => m('table.forums', [m('tr', [m('th', 'Forum Name')]), v.children]),
  };
};
const ThreadsTable = () => {
  return {
    oninit: (v) => { },
    view: (v) =>
      m('table.threads', [
        m('tr', [m('th', 'Comment'), m('th', 'Date'), m('th', 'Author')]),
        v.children,
      ]),
  };
};
const ThreadsReplyTable = () => {
  return {
    oninit: (v) => { },
    view: (v) =>
      m('table.threadreply', [
        m('tr', [
          m('th', ''),
          m('th', 'Comment'),
          m('th', 'Unread'),
          m('th', 'Author'),
          m('th', 'Date'),
        ]),
        v.children,
      ]),
  };
};

const SearchBar = () => {
  let searchString = '';
  return {
    view: (v) =>
      m('input[type=text][id=searchforum][placeholder=Search Subject].searchbar', {
        value: searchString,
        oninput: (e) => {
          searchString = e.target.value.toLowerCase();
          for (const hash in Data.DisplayForums) {
            if (Data.DisplayForums[hash].name.toLowerCase().indexOf(searchString) > -1) {
              Data.DisplayForums[hash].isSearched = true;
            } else {
              Data.DisplayForums[hash].isSearched = false;
            }
          }
        },
      }),
  };
};
function popupmessage(message) {
  const container = document.getElementById('modal-container');
  container.style.display = 'block';
  m.render(
    container,
    m('.modal-content', [
      m(
        'button.red',
        {
          onclick: () => (container.style.display = 'none'),
        },
        m('i.fas.fa-times')
      ),
      message,
    ])
  );
}

module.exports = {
  Data,
  SearchBar,
  ForumSummary,
  DisplayForumsFromList,
  ForumTable,
  ThreadsTable,
  ThreadsReplyTable,
  popupmessage,
  updatedisplayforums,
  GROUP_SUBSCRIBE_ADMIN,
  GROUP_SUBSCRIBE_NOT_SUBSCRIBED,
  GROUP_SUBSCRIBE_PUBLISH,
  GROUP_SUBSCRIBE_SUBSCRIBED,
  GROUP_MY_FORUM,
  THREAD_UNREAD,
};

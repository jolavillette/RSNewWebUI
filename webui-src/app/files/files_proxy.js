const m = require('mithril');
const rs = require('rswebui');
const futil = require('files/files_util');

const fileProxyObj = futil.createProxy({}, () => {
  m.redraw();
});

rs.events[rs.RsEventsType.FILE_TRANSFER] = {
  handler: (event) => {
    console.warn('[RS-DEBUG] FILE_TRANSFER event received:', event);

    // if request item doesn't already exists in Object then create new item
    if (!Object.prototype.hasOwnProperty.call(fileProxyObj, event.mRequestId)) {
      fileProxyObj[event.mRequestId] = [];
    }

    event.mResults.forEach((newRes) => {
      const isAlt = fileProxyObj[event.mRequestId].some(
        (oldRes) => oldRes.fHash === newRes.fHash && oldRes.fName === newRes.fName
      );
      if (!isAlt) {
        fileProxyObj[event.mRequestId].push(newRes);
      }
    });
  },
};

module.exports = {
  fileProxyObj,
};

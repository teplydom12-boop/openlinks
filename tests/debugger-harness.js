// Minimal protocol transport for worker tests. Browser tests use real CDP DOM
// coordinates and input events, including a composer inside another frame.
export function domReply(method) {
  return {
    'DOM.getDocument':{root:{nodeId:1}},
    'DOM.performSearch':{searchId:'editor-search',resultCount:1},
    'DOM.getSearchResults':{nodeIds:[2]},
    'DOM.getBoxModel':{model:{content:[10,10,110,10,110,90,10,90]}},
    'DOM.describeNode':{node:{backendNodeId:20}},
    'DOM.getNodeForLocation':{backendNodeId:20},
  }[method] || {};
}

/* Fixed MAIN-world collector for the observed 1688 virtual inbox. Only own
 * React data descriptors are read; no page handlers, getters, network calls,
 * clicks, editor changes or scrolling. The isolated reader binds this result
 * to its request, current document, sidebar digest and scroll geometry. */
(() => {
  const result = {
    platform: null, url: location.href, status: 'unsupported',
    schema: '1688-inbox-pagination-v1', capturedAt: Date.now(),
    domSignature: '', rowRanks: [], loadedCount: null, hasMore: null,
    loading: null, firstScreenRequestEnds: null, scrollOffset: null,
    itemCount: null, scrollTop: null, scrollHeight: null, clientHeight: null,
    startVerified: false, endVerified: false,
    limited: false, limitReason: '', fiberDepth: 0,
    diagnostic: { stage: 'url', branchCount: 0, currentRejected: 0,
      widgetCount: 0, listCount: 0, ownerCount: 0, nativeListMatch: 0,
      nativeOrderMatch: 0, firstRank: null, lastRank: null,
      invalidIdReason: '', invalidIdIndex: null, invalidIdCount: null,
      ownerSearchVisible: null, ownerFirstScreen: null,
      ownerStoreCount: null, ownerFilterCount: null, ownerListsEqual: null,
      rowOrder: [], virtualItems: [] }
  };
  try {
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !(url.hostname === '1688.com' || url.hostname.endsWith('.1688.com'))) return result;
    result.platform = '1688';
    const diagnostic = result.diagnostic;
    const limit = reason => { result.limited = true; if (!result.limitReason) result.limitReason = reason; };
    const own = (value, key) => {
      if (!value || typeof value !== 'object') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const native = {
      queryDocument: Document.prototype.querySelectorAll,
      queryElement: Element.prototype.querySelectorAll,
      parent: Object.getOwnPropertyDescriptor(Node.prototype, 'parentElement').get,
      connected: Object.getOwnPropertyDescriptor(Node.prototype, 'isConnected').get,
      html: Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML').get,
      scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop').get,
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight').get,
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight').get,
      attribute: Element.prototype.getAttribute,
      rect: Element.prototype.getBoundingClientRect,
      closest: Element.prototype.closest,
      contains: Node.prototype.contains,
      css: CSSStyleDeclaration.prototype.getPropertyValue
    };
    const query = (root, selector) => [
      ...(root === document ? native.queryDocument : native.queryElement).call(root, selector)
    ];
    const visible = node => {
      if (!native.connected.call(node) || native.closest.call(node, '[hidden],[aria-hidden="true"],[inert]')) return false;
      let parent = node, depth = 0;
      while (parent && depth++ < 100) {
        const style = getComputedStyle(parent), css = key => native.css.call(style, key);
        if (css('display') === 'none' || ['hidden', 'collapse'].includes(css('visibility')) || Number(css('opacity')) === 0) return false;
        parent = native.parent.call(parent);
      }
      if (parent) { limit('dom-ancestor-depth'); return false; }
      const rect = native.rect.call(node);
      return rect.width > 2 && rect.height > 2;
    };
    diagnostic.stage = 'dom-scope';
    const sidebars = query(document, '.ww_conversation_list').filter(visible);
    if (sidebars.length !== 1) return result;
    const sidebar = sidebars[0], scrollers = query(sidebar, '.conversation-list-scroll').filter(visible);
    if (scrollers.length !== 1) return result;
    const scroller = scrollers[0], html = native.html.call(sidebar);
    if (html.length > 1000000) { limit('sidebar-html-size'); return result; }
    let a = 2166136261, b = 2246822507;
    for (let index = 0; index < html.length; index++) {
      a = Math.imul(a ^ html.charCodeAt(index), 16777619);
      b = Math.imul(b ^ html.charCodeAt(index), 3266489909);
    }
    result.domSignature = `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}:${html.length}`;
    diagnostic.stage = 'dom-geometry';
    result.scrollTop = native.scrollTop.call(scroller);
    result.scrollHeight = native.scrollHeight.call(scroller);
    result.clientHeight = native.clientHeight.call(scroller);
    if (![result.scrollTop, result.scrollHeight, result.clientHeight].every(Number.isFinite) ||
        result.scrollTop < 0 || result.clientHeight <= 0 || result.scrollHeight < result.clientHeight) return result;

    diagnostic.stage = 'dom-rows';
    const rows = query(sidebar, '.conversation-list-panel .conversation-item[id]').filter(visible);
    if (rows.length > 3000) { limit('rendered-row-count'); return result; }
    const validId = value => typeof value === 'string' && value.length <= 256 && /^\d+\.\d+-\d+\.\d+#\d+@cntaobao$/.test(value);
    const domIds = [];
    for (const row of rows) {
      const id = native.attribute.call(row, 'id');
      if (!native.contains.call(scroller, row) || !validId(id)) return result;
      domIds.push(id);
    }
    if (new Set(domIds).size !== domIds.length) return result;
    // A committed native scroll offset without any intersecting rendered row
    // is still a settling virtual viewport, not evidence of list completion.
    const viewport = native.rect.call(scroller);
    if (rows.length && !rows.some(row => {
      const rect = native.rect.call(row);
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    })) return result;

    const idsOf = value => {
      if (!Array.isArray(value)) return null;
      const length = own(value, 'length');
      if (!Number.isSafeInteger(length) || length < 0) return null;
      if (length > 10000) { limit('native-list-size'); return null; }
      const ids = [];
      for (let index = 0; index < length; index++) {
        const id = own(value, String(index));
        if (!validId(id)) {
          if (!diagnostic.invalidIdReason) Object.assign(diagnostic, {
            invalidIdReason: id === undefined ? 'missing' : 'syntax', invalidIdIndex: index, invalidIdCount: length
          });
          return null;
        }
        ids.push(id);
      }
      if (new Set(ids).size !== ids.length) {
        if (!diagnostic.invalidIdReason) Object.assign(diagnostic, { invalidIdReason: 'duplicate', invalidIdCount: length });
        return null;
      }
      return ids;
    };
    const sameIds = (left, right) => left && right && left.length === right.length && left.every((id, index) => id === right[index]);
    const positionMetadata = node => {
      const rect = native.rect.call(node), style = native.attribute.call(node, 'style') || '';
      const inline = name => {
        if (style.length > 2048) return null;
        const match = style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))px\\s*(?:;|$)`, 'i'));
        return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
      };
      const indices = [], keys = Object.getOwnPropertyNames(node);
      if (keys.length <= 512) for (const key of keys.filter(key => /^__react(?:Fiber|InternalInstance)\$/.test(key)).slice(0, 2)) {
        let fiber = own(node, key); const seen = new Set();
        for (let depth = 0; fiber && typeof fiber === 'object' && depth < 6 && !seen.has(fiber); depth++, fiber = own(fiber, 'return')) {
          seen.add(fiber); const index = own(own(fiber, 'memoizedProps'), 'index');
          if (Number.isSafeInteger(index) && index >= 0 && index <= 10000) indices.push({ depth, index });
        }
      }
      return { top: rect.top, bottom: rect.bottom, inlineTop: inline('top'), inlineHeight: inline('height'), indices };
    };
    diagnostic.stage = 'react-hooks';
    const keys = Object.getOwnPropertyNames(scroller);
    if (keys.length > 512) { limit('react-hook-key-count'); return result; }
    const hooks = keys.filter(key => /^__react(?:Fiber|InternalInstance)\$/.test(key));
    if (!hooks.length || hooks.length > 2) return result;
    const chains = [], seenStarts = new Set();
    let branchLimitReason = '';
    diagnostic.stage = 'react-current-branch';
    for (const key of hooks) {
      const start = own(scroller, key);
      for (const first of [start, own(start, 'alternate')]) {
        if (!first || typeof first !== 'object' || seenStarts.has(first)) continue;
        seenStarts.add(first);
        diagnostic.branchCount++;
        const chain = [], seen = new Set();
        let fiber = first;
        while (fiber && typeof fiber === 'object' && !seen.has(fiber) && chain.length < 128) {
          seen.add(fiber); chain.push(fiber); fiber = own(fiber, 'return');
        }
        result.fiberDepth = Math.max(result.fiberDepth, chain.length);
        if (fiber) { branchLimitReason ||= seen.has(fiber) ? 'react-fiber-cycle' : 'react-fiber-depth'; continue; }
        const root = chain.at(-1), current = own(own(root, 'stateNode'), 'current');
        // React's current-root pointer is authoritative when present. A stale
        // alternate must not supply old hasMore or loading metadata.
        if (current !== undefined && current !== root) { diagnostic.currentRejected++; continue; }
        chains.push({ fibers: chain, currentProven: current === root });
      }
    }
    const candidates = [];
    for (const { fibers: chain, currentProven } of chains) {
      const widgets = [], lists = [], owners = [];
      for (let depth = 0; depth < chain.length; depth++) {
        const fiber = chain[depth], props = own(fiber, 'memoizedProps'), state = own(fiber, 'memoizedState');
        const itemCount = own(props, 'itemCount'), scrollOffset = own(state, 'scrollOffset');
        if (Number.isSafeInteger(itemCount) && itemCount >= 0 && Number.isFinite(scrollOffset) &&
            scrollOffset >= 0 && Math.abs(scrollOffset - result.scrollTop) <= 3) {
          widgets.push({ depth, itemCount, scrollOffset, fiber });
        }
        const list = idsOf(own(props, 'conversationIdList'));
        if (list && own(props, 'firstScreenRequestEnds') === true) lists.push({ depth, list });
        const dataStore = own(state, 'dataStore'), stored = idsOf(own(dataStore, 'conversationIdList'));
        const filtered = idsOf(own(state, 'filterConversationList'));
        const hasMore = own(state, 'hasMore'), loading = own(dataStore, 'conversationFetchLoading');
        if (dataStore && typeof dataStore === 'object') {
          const boolean = value => typeof value === 'boolean' ? value : null;
          const count = value => Array.isArray(value) && Number.isSafeInteger(own(value, 'length')) ? own(value, 'length') : null;
          Object.assign(diagnostic, {
            ownerSearchVisible: boolean(own(state, 'searchListVisible')),
            ownerFirstScreen: boolean(own(state, 'firstScreenRequestEnds')),
            ownerStoreCount: count(own(dataStore, 'conversationIdList')),
            ownerFilterCount: count(own(state, 'filterConversationList')),
            ownerListsEqual: !!sameIds(stored, filtered)
          });
        }
        if (stored && sameIds(stored, filtered) && own(state, 'searchListVisible') === false &&
            own(state, 'firstScreenRequestEnds') === true && typeof hasMore === 'boolean' && typeof loading === 'boolean') {
          owners.push({ depth, list: stored, hasMore, loading });
        }
      }
      diagnostic.widgetCount += widgets.length;
      diagnostic.listCount += lists.length;
      diagnostic.ownerCount += owners.length;
      for (const widget of widgets) for (const list of lists) for (const owner of owners) {
        if (widget.depth >= list.depth || list.depth >= owner.depth || !sameIds(list.list, owner.list) ||
            ![owner.list.length, owner.list.length + 1].includes(widget.itemCount)) continue;
        diagnostic.nativeListMatch++;
        const spacers = query(scroller, ':scope > *');
        if (spacers.length !== 1) continue;
        const wrappers = query(spacers[0], ':scope > *'), spacerRect = native.rect.call(spacers[0]);
        if (!wrappers.length || wrappers.length > 3000) continue;
        const slots = [], membership = new Set(owner.list), mappedRows = new Map();
        let valid = true, placeholders = 0;
        for (const wrapper of wrappers) {
          const position = positionMetadata(wrapper), top = position.inlineTop, height = position.inlineHeight;
          if (!visible(wrapper) || top === null || height === null || height <= 2 ||
              Math.abs(position.top - spacerRect.top - top) > 2 || Math.abs(position.bottom - position.top - height) > 2) { valid = false; break; }
          const keys = Object.getOwnPropertyNames(wrapper), indices = new Set();
          if (keys.length > 512) { valid = false; break; }
          for (const key of keys.filter(key => /^__react(?:Fiber|InternalInstance)\$/.test(key)).slice(0, 2)) {
            const start = own(wrapper, key);
            for (const first of [start, own(start, 'alternate')]) {
              if (own(first, 'stateNode') !== wrapper) continue;
              let fiber = first, index = null, styleMatches = false, conflict = false;
              const seen = new Set();
              for (let depth = 0; fiber && typeof fiber === 'object' && depth < 24 && !seen.has(fiber); depth++, fiber = own(fiber, 'return')) {
                if (fiber === widget.fiber) { if (!conflict && styleMatches && index !== null) indices.add(index); break; }
                seen.add(fiber);
                const props = own(fiber, 'memoizedProps'), value = own(props, 'index');
                if (value === undefined) continue;
                if (!Number.isSafeInteger(value) || value < 0 || value >= widget.itemCount || index !== null && index !== value) { conflict = true; break; }
                index = value;
                const style = own(props, 'style');
                if (own(style, 'top') === top && own(style, 'height') === height) styleMatches = true;
              }
            }
          }
          if (indices.size !== 1) { valid = false; break; }
          const index = indices.values().next().value, contained = query(wrapper, '.conversation-item[id]');
          if (contained.length > 1) { valid = false; break; }
          if (!contained.length) placeholders++;
          else {
            const row = contained[0], id = native.attribute.call(row, 'id'), rect = native.rect.call(row);
            if (!rows.includes(row) || !membership.has(id) || mappedRows.has(row) ||
                Math.abs(rect.top - position.top) > 2 || Math.abs(rect.bottom - position.bottom) > 2) { valid = false; break; }
            mappedRows.set(row, {id, index});
          }
          slots.push({index, top, height, rectTop:position.top, rectBottom:position.bottom});
        }
        if (!valid || mappedRows.size !== rows.length || placeholders > widget.itemCount - owner.list.length) continue;
        slots.sort((left, right) => left.index - right.index);
        if (slots.some((slot, index) => index > 0 && (slot.index !== slots[index - 1].index + 1 ||
            slot.rectTop <= slots[index - 1].rectTop || Math.abs(slot.rectTop - slots[index - 1].rectBottom) > 2))) continue;
        const rowRanks = rows.map(row => mappedRows.get(row));
        diagnostic.firstRank = slots[0].index;
        diagnostic.lastRank = slots.at(-1).index;
        diagnostic.nativeOrderMatch++;
        const atStart = result.scrollTop <= 3, atEnd = result.scrollHeight - result.clientHeight - result.scrollTop <= 3;
        const startVerified = atStart && slots[0].index === 0 && Math.abs(slots[0].top) <= 2;
        const last = slots.at(-1);
        const endVerified = atEnd && last.index === widget.itemCount - 1 && Math.abs(last.top + last.height - result.scrollHeight) <= 3;
        if (atStart && !startVerified || atEnd && !endVerified) continue;
        candidates.push({ currentProven, value: { rowRanks, loadedCount: owner.list.length, hasMore: owner.hasMore,
          loading: owner.loading, firstScreenRequestEnds: true,
          scrollOffset: widget.scrollOffset, itemCount: widget.itemCount, startVerified, endVerified } });
      }
    }
    // A bounded/cyclic stale alternate cannot invalidate a fully validated
    // current-root branch. Without that authoritative pointer the unfinished
    // branch remains an ambiguity, so collection must still fail closed.
    if (branchLimitReason && !candidates.some(candidate => candidate.currentProven)) limit(branchLimitReason);
    const unique = new Map(candidates.map(candidate => [JSON.stringify(candidate.value), candidate.value]));
    diagnostic.stage = !chains.length ? 'react-current-branch' : !diagnostic.widgetCount ? 'native-widget' :
      !diagnostic.listCount ? 'native-list-props' : !diagnostic.ownerCount ? 'native-owner' :
      !diagnostic.nativeListMatch ? 'native-list-match' : !diagnostic.nativeOrderMatch ? 'native-row-order' :
      !candidates.length ? 'native-boundary' : unique.size !== 1 ? 'candidate-conflict' : result.limited ? 'limited' : 'ready';
    if (unique.size === 1 && !result.limited) Object.assign(result, unique.values().next().value, { status: 'ready' });
    return result;
  } catch {
    result.diagnostic.stage = 'error';
    return result;
  }
})();

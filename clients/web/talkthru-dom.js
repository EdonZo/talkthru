/**
 * talkthru DOM hierarchy client — writes the optional hierarchy.json for a web app.
 *
 * Drop it into the page (or paste it into the console) before you start talking.
 * It samples the DOM on an interval and emits the same
 * `{ tMs, nodes[] }` snapshots the device client uploads, with `origin: "dom"`
 * on every node. Nothing is sent anywhere: stop() downloads a file you hand to
 * `talkthru process video.mp4 --hierarchy hierarchy.json`.
 *
 * No dependencies, no build step. Works in any browser with `performance.now`.
 */
(function (global) {
  'use strict';

  var VERSION = '0.1.0';

  var DEFAULTS = {
    /**
     * The pipeline ignores a snapshot more than 750 ms from a keyframe
     * (UI_CONTEXT.MAX_SNAPSHOT_SKEW_MS), so sampling twice a second leaves a
     * worst case of 250 ms between any frame and the nearest snapshot.
     */
    intervalMs: 500,
    /** Nodes thinner than this on either edge are noise (MIN_NODE_EDGE_PX). */
    minEdgePx: 8,
    /** Longer labels are truncated by the parser anyway (MAX_LABEL_CHARS). */
    maxLabelChars: 48,
    /** Per snapshot. A screen with more addressable elements than this is already
     *  past what session.md can afford to print. */
    maxNodes: 200,
    /** Added to every tMs, for when the recording was rolling before the page was. */
    offsetMs: 0,
    fileName: 'hierarchy.json',
    /** false keeps the bundle in memory; read it from stop()'s return value. */
    autoDownload: true
  };

  /** Checked in order; the first one present wins, then the element id. */
  var TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

  var INTERACTIVE_TAGS = /^(a|button|input|select|textarea|summary|label|option)$/;
  var INTERACTIVE_ROLES = /^(button|link|checkbox|radio|switch|slider|tab|menuitem|option|textbox|combobox|searchbox)$/;

  /** Never in the tree: no content of value, and script/style text is not a label. */
  var SKIP_TAGS = /^(script|style|head|meta|link|title|noscript|template|br|path|svg|defs)$/;

  var state = null;

  function options(given) {
    var opts = {};
    for (var key in DEFAULTS) opts[key] = DEFAULTS[key];
    for (var k in given || {}) if (k in DEFAULTS) opts[k] = given[k];
    return opts;
  }

  function clean(value, maxChars) {
    if (typeof value !== 'string') return undefined;
    var text = value.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
  }

  /**
   * Text owned by this element, not by its subtree — otherwise every wrapper
   * carries the whole page as its label. A control whose text sits in a child
   * span is the common exception, so fall back to textContent when it is short
   * enough to plausibly be a label rather than a paragraph.
   */
  function textOf(el, maxChars) {
    var own = '';
    for (var node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) own += node.nodeValue;
    }
    if (own.trim()) return own;
    var all = el.textContent || '';
    return all.length <= maxChars * 2 ? all : '';
  }

  /**
   * Field values are deliberately never read. Someone recording a walkthrough is
   * usually logged in, and a hierarchy file is meant to be safe to hand to an agent.
   */
  function labelFor(el, maxChars) {
    return (
      clean(el.getAttribute('aria-label'), maxChars) ||
      clean(el.getAttribute('title'), maxChars) ||
      clean(el.getAttribute('alt'), maxChars) ||
      clean(el.getAttribute('placeholder'), maxChars) ||
      clean(textOf(el, maxChars), maxChars)
    );
  }

  function testIdFor(el, maxChars) {
    for (var i = 0; i < TEST_ID_ATTRS.length; i++) {
      var found = clean(el.getAttribute(TEST_ID_ATTRS[i]), maxChars);
      if (found) return found;
    }
    return undefined;
  }

  function isInteractive(el, tag) {
    if (INTERACTIVE_TAGS.test(tag)) return true;
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.test(role.toLowerCase())) return true;
    if (el.hasAttribute('onclick') || el.isContentEditable) return true;
    var tabIndex = el.getAttribute('tabindex');
    return tabIndex !== null && Number(tabIndex) >= 0;
  }

  function isVisible(el, rect, opts) {
    if (rect.width < opts.minEdgePx || rect.height < opts.minEdgePx) return false;
    // Off-screen in either direction — present in the DOM, absent from the frame.
    if (rect.bottom <= 0 || rect.right <= 0) return false;
    if (rect.top >= innerHeight || rect.left >= innerWidth) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true
      });
    }
    return true;
  }

  /**
   * A node the pipeline would keep. summariseNodes() throws away anything with
   * no test id, no label and no interactive type, so emitting those is bytes
   * nobody reads.
   */
  function nodeFor(el, depth, parentLabel, opts) {
    var tag = el.tagName.toLowerCase();
    var interactive = isInteractive(el, tag);
    var testId = testIdFor(el, opts.maxLabelChars);
    var label = labelFor(el, opts.maxLabelChars);
    if (!testId && !label && !interactive) return null;
    // The span inside a button repeats the button. Only the outer one is a
    // thing anybody points at, and duplicates crowd out real nodes.
    if (!testId && !interactive && label === parentLabel) return null;
    /**
     * An element id is a real handle for an agent, but it is a weaker one: a
     * page-sized layout div with an id would otherwise outrank every control on
     * the screen, since summariseNodes() scores a test id above everything.
     * So an id only rides along on a node that earned its place some other way.
     */
    if (!testId) testId = clean(el.getAttribute('id'), opts.maxLabelChars);

    var rect = el.getBoundingClientRect();
    if (!isVisible(el, rect, opts)) return null;

    var node = { type: tag };
    if (label) node.label = label;
    if (testId) node.testId = testId;
    node.rect = [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height)
    ];
    node.depth = depth;
    node.origin = 'dom';
    return node;
  }

  /**
   * Depth counts from the document element, so `html` is 0 the way the window is
   * 0 on the device side. Open shadow roots are walked because a web component's
   * button is the thing being talked about; a closed root and a cross-origin
   * iframe are both unreachable and are skipped rather than guessed at.
   */
  function walk(parent, depth, parentLabel, out, opts) {
    for (var el = parent.firstElementChild; el; el = el.nextElementSibling) {
      if (out.length >= opts.maxNodes) return;
      if (SKIP_TAGS.test(el.tagName.toLowerCase())) continue;
      var node = nodeFor(el, depth, parentLabel, opts);
      if (node) out.push(node);
      var label = node && node.label ? node.label : parentLabel;
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1, label, out, opts);
      walk(el, depth + 1, label, out, opts);
    }
  }

  function sample(opts, startedAtMs) {
    var nodes = [];
    walk(document.documentElement, 1, undefined, nodes, opts);
    return {
      tMs: Math.max(0, Math.round(performance.now() - startedAtMs) + opts.offsetMs),
      screen: { width: Math.round(innerWidth), height: Math.round(innerHeight) },
      nodes: nodes
    };
  }

  function download(bundle, fileName) {
    var blob = new Blob([JSON.stringify(bundle, null, 2) + '\n'], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Give the download a tick to start before the blob goes away.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  var talkthru = {
    version: VERSION,

    /** Start sampling. Safe to call twice; the second call is ignored. */
    start: function (given) {
      if (state) return talkthru;
      var opts = options(given);
      state = { opts: opts, startedAtMs: performance.now(), startedAt: Date.now(), snapshots: [], timer: 0 };
      state.snapshots.push(sample(opts, state.startedAtMs));
      state.timer = setInterval(function () {
        state.snapshots.push(sample(state.opts, state.startedAtMs));
      }, opts.intervalMs);
      return talkthru;
    },

    /** Stop, download hierarchy.json, and return the bundle. */
    stop: function () {
      if (!state) return null;
      clearInterval(state.timer);
      var bundle = {
        version: 1,
        client: 'talkthru-dom/' + VERSION,
        startedAt: state.startedAt,
        snapshots: state.snapshots
      };
      var opts = state.opts;
      state = null;
      if (opts.autoDownload) download(bundle, opts.fileName);
      return bundle;
    },

    /** Snapshots captured so far, without stopping. */
    snapshots: function () {
      return state ? state.snapshots.slice() : [];
    },

    recording: function () {
      return state !== null;
    }
  };

  global.talkthru = talkthru;

  // Loaded during a recording, so start on load unless told not to:
  // <script src="talkthru-dom.js" data-autostart="false"></script>
  var script = document.currentScript;
  var autostart = !script || script.getAttribute('data-autostart') !== 'false';
  if (autostart) {
    var given = {};
    if (script) {
      if (script.getAttribute('data-interval')) given.intervalMs = Number(script.getAttribute('data-interval'));
      if (script.getAttribute('data-offset')) given.offsetMs = Number(script.getAttribute('data-offset'));
    }
    talkthru.start(given);
    if (global.console) console.log('talkthru: capturing DOM hierarchy — call talkthru.stop() when you are done.');
  }
})(typeof window !== 'undefined' ? window : this);

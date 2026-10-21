/**
 * Runs before the first paint.
 *
 * The chat app stores the chosen theme and sidebar state in localStorage. If
 * we waited for app.js (a module, so it runs after the HTML is parsed), the
 * page would paint once with the default theme and then jump - the classic
 * "theme flash". This file is a plain script in <head>, so it applies the
 * saved values before anything is drawn.
 *
 * The values are validated against a whitelist: a theme name that no longer
 * exists falls back to the default instead of leaving the page unstyled.
 */
(function () {
  "use strict";

  var THEMES = ["midnight", "aurora", "studio", "cyberpunk"];
  var SIDEBAR_STATES = ["expanded", "collapsed"];

  function readAllowed(key, allowed, fallback) {
    try {
      var saved = window.localStorage.getItem(key);
      return allowed.indexOf(saved) === -1 ? fallback : saved;
    } catch (error) {
      // localStorage can be blocked (private mode, hardened settings).
      return fallback;
    }
  }

  var root = document.documentElement;
  root.setAttribute("data-theme", readAllowed("tokenharbor.theme", THEMES, "midnight"));
  root.setAttribute("data-sidebar", readAllowed("tokenharbor.sidebar", SIDEBAR_STATES, "expanded"));
})();


(function () {
  "use strict";

  var THEMES = ["midnight", "aurora", "studio", "cyberpunk"];
  var SIDEBAR_STATES = ["expanded", "collapsed"];

  function readAllowed(key, allowed, fallback) {
    try {
      var saved = window.localStorage.getItem(key);
      return allowed.indexOf(saved) === -1 ? fallback : saved;
    } catch (error) {

      return fallback;
    }
  }

  var root = document.documentElement;
  root.setAttribute("data-theme", readAllowed("tokenharbor.theme", THEMES, "midnight"));
  root.setAttribute("data-sidebar", readAllowed("tokenharbor.sidebar", SIDEBAR_STATES, "expanded"));
})();
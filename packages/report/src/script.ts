/**
 * The report's only script: a hover/keyboard layer for the time-series charts (crosshair that snaps to
 * the nearest sample, one tooltip listing every series). Everything it shows is also in each chart's
 * table view, so the page is complete without it. All text is inserted with textContent.
 */
export const SCRIPT = `
(function () {
  var figs = document.querySelectorAll("figure.chart[data-chart]");
  Array.prototype.forEach.call(figs, function (fig) {
    var data;
    try { data = JSON.parse(fig.getAttribute("data-chart")); } catch (e) { return; }
    var svg = fig.querySelector("svg.plot");
    var hit = fig.querySelector("rect.hit");
    var cross = fig.querySelector("line.cross");
    var tip = fig.querySelector(".tip");
    if (!svg || !hit || !cross || !tip) return;
    var p = data.plot;
    var current = -1;

    function xOf(i) { return p.left + ((data.x[i] - p.x0) / (p.x1 - p.x0)) * (p.right - p.left); }
    function nearest(svgX) {
      var best = 0, bestD = Infinity;
      for (var i = 0; i < data.x.length; i++) {
        var d = Math.abs(xOf(i) - svgX);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    function fmt(v) {
      if (v === null || v === undefined) return "n/a";
      var a = Math.abs(v);
      if (a >= 1000) return Math.round(v).toLocaleString("en-US");
      return String(Number(v.toPrecision(4)));
    }
    function show(i) {
      current = i;
      var x = xOf(i);
      cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.style.display = "";
      while (tip.firstChild) tip.removeChild(tip.firstChild);
      var t = document.createElement("div"); t.className = "t";
      t.textContent = fmt(data.x[i]) + " " + data.xUnit;
      tip.appendChild(t);
      data.series.forEach(function (s) {
        var row = document.createElement("div"); row.className = "row";
        var key = document.createElement("span"); key.className = "key k" + s.slot;
        var val = document.createElement("b"); val.textContent = fmt(s.mean[i]);
        row.appendChild(key); row.appendChild(val);
        if (data.series.length > 1) {
          var name = document.createElement("span"); name.className = "name"; name.textContent = s.label;
          row.appendChild(name);
        }
        tip.appendChild(row);
      });
      tip.style.display = "block";
      var box = svg.getBoundingClientRect();
      var fbox = fig.getBoundingClientRect();
      var px = (x / p.w) * box.width + (box.left - fbox.left);
      var tw = tip.offsetWidth;
      var left = px + 12;
      if (left + tw > fbox.width) left = px - tw - 12;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = (box.top - fbox.top + 8) + "px";
    }
    function hide() { current = -1; cross.style.display = "none"; tip.style.display = "none"; }

    hit.addEventListener("pointermove", function (e) {
      var box = svg.getBoundingClientRect();
      show(nearest(((e.clientX - box.left) / box.width) * p.w));
    });
    hit.addEventListener("pointerleave", hide);
    fig.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { show(Math.min(data.x.length - 1, current + 1)); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { show(Math.max(0, current < 0 ? 0 : current - 1)); e.preventDefault(); }
      else if (e.key === "Escape") hide();
    });
    fig.addEventListener("blur", hide);
  });
})();
`;

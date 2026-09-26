/* ============================================================================
   Dalal — pages/calendar.js
   ----------------------------------------------------------------------------
   Trading holidays schedule and market session timings.
   ========================================================================== */
(function (D) {
  "use strict";

  var ui = D.ui;
  var fmt = D.fmt;
  var esc = fmt.esc;

  D.pages = D.pages || {};

  var HOLIDAYS_2025 = [
    { date: "2025-01-26", day: "Sunday", occasion: "Republic Day" },
    { date: "2025-02-26", day: "Wednesday", occasion: "Mahashivratri" },
    { date: "2025-03-14", day: "Friday", occasion: "Holi" },
    { date: "2025-03-31", day: "Monday", occasion: "Id-Ul-Fitr (Ramzan Id)" },
    { date: "2025-04-10", day: "Thursday", occasion: "Mahavir Jayanti" },
    { date: "2025-04-14", day: "Monday", occasion: "Dr. Baba Saheb Ambedkar Jayanti" },
    { date: "2025-04-18", day: "Friday", occasion: "Good Friday" },
    { date: "2025-05-01", day: "Thursday", occasion: "Maharashtra Day" },
    { date: "2025-08-15", day: "Friday", occasion: "Independence Day" },
    { date: "2025-08-27", day: "Wednesday", occasion: "Ganesh Chaturthi" },
    { date: "2025-10-02", day: "Thursday", occasion: "Mahatma Gandhi Jayanti / Dussehra" },
    { date: "2025-10-21", day: "Tuesday", occasion: "Diwali * Laxmi Pujan (Muhurat Trading)" },
    { date: "2025-10-22", day: "Wednesday", occasion: "Diwali Balipratipada" },
    { date: "2025-11-05", day: "Wednesday", occasion: "Prakash Gurpurb Sri Guru Nanak Dev" },
    { date: "2025-12-25", day: "Thursday", occasion: "Christmas" }
  ];

  D.pages.calendar = function (container) {
    var timer = null;

    function render() {
      var status = D.market.getStatus();
      var now = new Date();
      var todayIso = now.toISOString().slice(0, 10);

      var holidayRows = HOLIDAYS_2025.map(function (h) {
        var isPast = h.date < todayIso;
        var isToday = h.date === todayIso;
        var rowClass = isToday ? "bold" : (isPast ? "dim" : "");
        var statusBadge = isToday
          ? '<span class="badge down">Today</span>'
          : (isPast ? '<span class="dim small">Passed</span>' : '<span class="badge">Upcoming</span>');

        return '<tr class="' + rowClass + '">' +
          '<td>' + esc(h.date) + '</td>' +
          '<td>' + esc(h.day) + '</td>' +
          '<td>' + esc(h.occasion) + '</td>' +
          '<td class="num">' + statusBadge + '</td>' +
        '</tr>';
      }).join("");

      var html = '<div class="container">' +
        '<div class="page-head flex-between mb-4">' +
          '<div>' +
            '<h1>Market Schedule & Holidays</h1>' +
            '<p class="dim small">Official NSE trading sessions and exchange calendar (Asia/Kolkata)</p>' +
          '</div>' +
          '<div>' + ui.freshness(status) + '</div>' +
        '</div>' +

        '<div class="grid grid-2 mb-4">' +
          '<div class="card">' +
            '<div class="card-head"><h2>Current Session</h2></div>' +
            '<div class="card-body">' +
              '<div class="h2 mb-2 ' + (status.open ? 'up' : 'dim') + '">' +
                (status.open ? 'Market is Open' : 'Market is Closed') +
              '</div>' +
              '<p class="dim small">' + esc(status.reason || "NSE Regular Equities Segment") + '</p>' +
              '<div class="dim small mt-3">Current IST: ' + esc(fmt.time(Date.now())) + '</div>' +
            '</div>' +
          '</div>' +

          '<div class="card">' +
            '<div class="card-head"><h2>Session Timings (IST)</h2></div>' +
            '<div class="card-body card-body--flush">' +
              '<table class="data data-compact">' +
                '<tbody>' +
                  '<tr><td class="bold">09:00 - 09:08</td><td>Pre-open Order Entry & Modification</td></tr>' +
                  '<tr><td class="bold">09:08 - 09:12</td><td>Pre-open Order Matching & Discovery</td></tr>' +
                  '<tr><td class="bold">09:15 - 15:30</td><td class="up bold">Regular Continuous Trading</td></tr>' +
                  '<tr><td class="bold">15:30 - 15:40</td><td>Closing Price Calculation (VWAP)</td></tr>' +
                  '<tr><td class="bold">15:40 - 16:00</td><td>Post-closing Session</td></tr>' +
                '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><h2>NSE Trading Holidays 2025</h2></div>' +
          '<div class="card-body card-body--flush">' +
            '<div class="table-wrap"><table class="data">' +
              '<thead><tr>' +
                '<th>Date</th><th>Day</th><th>Occasion</th><th class="num">Status</th>' +
              '</tr></thead>' +
              '<tbody>' + holidayRows + '</tbody>' +
            '</table></div>' +
          '</div>' +
        '</div>' +
      '</div>';

      container.innerHTML = html;
    }

    render();
    timer = setInterval(render, 30000);

    return function cleanup() {
      if (timer) clearInterval(timer);
    };
  };
})(window.Dalal = window.Dalal || {});

// Mock/preview payloads for the three logbook-style registers on the
// "Risks & Issues" tab. Same shape /api/registers?type=X returns for live
// data, so preview mode demonstrates the real layout without a ClickUp
// connection.
//
// Deliberately empty: a fabricated sample entry (e.g. a made-up supplier
// risk) would look like real portfolio data the moment someone opens this
// tab, and there's no way to tell a genuine ClickUp-sourced entry apart from
// a placeholder once it's on screen. Preview mode should show the real
// empty state instead -- "nothing logged yet" -- exactly as a freshly
// created ClickUp list would, so nothing here is ever mistaken for an
// actual risk, issue, or lesson.
module.exports = {
  risk: [],
  issue: [],
  lesson: [],
};

export function dedupeEvents(events) {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

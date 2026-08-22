export function transition(match, event) {
  return { ...match, lastEvent: event.id };
}

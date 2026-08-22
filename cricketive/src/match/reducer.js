export function reduceMatch(match, event) {
  return { ...match, events: [...(match.events ?? []), event] };
}

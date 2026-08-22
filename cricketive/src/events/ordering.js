export function orderEvents(events) {
  return [...events].sort((left, right) => new Date(left.occurredAt) - new Date(right.occurredAt));
}

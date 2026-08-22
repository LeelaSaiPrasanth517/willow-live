export function validateEvent(event) {
  return Boolean(event?.id && event?.type && event?.occurredAt);
}

export function isLegalDelivery(delivery) {
  return !delivery?.isWide && !delivery?.isNoBall;
}

export function anomalyLabel(score){if(score>=.8)return"CRITICAL";if(score>=.5)return"HIGH";if(score>=.2)return"MEDIUM";return"LOW";}

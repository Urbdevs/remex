import { logger } from './logger';

const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

/**
 * Fire a PagerDuty "trigger" event via the Events API v2.
 *
 * Uses the routing key from PAGERDUTY_ROUTING_KEY env var.
 * If the key is absent the call is silently skipped (allows local dev without PD).
 * The function is intentionally non-throwing — caller is responsible for its own error handling.
 */
export async function alertPagerDuty(
  summary:  string,
  details:  Record<string, unknown>,
  severity: 'critical' | 'error' | 'warning' | 'info' = 'critical',
): Promise<void> {
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) {
    logger.warn({ summary }, 'pagerduty: PAGERDUTY_ROUTING_KEY not set — alert skipped');
    return;
  }

  const body = {
    routing_key:   routingKey,
    event_action:  'trigger',
    payload: {
      summary,
      severity,
      source:         'remex-api',
      custom_details: details,
    },
  };

  try {
    const res = await fetch(PAGERDUTY_EVENTS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: text, summary },
        'pagerduty: alert delivery failed',
      );
    } else {
      logger.info({ summary }, 'pagerduty: alert triggered');
    }
  } catch (err) {
    logger.error({ err, summary }, 'pagerduty: network error delivering alert');
  }
}

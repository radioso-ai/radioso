# Rate Limits

The Hivec API allows 60 requests per minute per account token.

If a client exceeds the limit, it should wait 30 seconds before retrying.

Burst traffic should be smoothed with a queue.

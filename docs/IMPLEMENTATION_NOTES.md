# Implementation Notes

## Architecture

The service is intentionally split into four layers:

### `config.py`

Loads required runtime configuration from environment variables.

### `client.py`

Owns all direct HTTP communication with Beli:

- access token refresh
- authenticated GET and POST requests
- low-level endpoint methods

This layer should stay close to Beli’s transport semantics.

### `service.py`

Owns application logic:

- radius-to-bounds conversion
- filter construction
- score and distance normalization
- average Beli score hydration
- deduplication
- exact-radius filtering

This layer should express the product behavior we want, not the quirks of the raw upstream.

### `main.py`

Owns the FastAPI surface:

- route registration
- dependency wiring
- exception translation

## Why `user-rec-scores` Matters

The most important reverse-engineering result was that nearby score-ranked restaurant discovery is driven by:

- `POST /api/user-rec-scores/`

not by:

- `search-app`
- `search-businesses-full`

Those search endpoints are still useful, but they are not the correct primitive for “best halal places within 10 miles of me”.

## Radius Handling

The upstream API does not accept:

- `radius`

It accepts:

- `coords`
- `bounds`

So this implementation:

1. converts a requested mile radius into a bounding box
2. queries the upstream using that box
3. applies exact-radius filtering with Haversine distance

That design is deliberate and should not be “simplified” away.

## Why `coords` Alone Is Not Enough

Empirical replay showed that:

- `sort_method = "Score"`
- with `coords`
- but without `bounds`

can produce global high-score restaurants rather than truly nearby results.

That is why this service always computes `bounds` for nearby recommendation endpoints.

## Deduplication

The upstream response can include repeated businesses with different cuisine strings or slightly different metadata payloads.

This implementation keeps the first occurrence by default because the result order already reflects the requested sort method.

## Score Semantics

The service exposes two different Beli-derived score concepts because the app uses both:

- `recommendation_score`
  - comes from `POST /api/user-rec-scores/`
  - is query-specific and location/context aware
- `average_beli_score`
  - comes from `GET /api/databusinessfloat-sparse/?business=<id>&field__name=AVGBUSINESSSCORE`
  - matches the average score family shown on the business page

These should not be merged into one field. The old `score` field is preserved as a backward-compatible alias of `recommendation_score`.

## Raw Payload Preservation

Every normalized restaurant result keeps a `raw` copy.

That is intentional:

- reverse-engineered APIs are unstable
- raw inspection is often necessary when the upstream changes
- it lets you validate hidden fields without changing the schema first

## Suggested Production Hardening

If you want to deploy this beyond local analysis:

- add structured logging
- add retries for transient upstream failures
- add request rate limiting
- add your own authentication layer
- add caching for taxonomy endpoints
- add persistence for query results if you want analytics

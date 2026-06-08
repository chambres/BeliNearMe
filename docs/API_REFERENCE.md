# API Reference

## Overview

This document describes the public API exposed by this project, not the internal Beli API directly.

All endpoints are JSON-only.

## `GET /health`

Health check.

### Response

```json
{
  "status": "ok"
}
```

## `GET /config`

Returns the runtime config the service was booted with.

This exists mainly to confirm that the correct Beli user id and base host are loaded.

### Response fields

- `beli_user_id`
- `beli_api_base`
- `request_timeout_seconds`

## `POST /v1/search/app`

Thin wrapper around Beli `GET /api/search-app/`.

Use this when you want:

- term-based discovery
- metadata hints returned in `cuisines` and `labels`
- a normalized view of search predictions

### Request

```json
{
  "term": "Halal",
  "location": {
    "latitude": 29.7604,
    "longitude": -95.3698
  },
  "city": "Houston, TX",
  "context": null
}
```

### Response

- `source_endpoint`
- `term`
- `cuisines`
- `labels`
- `predictions`
- `raw`

## `POST /v1/search/businesses-full`

Thin wrapper around Beli `GET /api/search-businesses-full/`.

Use this when:

- you want richer prediction rows
- you want the “full search” flavor instead of search-app

## `POST /v1/recommendations/nearby`

Primary endpoint for nearby recommendations ranked by a sort method.

### Request fields

- `location`
  - center of the query
- `radius_miles`
  - desired exact radius
- `page`
  - Beli page number
- `page_size`
  - number of raw results requested from Beli
- `sort_method`
  - one of:
    - `Score`
    - `Distance`
    - `Date added`
    - `Recency`
    - `Most Trending`
    - `Number of friends`
- `city`
  - optional city filter
- `cuisines`
  - optional cuisine metadata filters
- `open_now`
  - optional binary filter
- `min_score`
  - client-side threshold after results are returned
- `exact_radius_only`
  - if true, drops any restaurant outside the radius
- `include_filter_options`
  - if true, fetches Beli filter options over the returned result set
- `dedupe_businesses`
  - removes repeated business ids
- `for_map_view`
  - forwards the Beli map-view flag
- `raw_filters`
  - escape hatch for raw Beli filter injection

### Response fields

- `source_endpoint`
- `request_summary`
- `returned_count`
- `exact_radius_count`
- `results`
- `filter_options`

Each result includes both score families:

- `recommendation_score`
  - the query-context ranking value returned by `user-rec-scores`
- `average_beli_score`
  - the business-page average Beli score fetched from `databusinessfloat-sparse`
- `score`
  - backward-compatible alias of `recommendation_score`

## `POST /v1/recommendations/halal-nearby`

Same schema as `/v1/recommendations/nearby`, but forces:

```json
{
  "key": "CUISINE",
  "value": ["Halal"]
}
```

This is the fastest route to “halal restaurants near me ranked by score”.

## `GET /v1/metadata/dietary-restrictions`

Returns Beli’s dietary restriction taxonomy from:

- `GET /api/dietary-restriction-options/`

### Response

```json
{
  "options": [
    {
      "name": "Halal",
      "raw": {
        "...": "..."
      }
    }
  ]
}
```

## Error Model

The service currently surfaces upstream failures as:

- HTTP `502`

The `detail` message contains the Beli-side error text when available.

## Notes On Stability

The public API here is more stable than the internal Beli schema, but it still depends on reverse-engineered behavior.

If Beli changes:

- endpoint names
- auth rules
- field names
- filter semantics

then normalized responses may need to be updated.

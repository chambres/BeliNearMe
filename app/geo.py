from __future__ import annotations

import math


EARTH_RADIUS_MILES = 3958.7613


def haversine_miles(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    lat_a = math.radians(latitude_a)
    lon_a = math.radians(longitude_a)
    lat_b = math.radians(latitude_b)
    lon_b = math.radians(longitude_b)

    delta_lat = lat_b - lat_a
    delta_lon = lon_b - lon_a

    sin_lat = math.sin(delta_lat / 2.0)
    sin_lon = math.sin(delta_lon / 2.0)
    arc = sin_lat * sin_lat + math.cos(lat_a) * math.cos(lat_b) * sin_lon * sin_lon
    central_angle = 2.0 * math.asin(math.sqrt(arc))
    return EARTH_RADIUS_MILES * central_angle


def miles_to_bounds(latitude: float, longitude: float, radius_miles: float) -> dict[str, float]:
    if radius_miles <= 0:
        raise ValueError("radius_miles must be positive.")

    latitude_delta = radius_miles / 69.0
    longitude_scale = max(math.cos(math.radians(latitude)), 0.01)
    longitude_delta = radius_miles / (69.172 * longitude_scale)

    return {
        "northLatitude": latitude + latitude_delta,
        "southLatitude": latitude - latitude_delta,
        "eastLongitude": longitude + longitude_delta,
        "westLongitude": longitude - longitude_delta,
    }

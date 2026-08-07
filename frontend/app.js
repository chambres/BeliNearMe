"use strict";

// ---------- Element handles ----------
const form = document.getElementById("query-form");
const latitudeInput = document.getElementById("latitude");
const longitudeInput = document.getElementById("longitude");
const radiusInput = document.getElementById("radius");
const radiusValue = document.getElementById("radius-value");
const sortSelect = document.getElementById("sort");
const openNowInput = document.getElementById("open-now");
const exactRadiusInput = document.getElementById("exact-radius");

const priceOptions = document.getElementById("price-options");
const cuisineOptions = document.getElementById("cuisine-options");
const selectedCuisinesBox = document.getElementById("selected-cuisines");
const excludedCuisinesBox = document.getElementById("excluded-cuisines");
const excludedDropzone = document.getElementById("excluded-cuisines-dropzone");
const customCuisineInput = document.getElementById("custom-cuisine");
const addCuisineButton = document.getElementById("add-cuisine-button");

const submitButton = document.getElementById("submit-button");
const resetButton = document.getElementById("reset-button");

const statusBanner = document.getElementById("status-banner");
const resultsNote = document.getElementById("results-note");
const resultsList = document.getElementById("results-list");
const rowTemplate = document.getElementById("result-row-template");


const modeRadiusBtn = document.getElementById("mode-radius");
const modePathBtn = document.getElementById("mode-path");
const pathWidthInput = document.getElementById("path-width");
const pathWidthValue = document.getElementById("path-width-value");
const pathCount = document.getElementById("path-count");
const pathUndoBtn = document.getElementById("path-undo");
const pathClearBtn = document.getElementById("path-clear");

// ---------- State ----------
let map;
let centerMarker;
let radiusCircle;
let resultLayer;
const rowRefs = []; // { row, marker, businessId, scoreEl } per result
let activeIndex = -1;

// Search-area mode: "radius" (center + circle) or "path" (route corridor)
let mode = "radius";
let pathPoints = []; // [{ lat, lng }] waypoints
let pathLayer; // centerline polyline
let corridorLayer; // wide band polyline
let waypointLayer; // group of draggable vertex markers

let selectedCuisines = [];
let excludedCuisines = [];
let selectedPriceLevels = [];

const cuisineChoices = [
  "Halal", "Pakistani", "Indian", "Middle Eastern", "Mediterranean",
  "Mexican", "Italian", "Chinese", "Japanese", "Sushi", "Thai",
  "Vietnamese", "Korean", "Seafood", "Barbecue", "Steakhouse",
  "Vegan", "Vegetarian", "Gluten Free", "Kosher",
];
const priceChoices = [1, 2, 3, 4];

const defaults = {
  latitude: 29.7858,
  longitude: -95.8245,
  radius: 10,
  sort: "Score",
  cuisines: [],
  excludedCuisines: [],
  priceLevels: [],
  openNow: false,
  exactRadius: true,
};

// ---------- Formatting helpers ----------
function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Number(value).toFixed(1);
}

function formatDistance(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return `${Number(value).toFixed(1)} mi`;
}

function formatPrice(business) {
  if (!business) return null;
  const price = Number(business.price);
  if (!Number.isNaN(price) && price > 0) return "$".repeat(price);
  if (typeof business.price_key === "string" && business.price_key.trim()) return business.price_key.trim();
  return null;
}

function isOperational(status) {
  return typeof status === "string" && status.toUpperCase() === "OPERATIONAL";
}

function scoreTier(score) {
  const value = Number(score);
  if (Number.isNaN(value)) return "";
  if (value >= 9) return "tier-a";
  if (value >= 8) return "tier-b";
  return "";
}

// ---------- Geo (corridor math) ----------
const DEG = Math.PI / 180;
const MILES_PER_DEG_LAT = 69.0;

function haversineMiles(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Shortest distance (miles) from point p to segment a–b, via a local
// equirectangular projection centred on p (accurate at corridor scale).
function milesPointToSegment(p, a, b) {
  const kx = MILES_PER_DEG_LAT * Math.cos(p.lat * DEG); // miles per deg lng near p
  const ky = MILES_PER_DEG_LAT; // miles per deg lat
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// Distance (miles) from a point to the whole polyline.
function milesPointToPath(p, points) {
  if (!points.length) return Infinity;
  if (points.length === 1) return haversineMiles(p, points[0]);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    best = Math.min(best, milesPointToSegment(p, points[i], points[i + 1]));
  }
  return best;
}

function pathBboxCenter(points) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
  }
  return { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 };
}

// Radius (miles) whose bounding box covers the whole path plus the corridor.
function pathCoverRadius(points, widthMiles) {
  const center = pathBboxCenter(points);
  let maxDist = 0;
  for (const point of points) maxDist = Math.max(maxDist, haversineMiles(center, point));
  return { center, radius: Math.min(100, maxDist + widthMiles + 0.5) };
}

function pathWidth() {
  return Number(pathWidthInput.value);
}

// ---------- Request ----------
function buildPayload() {
  const base = {
    sort_method: sortSelect.value,
    city: null,
    cuisines: [...selectedCuisines],
    excluded_cuisines: [...excludedCuisines],
    price_levels: [...selectedPriceLevels],
    open_now: openNowInput.checked,
    include_filter_options: false,
  };

  if (mode === "path") {
    // Fetch every candidate across the route's bounding box, then filter to
    // the corridor client-side (see corridorFilter).
    const { center, radius } = pathCoverRadius(pathPoints, pathWidth());
    return {
      ...base,
      location: { latitude: center.lat, longitude: center.lng },
      radius_miles: radius,
      exact_radius_only: false,
      page_size: 200,
    };
  }

  return {
    ...base,
    location: {
      latitude: Number(latitudeInput.value),
      longitude: Number(longitudeInput.value),
    },
    radius_miles: Number(radiusInput.value),
    exact_radius_only: exactRadiusInput.checked,
  };
}

// Keep only results within the corridor width of the drawn path, annotate each
// with its distance to the path, and order shortest-first when sorting by
// Distance (otherwise preserve the server's score-based order).
function corridorFilter(results) {
  const width = pathWidth();
  const kept = [];
  for (const result of results) {
    const lat = Number(result.business && result.business.lat);
    const lng = Number(result.business && result.business.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
    const distance = milesPointToPath({ lat, lng }, pathPoints);
    if (distance <= width) {
      result._pathDistance = distance;
      kept.push(result);
    }
  }
  if (sortSelect.value === "Distance") {
    kept.sort((a, b) => a._pathDistance - b._pathDistance);
  }
  return kept;
}

function searchLabel() {
  return mode === "path" ? "your route" : "the map center";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (mode === "path" && pathPoints.length < 2) {
    setStatus("Add at least 2 stops on the map to define a route.");
    return;
  }

  const payload = buildPayload();
  const label = searchLabel();

  setLoading(true);
  setStatus(`Searching ${mode === "path" ? "along " : "near "}${label}…`);
  showSkeletons();

  try {
    const response = await fetch("/v1/recommendations/nearby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Request failed.");

    if (mode === "path") {
      const scanned = Array.isArray(data.results) ? data.results.length : 0;
      data.results = corridorFilter(data.results || []);
      data.exact_radius_count = data.results.length;
      data.returned_count = scanned;
    }
    renderResults(data, label);
  } catch (error) {
    renderError(error.message || "Unknown error.");
  } finally {
    setLoading(false);
  }
});

// ---------- Rendering ----------
function renderResults(data, label) {
  const results = Array.isArray(data.results) ? data.results : [];

  clearResultMarkers();
  resultsList.replaceChildren();
  rowRefs.length = 0;
  activeIndex = -1;

  const sortName = sortSelect.options[sortSelect.selectedIndex].text;
  resultsNote.textContent = results.length ? `sorted by ${sortName}` : "";

  if (!results.length) {
    setStatus("No restaurants matched these filters — widen the radius or clear a cuisine.");
    const empty = document.createElement("li");
    empty.className = "list-placeholder";
    empty.textContent = "No matches.";
    resultsList.appendChild(empty);
    return;
  }

  const preposition = mode === "path" ? "along" : "near";
  setStatus(`${results.length} restaurants ${preposition} ${label}. Click a row to locate it on the map.`);

  const bounds = [];
  if (mode === "path") {
    for (const point of pathPoints) bounds.push([point.lat, point.lng]);
  } else {
    const centerLat = Number(latitudeInput.value);
    const centerLng = Number(longitudeInput.value);
    if (!Number.isNaN(centerLat) && !Number.isNaN(centerLng)) bounds.push([centerLat, centerLng]);
  }

  results.forEach((result, index) => {
    const rank = index + 1;
    const business = result.business || {};
    const avg = result.average_beli_score;
    const rec = result.recommendation_score ?? result.score;
    const tier = scoreTier(avg);

    // ---- list row ----
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".row");
    if (tier) row.classList.add(tier);
    row.querySelector(".row-rank").textContent = rank;
    row.querySelector(".row-name").textContent = business.name || "Unknown";

    const headline = row.querySelector(".row-headline");
    const link = row.querySelector(".row-link");

    // phone / website icon links (from the raw Beli business payload)
    const rawBusiness = (result.raw && result.raw.business) || {};
    const phone = typeof rawBusiness.phone_number === "string" ? rawBusiness.phone_number.trim() : "";
    const website = typeof rawBusiness.website === "string" ? rawBusiness.website.trim() : "";
    if (phone) headline.insertBefore(iconLink(`tel:${phone}`, "phone", phone), link);
    if (/^https?:\/\//i.test(website)) headline.insertBefore(iconLink(website, "web", website), link);

    if (business.quick_link) {
      link.href = business.quick_link;
    } else {
      link.removeAttribute("href");
      link.textContent = "no link";
      link.classList.add("is-disabled");
    }
    link.addEventListener("click", (event) => event.stopPropagation());

    const scoreEl = row.querySelector(".row-score-value");
    const avgText = formatScore(avg);
    if (avgText) {
      scoreEl.textContent = avgText;
    } else {
      scoreEl.textContent = "–";
      scoreEl.classList.add("dim");
    }
    const rowScoreEl = scoreEl;

    row.querySelector(".row-meta").append(...buildMeta(result, business, rec));

    // ---- map marker ----
    let marker = null;
    const lat = Number(business.lat);
    const lng = Number(business.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && lat !== 0 && lng !== 0) {
      marker = L.marker([lat, lng], { icon: numberedIcon(rank, tier) });
      marker.bindPopup(popupHtml(business, avgText, result.distance_mi));
      marker.on("click", () => focusResult(index, { fromMap: true }));
      resultLayer.addLayer(marker);
      bounds.push([lat, lng]);
    }

    row.addEventListener("click", () => focusResult(index, { fromMap: false }));
    rowRefs.push({ row, marker, businessId: business.id, scoreEl: rowScoreEl });
    resultsList.appendChild(fragment);
  });

  if (map && bounds.length > 1) {
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
  }

}

function buildMeta(result, business, rec) {
  const parts = [];
  const cuisines = Array.isArray(business.cuisines) ? business.cuisines.filter(Boolean) : [];
  if (cuisines.length) parts.push(text(cuisines.slice(0, 3).join(", ")));

  const price = formatPrice(business);
  if (price) parts.push(tag(price));

  const distance = formatDistance(result._pathDistance ?? result.distance_mi);
  if (distance) parts.push(tag(distance));

  const recText = formatScore(rec);
  if (recText) parts.push(text(`rec ${recText}`));

  if (result.mention_count) parts.push(text(`${result.mention_count} ratings`));

  if (business.status) {
    const open = isOperational(business.status);
    const el = document.createElement("span");
    el.className = open ? "row-open" : "row-closed";
    el.textContent = open ? "Open" : "Closed";
    parts.push(el);
  }

  // Join with separators
  const out = [];
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "·";
      out.push(sep);
    }
    out.push(part);
  });
  return out;
}

function text(value) {
  const el = document.createElement("span");
  el.textContent = value;
  return el;
}

function tag(value) {
  const el = document.createElement("span");
  el.className = "tag";
  el.textContent = value;
  return el;
}

const ICON_SVG = {
  phone: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.94.36 1.86.7 2.73a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.35-1.27a2 2 0 0 1 2.11-.45c.87.34 1.79.57 2.73.7A2 2 0 0 1 22 16.92z"/></svg>',
  web: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
};

function iconLink(href, kind, title) {
  const anchor = document.createElement("a");
  anchor.className = "row-icon";
  anchor.href = href;
  anchor.title = title;
  anchor.setAttribute("aria-label", kind === "phone" ? `Call ${title}` : `Website: ${title}`);
  if (kind !== "phone") {
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
  }
  anchor.innerHTML = ICON_SVG[kind];
  anchor.addEventListener("click", (event) => event.stopPropagation());
  return anchor;
}

function popupHtml(business, avgText, distance) {
  const bits = [];
  const cuisines = Array.isArray(business.cuisines) ? business.cuisines.filter(Boolean) : [];
  if (avgText) bits.push(`Beli avg ${avgText}`);
  if (cuisines.length) bits.push(cuisines[0]);
  const dist = formatDistance(distance);
  if (dist) bits.push(dist);
  const name = escapeHtml(business.name || "Unknown");
  return `<div class="popup-name">${name}</div><div class="popup-meta">${escapeHtml(bits.join("  ·  "))}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]
  ));
}

function focusResult(index, { fromMap }) {
  const ref = rowRefs[index];
  if (!ref) return;

  if (activeIndex >= 0 && rowRefs[activeIndex]) {
    rowRefs[activeIndex].row.classList.remove("is-active");
    setMarkerActive(rowRefs[activeIndex].marker, false);
  }
  activeIndex = index;
  ref.row.classList.add("is-active");
  setMarkerActive(ref.marker, true);

  if (ref.marker && map) {
    map.panTo(ref.marker.getLatLng(), { animate: true });
    ref.marker.openPopup();
  }
  if (fromMap) {
    ref.row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function setMarkerActive(marker, active) {
  if (!marker || !marker._icon) return;
  marker._icon.classList.toggle("is-active", active);
}

function numberedIcon(rank, tier) {
  return L.divIcon({
    className: "pin",
    html: `<span class="pin-dot ${tier}">${rank}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -15],
  });
}

function clearResultMarkers() {
  if (resultLayer) resultLayer.clearLayers();
}

function showSkeletons() {
  resultsList.replaceChildren();
  for (let i = 0; i < 6; i += 1) {
    const li = document.createElement("li");
    li.className = "skeleton";
    resultsList.appendChild(li);
  }
}

function renderError(message) {
  clearResultMarkers();
  resultsList.replaceChildren();
  rowRefs.length = 0;
  resultsNote.textContent = "";
  statusBanner.classList.add("is-error");
  statusBanner.textContent = message;
  const li = document.createElement("li");
  li.className = "list-placeholder";
  li.textContent = "Request failed.";
  resultsList.appendChild(li);
}

function setStatus(message) {
  statusBanner.classList.remove("is-error");
  statusBanner.textContent = message;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Searching…" : "Search";
}

// ---------- Cuisine + price pickers ----------
function renderCuisineOptions() {
  cuisineOptions.replaceChildren();
  for (const cuisine of cuisineChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    if (selectedCuisines.includes(cuisine)) button.classList.add("is-active");
    button.textContent = cuisine;
    button.draggable = true;
    button.addEventListener("click", () => toggleCuisine(cuisine));
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", cuisine);
      event.dataTransfer.effectAllowed = "move";
    });
    cuisineOptions.appendChild(button);
  }
}

function renderSelectedCuisines() {
  selectedCuisinesBox.replaceChildren();
  if (!selectedCuisines.length) {
    selectedCuisinesBox.appendChild(emptyToken("No cuisine filter — showing all."));
    return;
  }
  for (const cuisine of selectedCuisines) {
    const token = document.createElement("span");
    token.className = "token is-selected";
    token.draggable = true;
    token.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", cuisine);
      event.dataTransfer.effectAllowed = "move";
    });
    token.appendChild(text(cuisine));
    token.appendChild(removeButton(`Remove ${cuisine}`, () => {
      selectedCuisines = selectedCuisines.filter((v) => v !== cuisine);
      renderCuisinePickers();
    }));
    selectedCuisinesBox.appendChild(token);
  }
}

function renderExcludedCuisines() {
  excludedCuisinesBox.replaceChildren();
  if (!excludedCuisines.length) {
    excludedCuisinesBox.appendChild(emptyToken("Drag a cuisine here to exclude it."));
    return;
  }
  for (const cuisine of excludedCuisines) {
    const token = document.createElement("span");
    token.className = "token is-excluded";
    token.appendChild(text(cuisine));
    token.appendChild(removeButton(`Remove excluded ${cuisine}`, () => {
      excludedCuisines = excludedCuisines.filter((v) => v !== cuisine);
      renderCuisinePickers();
    }));
    excludedCuisinesBox.appendChild(token);
  }
}

function renderPriceOptions() {
  priceOptions.replaceChildren();
  for (const level of priceChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip is-price";
    if (selectedPriceLevels.includes(level)) button.classList.add("is-active");
    button.textContent = "$".repeat(level);
    button.addEventListener("click", () => togglePrice(level));
    priceOptions.appendChild(button);
  }
}

function renderCuisinePickers() {
  renderCuisineOptions();
  renderSelectedCuisines();
  renderExcludedCuisines();
}

function emptyToken(message) {
  const el = document.createElement("span");
  el.className = "token-empty";
  el.textContent = message;
  return el;
}

function removeButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "token-remove";
  button.textContent = "×";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", handler);
  return button;
}

function toggleCuisine(cuisine) {
  excludedCuisines = excludedCuisines.filter((v) => v !== cuisine);
  if (selectedCuisines.includes(cuisine)) {
    selectedCuisines = selectedCuisines.filter((v) => v !== cuisine);
  } else {
    selectedCuisines = [...selectedCuisines, cuisine];
  }
  renderCuisinePickers();
}

function togglePrice(level) {
  if (selectedPriceLevels.includes(level)) {
    selectedPriceLevels = selectedPriceLevels.filter((v) => v !== level);
  } else {
    selectedPriceLevels = [...selectedPriceLevels, level].sort((a, b) => a - b);
  }
  renderPriceOptions();
}

function addCustomCuisine() {
  const value = customCuisineInput.value.trim();
  if (!value) return;
  if (!selectedCuisines.includes(value)) selectedCuisines = [...selectedCuisines, value];
  excludedCuisines = excludedCuisines.filter((v) => v !== value);
  if (!cuisineChoices.includes(value)) cuisineChoices.push(value);
  customCuisineInput.value = "";
  renderCuisinePickers();
}

function excludeCuisine(cuisine) {
  if (!cuisine) return;
  if (!excludedCuisines.includes(cuisine)) excludedCuisines = [...excludedCuisines, cuisine];
  selectedCuisines = selectedCuisines.filter((v) => v !== cuisine);
  if (!cuisineChoices.includes(cuisine)) cuisineChoices.push(cuisine);
  renderCuisinePickers();
}

addCuisineButton.addEventListener("click", addCustomCuisine);
customCuisineInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addCustomCuisine();
  }
});

excludedDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  excludedDropzone.classList.add("is-over");
});
excludedDropzone.addEventListener("dragleave", () => excludedDropzone.classList.remove("is-over"));
excludedDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  excludedDropzone.classList.remove("is-over");
  excludeCuisine(event.dataTransfer.getData("text/plain").trim());
});

// ---------- Reset ----------
resetButton.addEventListener("click", () => {
  latitudeInput.value = defaults.latitude;
  longitudeInput.value = defaults.longitude;
  radiusInput.value = defaults.radius;
  sortSelect.value = defaults.sort;
  openNowInput.checked = defaults.openNow;
  exactRadiusInput.checked = defaults.exactRadius;

  selectedCuisines = [...defaults.cuisines];
  excludedCuisines = [...defaults.excludedCuisines];
  selectedPriceLevels = [...defaults.priceLevels];
  customCuisineInput.value = "";

  renderCuisinePickers();
  renderPriceOptions();
  updateRadiusLabel();
  syncCenter({ recenter: true });
});

// ---------- Map ----------
function initMap() {
  if (typeof L === "undefined") {
    setStatus("Map failed to load — search still works.");
    return;
  }

  const lat = Number(latitudeInput.value);
  const lng = Number(longitudeInput.value);

  map = L.map("map-picker", { zoomControl: true, scrollWheelZoom: true }).setView([lat, lng], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  const accent = token("--color-accent");

  radiusCircle = L.circle([lat, lng], {
    radius: milesToMeters(Number(radiusInput.value)),
    color: accent,
    weight: 1.5,
    opacity: 0.9,
    fillColor: accent,
    fillOpacity: 0.08,
  }).addTo(map);

  centerMarker = L.marker([lat, lng], { draggable: true, zIndexOffset: 1000 }).addTo(map);
  centerMarker.bindTooltip("Search center — drag to move", { direction: "top" });

  resultLayer = L.layerGroup().addTo(map);

  // Path-mode layers (created once, added/removed with the mode)
  corridorLayer = L.polyline([], {
    color: accent,
    opacity: 0.18,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  });
  pathLayer = L.polyline([], { color: accent, weight: 2.5, opacity: 0.95, interactive: false });
  waypointLayer = L.layerGroup();

  centerMarker.on("dragend", () => {
    const pos = centerMarker.getLatLng();
    setCenter(pos.lat, pos.lng, { recenter: false });
  });

  map.on("click", (event) => {
    if (mode === "path") {
      addPathPoint(event.latlng.lat, event.latlng.lng);
    } else {
      setCenter(event.latlng.lat, event.latlng.lng, { recenter: false });
    }
  });

  map.on("zoomend", updateCorridorWeight);

  radiusInput.addEventListener("input", () => {
    syncRadiusCircle();
    updateRadiusLabel();
  });
}

// ---------- Path drawing + corridor ----------
function setMode(next) {
  if (next === mode) return;
  mode = next;
  modeRadiusBtn.classList.toggle("is-active", mode === "radius");
  modePathBtn.classList.toggle("is-active", mode === "path");
  document.querySelectorAll(".mode-radius-only").forEach((el) => { el.hidden = mode !== "radius"; });
  document.querySelectorAll(".mode-path-only").forEach((el) => { el.hidden = mode !== "path"; });

  if (!map) return;
  if (mode === "path") {
    map.removeLayer(centerMarker);
    map.removeLayer(radiusCircle);
    corridorLayer.addTo(map);
    pathLayer.addTo(map);
    waypointLayer.addTo(map);
    updateCorridorWeight();
  } else {
    map.removeLayer(corridorLayer);
    map.removeLayer(pathLayer);
    map.removeLayer(waypointLayer);
    centerMarker.addTo(map);
    radiusCircle.addTo(map);
  }
}

function waypointIcon(index) {
  return L.divIcon({
    className: "waypoint",
    html: `<span class="waypoint-dot">${index + 1}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function addPathPoint(lat, lng) {
  pathPoints.push({ lat, lng });
  redrawPath();
}

function redrawPath() {
  const latlngs = pathPoints.map((p) => [p.lat, p.lng]);
  pathLayer.setLatLngs(latlngs);
  corridorLayer.setLatLngs(latlngs);
  updateCorridorWeight();

  waypointLayer.clearLayers();
  pathPoints.forEach((point, index) => {
    const marker = L.marker([point.lat, point.lng], {
      icon: waypointIcon(index),
      draggable: true,
      zIndexOffset: 900,
    });
    marker.on("drag", (event) => {
      const pos = event.target.getLatLng();
      pathPoints[index] = { lat: pos.lat, lng: pos.lng };
      pathLayer.setLatLngs(pathPoints.map((p) => [p.lat, p.lng]));
      corridorLayer.setLatLngs(pathPoints.map((p) => [p.lat, p.lng]));
    });
    marker.on("dragend", redrawPath);
    waypointLayer.addLayer(marker);
  });

  pathCount.textContent = `${pathPoints.length} ${pathPoints.length === 1 ? "stop" : "stops"}`;
}

// Render the corridor as a band whose on-screen width matches the real
// corridor width (± pathWidth) at the current zoom.
function updateCorridorWeight() {
  if (!map || !corridorLayer || mode !== "path" || pathPoints.length < 1) return;
  const lat = map.getCenter().lat;
  const metersPerPixel = (156543.03392 * Math.cos(lat * DEG)) / 2 ** map.getZoom();
  const fullWidthMeters = 2 * pathWidth() * 1609.344;
  corridorLayer.setStyle({ weight: Math.max(3, fullWidthMeters / metersPerPixel) });
}

function clearPath() {
  pathPoints = [];
  redrawPath();
}

function undoPathPoint() {
  pathPoints.pop();
  redrawPath();
}

modeRadiusBtn.addEventListener("click", () => setMode("radius"));
modePathBtn.addEventListener("click", () => setMode("path"));
pathClearBtn.addEventListener("click", clearPath);
pathUndoBtn.addEventListener("click", undoPathPoint);
pathWidthInput.addEventListener("input", () => {
  pathWidthValue.textContent = `${pathWidth().toFixed(2)} mi`;
  updateCorridorWeight();
});

function setCenter(lat, lng, { recenter = true } = {}) {
  latitudeInput.value = Number(lat).toFixed(6);
  longitudeInput.value = Number(lng).toFixed(6);
  if (!map || !centerMarker) return;
  centerMarker.setLatLng([lat, lng]);
  if (radiusCircle) radiusCircle.setLatLng([lat, lng]);
  if (recenter) map.panTo([lat, lng], { animate: true });
}

function syncCenter({ recenter = false } = {}) {
  const lat = Number(latitudeInput.value);
  const lng = Number(longitudeInput.value);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return;
  setCenter(lat, lng, { recenter });
  syncRadiusCircle();
}

function syncRadiusCircle() {
  if (!radiusCircle) return;
  const miles = Number(radiusInput.value);
  if (Number.isNaN(miles) || miles <= 0) return;
  radiusCircle.setRadius(milesToMeters(miles));
}

function updateRadiusLabel() {
  const miles = Number(radiusInput.value);
  radiusValue.textContent = Number.isNaN(miles) || miles <= 0 ? "–" : `${miles} mi`;
}

/* Leaflet needs a concrete colour string, so read it from the design token
   rather than hardcoding a hex that would drift from tokens.css. */
function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function milesToMeters(miles) {
  return miles * 1609.344;
}

// ---------- Boot ----------
window.addEventListener("DOMContentLoaded", () => {
  selectedCuisines = [...defaults.cuisines];
  excludedCuisines = [...defaults.excludedCuisines];
  selectedPriceLevels = [...defaults.priceLevels];

  renderCuisinePickers();
  renderPriceOptions();
  updateRadiusLabel();
  pathWidthValue.textContent = `${pathWidth().toFixed(2)} mi`;
  initMap();
  form.requestSubmit();
});

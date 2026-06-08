const form = document.getElementById("query-form");
const resultsGrid = document.getElementById("results-grid");
const statusBanner = document.getElementById("status-banner");
const resultsTitle = document.getElementById("results-title");
const visibleCount = document.getElementById("visible-count");
const returnedCount = document.getElementById("returned-count");
const radiusCount = document.getElementById("radius-count");
const submitButton = document.getElementById("submit-button");
const resetButton = document.getElementById("katy-halal-button");
const template = document.getElementById("restaurant-card-template");
const latitudeInput = document.getElementById("latitude");
const longitudeInput = document.getElementById("longitude");
const cityInput = document.getElementById("city");
const radiusInput = document.getElementById("radius");
const radiusValue = document.getElementById("radius-value");
const selectedCuisinesContainer = document.getElementById("selected-cuisines");
const excludedCuisinesContainer = document.getElementById("excluded-cuisines");
const excludedCuisinesDropzone = document.getElementById("excluded-cuisines-dropzone");
const cuisineOptionsContainer = document.getElementById("cuisine-options");
const priceOptionsContainer = document.getElementById("price-options");
const customCuisineInput = document.getElementById("custom-cuisine");
const addCuisineButton = document.getElementById("add-cuisine-button");

let map;
let marker;
let radiusCircle;
let selectedCuisines = [];
let excludedCuisines = [];
let selectedPriceLevels = [];

const cuisineChoices = [
  "Halal",
  "Pakistani",
  "Indian",
  "Middle Eastern",
  "Mediterranean",
  "Mexican",
  "Italian",
  "Chinese",
  "Japanese",
  "Sushi",
  "Thai",
  "Vietnamese",
  "Korean",
  "Seafood",
  "Barbecue",
  "Steakhouse",
  "Vegan",
  "Vegetarian",
  "Gluten Free",
  "Kosher",
];

const priceChoices = [1, 2, 3, 4];

const defaults = {
  latitude: 29.7858,
  longitude: -95.8245,
  radius: 10,
  city: "",
  sort: "Score",
  cuisines: [],
  excludedCuisines: [],
  priceLevels: [],
  openNow: false,
  exactRadius: true,
};

resetButton.addEventListener("click", () => {
  latitudeInput.value = defaults.latitude;
  longitudeInput.value = defaults.longitude;
  radiusInput.value = defaults.radius;
  cityInput.value = defaults.city;
  document.getElementById("sort").value = defaults.sort;
  document.getElementById("open-now").checked = defaults.openNow;
  document.getElementById("exact-radius").checked = defaults.exactRadius;

  selectedCuisines = [...defaults.cuisines];
  excludedCuisines = [...defaults.excludedCuisines];
  selectedPriceLevels = [...defaults.priceLevels];

  renderCuisinePicker();
  renderExcludedCuisines();
  renderPricePicker();
  customCuisineInput.value = "";

  syncMapToInputs({ recenter: true });
  syncRadiusCircle();
  updateRadiusValue();
});

addCuisineButton.addEventListener("click", () => {
  addCustomCuisine();
});

customCuisineInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  addCustomCuisine();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = buildPayload();
  const label = getSearchLabel();

  setLoadingState(true);
  setStatus(`Searching metadata-ranked restaurants near ${label}...`);

  try {
    const response = await fetch("/v1/recommendations/nearby", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || "Request failed.");
    }

    renderResults(data, label);
  } catch (error) {
    resultsGrid.replaceChildren();
    resultsTitle.textContent = "Request failed";
    visibleCount.textContent = "0";
    returnedCount.textContent = "0";
    radiusCount.textContent = "0";
    setStatus(error.message || "Unknown error.");
  } finally {
    setLoadingState(false);
  }
});

function buildPayload() {
  const city = cityInput.value.trim();

  return {
    location: {
      latitude: Number(latitudeInput.value),
      longitude: Number(longitudeInput.value),
    },
    radius_miles: Number(radiusInput.value),
    sort_method: document.getElementById("sort").value,
    city: city || null,
    cuisines: [...selectedCuisines],
    excluded_cuisines: [...excludedCuisines],
    price_levels: [...selectedPriceLevels],
    open_now: document.getElementById("open-now").checked,
    exact_radius_only: document.getElementById("exact-radius").checked,
    include_filter_options: false,
  };
}

function getSearchLabel() {
  const city = cityInput.value.trim();
  if (city) {
    return city;
  }

  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  if (!Number.isNaN(latitude) && !Number.isNaN(longitude)) {
    return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
  }

  return "selected area";
}

function renderResults(data, label) {
  resultsGrid.replaceChildren();
  const results = Array.isArray(data.results) ? data.results : [];

  resultsTitle.textContent = `${label} results`;
  visibleCount.textContent = String(results.length);
  returnedCount.textContent = String(data.returned_count ?? 0);
  radiusCount.textContent = String(data.exact_radius_count ?? 0);

  if (!results.length) {
    setStatus("No restaurants matched the current metadata, price, and radius filters.");
    return;
  }

  setStatus(
    `Showing ${results.length} restaurants ordered by average Beli score, with rec score and Google rating where available.`,
  );

  for (const result of results) {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".restaurant-name").textContent = result.business?.name ?? "Unknown";

    const link = fragment.querySelector(".beli-link");
    const quickLink = result.business?.quick_link;
    if (quickLink) {
      link.href = quickLink;
    } else {
      link.removeAttribute("href");
      link.textContent = "No Beli link";
      link.classList.add("muted-link");
    }

    fragment.querySelector(".average-beli-rating").textContent = formatRating(result.average_beli_score);
    fragment.querySelector(".recommendation-rating").textContent = formatRating(result.recommendation_score ?? result.score);
    fragment.querySelector(".google-rating").textContent = formatRating(result.google_rating);
    fragment.querySelector(".distance").textContent = formatDistance(result.distance_mi);
    fragment.querySelector(".address").textContent = result.business?.address || "Unavailable";
    fragment.querySelector(".status").textContent = formatStatus(result.business?.status);
    fragment.querySelector(".price").textContent = formatPrice(result.business);
    fragment.querySelector(".cuisines").textContent = (result.business?.cuisines || []).join(", ") || "Unavailable";
    fragment.querySelector(".score-note").textContent =
      "Beli Avg comes from the business-page average score field. Rec Score is the recommendation value from Beli's nearby recommendations API.";

    resultsGrid.appendChild(fragment);
  }
}

function formatRating(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(1);
}

function formatDistance(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${Number(value).toFixed(2)} mi`;
}

function formatStatus(value) {
  if (!value) {
    return "Unknown";
  }
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatPrice(business) {
  if (!business) {
    return "-";
  }

  const price = Number(business.price);
  if (!Number.isNaN(price) && price > 0) {
    return "$".repeat(price);
  }

  if (typeof business.price_key === "string" && business.price_key.trim()) {
    return business.price_key.trim();
  }

  return "-";
}

function setStatus(message) {
  statusBanner.textContent = message;
}

function setLoadingState(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Searching..." : "Search";
}

function renderCuisinePicker() {
  renderSelectedCuisines();
  renderCuisineOptions();
}

function renderPricePicker() {
  priceOptionsContainer.replaceChildren();

  for (const priceLevel of priceChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "price-chip";
    if (selectedPriceLevels.includes(priceLevel)) {
      button.classList.add("price-chip-active");
    }
    button.textContent = "$".repeat(priceLevel);
    button.addEventListener("click", () => togglePriceLevel(priceLevel));
    priceOptionsContainer.appendChild(button);
  }
}

function renderSelectedCuisines() {
  selectedCuisinesContainer.replaceChildren();

  if (!selectedCuisines.length) {
    const empty = document.createElement("span");
    empty.className = "selected-cuisines-empty";
    empty.textContent = "No cuisine filter selected.";
    selectedCuisinesContainer.appendChild(empty);
    return;
  }

  for (const cuisine of selectedCuisines) {
    const chip = document.createElement("span");
    chip.className = "selected-chip";
    chip.draggable = true;
    chip.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", cuisine);
      event.dataTransfer.effectAllowed = "move";
    });

    const label = document.createElement("span");
    label.textContent = cuisine;
    chip.appendChild(label);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "selected-chip-remove";
    removeButton.textContent = "x";
    removeButton.setAttribute("aria-label", `Remove ${cuisine}`);
    removeButton.addEventListener("click", () => {
      selectedCuisines = selectedCuisines.filter((value) => value !== cuisine);
      renderCuisinePicker();
    });
    chip.appendChild(removeButton);

    selectedCuisinesContainer.appendChild(chip);
  }
}

function renderExcludedCuisines() {
  excludedCuisinesContainer.replaceChildren();

  if (!excludedCuisines.length) {
    const empty = document.createElement("span");
    empty.className = "excluded-cuisines-empty";
    empty.textContent = "Drag cuisine chips here to exclude them.";
    excludedCuisinesContainer.appendChild(empty);
    return;
  }

  for (const cuisine of excludedCuisines) {
    const chip = document.createElement("span");
    chip.className = "excluded-chip";

    const label = document.createElement("span");
    label.textContent = cuisine;
    chip.appendChild(label);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "excluded-chip-remove";
    removeButton.textContent = "x";
    removeButton.setAttribute("aria-label", `Remove excluded cuisine ${cuisine}`);
    removeButton.addEventListener("click", () => {
      excludedCuisines = excludedCuisines.filter((value) => value !== cuisine);
      renderExcludedCuisines();
      renderCuisinePicker();
    });
    chip.appendChild(removeButton);

    excludedCuisinesContainer.appendChild(chip);
  }
}

function renderCuisineOptions() {
  cuisineOptionsContainer.replaceChildren();

  for (const cuisine of cuisineChoices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cuisine-chip";
    if (selectedCuisines.includes(cuisine)) {
      button.classList.add("cuisine-chip-active");
    }
    button.draggable = true;
    button.textContent = cuisine;
    button.addEventListener("click", () => toggleCuisine(cuisine));
    button.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", cuisine);
      event.dataTransfer.effectAllowed = "move";
    });
    cuisineOptionsContainer.appendChild(button);
  }
}

function toggleCuisine(cuisine) {
  excludedCuisines = excludedCuisines.filter((value) => value !== cuisine);
  if (selectedCuisines.includes(cuisine)) {
    selectedCuisines = selectedCuisines.filter((value) => value !== cuisine);
  } else {
    selectedCuisines = [...selectedCuisines, cuisine];
  }
  renderCuisinePicker();
  renderExcludedCuisines();
}

function togglePriceLevel(priceLevel) {
  if (selectedPriceLevels.includes(priceLevel)) {
    selectedPriceLevels = selectedPriceLevels.filter((value) => value !== priceLevel);
  } else {
    selectedPriceLevels = [...selectedPriceLevels, priceLevel].sort((left, right) => left - right);
  }
  renderPricePicker();
}

function addCustomCuisine() {
  const value = customCuisineInput.value.trim();
  if (!value) {
    return;
  }

  if (!selectedCuisines.includes(value)) {
    selectedCuisines = [...selectedCuisines, value];
  }
  excludedCuisines = excludedCuisines.filter((cuisine) => cuisine !== value);

  if (!cuisineChoices.includes(value)) {
    cuisineChoices.push(value);
  }

  customCuisineInput.value = "";
  renderCuisinePicker();
  renderExcludedCuisines();
}

function excludeCuisine(cuisine) {
  if (!cuisine) {
    return;
  }

  if (!excludedCuisines.includes(cuisine)) {
    excludedCuisines = [...excludedCuisines, cuisine];
  }
  selectedCuisines = selectedCuisines.filter((value) => value !== cuisine);

  if (!cuisineChoices.includes(cuisine)) {
    cuisineChoices.push(cuisine);
  }

  renderCuisinePicker();
  renderExcludedCuisines();
}

function initializeExcludedCuisineDropzone() {
  excludedCuisinesDropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    excludedCuisinesDropzone.classList.add("excluded-cuisines-dropzone-active");
  });

  excludedCuisinesDropzone.addEventListener("dragleave", () => {
    excludedCuisinesDropzone.classList.remove("excluded-cuisines-dropzone-active");
  });

  excludedCuisinesDropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    excludedCuisinesDropzone.classList.remove("excluded-cuisines-dropzone-active");
    const cuisine = event.dataTransfer.getData("text/plain").trim();
    excludeCuisine(cuisine);
  });
}

function initializeMap() {
  if (typeof L === "undefined") {
    setStatus("Map picker failed to load. Search still works, but the map controls are unavailable.");
    return;
  }

  const startLat = Number(latitudeInput.value);
  const startLng = Number(longitudeInput.value);

  map = L.map("map-picker", {
    zoomControl: true,
    scrollWheelZoom: true,
  }).setView([startLat, startLng], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  marker = L.marker([startLat, startLng], {
    draggable: true,
  }).addTo(map);

  radiusCircle = L.circle([startLat, startLng], {
    radius: milesToMeters(Number(radiusInput.value)),
    color: "#0e6662",
    weight: 2,
    opacity: 0.85,
    fillColor: "#0e6662",
    fillOpacity: 0.12,
  }).addTo(map);

  marker.on("dragend", () => {
    const position = marker.getLatLng();
    setCoordinates(position.lat, position.lng, { recenter: false });
  });

  map.on("click", (event) => {
    setCoordinates(event.latlng.lat, event.latlng.lng, { recenter: false });
  });

  latitudeInput.addEventListener("change", () => syncMapToInputs({ recenter: true }));
  longitudeInput.addEventListener("change", () => syncMapToInputs({ recenter: true }));
  radiusInput.addEventListener("input", () => {
    syncRadiusCircle();
    updateRadiusValue();
  });
}

function setCoordinates(latitude, longitude, options = {}) {
  const { recenter = true } = options;
  latitudeInput.value = Number(latitude).toFixed(6);
  longitudeInput.value = Number(longitude).toFixed(6);

  if (!map || !marker) {
    return;
  }

  marker.setLatLng([latitude, longitude]);
  if (radiusCircle) {
    radiusCircle.setLatLng([latitude, longitude]);
  }
  if (recenter) {
    map.panTo([latitude, longitude], { animate: true });
  }
}

function syncMapToInputs(options = {}) {
  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return;
  }

  setCoordinates(latitude, longitude, options);
}

function syncRadiusCircle() {
  if (!map || !radiusCircle) {
    return;
  }

  const radiusMiles = Number(radiusInput.value);
  if (Number.isNaN(radiusMiles) || radiusMiles <= 0) {
    return;
  }

  radiusCircle.setRadius(milesToMeters(radiusMiles));
}

function updateRadiusValue() {
  const radiusMiles = Number(radiusInput.value);
  if (Number.isNaN(radiusMiles) || radiusMiles <= 0) {
    radiusValue.textContent = "-";
    return;
  }

  radiusValue.textContent = `${radiusMiles} mi`;
}

function milesToMeters(miles) {
  return miles * 1609.344;
}

window.addEventListener("DOMContentLoaded", () => {
  selectedCuisines = [...defaults.cuisines];
  excludedCuisines = [...defaults.excludedCuisines];
  selectedPriceLevels = [...defaults.priceLevels];

  renderCuisinePicker();
  renderExcludedCuisines();
  renderPricePicker();
  initializeExcludedCuisineDropzone();
  updateRadiusValue();
  initializeMap();
  form.requestSubmit();
});

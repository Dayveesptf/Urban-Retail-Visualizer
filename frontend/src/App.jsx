// src/StoreDensityMap.jsx
import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import "leaflet.heat";
import clustering from "density-clustering";

// Fix default marker icon paths (CDN)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

// Haversine distance (meters)
function haversine(p1, p2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(p2[0] - p1[0]);
  const dLon = toRad(p2[1] - p1[1]);
  const lat1 = toRad(p1[0]);
  const lat2 = toRad(p2[0]);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Map size-weight mapping (for heat weighting)
const sizeWeight = {
  small: 0.4,
  medium: 0.7,
  large: 1.0,
};

export default function StoreDensityMap() {
  const mapRef = useRef(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [aiInsight, setAiInsight] = useState(null);
  const [clustersMeta, setClustersMeta] = useState([]);

  // Ensure map container exists only once
  useEffect(() => {
    mapRef.current = L.map("map", {
      center: [6.5244, 3.3792], // default Lagos
      zoom: 12,
      tap: false,
      preferCanvas: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Main function: geocode -> overpass -> cluster -> visualize -> send to AI
  async function analyzeLocation(address) {
    setStatus("Geocoding address...");
    setAiInsight(null);
    setClustersMeta([]);

   // 1) Geocode via backend proxy to avoid CORS
const nomRes = await fetch(`/api/geocode?q=${encodeURIComponent(address)}`);
if (!nomRes.ok) {
  setStatus("Geocoding failed.");
  return;
}
const nomJson = await nomRes.json();
if (!nomJson || nomJson.length === 0) {
  setStatus("Location not found.");
  return;
}
const { lat, lon } = nomJson[0];
const center = [parseFloat(lat), parseFloat(lon)];
mapRef.current.setView(center, 13);
setStatus("Fetching stores from Overpass...");

    // 2) Overpass: find nodes with shop tag within radius (e.g., 5000 m)
    const radius = 5000; // meters
    // Overpass QL: get nodes within radius around lat,lon with shop tag or amenity=marketplace
    const overpassQL = `
      [out:json][timeout:25];
      (
        node["shop"](around:${radius},${center[0]},${center[1]});
        node["amenity"="marketplace"](around:${radius},${center[0]},${center[1]});
      );
      out center tags;
    `;
    const overpassUrl = "https://overpass-api.de/api/interpreter";
    const overpassRes = await fetch(overpassUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(overpassQL)}`,
    });
    const overpassJson = await overpassRes.json();
    const elements = overpassJson.elements || [];
    if (elements.length === 0) {
      setStatus("No stores found in that area.");
      return;
    }
    setStatus(`Found ${elements.length} places. Clustering...`);

    // Build normalized stores array (with size tag attempt)
    // size mapping: try to infer from tags (e.g., supermarket => large)
    const fetchedStores = elements.map((el) => {
      const name = (el.tags && (el.tags.name || el.tags["brand"])) || "Unnamed";
      // crude size inference: supermarket/department_store -> large; convenience -> small
      const type = el.tags && (el.tags.shop || el.tags.amenity || "shop");
      let size = "small";
      const bigKeywords = ["supermarket", "department_store", "mall"];
      const medKeywords = ["grocery", "chemist", "bakery", "convenience"];
      if (el.tags) {
        const allTags = Object.values(el.tags).join(" ").toLowerCase();
        if (bigKeywords.some((k) => allTags.includes(k))) size = "large";
        else if (medKeywords.some((k) => allTags.includes(k))) size = "medium";
      }
      return {
        id: el.id,
        name,
        lat: el.lat,
        lng: el.lon,
        type,
        size,
        raw: el.tags || {},
      };
    });

    // 3) Run DBSCAN with Haversine (eps in meters). density-clustering expects an optional distance function
    const points = fetchedStores.map((s) => [s.lat, s.lng]);
    const dbscan = new clustering.DBSCAN();
    // We'll pass epsilon = 500 meters and minPts = 3 (adjustable)
    const eps = 500;
    const minPts = 3;
    const clusters = dbscan.run(points, eps, minPts, haversine);

    // identify noise points
    const noise = dbscan.noise || [];

    setStatus(`Found ${clusters.length} clusters (and ${noise.length} noise points). Rendering...`);

    // Clear previous layers
    mapRef.current.eachLayer((layer) => {
      // keep tile layer(s) — tileLayer has options but simplest is skip if has _url
      if (!layer._url) mapRef.current.removeLayer(layer);
    });

    // Add heatmap (weighted by size)
    const heatData = fetchedStores.map((s) => [
      s.lat,
      s.lng,
      sizeWeight[s.size] || 0.5,
    ]);
    L.heatLayer(heatData, { radius: 25, blur: 15, maxZoom: 17 }).addTo(mapRef.current);

    // Marker cluster group for individual stores
    const markerCluster = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: true });

    // Add store markers (all)
    fetchedStores.forEach((s) => {
      const m = L.marker([s.lat, s.lng]).bindPopup(
        `<div class="p-2">
           <strong>${s.name}</strong><br/>
           ${s.type || ""} • ${s.size}<br/>
           <small>id:${s.id}</small>
         </div>`
      );
      markerCluster.addLayer(m);
    });
    mapRef.current.addLayer(markerCluster);

    // Process clusters: compute centroid, radius (max dist), density (stores/km²), type breakdown
    const clustersSummary = clusters.map((clusterIndexes, idx) => {
      const clusterStores = clusterIndexes.map((i) => fetchedStores[i]);
      const latSum = clusterStores.reduce((s, it) => s + it.lat, 0);
      const lngSum = clusterStores.reduce((s, it) => s + it.lng, 0);
      const centroid = [latSum / clusterStores.length, lngSum / clusterStores.length];
      const maxDist = Math.max(
        ...clusterStores.map((cs) => haversine(centroid, [cs.lat, cs.lng]))
      );
      const radiusMeters = Math.max(maxDist, 100); // at least 100m
      const areaKm2 = Math.PI * (radiusMeters / 1000) ** 2;
      const densityPerKm2 = clusterStores.length / Math.max(areaKm2, 0.0001);

      // breakdown
      const types = {};
      const sizes = {};
      clusterStores.forEach((s) => {
        types[s.type] = (types[s.type] || 0) + 1;
        sizes[s.size] = (sizes[s.size] || 0) + 1;
      });

      return {
        id: idx,
        centroid,
        radiusMeters,
        storeCount: clusterStores.length,
        densityPerKm2,
        densityScore: Math.round(Math.min(100, densityPerKm2 * 10)), // normalized
        types,
        sizes,
        stores: clusterStores,
      };
    });

    // draw cluster centroids and circles
    clustersSummary.forEach((c) => {
      const circle = L.circle(c.centroid, {
        radius: c.radiusMeters,
        color: "crimson",
        fillColor: "#f03",
        fillOpacity: 0.12,
        weight: 2,
      }).addTo(mapRef.current);

      const icon = L.divIcon({
        className: "cluster-centroid",
        html: `<div style="background:rgba(220,20,60,0.9);color:white;border-radius:999px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-weight:700">${c.storeCount}</div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });
      L.marker(c.centroid, { icon })
        .bindPopup(`<strong>Cluster ${c.id + 1}</strong><br/>Stores: ${c.storeCount}<br/>Density score: ${c.densityScore}`)
        .addTo(mapRef.current)
        .on("click", () => {
          setClustersMeta([c]); // show one cluster in side panel (you can adapt)
        });

      // hover highlight
      circle.on("mouseover", () => circle.setStyle({ fillOpacity: 0.25 }));
      circle.on("mouseout", () => circle.setStyle({ fillOpacity: 0.12 }));
    });

    // fit map bounds to data
    const allCoords = fetchedStores.map((s) => [s.lat, s.lng]);
    const bounds = L.latLngBounds(allCoords);
    mapRef.current.fitBounds(bounds.pad(0.2));

    // 4) send summary to backend AI endpoint
    try {
      setStatus("Requesting AI analysis...");
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: { address, center, radiusMeters: radius },
          clusters: clustersSummary.map((c) => ({
            id: c.id,
            centroid: c.centroid,
            storeCount: c.storeCount,
            types: c.types,
            sizes: c.sizes,
          })),
        }),
      });
      if (resp.ok) {
        const body = await resp.json();
        setAiInsight(body.insight);
        setStatus("Done");
      } else {
        setStatus("AI request failed");
      }
    } catch (err) {
      console.error(err);
      setStatus("AI request error");
}
console.log("Sending clusters to AI:", clustersSummary);

  }

  const formatAiInsight = (raw) => {
  if (!raw) return "<p>No insight available.</p>";

  const sections = raw.split("**").filter(Boolean); // Split by bold markers
  let html = "";

  sections.forEach((s) => {
    // Detect if it's a heading or regular paragraph
    if (s.toLowerCase().includes("overall store density") ||
        s.toLowerCase().includes("cluster highlights") ||
        s.toLowerCase().includes("store type") ||
        s.toLowerCase().includes("suggestions") ||
        s.toLowerCase().includes("conclusion")) {
      html += `<h3 class="text-base font-semibold mb mt-6 underline underline-offset-4">${s.trim()}</h3>`;
    } else {
      // Split lists into paragraphs
      const lines = s.split("\n\n").filter(Boolean);
      lines.forEach((line) => {
        html += `<p class="text-sm mt-1">${line.replace(/^\*\s*/, "").trim()}</p>`;
      });
    }
  });

  return html;
};

  return (
    <div className="flex h-screen">
  {/* Left column: input + map */}
  <div className="flex flex-col w-3/5">
    {/* Top input panel */}
    <div className="p-4 bg-white shadow flex items-center mx-auto">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Enter location (e.g., Yaba, Lagos)"
        className="px-3 py-2 border rounded w-72 mr-2"
      />
      <button
        onClick={() => analyzeLocation(query || "Lagos, Nigeria")}
        className="px-3 py-2 bg-blue-600 text-white rounded"
      >
        Analyze
      </button>
      <div className="text-sm text-gray-600 ml-3">{status}</div>
    </div>

    {/* Map container */}
    <div className="flex-1 w-full">
      <div id="map" className="h-full w-full" />
    </div>
  </div>

  {/* Right column: AI Insight + Cluster Summaries */}
  <div className="w-2/5 p-4 bg-gray-100 overflow-y-auto">
    <h2 className="text-xl font-bold mb-3">AI Insight</h2>
    {aiInsight ? (
      <div className="prose max-w-none">
        <div className="text-base" dangerouslySetInnerHTML={{ __html: formatAiInsight(aiInsight) }} />
      </div>
    ) : (
      <p className="text-sm text-gray-600">No AI analysis yet. Click Analyze.</p>
    )}

    <hr className="my-4" />
    <h3 className="font-semibold">Cluster Summaries</h3>
    {clustersMeta.length === 0 && (
      <p className="text-sm text-gray-600">Click a cluster marker to view details here.</p>
    )}
    {clustersMeta.map((c) => (
      <div key={c.id} className="bg-white p-3 rounded shadow my-2">
        <div className="text-sm font-medium">Cluster {c.id + 1}</div>
        <div className="text-sm">Stores: {c.storeCount}</div>
        <div className="text-sm">Density score: {c.densityScore}/100</div>
        <div className="text-sm mt-2">
          <strong>Types:</strong><br/>
          {Object.entries(c.types).map(([k, v]) => (
            <span key={k} className="mr-2 text-sm">
              {k}: {v}
            </span>
          ))}
        </div>
      </div>
    ))}
  </div>
</div>

  );
}

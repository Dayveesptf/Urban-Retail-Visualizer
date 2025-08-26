/* eslint-disable no-undef */
import express from "express";
import fetch from "node-fetch"; // or global fetch if Node 18+
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY missing in .env");
  process.exit(1);
}

app.post("/api/analyze", async (req, res) => {
  const { location, clusters } = req.body;

  if (!location || !clusters) {
    return res.status(400).json({ error: "Missing location or clusters" });
  }

  try {
    // Trim cluster data to essential info only
    const minimalClusters = clusters.map((c) => ({
      id: c.id,
      storeCount: c.storeCount,
      types: c.types,
      sizes: c.sizes,
    }));

    const prompt = `You are a retail analyst AI. 
Analyze the following clusters for ${location.address}:
${JSON.stringify(minimalClusters, null, 2)}
Explain which location has the highest store density, what type of stores are common, and give suggestions for potential business opportunities.
Do NOT include generic statements about geographical analysis, mapping, or obvious location commentary. Focus only on actionable insights, market opportunities, and cluster characteristics.
Provide a concise text report:
- Overall store density
- Cluster highlights
- Store type and size breakdown
- Suggestions for market opportunities
`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          candidateCount: 1,
          maxOutputTokens: 2000
        }
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(500).json({ error: "Gemini API request failed", details: data });
    }

    // Extract the generated text
    let insight = "<p>No insight returned.</p>";
if (data?.candidates?.length > 0) {
  const candidate = data.candidates[0];
  if (candidate?.content?.parts?.length > 0) {
    insight = candidate.content.parts[0].text;
  } else if (candidate?.content?.text) {
    // Some versions of the API might use this structure
    insight = candidate.content.text;
  }
}

// If still no insight, log the full response for debugging
if (insight === "<p>No insight returned.</p>") {
  console.log("Full API response for debugging:", JSON.stringify(data, null, 2));
}

    res.json({ insight });
  } catch (err) {
    console.error("AI analyze error:", err);
    res.status(500).json({ error: "AI request failed", details: err.message });
  }
});

// --- Geocode endpoint (GET) ---
app.get("/api/geocode", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query missing" });

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      q
    )}&limit=1`;
    const response = await fetch(url, {
      headers: { "User-Agent": "hackathon-app" },
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Geocode error:", err);
    res.status(500).json({ error: "Failed to fetch geocode", details: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

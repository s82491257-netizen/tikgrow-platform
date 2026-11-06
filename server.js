
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const { pool, testDatabase } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "SavCel Hub",
    version: "2.0.0",
    status: "online"
  });
});

app.get("/api/db-health", async (req, res) => {
  try {
    const result = await testDatabase();

    res.json({
      success: true,
      database: "connected",
      time: result.current_time
    });
  } catch (error) {
    console.error("Database health check failed:", error.message);

    res.status(500).json({
      success: false,
      database: "disconnected",
      message: "Database connection failed"
    });
  }
});

app.get("/api", (req, res) => {
  res.json({
    success: true,
    platform: "SavCel Hub"
  });
});

app.get("/", (req, res) => {
  const homepage = path.join(__dirname, "index.html");

  if (!fs.existsSync(homepage)) {
    return res.status(404).send("Homepage not found.");
  }

  res.sendFile(homepage);
});

// Serve only the homepage for now.
// Do not expose server files or environment secrets.
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Page not found"
  });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SavCel Hub running on port ${PORT}`);
});

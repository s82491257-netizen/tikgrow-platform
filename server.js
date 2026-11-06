

require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false
}));

// Request limits
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "SavCel Hub server is running",
    status: "online"
  });
});

// Website files
app.use(express.static(path.join(__dirname, "public")));

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Page not found"
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: "Something went wrong"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SavCel Hub running on port ${PORT}`);
});



require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

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
  limit: 150,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

// SERVER STATUS
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    name: "SavCel Hub",
    version: "2.0.0",
    status: "online",
    message: "Welcome to SavCel Hub API"
  });
});

// STORE WEBSITE
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API INFORMATION
app.get("/api", (req, res) => {
  res.json({
    success: true,
    platform: "SavCel Hub",
    services: [
      "Online Store",
      "Data Bundles",
      "Phone Numbers",
      "Digital Products",
      "Reseller Platform",
      "Customer Accounts",
      "Paystack Payments",
      "Admin Dashboard"
    ]
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Page not found"
  });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

// START SERVER
app.listen(PORT, "0.0.0.0", () => {
  console.log("================================");
  console.log("       SAVCEL HUB ONLINE");
  console.log("================================");
  console.log(`Server running on port ${PORT}`);
});

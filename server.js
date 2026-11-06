


require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

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

app.get("/api", (req, res) => {
  res.json({
    success: true,
    platform: "SavCel Hub"
  });
});

// SERVE HOMEPAGE FROM ROOT
app.get("/", (req, res) => {
  const homepage = path.join(__dirname, "index.html");

  if (!fs.existsSync(homepage)) {
    return res.status(404).send("Homepage index.html was not found.");
  }

  res.sendFile(homepage);
});

// SERVE OTHER STATIC FILES
app.use(express.static(__dirname));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Page not found"
  });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err.stack);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SavCel Hub running on port ${PORT}`);
});

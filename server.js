
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const { testDatabase } = require("./db");
const authRoutes = require("./routes/auth");
const productsRoutes = require("./routes/products");
const requireAuth = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({
  extended: false,
  limit: "1mb"
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

// PUBLIC HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "SavCel Hub",
    status: "online"
  });
});

// DATABASE CHECK
app.get("/api/db-health", async (req, res) => {
  try {
    const result = await testDatabase();

    res.json({
      success: true,
      database: "connected",
      time: result.current_time
    });
  } catch (error) {
    console.error("Database check failed:", error.message);

    res.status(500).json({
      success: false,
      database: "disconnected"
    });
  }
});

// PUBLIC AUTHENTICATION ROUTES
app.use("/api/auth", authRoutes);
const productsRoutes = require("./routes/products");
// LOGIN AND REGISTRATION PAGE
app.get("/auth", (req, res) => {
  const authPage = path.join(
    __dirname,
    "public",
    "auth.html"
  );

  if (!fs.existsSync(authPage)) {
    return res.status(404).send("Login page not found.");
  }

  res.sendFile(authPage);
});

// PROTECTED MY ACCOUNT PAGE
app.get("/account", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "account.html")
  );
});

// PROTECT ALL CUSTOMER PAGES
app.get("/", requireAuth, (req, res) => {
  const homepage = path.join(__dirname, "index.html");

  if (!fs.existsSync(homepage)) {
    return res.status(404).send("Homepage not found.");
  }

  res.sendFile(homepage);
});

// PROTECTED CUSTOMER API EXAMPLE
app.get("/api/customer/account", requireAuth, (req, res) => {
  res.json({
    success: true,
    message: "You are logged in.",
    userId: req.user.id
  });
});

// PUBLIC WEBSITE ASSETS
app.use(express.static(
  path.join(__dirname, "public")
));

// SEND UNKNOWN PAGE VISITORS TO LOGIN
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      message: "API endpoint not found."
    });
  }

  res.redirect("/auth");
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

// START SERVER
app.listen(PORT, "0.0.0.0", () => {
  console.log("SavCel Hub running on port " + PORT);
});

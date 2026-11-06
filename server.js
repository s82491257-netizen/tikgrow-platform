
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

// BASIC SECURITY
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

// HEALTH CHECK
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

// AUTHENTICATION API
app.use("/api/auth", authRoutes);

// PRODUCTS AND STORE API
app.use("/api/products", productsRoutes);

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

// PROTECTED STORE PAGE
app.get("/store", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "store.html")
  );
});

// PROTECTED MY ACCOUNT PAGE
app.get("/account", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "account.html")
  );
});

// PROTECTED CUSTOMER HOMEPAGE
app.get("/", requireAuth, (req, res) => {
  const homepage = path.join(__dirname, "index.html");

  if (!fs.existsSync(homepage)) {
    return res.status(404).send("Homepage not found.");
  }

  res.sendFile(homepage);
});

// PROTECTED CUSTOMER API
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

// UNKNOWN API ROUTES
app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// UNKNOWN WEBSITE ROUTES
app.use((req, res) => {
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

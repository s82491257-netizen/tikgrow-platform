
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const { testDatabase } = require("./db");

const authRoutes = require("./routes/auth");
const productsRoutes = require("./routes/products");
const cartRoutes = require("./routes/cart");
const checkoutRoutes = require("./routes/checkout");
const adminRoutes = require("./routes/admin");

const requireAuth = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;

// SECURITY
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

// DATABASE HEALTH
app.get("/api/db-health", async (req, res) => {
  try {
    const result = await testDatabase();

    res.json({
      success: true,
      database: "connected",
      time: result.current_time
    });
  } catch (error) {
    console.error("Database error:", error.message);

    res.status(500).json({
      success: false,
      database: "disconnected"
    });
  }
});

// API ROUTES
app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/admin", adminRoutes);

// LOGIN PAGE
app.get("/auth", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "auth.html")
  );
});

// STORE PAGE
app.get("/store", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "store.html")
  );
});

// CART PAGE
app.get("/cart", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "cart.html")
  );
});

// CHECKOUT PAGE
app.get("/checkout", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "checkout.html")
  );
});

// PAYMENT VERIFICATION PAGE
app.get("/payment/verify", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "payment.html")
  );
});

// ACCOUNT PAGE
app.get("/account", requireAuth, (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "account.html")
  );
});

// SETTINGS PAGE
app.get("/settings", requireAuth, (req, res) => {
  const settingsFile = path.join(
    __dirname,
    "public",
    "settings.html"
  );

  if (!fs.existsSync(settingsFile)) {
    return res.status(404).send(
      "Settings page is not ready yet."
    );
  }

  res.sendFile(settingsFile);
});

// ADMIN DASHBOARD PAGE
app.get("/admin", requireAuth, async (req, res) => {
  try {
    const result = await require("./db").pool.query(
      `SELECT role FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );

    if (
      !result.rows.length ||
      result.rows[0].role !== "admin"
    ) {
      return res.status(403).send(
        "Administrator access required."
      );
    }

    const adminFile = path.join(
      __dirname,
      "public",
      "admin.html"
    );

    if (!fs.existsSync(adminFile)) {
      return res.status(404).send(
        "Admin dashboard page is not ready yet."
      );
    }

    res.sendFile(adminFile);

  } catch (error) {
    console.error("Admin page error:", error.message);

    res.status(500).send(
      "Unable to load admin dashboard."
    );
  }
});

// CUSTOMER ACCOUNT API
app.get("/api/customer/account", requireAuth, (req, res) => {
  res.json({
    success: true,
    message: "You are logged in.",
    userId: req.user.id
  });
});

// BLOCK DIRECT HTML FILE ACCESS
app.use((req, res, next) => {
  if (req.path.toLowerCase().endsWith(".html")) {
    return res.redirect("/auth");
  }

  next();
});

// PUBLIC ASSETS
app.use(express.static(
  path.join(__dirname, "public"),
  { index: false }
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
  console.log(
    "SavCel Hub running on port " + PORT
  );
});

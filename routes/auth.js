
const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again later."
  }
});

function requireFields(body, fields) {
  return fields.every(field =>
    typeof body[field] === "string" &&
    body[field].trim().length > 0
  );
}

// CUSTOMER REGISTRATION
router.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!requireFields(req.body || {}, ["name", "email", "password"])) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required."
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanName.length > 80) {
      return res.status(400).json({
        success: false,
        message: "Name is too long."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (password.length < 10 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Password must be 10–128 characters."
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [cleanEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'customer')
       RETURNING id, name, email, role, created_at`,
      [cleanName, cleanEmail, passwordHash]
    );

    return res.status(201).json({
      success: true,
      message: "Account created successfully.",
      user: result.rows[0]
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists."
      });
    }

    console.error("Registration error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Registration failed."
    });
  }
});

// CUSTOMER LOGIN
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!requireFields(req.body || {}, ["email", "password"])) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    return res.json({
      success: true,
      message: "Login successful.",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Login failed."
    });
  }
});

// CHECK EMAIL ACCOUNT
router.post("/check-email", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required."
      });
    }

    const result = await pool.query(
      "SELECT id FROM users WHERE email = $1 LIMIT 1",
      [email]
    );

    return res.json({
      success: true,
      exists: result.rows.length > 0
    });

  } catch (error) {
    console.error("Email check error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to check email."
    });
  }
});

module.exports = router;

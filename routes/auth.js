
const express = require("express");
const crypto = require("crypto");
const { promisify } = require("util");
const { pool } = require("../db");

const router = express.Router();
const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = "savcel_session";
const SESSION_DAYS = 7;

function getAuthSecret() {
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters.");
  }

  return process.env.AUTH_SECRET;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);

  return salt + ":" + key.toString("hex");
}

async function verifyPassword(password, storedHash) {
  const parts = storedHash.split(":");

  if (parts.length !== 2) return false;

  const salt = parts[0];
  const originalKey = Buffer.from(parts[1], "hex");
  const newKey = await scrypt(password, salt, 64);

  return originalKey.length === newKey.length &&
    crypto.timingSafeEqual(originalKey, newKey);
}

function createSession(userId) {
  const expires = Math.floor(Date.now() / 1000) +
    SESSION_DAYS * 24 * 60 * 60;

  const payload = Buffer.from(JSON.stringify({
    id: userId,
    exp: expires
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", getAuthSecret())
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function readSession(req) {
  const cookieHeader = req.headers.cookie || "";
  const cookies = cookieHeader.split(";");

  const sessionCookie = cookies.find((cookie) =>
    cookie.trim().startsWith(COOKIE_NAME + "=")
  );

  if (!sessionCookie) return null;

  const token = sessionCookie.trim().slice(COOKIE_NAME.length + 1);
  const parts = token.split(".");

  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", getAuthSecret())
    .update(payload)
    .digest("base64url");

  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    if (!Number.isInteger(data.id) || data.exp < Date.now() / 1000) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  res.cookie("savcel_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/"
  });
}

// CUSTOMER REGISTRATION
router.post("/register", async (req, res) => {
  try {
    const { full_name, email, phone, password } = req.body;

    if (
      typeof full_name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide your name, email and password."
      });
    }

    const name = full_name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = typeof phone === "string"
      ? phone.trim()
      : null;

    if (name.length < 2 || name.length > 150) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid full name."
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: "Password must be 8 to 128 characters."
      });
    }

    if (cleanPhone && cleanPhone.length > 30) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid phone number."
      });
    }

    const passwordHash = await hashPassword(password);

    const result = await pool.query(
      `INSERT INTO users
       (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, 'customer')
       RETURNING id, full_name, email, phone, role`,
      [name, cleanEmail, cleanPhone || null, passwordHash]
    );

    const user = result.rows[0];

    setSessionCookie(res, createSession(user.id));

    return res.status(201).json({
      success: true,
      message: "Your SavCel Hub account has been created.",
      user
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        success: false,
        message: "This email or phone number is already registered."
      });
    }

    console.error("Registration error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Registration failed. Please try again."
    });
  }
});

// CUSTOMER LOGIN
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter your email and password."
      });
    }

    const result = await pool.query(
      `SELECT id, full_name, email, phone, password_hash, role
       FROM users
       WHERE email = $1 AND is_active = TRUE`,
      [email.trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = result.rows[0];
    const valid = await verifyPassword(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password."
      });
    }

    setSessionCookie(res, createSession(user.id));

    delete user.password_hash;

    return res.json({
      success: true,
      message: "Login successful.",
      user
    });

  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Login failed. Please try again."
    });
  }
});

// CURRENT CUSTOMER
router.get("/me", async (req, res) => {
  try {
    const session = readSession(req);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: "Please log in."
      });
    }

    const result = await pool.query(
      `SELECT id, full_name, email, phone, role
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [session.id]
    );

    if (!result.rows.length) {
      clearSessionCookie(res);

      return res.status(401).json({
        success: false,
        message: "Account not found."
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Account lookup error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Could not load your account."
    });
  }
});

// LOGOUT
router.post("/logout", (req, res) => {
  clearSessionCookie(res);

  res.json({
    success: true,
    message: "You have logged out."
  });
});

module.exports = router;

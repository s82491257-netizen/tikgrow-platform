
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// SECURE TOKEN CHECK
function validSetupToken(req) {
  const savedToken = String(
    process.env.ADMIN_SETUP_TOKEN || ""
  ).trim();

  const suppliedToken = String(
    req.get("x-admin-setup-token") || ""
  ).trim();

  if (savedToken.length < 40 || !suppliedToken) {
    return false;
  }

  const savedBuffer = Buffer.from(savedToken, "utf8");
  const suppliedBuffer = Buffer.from(suppliedToken, "utf8");

  if (savedBuffer.length !== suppliedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    savedBuffer,
    suppliedBuffer
  );
}

// ACTIVATE FIRST ADMINISTRATOR
router.post("/setup", async (req, res) => {
  if (!validSetupToken(req)) {
    return res.status(403).json({
      success: false,
      message: "Invalid admin setup authorization."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock(99112233)"
    );

    const currentUser = await client.query(
      `SELECT id, role, is_active
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    if (!currentUser.rows.length ||
        !currentUser.rows[0].is_active) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "Your account is not active."
      });
    }

    if (currentUser.rows[0].role === "admin") {
      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Your account is already an administrator."
      });
    }

    const existingAdmin = await client.query(
      `SELECT id
       FROM users
       WHERE role = 'admin'
       LIMIT 1`
    );

    if (existingAdmin.rows.length > 0) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        success: false,
        message: "An administrator already exists."
      });
    }

    await client.query(
      `UPDATE users
       SET role = 'admin'
       WHERE id = $1`,
      [req.user.id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Administrator account activated successfully."
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Admin setup error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Admin setup failed. Please try again."
    });

  } finally {
    client.release();
  }
});

// ADMIN DASHBOARD API
router.get("/dashboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role
       FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );

    if (!result.rows.length ||
        result.rows[0].role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Administrator access required."
      });
    }

    return res.json({
      success: true,
      admin: result.rows[0]
    });

  } catch (error) {
    console.error("Admin dashboard error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load admin dashboard."
    });
  }
});

module.exports = router;

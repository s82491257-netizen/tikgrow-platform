
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

function checkAdminToken(req) {
  const saved = String(
    process.env.ADMIN_SETUP_TOKEN || ""
  ).trim();

  const supplied = String(
    req.headers["x-admin-setup-token"] || ""
  ).trim();

  if (!saved || !supplied || saved.length < 40) {
    return false;
  }

  const a = Buffer.from(saved, "utf8");
  const b = Buffer.from(supplied, "utf8");

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// FIRST ADMIN ACTIVATION
router.post("/setup", async (req, res) => {
  if (!checkAdminToken(req)) {
    return res.status(403).json({
      success: false,
      message: "Invalid admin setup authorization."
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock(99112233)"
    );

    const user = await client.query(
      `SELECT id, role, is_active
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.user.id]
    );

    if (!user.rows.length || !user.rows[0].is_active) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "Your account is not active."
      });
    }

    if (user.rows[0].role === "admin") {
      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "You are already an administrator."
      });
    }

    const admins = await client.query(
      `SELECT id FROM users
       WHERE role = 'admin'
       LIMIT 1`
    );

    if (admins.rows.length) {
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
      message: "Administrator activated successfully."
    });

  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Admin setup error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to activate administrator."
    });

  } finally {
    if (client) client.release();
  }
});

// ADMIN DASHBOARD INFORMATION
router.get("/dashboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, role
       FROM users
       WHERE id = $1
       AND role = 'admin'
       AND is_active = TRUE`,
      [req.user.id]
    );

    if (!result.rows.length) {
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
    console.error("Dashboard error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load dashboard."
    });
  }
});

module.exports = router;

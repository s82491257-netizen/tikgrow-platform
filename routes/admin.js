
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

// ONE-TIME ADMIN ACCOUNT SETUP
router.post("/setup", async (req, res) => {
  const suppliedToken = String(
    req.headers["x-admin-setup-token"] || ""
  );

  const savedToken = process.env.ADMIN_SETUP_TOKEN || "";

  if (
    !savedToken ||
    savedToken.length < 40 ||
    suppliedToken.length !== savedToken.length ||
    !crypto.timingSafeEqual(
      Buffer.from(suppliedToken),
      Buffer.from(savedToken)
    )
  ) {
    return res.status(403).json({
      success: false,
      message: "Invalid admin setup authorization."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Prevent two people from claiming admin access together.
    await client.query(
      "SELECT pg_advisory_xact_lock(99112233)"
    );

    const currentUser = await client.query(
      `SELECT id, role
       FROM users
       WHERE id = $1 AND is_active = TRUE
       FOR UPDATE`,
      [req.user.id]
    );

    if (!currentUser.rows.length) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        message: "Account not found."
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
      `SELECT id FROM users
       WHERE role = 'admin'
       LIMIT 1`
    );

    if (existingAdmin.rows.length) {
      await client.query("ROLLBACK");

      return res.status(403).json({
        success: false,
        message: "Admin setup has already been completed."
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
      message: "Your account is now the SavCel Hub administrator."
    });

  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Admin setup error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Admin setup could not be completed."
    });

  } finally {
    client.release();
  }
});

// ADMIN ACCESS CHECK
router.get("/dashboard", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT role FROM users
       WHERE id = $1 AND is_active = TRUE`,
      [req.user.id]
    );

    if (!result.rows.length || result.rows[0].role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Administrator access required."
      });
    }

    res.json({
      success: true,
      message: "Welcome to SavCel Hub Admin.",
      dashboard: true
    });

  } catch (error) {
    console.error("Admin dashboard error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load admin dashboard."
    });
  }
});

module.exports = router;


const express = require("express");
const { pool } = require("../db");
const { requireLogin, requireRole } = require("../middleware/auth");

const router = express.Router();

// All reseller routes require login
router.use(requireLogin);

// APPLY TO BECOME A RESELLER
router.post("/apply", async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { phone, businessName, reason } = req.body || {};

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    const existing = await pool.query(
      `SELECT id, status
       FROM reseller_applications
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "You have already submitted a reseller application.",
        status: existing.rows[0].status
      });
    }

    const result = await pool.query(
      `INSERT INTO reseller_applications
       (user_id, phone, business_name, reason, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, status, created_at`,
      [
        userId,
        String(phone).trim().slice(0, 30),
        String(businessName || "").trim().slice(0, 100),
        String(reason || "").trim().slice(0, 500)
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Your reseller application has been submitted for admin review.",
      application: result.rows[0]
    });

  } catch (error) {
    console.error("Reseller application error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to submit reseller application."
    });
  }
});

// CHECK APPLICATION STATUS
router.get("/application", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone, business_name, status, created_at
       FROM reseller_applications
       WHERE user_id = $1
       LIMIT 1`,
      [req.session.user.id]
    );

    return res.json({
      success: true,
      application: result.rows[0] || null
    });

  } catch (error) {
    console.error("Application status error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to check application."
    });
  }
});

// RESELLER DASHBOARD
router.get("/dashboard", requireRole("reseller", "admin"), async (req, res) => {
  try {
    const userId = req.session.user.id;

    const walletResult = await pool.query(
      `SELECT balance, currency
       FROM reseller_wallets
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    const transactionsResult = await pool.query(
      `SELECT id, transaction_type, amount, description, created_at
       FROM wallet_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    return res.json({
      success: true,
      reseller: {
        id: userId,
        name: req.session.user.name,
        email: req.session.user.email
      },
      wallet: walletResult.rows[0] || {
        balance: 0,
        currency: "GHS"
      },
      recentTransactions: transactionsResult.rows
    });

  } catch (error) {
    console.error("Reseller dashboard error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load reseller dashboard."
    });
  }
});

module.exports = router;

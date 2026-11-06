
const express = require("express");
const { pool } = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

// GET ALL ACTIVE PRODUCTS
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.description,
        p.image_url,
        p.price,
        p.reseller_price,
        p.stock,
        p.product_type,
        c.name AS category
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = TRUE
      ORDER BY p.created_at DESC
    `);

    res.json({
      success: true,
      products: result.rows
    });
  } catch (error) {
    console.error("Products error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load products."
    });
  }
});

// GET PRODUCT CATEGORIES
router.get("/categories", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, description, image_url
      FROM categories
      WHERE is_active = TRUE
      ORDER BY name ASC
    `);

    res.json({
      success: true,
      categories: result.rows
    });
  } catch (error) {
    console.error("Categories error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to load categories."
    });
  }
});

// ADD PRODUCT - ADMIN ONLY
router.post("/", requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      "SELECT role FROM users WHERE id = $1 AND is_active = TRUE",
      [req.user.id]
    );

    if (!userResult.rows.length || userResult.rows[0].role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required."
      });
    }

    const {
      name,
      description,
      image_url,
      price,
      reseller_price,
      stock,
      category_id,
      product_type
    } = req.body;

    const cleanName = String(name || "").trim();
    const productPrice = Number(price);
    const productStock = Number(stock ?? 0);
    const resellerPrice =
      reseller_price === "" || reseller_price == null
        ? null
        : Number(reseller_price);

    if (
      !cleanName ||
      cleanName.length > 200 ||
      !Number.isFinite(productPrice) ||
      productPrice < 0 ||
      !Number.isInteger(productStock) ||
      productStock < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid product name, price and stock."
      });
    }

    if (
      resellerPrice !== null &&
      (!Number.isFinite(resellerPrice) || resellerPrice < 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid reseller price."
      });
    }

    const allowedTypes = ["physical", "digital", "service"];
    const type = product_type || "physical";

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product type."
      });
    }

    const image = image_url ? String(image_url).trim() : null;

    if (image && (!/^https:\/\//i.test(image) || image.length > 2000)) {
      return res.status(400).json({
        success: false,
        message: "Product image must use a valid HTTPS URL."
      });
    }

    const categoryId =
      category_id === "" || category_id == null
        ? null
        : Number(category_id);

    if (
      categoryId !== null &&
      (!Number.isInteger(categoryId) || categoryId < 1)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid category."
      });
    }

    const result = await pool.query(
      `INSERT INTO products
       (category_id, name, description, image_url, price,
        reseller_price, stock, product_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        categoryId,
        cleanName,
        description || null,
        image,
        productPrice,
        resellerPrice,
        productStock,
        type
      ]
    );

    res.status(201).json({
      success: true,
      message: "Product added successfully.",
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Add product error:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to add product."
    });
  }
});

module.exports = router;

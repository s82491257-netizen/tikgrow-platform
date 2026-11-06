
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pool, testDatabase } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 150
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "SavCel Hub",
    status: "online"
  });
});

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

app.get("/api", (req, res) => {
  res.json({
    success: true,
    platform: "SavCel Hub"
  });
});

// TEMPORARY DATABASE SETUP PAGE
app.get("/setup", (req, res) => {
  res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>SavCel Hub Setup</title>
      <style>
        body {
          background: #100b20;
          color: white;
          font-family: Arial;
          padding: 30px 18px;
        }
        .card {
          max-width: 420px;
          margin: 60px auto;
          background: #211638;
          padding: 25px;
          border-radius: 16px;
        }
        input, button {
          width: 100%;
          box-sizing: border-box;
          padding: 15px;
          margin-top: 15px;
          border-radius: 9px;
          border: 0;
          font-size: 16px;
        }
        button {
          background: #743cff;
          color: white;
          font-weight: bold;
        }
        #result {
          overflow-wrap: anywhere;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>SavCel Hub</h2>
        <p>Secure database setup</p>
        <form id="setupForm">
          <input
            id="token"
            type="password"
            placeholder="Enter your setup token"
            required
            autocomplete="off"
          >
          <button type="submit">Create Database Tables</button>
        </form>
        <p id="result"></p>
      </div>
      <script>
        document.getElementById("setupForm")
          .addEventListener("submit", async function(event) {
            event.preventDefault();

            const result = document.getElementById("result");
            const token = document.getElementById("token").value;

            result.textContent = "Setting up database...";

            try {
              const response = await fetch("/api/admin/setup-schema", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ token })
              });

              const data = await response.json();
              result.textContent = data.message;

              if (response.ok) {
                document.getElementById("token").value = "";
              }
            } catch (error) {
              result.textContent = "Setup request failed. Please try again.";
            }
          });
      </script>
    </body>
    </html>
  `);
});

// PROTECTED DATABASE SETUP
app.post("/api/admin/setup-schema", async (req, res) => {
  const expected = process.env.ADMIN_SETUP_TOKEN;
  const supplied = req.body.token;

  if (
    !expected ||
    typeof supplied !== "string" ||
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(supplied),
      Buffer.from(expected)
    )
  ) {
    return res.status(401).json({
      success: false,
      message: "Invalid setup token."
    });
  }

  try {
    const schemaPath = path.join(
      __dirname,
      "database",
      "schema.sql"
    );

    const sql = fs.readFileSync(schemaPath, "utf8");

    if (!sql.trim()) {
      throw new Error("Schema file is empty.");
    }

    await pool.query(sql);

    res.json({
      success: true,
      message: "SavCel Hub database tables created successfully!"
    });
  } catch (error) {
    console.error("Schema setup failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Database setup failed. Check the Render logs."
    });
  }
});

app.get("/", (req, res) => {
  const homepage = path.join(__dirname, "index.html");

  if (!fs.existsSync(homepage)) {
    return res.status(404).send("Homepage not found.");
  }

  res.sendFile(homepage);
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Page not found"
  });
});

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("SavCel Hub running on port " + PORT);
});

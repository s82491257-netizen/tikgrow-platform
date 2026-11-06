
const crypto = require("crypto");

const COOKIE_NAME = "savcel_session";

function requireAuth(req, res, next) {
  try {
    const secret = process.env.AUTH_SECRET;

    if (!secret || secret.length < 32) {
      return res.status(500).json({
        success: false,
        message: "Authentication security is not configured."
      });
    }

    const cookieHeader = req.headers.cookie || "";

    const sessionCookie = cookieHeader
      .split(";")
      .find(cookie => cookie.trim().startsWith(COOKIE_NAME + "="));

    if (!sessionCookie) {
      return res.status(401).json({
        success: false,
        message: "Please log in to continue."
      });
    }

    const token = sessionCookie.trim()
      .slice(COOKIE_NAME.length + 1);

    const parts = token.split(".");

    if (parts.length !== 2) {
      return res.status(401).json({
        success: false,
        message: "Invalid login session."
      });
    }

    const [payload, signature] = parts;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");

    const suppliedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid login session."
      });
    }

    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    if (
      !Number.isInteger(session.id) ||
      !Number.isInteger(session.exp) ||
      session.exp <= Math.floor(Date.now() / 1000)
    ) {
      return res.status(401).json({
        success: false,
        message: "Your session has expired. Please log in again."
      });
    }

    req.user = {
      id: session.id
    };

    next();

  } catch (error) {
    console.error("Authentication error:", error.message);

    return res.status(401).json({
      success: false,
      message: "Please log in again."
    });
  }
}

module.exports = requireAuth;


<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SavCel Hub | Admin Activation</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#eef7ff;font-family:Arial,sans-serif;color:#172b4d}
.card{width:100%;max-width:420px;background:white;padding:30px;border-radius:20px;box-shadow:0 12px 40px #183b6018}
h2{margin-top:0;color:#1476d4}
p{color:#61758b;line-height:1.6}
input{width:100%;padding:15px;margin:12px 0;border:1px solid #cbdced;border-radius:10px;font-size:16px}
button{width:100%;padding:15px;border:0;border-radius:10px;background:#1476d4;color:white;font-size:16px;font-weight:bold}
button:disabled{opacity:.6}
#message{margin-top:16px;line-height:1.5;overflow-wrap:anywhere}
</style>
</head>
<body>
<div class="card">
<h2>Activate Administrator</h2>
<p>Enter the ADMIN_SETUP_TOKEN currently saved in your Render environment.</p>

<form id="setupForm">
<input
id="token"
type="password"
placeholder="Enter admin setup token"
autocomplete="off"
required
>
<button id="submitButton" type="submit">Activate Admin</button>
</form>

<div id="message" role="status"></div>
</div>

<script>
const form = document.getElementById("setupForm");
const tokenInput = document.getElementById("token");
const message = document.getElementById("message");
const button = document.getElementById("submitButton");

form.addEventListener("submit", async function(event) {
  event.preventDefault();

  const token = tokenInput.value.trim();

  if (!token) {
    message.textContent = "Please enter your setup token.";
    return;
  }

  button.disabled = true;
  message.textContent = "Checking authorization...";

  try {
    const response = await fetch("/api/admin/setup", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-admin-setup-token": token
      },
      body: JSON.stringify({})
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      message.textContent = data.message || "Admin activation failed.";
      button.disabled = false;
      return;
    }

    message.textContent = "Admin activated successfully. Opening dashboard...";

    setTimeout(function() {
      window.location.href = "/admin";
    }, 1200);

  } catch (error) {
    message.textContent = "Connection error. Please try again.";
    button.disabled = false;
  }
});
</script>
</body>
</html>

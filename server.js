require("dotenv").config();
const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

function tellerRequest(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.teller.io",
      path,
      method: "GET",
      headers: { "Authorization": "Basic " + Buffer.from(accessToken + ":").toString("base64") },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch(e) { reject(e); } });
    });
    req.on("error", reject);
    req.end();
  });
}

const store = {};

app.get("/health", (_, res) => res.json({ status: "ok", provider: "teller" }));

app.post("/api/save-token", (req, res) => {
  const { accessToken, userId, enrollment } = req.body;
  if (!accessToken || !userId) return res.status(400).json({ error: "accessToken and userId required" });
  store[userId] = { accessToken, enrollment };
  console.log("Bank linked for user", userId);
  res.json({ success: true });
});

app.get("/api/accounts", async (req, res) => {
  const entry = store[req.query.userId];
  if (!entry) return res.status(404).json({ error: "No bank linked yet." });
  try {
    const r = await tellerRequest("/accounts", entry.accessToken);
    if (r.status !== 200) return res.status(r.status).json({ error: r.data.message || "Teller error" });
    const accounts = await Promise.all(r.data.map(async (a) => {
      let balance = 0;
      try {
        const br = await tellerRequest("/accounts/" + a.id + "/balances", entry.accessToken);
        if (br.status === 200) balance = parseFloat(br.data.available || br.data.ledger || 0);
        if (["credit_card","loan"].includes(a.subtype)) balance = -Math.abs(balance);
      } catch(e) {}
      return { id: a.id, name: a.name, type: mapType(a.type, a.subtype), balance, institution: a.institution.name, last4: a.last_four, teller: true };
    }));
    res.json({ accounts });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/transactions", async (req, res) => {
  const entry = store[req.query.userId];
  if (!entry) return res.status(404).json({ error: "No bank linked yet." });
  try {
    const acctR = await tellerRequest("/accounts", entry.accessToken);
    if (acctR.status !== 200) return res.status(acctR.status).json({ error: "Could not fetch accounts" });
    const cutoff = new Date(Date.now() - (req.query.days || 30) * 86400000).toISOString().slice(0, 10);
    const all = [];
    await Promise.all(acctR.data.map(async (acct) => {
      try {
        const txR = await tellerRequest("/accounts/" + acct.id + "/transactions", entry.accessToken);
        if (txR.status === 200) {
          txR.data.filter(tx => tx.date >= cutoff).forEach(tx => {
            const amt = parseFloat(tx.amount || 0);
            all.push({ id: tx.id, name: tx.description, amount: tx.type === "credit" ? Math.abs(amt) : -Math.abs(amt), date: tx.date, category: mapCat(tx.details?.category || tx.type || ""), account: acct.name, pending: tx.status === "pending" });
          });
        }
      } catch(e) {}
    }));
    all.sort((a, b) => b.date.localeCompare(a.date));
    res.json({ transactions: all });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/disconnect", (req, res) => {
  if (store[req.body.userId]) { delete store[req.body.userId]; res.json({ success: true }); }
  else res.status(404).json({ error: "Not found" });
});

function mapType(type, subtype) {
  if (subtype === "checking") return "Checking";
  if (subtype === "savings") return "Savings";
  if (subtype === "credit_card") return "Credit";
  if (type === "investment") return "Investment";
  if (type === "loan") return "Loan";
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function mapCat(c) {
  c = c.toLowerCase();
  if (/food|restaurant|dining/.test(c)) return "dining";
  if (/grocer|supermarket/.test(c)) return "groceries";
  if (/transport|gas|uber|lyft|taxi/.test(c)) return "transport";
  if (/entertain|recreation/.test(c)) return "entertainment";
  if (/health|medical|pharmacy|gym/.test(c)) return "health";
  if (/rent|mortgage|housing/.test(c)) return "housing";
  if (/util|electric|water|internet/.test(c)) return "utilities";
  if (/income|payroll|deposit|salary/.test(c)) return "income";
  return "shopping";
}

app.listen(PORT, () => console.log("PocketBook backend running on port", PORT));

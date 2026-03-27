require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require("plaid");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: [
    "http://localhost:3000","http://localhost:5173",
    "http://127.0.0.1:3000","http://127.0.0.1:5173",
    ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : []),
  ],
  credentials: true,
}));
app.use(express.json());

const plaidEnv = process.env.PLAID_ENV || "sandbox";
const plaidClient = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: { headers: {
    "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
    "PLAID-SECRET":    process.env.PLAID_SECRET,
  }},
}));

const tokenStore = {}; // userId → { accessToken, itemId }

app.get("/health", (_,res) => res.json({ status:"ok", env:plaidEnv }));

app.post("/api/create-link-token", async (req,res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error:"userId required" });
  try {
    const r = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Ledger",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });
    res.json({ link_token: r.data.link_token });
  } catch(e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

app.post("/api/exchange-token", async (req,res) => {
  const { publicToken, userId } = req.body;
  if (!publicToken||!userId) return res.status(400).json({ error:"publicToken and userId required" });
  try {
    const r = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    tokenStore[userId] = { accessToken: r.data.access_token, itemId: r.data.item_id };
    console.log(`✓ Bank linked for user ${userId}`);
    res.json({ success:true, itemId: r.data.item_id });
  } catch(e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

app.get("/api/accounts", async (req,res) => {
  const stored = tokenStore[req.query.userId];
  if (!stored) return res.status(404).json({ error:"No bank linked yet." });
  try {
    const r = await plaidClient.accountsGet({ access_token: stored.accessToken });
    res.json({ accounts: r.data.accounts.map(a => ({
      id: a.account_id, name: a.name, plaid: true,
      type: {depository:"Checking",credit:"Credit",investment:"Investment",loan:"Loan"}[a.type] || a.type,
      balance: ["credit","loan"].includes(a.type) ? -(a.balances.current||0) : (a.balances.current ?? a.balances.available ?? 0),
      institution: "Bank", last4: a.mask,
    }))});
  } catch(e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

app.get("/api/transactions", async (req,res) => {
  const stored = tokenStore[req.query.userId];
  if (!stored) return res.status(404).json({ error:"No bank linked yet." });
  const end   = new Date().toISOString().slice(0,10);
  const start = new Date(Date.now() - (req.query.days||30)*86400000).toISOString().slice(0,10);
  try {
    const r = await plaidClient.transactionsGet({
      access_token: stored.accessToken, start_date:start, end_date:end,
      options:{ count:250, offset:0 },
    });
    res.json({ transactions: r.data.transactions.map(tx => ({
      id: tx.transaction_id,
      name: tx.merchant_name || tx.name,
      amount: -tx.amount,
      date: tx.date,
      category: mapCat(tx.personal_finance_category?.primary || tx.category?.[0]),
      account: tx.account_id,
      pending: tx.pending,
    })), total: r.data.total_transactions });
  } catch(e) { res.status(500).json({ error: e.response?.data?.error_message || e.message }); }
});

app.delete("/api/disconnect", async (req,res) => {
  const stored = tokenStore[req.body.userId];
  if (!stored) return res.status(404).json({ error:"Not found." });
  try {
    await plaidClient.itemRemove({ access_token: stored.accessToken });
    delete tokenStore[req.body.userId];
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

function mapCat(raw) {
  if (!raw) return "shopping";
  const c = raw.toLowerCase();
  if (/food|restaurant|dining/.test(c))              return "dining";
  if (/grocer|supermarket/.test(c))                  return "groceries";
  if (/travel|transport|gas|taxi|uber|lyft/.test(c)) return "transport";
  if (/entertain|recreation/.test(c))                return "entertainment";
  if (/health|medical|pharmacy|gym|fitness/.test(c)) return "health";
  if (/rent|mortgage|housing/.test(c))               return "housing";
  if (/util|electric|water|internet|phone/.test(c))  return "utilities";
  if (/income|payroll|deposit|salary/.test(c))       return "income";
  return "shopping";
}

app.listen(PORT, () => console.log(`\n  Ledger backend → http://localhost:${PORT}  (Plaid: ${plaidEnv})\n`));
